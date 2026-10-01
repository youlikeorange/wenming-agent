/** lib/agent/tools/index.js —— 工具分发表 + HTTP 路由（/agent/tools/*）
 *
 *  端点：
 *    GET  /agent/tools/status     → 身份 / 绑定 / 白名单 / 上限 / 危险清单 / 工具表
 *    POST /agent/tools/roots      → { action:'add'|'remove'|'set'|'reset', path|roots }
 *    POST /agent/tools/deny-check → { command } → { hit, grant }
 *    POST /agent/tools/call       → { name, args, limits, grant } → { ok, text, note, ms }
 *  全部要求文档站登录（由 lib/agent/index.js 前置判定），并受单窗口互斥保护。
 *
 *  分发表里的 write/danger/command 标记只用于状态展示与审计文案；真正的读写判定
 *  在各工具内部（roots 白名单 + osaccess 权限 + 危险命令票据）。
 */
const { json } = require('../../http');
const store = require('../store');
const { auditLog } = require('../../auth');
const { effLimits, LIMITS } = require('../limits');
const { denyHit, denyList } = require('../deny');
const { issueGrant } = require('../grants');
const roots = require('../roots');
const fsTools = require('./fs');
const execTools = require('./exec');
const session = require('../session');

/* 工具分发表：这里只登记"怎么执行"。**读写之分不在这张表上**——
   客户端侧才有（core/agent-defs.js 的 FS_READ_NAMES/FS_WRITE_NAMES，决定要不要弹确认框），
   服务端侧由访问级别 + 危险命令清单把关。原先这里还挂着 write/danger 两个标记，
   全项目无人读取（审计时删掉，免得看代码的人以为服务端按它们做闸门）。
   command: true 仍在用：/call 的审计日志据此决定打 cmd= 还是 path=。 */
const TOOLS = {
  read_file: { run: (a, args, l) => fsTools.readFile(a, args, l) },
  list_directory: { run: (a, args) => fsTools.listDirectory(a, args) },
  directory_tree: { run: (a, args, l) => fsTools.directoryTree(a, args, l) },
  search_files: { run: (a, args, l) => fsTools.searchFiles(a, args, l) },
  get_file_info: { run: (a, args) => fsTools.fileInfo(a, args) },
  write_file: { run: (a, args, l) => fsTools.writeFile(a, args, l) },
  edit_file: { run: (a, args) => fsTools.editFile(a, args) },
  create_directory: { run: (a, args) => fsTools.createDirectory(a, args) },
  move_file: { run: (a, args) => fsTools.moveFile(a, args) },
  delete_path: { run: (a, args) => fsTools.deletePath(a, args) },
  run_command: { command: true, run: (a, args, l, g) => execTools.runCommand(a, args, l, g) },
};

/** 面板展示 + 前端据它决定注册哪些工具（未绑定 → 前端不注册文件/命令工具） */
function statusInfo(actor) {
  const b = session.bindingView(actor.account);
  return {
    ok: true,
    account: actor.account,
    binding: b,
    siteUser: session.SITE_USER,
    // 绑定账号能做什么：文件工具受其权限位约束，命令工具直接以它运行
    user: actor.osUser || '',
    uid: actor.uid,
    home: actor.home,
    method: actor.method,
    needBind: actor.needBind,
    needUnlock: actor.needUnlock,
    roots: roots.list(actor),
    defaults: roots.defaultsFor(),
    start: roots.startFor(actor),          // 项目起点（目录选择器从这里开始；不是访问范围限制）
    startDefault: roots.DEFAULT_START,
    limits: LIMITS,
    deny: denyList(),                 // 命中不等于拒绝：执行前弹授权窗，人点了才跑
    tools: Object.keys(TOOLS),
  };
}

