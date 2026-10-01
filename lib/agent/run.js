/** lib/agent/run.js —— 托管运行：把 Agent 循环搬到服务端（关掉浏览器也不中断）
 *
 *  为什么要有它：循环原先整个跑在浏览器里（ui/state/session.js 的 send → core/agent.js），
 *  浏览器一关，在途的那一轮就没了——模型白跑、工具白调、结果一个字都不落盘。
 *  这里把循环搬到服务端：**人走了它照样跑完，结果写进会话**；界面只是"看"的一方，
 *  随时可以关掉、刷新、换窗口，回来再接上（事件有回放）。
 *
 *  怎么做（关键是**不重写第二份 agent**）：
 *    · 循环  = core/agent.js（原样）              · 工具 = core/tool-runner.js（原样）
 *    · 协议  = core/protocol/*（原样）             · 组装 = core/assemble.js（两端同一份）
 *  于是"浏览器里跑的 agent"和"服务端跑的 agent"是同一套代码，行为不会分叉。
 *
 *  **本文件只做编排**，四块各自成模块：
 *    run-core.js      加载 core 并接上进程内桥 / 直连上游（进程内单例）
 *    run-registry.js  谁在跑（登记表、生命周期、插话队列；**同一时刻只允许一个运行**）
 *    run-events.js    事件日志与 SSE 回放/续播
 *    run-confirm.js   人工闸门（确认中继，多槽位）
 *    run-loop.js      循环本体（灌账号数据 → 跑内核 → 落盘 → 收尾）
 *
 *  端点（都在 /agent/run 下，属 Agent 子项目同源契约；全部要求登录）：
 *    POST /agent/run/start    { sessionId, text, providerId, history, localEdits } → { runId }
 *    GET  /agent/run/events   ?id=<runId>            → SSE（先回放已发生的事件，再续播）
 *    GET  /agent/run/state    ?sessionId=<id>        → 这个会话有没有在跑的运行
 *    POST /agent/run/stop     { id }
 *    POST /agent/run/steer    { id, text }
 *    POST /agent/run/confirm  { id, confirmId, ok, remember, grant }
 *
 *  **所有取 run 的入口都按 account 过滤**（get(id, account)）：任何登录用户都不许订阅别人的
 *  事件流、也不许替别人点"同意执行"（2026-10-01 审计的 P0：attach/answerConfirm 原先不校验）。
 */
const store = require('./store');
const settings = require('./settings');
const session = require('./session');
const reg = require('./run-registry');
const events = require('./run-events');
const confirm = require('./run-confirm');
const loop = require('./run-loop');

const CONFIRM_WAIT_MS = confirm.CONFIRM_WAIT_MS;

/* 登出/解绑 = **立刻收回**：那一轮最多还能跑 30 分钟，期间模型再发 run_command 仍会以旧身份
   （su 档还带着内存里的密码副本）执行——"撤销即生效"对托管运行不成立（2026-10-01 审计）。
   这里挂在 session 的登出钩子上（logout 与 unbind 都会触发），直接掐断在途那一轮；
   工具层还有第二道闸（run-bridge 每次执行前重新取身份，锁上/解绑后一律拒绝）。 */
session.onLogout((account) => {
  const run = reg.activeOf();
  if (run && run.account === account) {
    try { run.abort.abort(); } catch { /* 已结束 */ }
  }
});

function busyError() {
  const act = reg.busy();
  return Object.assign(new Error(`已有一段回答正在服务端生成（${act && act.title ? act.title : '另一段对话'}）。`
    + '托管运行同一时刻只允许一个，等它结束再发。'), { status: 409 });
}

/**
 * 启动一次托管运行。**立即返回 runId**，循环在后台跑——所以关掉浏览器不影响它。
 * @param {{account:string, actor:object, sessionId:string, text:string, providerId?:string,
 *          history?:Array, localEdits?:boolean}} req
 */
