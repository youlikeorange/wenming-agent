/** lib/agent/run-registry.js —— 托管运行的**登记表**：谁在跑、谁在等、谁看得到什么
 *
 *  一个 run 对象就是一轮运行的**全部状态**（事件日志、订阅者、确认、插话、历史、会话对象、
 *  它自己那份 core 实例）。本模块只管"登记与生命周期"，不碰模型、不碰存储——那些在 run-loop.js。
 *
 *  **可以同时跑多段**（2026-10-01 起）：每段运行持有自己的 core 实例
 *  （Prompts/Memory/AgentDefs/AgentContext/ToolRunner 都是 createX() 造出来的，
 *  见 lib/agent/run-core.js），所以"多开几个会话一起问"不会串数据。
 *  并发有三道闸：
 *    · **一条会话同时只有一段运行**（同一会话的两段运行会互相覆盖历史）；
 *    · 每个账号最多 MAX_PER_ACCOUNT 段（默认 3，AGENT_RUNS_PER_ACCOUNT 可改）；
 *    · 全进程最多 MAX_TOTAL 段（默认 8，AGENT_RUNS_TOTAL 可改）。
 *  端点上永远**只看得见自己账号的运行**（busyOf/stateOf/get/listOf 都按 account 过滤）：
 *  runId 一旦泄露，别人就能订阅它的事件流、甚至替对方点"同意执行"
 *  （2026-10-01 审计的 P0）。
 */
const { emit, view } = require('./run-events');

const KEEP_DONE_MS = 10 * 60 * 1000;      // 跑完后保留一段，供"回来接上"
const MAX_PER_ACCOUNT = Math.max(1, Number(process.env.AGENT_RUNS_PER_ACCOUNT) || 3);
const MAX_TOTAL = Math.max(1, Number(process.env.AGENT_RUNS_TOTAL) || 8);

const runs = new Map();                    // id → run（含已结束的）

const newId = () => 'r-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/** 登记一次新运行；调用方负责把 live/历史/会话/core 补齐（见 run.js 的 startRun）。
 *
 *  **run 对象的字段归属**（宽状态体，五个模块共写——加字段前先看这张表，别抢别人的）：
 *    本模块造骨架：id/status/error/startedAt/lastSave/events/clients/confirms/steering/
 *                  subs/subSeq/settled/abort/toolCount
 *    run.js       补：account/actor/sessionId/providerId/title/history/session/live/core
 *    run-loop.js  写：lastSave/saveError/traceChars/status/finished/endedAt/wallMs/
 *                  lastShape/errorKind/parentMessages（finish 落盘与日志）
 *    run-subagent.js 写：subs（转录）/ subSeq（编号）
 *    run-bridge.js   写：toolCount（经 countTool()）
 */
function create(fields) {
  const run = Object.assign({
    id: newId(), status: 'running', error: '',
    startedAt: Date.now(), lastSave: 0, saveError: '',
    events: [], eventChars: 0, trimmed: false, clients: new Set(),
    confirms: new Map(), confirmSeq: 0, toolCount: 0,
    steering: [],                          // 生成中的插话（下一轮开始前注入，Pi 的 Steering）
    live: null,
    core: null,                            // 本段运行自己的 core 实例（run-core.createCoreContext）
    subs: new Map(),                       // 子智能体的转录（subId → { label, task, tools, answer, … }）
    subSeq: 0,                             // 子智能体编号（sub-1、sub-2…，界面与事件用它寻址）
    settled: false,                        // 收尾（含落盘）是否已经完成——见 listOf 的说明
    abort: new AbortController(),
    countTool() { this.toolCount++; },
  }, fields);
  runs.set(run.id, run);
  return run;
}

/** 取一个运行。传了 account 就必须是它主人的（**端点一律要传**，防跨账号） */
function get(id, account) {
  const run = runs.get(String(id || ''));
  if (!run) return null;
  if (account !== undefined && run.account !== account) return null;
  return run;
}

/** 内部用：本账号还在"占着"的 **run 对象**（含 abort / 事件日志 / 转录）。
 *  hub 回放、登出掐断这类要动真对象的地方用它；**对外一律用 listOf（视图，不含账号与事件流）**。 */