async function handleTools(req, url, res, actor) {
  const pathname = url.pathname;

  if (pathname === '/agent/tools/status' && req.method === 'GET') {
    return json(res, 200, statusInfo(actor));
  }

  if (pathname === '/agent/tools/roots' && req.method === 'POST') {
    let body;
    try { body = await store.readAgentJson(req, pathname); } catch (e) { return json(res, e.status || 400, { ok: false, error: 'invalid json' }); }
    try {
      /* apply() 的返回**恒为对象**，键随动作而变（start → {start}，其余 → {roots}）。
         响应体直接展开它，键名与前端契约一致（settings.js 读 d.roots、projects.js 读 d.start）；
         审计日志也按实际形状取字段——旧写法一律按数组 join，start 动作必然 TypeError→500。 */
      const out = await roots.apply(String(body.action || ''), body, actor);
      auditLog(`agent-roots-${body.action} account=${actor.account} `
        + (out.roots ? `roots=${out.roots.join(':')}` : `start=${out.start}`));
      return json(res, 200, Object.assign({ ok: true }, out));
    } catch (e) {
      return json(res, e.status || 500, { ok: false, error: e.message });
    }
  }

  if (pathname === '/agent/tools/deny-check' && req.method === 'POST') {
    // 危险命令预检（前端在执行 run_command 前调用）：命中就签发一次性授权票据。
    // 票据不在模型的工具清单里，只有「人」点过授权窗才拿得到。
    let body;
    try { body = await store.readAgentJson(req, pathname); } catch (e) { return json(res, e.status || 400, { ok: false, error: 'invalid json' }); }
    const command = String((body && body.command) || '');
    if (!command.trim()) return json(res, 400, { ok: false, error: '缺少 command' });
    const hit = denyHit(command);
    auditLog(`agent-deny-check account=${actor.account} hit=${hit || 'none'} cmd=${command.slice(0, 160)}`);
    return json(res, 200, { ok: true, hit, grant: hit ? issueGrant(command) : '' });
  }

  if (pathname === '/agent/tools/call' && req.method === 'POST') {
    let body;
    try { body = await store.readAgentJson(req, pathname); } catch (e) { return json(res, e.status || 400, { ok: false, error: 'invalid json' }); }
    const name = String((body && body.name) || '');
    const args = (body && body.args && typeof body.args === 'object') ? body.args : {};
    const grant = body ? body.grant : '';
    const tool = TOOLS[name];
    if (!tool) return json(res, 404, { ok: false, error: '未知工具：' + name });
    if (!actor.bound) {
      return json(res, 403, { ok: false, needBind: true,
        error: '还没有绑定本机账号：Agent 的工具以绑定账号的权限执行，请先在设置抽屉 → 本机账号 里绑定' });
    }
    // 面板上的限额随请求下发（只能收紧，不能超过硬上限）——见 lib/agent/limits.js
    const limits = effLimits(body && body.limits);
    const t0 = Date.now();
    try {
      const r = await tool.run(actor, args, limits, grant);
      const ms = Date.now() - t0;
      auditLog(`agent-tool account=${actor.account} as=${actor.osUser} tool=${name} ${
        tool.command ? 'cmd=' + String(args.command || '').slice(0, 200)
          : 'path=' + String(args.path || args.source || '').slice(0, 200)} ok=${r.ok !== false} ms=${ms}`);
      return json(res, 200, { ok: r.ok !== false, text: String(r.text || '').slice(0, limits.outputBytes), note: r.note || '', ms });
    } catch (e) {
      auditLog(`agent-tool account=${actor.account} as=${actor.osUser} tool=${name} ok=false err=${String(e.message).slice(0, 200)}`);
      // needUnlock：su 类绑定还没在本次会话解锁 —— 前端据此弹解锁框
      // needGrant：危险命令没有有效授权票据 —— 前端据此弹授权窗
      // needBind / needPermission / needRoots：绑定或权限或白名单没到位 —— 界面给出对应入口
      return json(res, e.status || 500, {
        ok: false, error: e.message || '工具执行失败',
        needBind: !!e.needBind, needUnlock: !!e.needUnlock, needGrant: !!e.needGrant,
        needPermission: !!e.needPermission, needRoots: !!e.needRoots,
        hit: e.hit || '', osUser: e.osUser || '',
      });
    }
  }

  return json(res, 404, { ok: false, error: 'unknown agent tools endpoint' });
}

module.exports = { handleTools, statusInfo, TOOLS, denyHit };
