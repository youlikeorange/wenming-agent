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
 *  **可以同时跑多段**（2026-10-01 起）：每条运行有自己的 core 实例（run-core.createCoreContext），
 *  于是"一个会话在生成、切到另一个会话再问一句"两边互不干扰；一个账号最多 3 段、
 *  全进程最多 8 段（见 run-registry 的三道闸），同一会话永远只有一段。
 *
 *  **本文件只做编排**，各块自成模块：
 *    run-core.js      装配 core（静态模块共用 + 每段运行一套实例）
 *    run-registry.js  谁在跑（登记表、生命周期、并发闸、插话队列）
 *    run-events.js    事件日志、单运行 SSE、**账号事件口**（一条流看全部会话）
 *    run-confirm.js   人工闸门（确认中继，多槽位）
 *    run-subagent.js  子智能体（自己一段上下文 + 默认只读的工具集）
 *    run-loop.js      循环本体（灌账号数据 → 跑内核 → 落盘 → 收尾）
 *
 *  端点（都在 /agent/run 下，属 Agent 子项目同源契约；全部要求登录）：
 *    POST /agent/run/start    { sessionId, text, providerId, history, localEdits } → { runId }
 *    GET  /agent/run/events   ?id=<runId>            → SSE（先回放已发生的事件，再续播）
 *    GET  /agent/run/hub                             → SSE：本账号**所有**运行的事件（统一口）
 *    GET  /agent/run/state    ?sessionId=<id>        → 这个会话有没有在跑的运行 + 本账号在跑的清单
 *    GET  /agent/run/subagent ?id=<runId>&sub=<subId>→ 某个子智能体的完整转录
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
const { createCoreContext } = require('./run-core');

const CONFIRM_WAIT_MS = confirm.CONFIRM_WAIT_MS;

/* 登出/解绑 = **立刻收回**：那一轮最多还能跑 30 分钟，期间模型再发 run_command 仍会以旧身份
   （su 档还带着内存里的密码副本）执行——"撤销即生效"对托管运行不成立（2026-10-01 审计）。
   这里挂在 session 的登出钩子上（logout 与 unbind 都会触发），掐断该账号**所有**在途运行；
   工具层还有第二道闸（run-bridge 每次执行前重新取身份，锁上/解绑后一律拒绝）。 */
session.onLogout((account) => {
  for (const run of reg.objectsOf(account)) {
    try { run.abort.abort(); } catch { /* 已结束 */ }
  }
});

/** 起跑前的三道闸：同一会话不许并行、同账号限流、全进程限流（都把话说明白） */
function gateErrors(account, sessionId) {
  if (reg.stateOf(account, sessionId)) {
    return Object.assign(new Error('这条对话正在服务端生成回答：等它结束，或先点「停止」。'
      + '（想同时问别的，切到另一条对话去发即可）'), { status: 409 });
  }
  const cap = reg.capacity(account);
  if (!cap.ok) return Object.assign(new Error(cap.error), { status: cap.status });
  return null;
}

/**
 * 启动一次托管运行。**立即返回 runId**，循环在后台跑——所以关掉浏览器不影响它。
 * @param {{account:string, actor:object, sessionId:string, text:string, providerId?:string,
 *          history?:Array, localEdits?:boolean}} req
 */