async function startRun(req) {
  if (reg.activeOf()) throw busyError();
  const account = req.account;
  const list = store.readSessions(account);
  /* 会话可能还没落盘（客户端新建会话后立刻发第一条消息，落盘是防抖的）：
     这时按请求里的 id 现造一个——它紧接着就会被这次运行写进 sessions.json，
     不该因为"晚了几百毫秒"就 404。 */
  const found = list.sessions.find((s) => s.id === req.sessionId);
  const sess = found || store.sanitizeSession({
    id: req.sessionId, title: '新对话', ts: Date.now(),
    msgs: Array.isArray(req.history) ? req.history : [],
  });
  if (!sess) throw Object.assign(new Error('会话 id 不合法'), { status: 400 });
  const s = settings.read(account);
  const providerId = String(req.providerId || sess.provider || s.activeId || '');
  const prov = s.providers.find((p) => p.id === providerId) || null;
  if (!prov) throw Object.assign(new Error('没有可用的模型服务商（设置抽屉 → 模型）'), { status: 400 });

  /* 历史对账：客户端交上来的那份可能是**落后一轮**的（一轮结束后 1.5 秒内切走了会话、
     或那次重拉失败——会话对象还停在运行前的快照）。以它为准就会把服务端刚跑完的那一轮
     整份覆盖掉（2026-10-01 审计实测的数据丢失）。规则见 core/sessions.js（两端同一份）。 */
  const C = await require('./run-core').core();
  const serverMsgs = sess.msgs || [];
  const base = Array.isArray(req.history)
    ? C.Sessions.reconcileHistory(serverMsgs, req.history, { localEdits: !!req.localEdits })
    : serverMsgs;
  const history = C.Sessions.trimTrailingQuestion(base, req.text);

  const run = reg.create({
    account, actor: req.actor, sessionId: req.sessionId,
    providerId, title: sess.title,
    history,
    session: sess, live: null,
  });
  // 立刻放一条占位的助手消息（界面一订阅就能看到"正在生成"，与浏览器侧同一形态）
  run.live = { id: C.Sessions.newMsgId(), role: 'assistant', content: '', thinking: '', stats: null, trace: [], wallMs: 0, streaming: true };
  run.history.push({ id: C.Sessions.newMsgId(), role: 'user', content: String(req.text || '') }, run.live);
  /* **等这次写盘完成再返回**：会话（含本轮提问）先落盘，之后哪怕进程立刻挂掉，
     用户也还找得回"我问过什么"——这是"关掉浏览器不丢内容"的最小保证。 */
  await loop.persist(run, true);
  loop.execute(run, req).catch(() => { /* execute 内部已收尾 */ });
  return { runId: run.id };
}

/** 挂一个 SSE 订阅者（**只允许 run 的主人**：跨账号读别人的事件流是信息泄露）。 */
function attach(runId, res, account) {
  const run = reg.get(runId, account);
  if (!run || !account) return false;
  return events.attach(run, res);
}

/** 回答一个确认（**只允许 run 的主人**：否则任何人拿到 confirmId 就能替别人批准危险命令）。 */
function answerConfirm(runId, id, ok, remember, grant, account) {
  const run = reg.get(runId, account);
  if (!run || !account) return false;
  return confirm.answerConfirm(run, id, ok, remember, grant);
}

/** 这一轮还在跑吗（供 run-http 的 /state 用；只回本账号那一段） */
const stateOf = (account, sessionId) => reg.stateOf(account, sessionId);
const busyOf = (account) => reg.busyOf(account);
const stopRun = (account, id) => reg.stopRun(account, id);
const steer = (account, id, text) => reg.steer(account, id, text);
/** 内部用（循环自检、测试）：全局唯一的那一段运行，**不带账号过滤**，不要直接回给端点 */
const busy = () => reg.busy();

module.exports = {
  startRun, attach, answerConfirm, stopRun, steer, stateOf, busyOf, busy, busyError,
  CONFIRM_WAIT_MS,
  _runs: reg.runs,
};
