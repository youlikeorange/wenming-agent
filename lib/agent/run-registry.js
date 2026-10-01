/** lib/agent/run-registry.js —— 托管运行的**登记表**：谁在跑、谁在等、谁看得到什么
 *
 *  一个 run 对象就是一轮运行的**全部状态**（事件日志、订阅者、确认、插话、历史、会话对象）。
 *  本模块只管"登记与生命周期"，不碰模型、不碰存储——那些在 run-loop.js。
 *
 *  **同一时刻只允许一个运行**（全局队列）：core 的登记表（Prompts/Memory/AgentDefs）是模块级
 *  单例，两份运行并发会互相看到对方的账号数据（跨账号串数据）。所以 `active` 是全局的，
 *  而**端点上只能看到自己账号的那一段**（`busyOf/stateOf/get` 都按 account 过滤）——
 *  这两件事原先混在一起：busy() 无条件回全局那段的 runId/标题，任何登录用户都能拿到别人的
 *  runId 去订阅它的事件流、甚至替对方点"同意执行"（2026-10-01 审计的 P0）。
 */
const { emit } = require('./run-events');

const KEEP_DONE_MS = 10 * 60 * 1000;      // 跑完后保留一段，供"回来接上"
const runs = new Map();                    // id → run（含已结束的）
let active = null;                         // 当前在跑的那个（全局唯一）

const newId = () => 'r-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/** 登记一次新运行；调用方负责把 live/历史/会话补齐（见 run.js 的 startRun） */
function create(fields) {
  const run = Object.assign({
    id: newId(), status: 'running', error: '',
    startedAt: Date.now(), lastSave: 0, saveError: '',
    events: [], eventChars: 0, trimmed: false, clients: new Set(),
    confirms: new Map(), confirmSeq: 0, toolCount: 0,
    steering: [],                          // 生成中的插话（下一轮开始前注入，Pi 的 Steering）
    live: null,
    abort: new AbortController(),
    countTool() { this.toolCount++; },
  }, fields);
  runs.set(run.id, run);
  active = run;
  return run;
}

/** 取一个运行。传了 account 就必须是它主人的（**端点一律要传**，防跨账号） */
function get(id, account) {
  const run = runs.get(String(id || ''));
  if (!run) return null;
  if (account !== undefined && run.account !== account) return null;
  return run;
}

const activeOf = () => active;

/** 全局忙不忙（**内部用**：起跑前的排他检查、循环自检）。对外一律用 busyOf */
const busy = () => (active
  ? { runId: active.id, sessionId: active.sessionId, title: active.title, startedAt: active.startedAt }
  : null);

/** 这个账号有没有在跑的运行（/agent/run/state 用它——只回本账号那一段，不泄露别人的 runId） */
const busyOf = (account) => (active && active.account === account
  ? { runId: active.id, sessionId: active.sessionId, title: active.title, startedAt: active.startedAt }
  : null);

function stateOf(account, sessionId) {
  for (const run of runs.values()) {
    if (run.account === account && run.sessionId === sessionId && run.status === 'running') {
      return { runId: run.id, status: run.status, startedAt: run.startedAt, title: run.title };
    }
  }
  return null;
}

function stopRun(account, id) {
  const run = get(id, account);
  if (!run) return false;
  try { run.abort.abort(); } catch { /* 已结束 */ }
  return true;
}

/** 收尾后的登记处理：让出全局占用 + 保留一段供"回来接上"，到点删除（内存有上限） */
function release(run) {
  if (active === run) active = null;
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

/** 插话在追踪条上的那条（"待注入" → "下一轮生效" → "最终回答后生效"） */
function markSteer(run, text, when) {
  const live = run.live;
  if (!live) return;
  if (!Array.isArray(live.trace)) live.trace = [];
  const brief = String(text).slice(0, 60);
  const label = `已插话（${when}）：${brief}`;
  const at = live.trace.find((x) => x.kind === 'steer' && x.label === `已插话（待注入）：${brief}`);
  if (at) { at.label = label; return; }
  live.trace.push({ kind: 'steer', state: 'done', label, ok: true, note: '插话' });
}

/** 内核取走插话后同步一次待注入条数（界面上的"已排队 N 条"据此归零） */
function steerPending(run) { emit(run, { type: 'steer_pending', pending: run.steering.length }); }

module.exports = {
  runs, KEEP_DONE_MS, create, get, activeOf, busy, busyOf, stateOf, stopRun, release,
  steer, markSteer, steerPending,
};
