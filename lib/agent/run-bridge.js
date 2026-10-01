/** lib/agent/run-bridge.js —— 托管运行的**进程内端点桥**（把 core 的 HTTP 调用接回真实处理函数）
 *
 *  背景：Agent 的循环与工具分发（agent/src/core/agent.js、core/tool-runner.js）本来跑在浏览器里，
 *  它们通过同源 HTTP 调 /agent/tools/*、/agent/search、/agent/skills/import。要把这套循环搬到
 *  服务端（关掉浏览器也不中断），最省事也最不容易分叉的办法不是"再写一份工具执行"，
 *  而是**把那一层 HTTP 换成进程内直调**：路径照旧、请求体照旧、响应形状照旧，
 *  于是 core 里那些预算/确认/错误分类的逻辑一行不改，两端行为天然一致。
 *
 *  注入点在 core/http.js 的 fetch（不是 request）——超时、中断、needLogin/needUnlock
 *  这些错误分类必须继续生效，所以只换"最底下那一跳"。
 *
 *  账号从哪来：一次运行 = 一个账号，但注入的 fetch 是**模块级单例**。
 *  用 AsyncLocalStorage 把"当前运行"带在异步上下文里，桥按上下文取账号——
 *  这也是为什么同一时刻只允许一个托管运行（见 run.js 的全局队列）：
 *  core 的登记表（Prompts/Memory）本身是模块级单例，两份运行并发会互相看到对方的数据。
 */
const { AsyncLocalStorage } = require('async_hooks');
const { effLimits } = require('./limits');
const { denyHit, denyList } = require('./deny');
const { issueGrant } = require('./grants');
const { json } = require('../http');
const store = require('./store');
const session = require('./session');
const roots = require('./roots');
const search = require('./search');
const skills = require('./skills');
const { TOOLS, statusInfo } = require('./tools');

/** 当前运行的上下文：{ account, actor, run } */
const als = new AsyncLocalStorage();
const current = () => als.getStore() || null;
const runWith = (ctx, fn) => als.run(ctx, fn);

let installed = false;
/** 装一次（进程级）：core/http.js 的 fetch 之后一律走这里 */
async function installBridge() {
  if (installed) return;
  const http = await import('../../agent/src/core/http.js');
  http.setFetchImpl(bridgeFetch);
  installed = true;
}

const respond = (status, obj) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json' },
});

/** 请求体（core/http.js 发的是 JSON 字符串） */
function bodyOf(init) {
  const raw = init && init.body;
  if (!raw) return {};
  try { return JSON.parse(typeof raw === 'string' ? raw : String(raw)); } catch { return {}; }
}

/** 按路径分发。未覆盖的路径一律 501——**绝不静默成功**：
 *  那样会让"服务端跑不了某个工具"变成"工具返回了空结果"，比报错难查得多。 */
async function bridgeFetch(url, init = {}) {
  const ctx = current();
  const path = String(url || '');
  if (!ctx) return respond(500, { ok: false, error: '托管运行上下文丢失（内部错误）' });
  const { account, actor, run } = ctx;
  const method = String(init.method || 'GET').toUpperCase();
  const body = bodyOf(init);

  /* ---- 工具 ---- */
  if (path === '/agent/tools/status' && method === 'GET') {
    return respond(200, statusInfo(actor));
  }

  if (path === '/agent/tools/deny-check' && method === 'POST') {
    const command = String(body.command || '');
    if (!command.trim()) return respond(400, { ok: false, error: '缺少 command' });
    const hit = denyHit(command);
    // 危险命令的一次性授权票据：托管运行里由**人**在界面上点授权后回传（见 run.js 的确认中继）
    return respond(200, { ok: true, hit, grant: hit ? issueGrant(command) : '' });
  }

  if (path === '/agent/tools/call' && method === 'POST') {
    const name = String(body.name || '');
    const args = (body.args && typeof body.args === 'object') ? body.args : {};
    const tool = TOOLS[name];
    if (!tool) return respond(404, { ok: false, error: '未知工具：' + name });
    /* **每次执行前重新取身份**，而不是用 start 时的快照：
       一轮托管运行最长 30 分钟，期间用户可能登出/解绑/上锁——用快照就等于
       "撤销之后模型还能以旧身份（su 档还带着内存里的密码副本）继续执行命令"（2026-10-01 审计）。
       重新取到的 actor 会立刻反映：未绑定 → 下面 403；上锁 → needUnlock 由工具层拒绝。 */
    const live = session.actorOf(account);
    const act = live || actor;
    if (!act.bound) {
      return respond(403, { ok: false, needBind: true,
        error: '还没有绑定本机账号：Agent 的工具以绑定账号的权限执行，请先在设置抽屉 → 本机账号 里绑定' });
    }
    const limits = effLimits(body.limits);
    const t0 = Date.now();
    try {
      const r = await tool.run(act, args, limits, body.grant);
      if (run) run.countTool();
      /* files 与 HTTP 那条路同一形状（工具产出的可下载文件清单）——两条路的响应必须一致，
         否则"服务端跑"与"别处跑"会画出不同的卡片。 */
      return respond(200, {
        ok: r.ok !== false, text: String(r.text || '').slice(0, limits.outputBytes), note: r.note || '', ms: Date.now() - t0,
        files: Array.isArray(r.files) ? r.files.slice(0, 20) : undefined,
      });
    } catch (e) {
      return respond(e.status || 500, {
        ok: false, error: e.message || '工具执行失败',
        needBind: !!e.needBind, needUnlock: !!e.needUnlock, needGrant: !!e.needGrant,
        needPermission: !!e.needPermission, needRoots: !!e.needRoots,
        hit: e.hit || '', osUser: e.osUser || '',
      });
    }
  }

  if (path === '/agent/tools/roots' && method === 'POST') {
    try {
      const out = await roots.apply(String(body.action || ''), body, actor);
      return respond(200, Object.assign({ ok: true }, out));
    } catch (e) {
      return respond(e.status || 500, { ok: false, error: e.message });
    }
  }

  /* ---- 联网搜索 ---- */
  if (path === '/agent/search' && method === 'POST') {
    const r = await search.runSearch(body.query, body.max_results, account);
    if (run) run.countTool();
    return respond(r.ok ? 200 : 502, r);
  }

  /* ---- 技能安装（与 /agent/skills/import 同一形状） ---- */
  if (path === '/agent/skills/import' && method === 'POST') {
    const act = session.actorOf(account) || actor;      // 同上：实名实时取，不用快照
    if (!act.bound) return respond(403, { ok: false, needBind: true, error: '先绑定本机账号：读技能文件要以它的权限进行' });
    try {
      const plan = await skills.planImport(act, { path: body.path, auto: body.auto });
      if (body.dryRun) {
        return respond(200, { ok: true, dryRun: true, path: plan.path, errors: plan.errors,
          items: plan.items.map((it) => ({ name: it.name, description: it.description, auto: it.auto, file: it.file, chars: it.text.length })) });
      }
      const done = await skills.applyImport(account, plan.items);
      if (run) run.countTool();
      return respond(200, { ok: true, path: plan.path, errors: plan.errors, imported: done, count: done.length });
    } catch (e) {
      return respond(e.status || 500, { ok: false, error: e.message,
        needPermission: !!e.needPermission, needRoots: !!e.needRoots, needBind: !!e.needBind });
    }
  }

  return respond(501, { ok: false, error: `托管运行暂不支持这个端点：${path}` });
}

module.exports = { installBridge, runWith, current, als, statusInfoFor: (actor) => statusInfo(actor), json };
