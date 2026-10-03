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
const undo = require('../undo');
const fsTools = require('./fs');
const execTools = require('./exec');
const deliverTools = require('./deliver');
const todoLib = require('../todo');
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
  /* 传输文件：把产出物放进用户的「待下载」目录（可执行文件自动打包，见 lib/agent/files.js） */
  deliver_file: { run: (a, args, l) => deliverTools.deliverFile(a, args, l) },
  /* 任务清单（右上角浮层那块）：agent 自己决定要不要列；全量覆盖，全完成即丢弃
     （存储与规则见 lib/agent/todo.js）。要 ctx 里的会话 id——所以它是第一个吃第 5 个参数的 run。 */
  todo_write: { run: (a, args, l, g, ctx) => todoLib.writeTool(a, args, ctx) },
};

/** 工具结果里的行数（工具没改文件、或没记成日志时为 undefined）——响应里只带这两个数 */
const linesOf = (r) => {
  if (!r || !r.lines || typeof r.lines !== 'object') return undefined;
  const added = Math.max(0, Math.floor(Number(r.lines.added) || 0));
  const removed = Math.max(0, Math.floor(Number(r.lines.removed) || 0));
  return (added || removed) ? { added, removed } : undefined;
};

/** 工具结果 → 响应体（**两条调用路径的唯一一份**：HTTP 的 /tools/call 与托管运行的进程内桥）。
 *  files / lines / undoRef 每个都有过"只加了一条路、另一条路没加"的分叉（卡片刷不出来、
 *  行数不显示、卡片点不开比对）——所以这里的白名单只许有一份，谁都不许再抄。 */
function toolResultBody(r, limits, ms) {
  return {
    ok: r.ok !== false, text: String(r.text || '').slice(0, limits.outputBytes), note: r.note || '', ms,
    files: Array.isArray(r.files) ? r.files.slice(0, 20) : undefined,
    lines: linesOf(r),
    undoRef: r.undoRef && typeof r.undoRef === 'object' ? r.undoRef : undefined,
    /* 任务清单（todo_write）：null = 已丢弃，**要保留**（与"没这个字段"不同），见 lib/agent/todo.js */
    todo: r.todo !== undefined ? r.todo : undefined,
  };
}

/** 工具失败 → 响应体（同样两条路唯一一份）：needUnlock / needGrant / needBind…
 *  界面据这些标记把用户引到该去的地方（解锁框 / 授权窗 / 绑定抽屉），而不是只显示一句报错。 */
function toolErrorBody(e) {
  return {
    ok: false, error: (e && e.message) || '工具执行失败',
    needBind: !!(e && e.needBind), needUnlock: !!(e && e.needUnlock), needGrant: !!(e && e.needGrant),
    needPermission: !!(e && e.needPermission), needRoots: !!(e && e.needRoots),
    hit: (e && e.hit) || '', osUser: (e && e.osUser) || '',
  };
}

/** 工具执行的**唯一入口**：会改文件的工具由 undo.wrap 包一层——
 *  执行前后各拍一次快照 → 记进本次运行的改动日志（行数统计 + 原内容备份）→ 行数挂回结果。
 *  两条调用路径都走这里：HTTP（/agent/tools/call）与托管运行的进程内直调（run-bridge），
 *  于是"行数显示"与"一键撤销"对两条路都成立。
 *  @param {object} ctx { account, run? }：run 缺席（脚本直调）时只执行、不记录——没有卡片可撤。 */
async function callTool(name, actor, args, limits, grant, ctx) {
  const tool = TOOLS[name];
  if (!tool) throw Object.assign(new Error('未知工具：' + name), { status: 404 });
  const meta = Object.assign({ actor }, ctx || {});
  /* ctx 第 5 个参数交给 run（todo_write 要用它取会话 id）；现有工具忽略它，行为不变。 */
  return undo.wrap(meta, name, args, () => tool.run(actor, args, limits, grant, ctx));
}

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

async function handleTools(req, url, res, actor, account) {
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
      /* account 交给 callTool：改文件的工具要按账号+会话记改动日志（一键撤销的依据）。
         这条路没有 run 上下文，所以只记在 undo 的"账号/会话"两级的通用日志里不可行——
         统一交给 undo.wrap（没有 run 就不记），行为与托管运行那条路完全一致。 */
      const r = await callTool(name, actor, args, limits, grant, {
        account, sessionId: String((body && body.sessionId) || ''),
      });
      const ms = Date.now() - t0;
      auditLog(`agent-tool account=${actor.account} as=${actor.osUser} tool=${name} ${
        tool.command ? 'cmd=' + String(args.command || '').slice(0, 200)
          : 'path=' + String(args.path || args.source || '').slice(0, 200)} ok=${r.ok !== false} ms=${ms}`);
      /* 响应体的组装在 toolResultBody（**两条调用路径共用一份**，别在这里另抄：files/lines/undoRef
         都踩过"只加了一条路"的分叉坑——卡片刷不出来、行数不显示、卡片点不开比对）。 */
      return json(res, 200, toolResultBody(r, limits, ms));
    } catch (e) {
      auditLog(`agent-tool account=${actor.account} as=${actor.osUser} tool=${name} ok=false err=${String(e.message).slice(0, 200)}`);
      /* needUnlock：su 类绑定还没在本次会话解锁 —— 前端据此弹解锁框
         needGrant：危险命令没有有效授权票据 —— 前端据此弹授权窗
         needBind / needPermission / needRoots：绑定或权限或白名单没到位 —— 界面给出对应入口 */
      return json(res, e.status || 500, toolErrorBody(e));
    }
  }

  return json(res, 404, { ok: false, error: 'unknown agent tools endpoint' });
}

module.exports = { handleTools, statusInfo, TOOLS, denyHit, callTool, toolResultBody, toolErrorBody };