function objectsOf(account) {
  const out = [];
  for (const run of runs.values()) {
    if (account !== undefined && run.account !== account) continue;
    if (!run.settled) out.push(run);
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

/** 本账号还在"占着"的运行清单（对外的视图，最近的在前）——统一事件口与 /state 都用它。
 *  **判据是 settled 而不是 status**：status 在收尾一开始就改成 done/error/stopped，
 *  而这时落盘（persist）还没写完——按 status 判会让"等它跑完再读会话"的调用方
 *  读到半截快照（客户端刷新接上、/state、测试的 settle 都吃这个亏）。
 *  settled 由 run-loop 的 finish() 在**落盘之后**置位。 */
const listOf = (account) => objectsOf(account).map(view);

// view 从 run-events import（唯一一份，见那边注释）；本模块原先的副本与零消费的 busy 已删。

/** 这个账号有没有在跑的运行（`/agent/run/state` 用它——只回本账号那几段，不泄露别人的 runId） */
const busyOf = (account) => listOf(account);

/** 这条会话有没有在跑的运行（同一会话不许两段：它们会互相覆盖历史） */
function stateOf(account, sessionId) {
  for (const run of runs.values()) {
    if (run.account === account && run.sessionId === sessionId && !run.settled) {
      return view(run);
    }
  }
  return null;
}

/** 还能不能开新的一段（三道闸：会话级由 stateOf 管，这里是账号级与全进程级） */
function capacity(account) {
  const total = listOf(undefined).length;
  const mine = listOf(account).length;
  if (mine >= MAX_PER_ACCOUNT) {
    return { ok: false, status: 429, error: `同时最多跑 ${MAX_PER_ACCOUNT} 段对话（这个账号已经有 ${mine} 段在生成）：等一段结束，或先点「停止」。` };
  }
  if (total >= MAX_TOTAL) {
    return { ok: false, status: 429, error: `服务端同时在跑的对话已达上限（${MAX_TOTAL} 段），稍后再试。` };
  }
  return { ok: true };
}

function stopRun(account, id) {
  const run = get(id, account);
  if (!run) return false;
  try { run.abort.abort(); } catch { /* 已结束 */ }
  return true;
}

/** 收尾后的登记处理：保留一段供"回来接上"，到点删除（内存有上限） */
function release(run) {
  setTimeout(() => {
    if (runs.get(run.id) === run && run.status !== 'running') runs.delete(run.id);
  }, KEEP_DONE_MS).unref?.();
}

/* ============================ 插话（Steering） ============================ */

/** 生成中用户输入的话排进队列，内核下一轮开始前注入。
 *  界面先看到一条追踪条——"已受理"要立刻可见，不能等下一轮才知道话有没有送到。 */
function steer(account, id, text) {
  const run = get(id, account);
  const t = String(text || '').trim();
  if (!run || run.status !== 'running' || !t) return false;
  run.steering.push(t);
  markSteer(run, t, '待注入');
  // pending 一起发出去：输入框旁边那句"已排队 N 条"要跟**服务端**的队列一致
  emit(run, { type: 'steer_accepted', text: t, pending: run.steering.length });
  return true;
}

/** 插话在追踪条上的那条（"待注入" → "下一轮生效" → "最终回答后生效"）。
 *  原地更新靠**结构化字段**（steerText/steerState）寻址，不靠 label 字符串反查——
 *  旧实现拿 `已插话（待注入）：…` 这个渲染串当查找键，措辞一改就静默失效（2026-10-06 审计）。
 *  label 只是给人看的；前端的乐观条目（ui/state/run.js）带同样的结构化字段。 */
function markSteer(run, text, when) {
  const live = run.live;
  if (!live) return;
  if (!Array.isArray(live.trace)) live.trace = [];
  const brief = String(text).slice(0, 60);
  const label = `已插话（${when}）：${brief}`;
  const at = live.trace.find((x) => x && x.kind === 'steer' && x.steerText === brief && x.steerState === '待注入');
  if (at) { at.label = label; at.steerState = when; return; }
  live.trace.push({ kind: 'steer', state: 'done', label, ok: true, note: '插话', steerText: brief, steerState: when });
}

/** 内核取走插话后同步一次待注入条数（界面上的"已排队 N 条"据此归零） */
function steerPending(run) { emit(run, { type: 'steer_pending', pending: run.steering.length }); }

/** KEEP_DONE_MS / MAX_PER_ACCOUNT / MAX_TOTAL 只在本文件用（capacity/release），
 *  view 从 run-events import——原先导出一批零消费符号（2026-10-06 审计收缩）。 */
module.exports = {
  runs,
  create, get, listOf, objectsOf, busyOf, stateOf, capacity, stopRun, release,
  steer, markSteer, steerPending,
};