async function startRun(req) {
  const account = req.account;
  const sessionId = String(req.sessionId || '');
  const busy = gateErrors(account, sessionId);
  if (busy) throw busy;
  const list = store.readSessions(account);
  /* 会话可能还没落盘（客户端新建会话后立刻发第一条消息，落盘是防抖的）：
     这时按请求里的 id 现造一个——它紧接着就会被这次运行写进 sessions.json，
     不该因为"晚了几百毫秒"就 404。 */
  const found = list.sessions.find((s) => s.id === sessionId);
  const sess = found || store.sanitizeSession({
    id: sessionId, title: '新对话', ts: Date.now(),
    msgs: Array.isArray(req.history) ? req.history : [],
  });
  if (!sess) throw Object.assign(new Error('会话 id 不合法'), { status: 400 });
  const s = settings.read(account);
  const providerId = String(req.providerId || sess.provider || s.activeId || '');
  const prov = s.providers.find((p) => p.id === providerId) || null;
  if (!prov) throw Object.assign(new Error('没有可用的模型服务商（设置抽屉 → 模型）'), { status: 400 });

  /* 本段运行专用的 core 实例：多段并行互不串数据（登记表/记忆/工具/上下文都在它里面）。 */
  const C = await createCoreContext();
  /* 历史对账：客户端交上来的那份可能是**落后一轮**的（一轮结束后 1.5 秒内切走了会话、
     或那次重拉失败——会话对象还停在运行前的快照）。以它为准就会把服务端刚跑完的那一轮
     整份覆盖掉（2026-10-01 审计实测的数据丢失）。规则见 core/sessions.js（两端同一份）。 */
  const serverMsgs = sess.msgs || [];
  const base = Array.isArray(req.history)
    ? C.Sessions.reconcileHistory(serverMsgs, req.history, { localEdits: !!req.localEdits })
    : serverMsgs;
  const history = C.Sessions.trimTrailingQuestion(base, req.text);

  const run = reg.create({
    account, actor: req.actor, sessionId,
    providerId, title: sess.title,
    history,
    session: sess, live: null, core: C,
  });
  // 立刻放一条占位的助手消息（界面一订阅就能看到"正在生成"，与浏览器侧同一形态）
  run.live = { id: C.Sessions.newMsgId(), role: 'assistant', content: '', thinking: '', stats: null, trace: [], wallMs: 0, streaming: true };
  run.history.push({ id: C.Sessions.newMsgId(), role: 'user', content: String(req.text || '') }, run.live);
  /* **等这次写盘完成再返回**：会话（含本轮提问）先落盘，之后哪怕进程立刻挂掉，
     用户也还找得回"我问过什么"——这是"关掉浏览器不丢内容"的最小保证。 */
  await loop.persist(run, true);
  /* **向统一事件口宣告这一段开始了**（带服务端的 liveId）：hub 是一条长连接，
     订阅者不会为"后来才开的运行"重新握手，所以不给这条事件，客户端就不知道
     服务端那条助手消息的 id——它只能每个事件现造一条消息（界面上冒出好几条空气泡，实测）。
     自己那段运行的订阅者收到它也无害（与 replay_start 同一形状，见 ui/state/run.js）。 */
  events.emit(run, { type: 'run_started', liveId: run.live.id });
  loop.execute(run, req).catch(() => { /* execute 内部已收尾 */ });
  return { runId: run.id };
}

/** 挂一个 SSE 订阅者（**只允许 run 的主人**：跨账号读别人的事件流是信息泄露）。 */
function attach(runId, res, account) {
  const run = reg.get(runId, account);
  if (!run || !account) return false;
  return events.attach(run, res);
}

/** 挂账号事件口（统一口：一条流收这个账号全部运行的事件，按 account 过滤）。 */
function attachHub(res, account) {
  if (!account) return false;
  return events.hubAttach(account, res, reg.objectsOf(account));
}

/** 回答一个确认（**只允许 run 的主人**：否则任何人拿到 confirmId 就能替别人批准危险命令）。 */
function answerConfirm(runId, id, ok, remember, grant, account) {
  const run = reg.get(runId, account);
  if (!run || !account) return false;
  return confirm.answerConfirm(run, id, ok, remember, grant);
}

/** 某个子智能体的转录（给界面展开看"它到底做了什么"）；按 account 过滤。 */
function subAgentOf(account, runId, subId) {
  const run = reg.get(runId, account);
  if (!run) return null;
  const t = run.subs && run.subs.get(String(subId || ''));
  if (!t) return null;
  return {
    subId: t.subId, label: t.label, task: t.task, model: t.model,
    rounds: t.rounds, ms: t.ms || 0, answer: t.answer || '', error: t.error || '',
    stopped: !!t.stopped,
    steps: (t.steps || []).map((x) => ({
      name: x.name, label: x.label, ok: x.ok !== false, note: x.note || '',
      ms: x.ms || 0, args: x.args, result: String(x.result || '').slice(0, 4000),
    })),
  };
}

/** 这一轮还在跑吗（供 run-http 的 /state 用；只回本账号那几段） */
const stateOf = (account, sessionId) => reg.stateOf(account, sessionId);
const busyOf = (account) => reg.busyOf(account);
const listOf = (account) => reg.listOf(account);
const stopRun = (account, id) => reg.stopRun(account, id);
const steer = (account, id, text) => reg.steer(account, id, text);
/** 内部用（测试/诊断）：全局在跑的那几段，**不带账号过滤**；没有在跑的就是 null。
 *  返回 null（而不是空数组）是有意的：调用方到处在写 `if (R.busy())`，
 *  空数组是**真值**，会让"还有人在跑吗"这种判断永远为真。 */
const busy = () => (reg.listOf(undefined).length ? reg.listOf(undefined) : null);

module.exports = {
  startRun, attach, attachHub, answerConfirm, subAgentOf,
  stopRun, steer, stateOf, busyOf, listOf, busy,
  CONFIRM_WAIT_MS,
  _runs: reg.runs,
};
