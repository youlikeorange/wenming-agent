/* ui/state/run.js —— 托管运行的**客户端一半**：开跑、看直播、插话、停止、回来接上
 *
 *  循环本身在服务端（lib/agent/run.js），这里只做四件事：
 *    ① 把这一轮的用户输入与当前历史交给服务端（POST /agent/run/start）；
 *    ② 订阅**统一事件口**（GET /agent/run/hub，一条 SSE 收本账号全部会话的运行事件），
 *       把每条事件写进**它那条会话**的助手消息里（事件自带 runId/sessionId/liveId）；
 *    ③ 把人做的决定送回去（插话 / 停止 / 确认框的同意与否），一律按 runId 打到服务端；
 *    ④ 刷新/断线后把画面补回来（hub 快照 + 回放，落盘那份兜底）。
 *
 *  **多会话并行**（2026-10-01 起）：
 *    · 服务端可以同时跑好几条会话的运行，客户端用 `runs`（sessionId → 记录）跟每一条；
 *    · 一条 SSE 连接看全部——不再"换个会话就断开重连"，所以**生成中切到别的会话完全不受影响**；
 *    · state.streaming 的含义收窄成"**当前这条**会话正在生成"（Composer/停止按钮据此显示），
 *      别的会话在跑不会挡住你新建/切换/清空（那几条的判断见 session.js）。
 *
 *  为什么值得这么绕：浏览器只是"观众"。关掉页面、断网、换窗口，服务端照样把这一轮跑完并落盘——
 *  人回来时用 GET /agent/run/state 找到还在跑的那几条，接上继续看。
 */
import { state, patch, touch } from './store.js';
import { applyTodo } from './todo.js';
import { post, request } from '../../core/http.js';
import { EP } from '../../core/endpoints.js';
import { sseLines } from '../../core/protocol/sse.js';
import { newMsgId } from '../../core/sessions.js';
import { toast } from '../components/ui/toast.jsx';

/* 生成中的重绘节流（80ms 一帧）。原先这份在 session.js（那时循环在浏览器里跑），
   循环搬去服务端后它跟着事件流搬到本文件——session.js 里的同名注释已成为历史。 */
const EMIT_MS = 80;
let lastEmit = 0;
let emitTimer = null;
function touchSoon() {
  const t = (globalThis.performance || Date).now();
  const wait = EMIT_MS - (t - lastEmit);
  if (wait <= 0) { lastEmit = t; touch(); return; }
  if (emitTimer) return;
  emitTimer = setTimeout(() => { emitTimer = null; lastEmit = (globalThis.performance || Date).now(); touch(); }, wait);
}

/* ============================ 每段运行在本地的记录 ============================ */
/* sessionId → { sessionId, runId, liveId, localId, settled, status, title, startedAt, steering, error }
   localId = 本窗口自己插的那条占位消息 id（服务端会另给一个 liveId，收到后把两条认成同一条）；
   liveId  = **服务端那条**助手消息 id：事件按它寻址，于是"别人开的运行/刷新后接上"也能对上。 */
const runs = new Map();

/** 失败/停止时补在正文尾巴上的说明（与 lib/agent/run-loop.js 的 finish 同一句话；
 *  那句是服务端在流结束**之后**写上的，这里只在"服务端没给最终正文"的兜底路上用） */
const FAIL_PREFIX = '请求失败：';
const STOP_MARKER = '*[已停止生成]*';

/** 这条会话现在有在跑的运行吗（侧栏小标、归档/清空等操作的前置判断用它） */
export const isRunning = (sessionId) => !!runs.get(sessionId) && !runs.get(sessionId).settled;
/** 当前会话在跑的那一段（没有就是 ''） */
export const activeRunId = () => {
  const r = runs.get(state.activeSessId);
  return r && !r.settled ? r.runId : '';
};
/* runOf / runningSessionIds 两个导出已删（2026-10-06 审计：全仓零调用，注释声称的
   "侧栏与当前项目跟随"实际走的是 state.runs 快照）。 */
/** 把本地记录映射进 state（UI 只读 state.runs），并同步"当前会话是否在生成" */
function publish() {
  const obj = {};
  for (const [sid, r] of runs) {
    obj[sid] = {
      runId: r.runId, liveId: r.liveId, status: r.status || 'running', title: r.title || '',
      startedAt: r.startedAt || 0, steering: r.steering || 0, error: r.error || '',
      settled: !!r.settled,
    };
  }
  patch({ runs: obj });
  syncActive();
}

/** 当前会话的生成态（Composer 的"停止/插话"、guard 判断都读 state.streaming 这一个口径） */
export function syncActive() {
  const rec = runs.get(state.activeSessId);
  const live = !!rec && !rec.settled;
  patch({ streaming: live, steering: live ? (rec.steering || 0) : 0 });
  /* （abortSignal 字段已删：停止走服务端 POST /agent/run/stop，客户端没有可中断的本地信号） */
}

/* ============================ 消息寻址 ============================ */
/* 一切事件都落到"它那条会话"的助手消息上。消息在 `state.sessions[i].msgs` 里（state.history
   只是当前会话那份的浅拷贝，两边共享同一条对象），所以**后台会话的流式内容照样进得去**。 */

const sessionById = (id) => state.sessions.find((s) => s.id === id) || null;

function ensureMsgs(sess) {
  if (!Array.isArray(sess.msgs)) sess.msgs = [];
  return sess.msgs;
}

/** 事件要写的那条助手消息：先按服务端 liveId 找，找不到就用本窗口的占位认领这个名字，
 *  再找不到（别人开的 / 刷新后首次收到）就现造一条——**服务端确实是先落盘再跑**，
 *  正常情况下它已经在那条会话里了。 */
/** 这条会话里最后那条"正在生成"的助手消息（一条会话同时只有一段运行，所以它不可能是别人的） */
function lastStreaming(msgs) {
  const last = msgs[msgs.length - 1];
  return (last && last.role === 'assistant' && last.streaming) ? last : null;
}

/** 本窗口刚发的那条占位：把它的 id 认成服务端的 liveId（否则会出现两条助手气泡）。
 *  找不到时再看一眼 state.history（当前会话正在画的那份）——两处是同一批对象，
 *  但历史同步可能慢一拍；认领到就把它并进会话对象，保证两处共用同一条消息。 */
function claimLocal(msgs, rec, liveId, sessionId) {
  if (!rec || !rec.localId) return null;
  const local = msgs.find((m) => m && m.id === rec.localId)
    || (sessionId === state.activeSessId ? state.history.find((m) => m && m.id === rec.localId) : null);
  if (!local) return null;
  /* 还不知道服务端的 liveId（run_started/replay_start 还没到）时**先留着本地 id**：
     它照样是这一段的唯一落点，等 id 来了再认领（否则每个事件都会现造一条新消息）。 */
  if (liveId) { local.id = liveId; rec.localId = ''; }
  if (!msgs.includes(local)) msgs.push(local);
  return local;
}

function msgFor(sessionId, liveId, rec) {
  const sess = sessionById(sessionId);
  if (!sess) return null;
  const msgs = ensureMsgs(sess);
  const hit = liveId ? msgs.find((m) => m && m.id === liveId) : null;
  if (hit) return hit;
  const claimed = claimLocal(msgs, rec, liveId, sessionId);
  if (claimed) return claimed;
  /* 还不知道服务端的 liveId 时（run_started/replay_start 没到、快照也还没带上它），
     就认"这条会话里最后那条正在生成的助手消息"——**一条会话同时只有一段运行**
     （服务端也这么保证），所以它不可能是别人的。等 id 到了再改名（见下）。
     没有这一步就会"每个事件现造一条新消息"：界面上冒出一串空气泡，而真正的正文
     在另一条上、`end` 到来时也结不掉（2026-10-01 实测：服务端已跑完，界面还在转圈）。 */
  const fallback = liveId ? null : lastStreaming(msgs);
  if (fallback) return fallback;
  const msg = { id: liveId || newMsgId(), role: 'assistant', content: '', thinking: '', stats: null, trace: [], wallMs: 0, streaming: true };
  msgs.push(msg);
  if (state.activeSessId === sessionId && !state.history.includes(msg)) state.history.push(msg);
  return msg;
}

function traceArr(msg) {
  if (!Array.isArray(msg.trace)) msg.trace = [];
  return msg.trace;
}

/** 追踪条的槽位：优先用内核给的 token（下标，顺序与服务端一致），
 *  对不上时按 callId 找（并行工具调用下下标可能错位），再不行就补一个新槽位。 */
/** 内核给的 token 就是槽位；空槽或 callId 对不上时返回 null，交给下面按 callId 找 */
function indexSlot(arr, ev) {
  const i = ev.token;
  if (!Number.isInteger(i) || i < 0 || i >= 1000) return null;
  const at = arr[i];
  if (!at) return null;
  return (!ev.callId || !at.callId || at.callId === ev.callId) ? at : null;
}

function slotFor(arr, ev, create) {
  const at = indexSlot(arr, ev);
  if (at) return at;
  const hit = ev.callId ? arr.find((x) => x && x.callId === ev.callId) : null;
  if (hit) return hit;
  if (!create) return null;
  const fresh = create();
  arr.push(fresh);
  return fresh;
}

/* ============================ 事件 → 界面状态 ============================ */

/** 工具结束事件 → 追踪条条目（与落盘那份同形；服务端没给的字段就不写）。
 *  单独一个函数：tool_end 里塞着六七条"缺省保持"的字段，全挤在分派表里会把那条分支撑成
 *  "改一处要读二十行"的样子（这几个字段各自都有过踩坑记录，见下面的注释）。 */
function fillToolEnd(at, ev) {
  Object.assign(at, {
    kind: at.kind === 'sub' ? 'sub' : 'tool', state: 'done', label: ev.label || at.label, name: ev.name || at.name,
    ok: ev.ok !== false, note: ev.note || '', args: ev.args, result: ev.result, ms: ev.ms, callId: ev.callId || at.callId,
    /* 真实字数（记录上限截断前的长度）：追踪条显示"模型收到多少 / 只显示前 N 字" */
    resultChars: ev.resultChars,
    /* 写入/删除的行数（写/改/删文件才有；服务端只在两个数非零时才给）：追踪条显示 +N / −M */
    ...(ev.lines ? { lines: ev.lines } : {}),
    /* 改动的定位信息：点那条 +N/−M 卡片打开「比对修改」抽屉（见 state/fileDiff.js）。
       服务端没给（旧记录 / 没有改动）就不写，卡片也就不可点。 */
    ...(ev.undoRef ? { undoRef: ev.undoRef } : {}),
    /* 可下载文件清单（deliver_file）：追踪条上的文件卡片（原先漏了这一步——
       卡片要等重拉会话才出现，直播时看不到） */
    ...(Array.isArray(ev.files) && ev.files.length ? { files: ev.files } : {}),
    /* 任务清单（todo_write）：与服务端落盘那份同形（null = 已丢弃，字段缺席 = 与清单无关） */
    ...(ev.todo !== undefined ? { todo: ev.todo } : {}),
  });
}

/* 形状与 core/agent.js 的 hooks 一致 + 托管运行专属的几条（sub_* 是子智能体）。
   按类型查表分派（不是一条长 if 链）：事件种类会随功能增加。 */
const HANDLERS = {
  /* 一段运行开始回放：把这条消息清空重建（除非服务端说事件已截断——那时以落盘那份为准）。
     `error` 也一起清：那条"没有跑完"可能是上一次误判留下的。 */
  replay_start: (ev, msg) => {
    if (!ev.truncated) { msg.content = ''; msg.thinking = ''; msg.trace = []; delete msg.error; }
    if (!msg.streaming) msg.streaming = true;
  },
  /* 服务端宣告"这一段开始了"（带 liveId）：hub 是长连接，后开的运行不会重新握手，
     没有这条就不知道服务端那条助手消息的 id（每个事件都会现造一条新消息，实测冒出一堆空气泡）。 */
  run_started: (ev, msg) => {
    if (!msg.streaming) msg.streaming = true;
    if (!msg.id && ev.liveId) msg.id = ev.liveId;
  },
  content: (ev, msg) => { msg.content = (msg.content || '') + ev.text; touchSoon(); },
  thinking: (ev, msg) => { msg.thinking = (msg.thinking || '') + ev.text; touchSoon(); },
  stats: (ev, msg) => { msg.stats = ev.raw; touchSoon(); },
  /* 调用保护的中断重调（单次超时/思考循环）：把本次尝试已流出的半截清掉——
     服务端从零重新生成，不清的话界面上新旧两份叠加成重复文本（与 run.live 同口径）。 */
  live_reset: (ev, msg) => { msg.content = ''; msg.thinking = ''; touchSoon(); },
  notice: (ev, msg) => {
    traceArr(msg).push({ kind: 'notice', state: 'done', label: ev.text, ok: true, note: '提示' });
    touchSoon();
  },
  /* 运行级错误（上游 401/429/断网…）：**在会话里看得见**——挂到消息上，界面画一条红色错误块，
     一个字都没生成时尤其重要（旧实现只有 end 事件里一句文本，容易漏看）。 */
  error: (ev, msg) => {
    if (ev.fatal) { msg.error = FAIL_PREFIX + (ev.text || '未知错误'); }
    else traceArr(msg).push({ kind: 'notice', state: 'done', label: ev.text, ok: false, note: '错误' });
    touchSoon();
  },
  tool_start: (ev, msg) => {
    const at = slotFor(traceArr(msg), ev, () => ({ kind: 'tool', state: 'running', label: ev.label, name: ev.name, ok: true, note: '', callId: ev.callId || '' }));
    if (at) Object.assign(at, { state: 'running', label: ev.label || at.label, name: ev.name || at.name, callId: ev.callId || at.callId });
    touchSoon();
  },
  tool_end: (ev, msg) => {
    /* 任务清单（todo_write 的结果，见 state/todo.js）：右上角浮层据此实时更新。
       null = 已丢弃；字段缺席 = 这次调用与清单无关（两者不能混）。 */
    if (ev.todo !== undefined) { try { applyTodo(ev.todo, ev.sessionId); } catch { /* 不影响主流程 */ } }
    const arr = traceArr(msg);
    const at = slotFor(arr, ev, () => ({ kind: 'tool', label: ev.label, name: ev.name, ok: true, note: '', callId: ev.callId || '' }));
    if (at) fillToolEnd(at, ev);
    touchSoon();
  },
  /* ---- 子智能体：过程实时显示在那张"子智能体"卡片上（结论仍由 tool_end 交给模型） ---- */
  sub_start: (ev, msg) => {
    const at = slotFor(traceArr(msg), ev, () => ({ kind: 'sub', state: 'running', ok: true, callId: ev.callId || '' }));
    if (at) Object.assign(at, {
      kind: 'sub', state: 'running', name: 'spawn_agent',
      label: `子智能体：${ev.label || ev.task || '(子任务)'}`, task: ev.task, subId: ev.subId, callId: ev.callId || at.callId,
      runId: ev.runId || '',            // 「查看记录」要按 runId+subId 去取完整转录
      model: ev.model, rounds: ev.rounds, tools: ev.tools, note: '启动', result: '',
    });
    touchSoon();
  },
  sub_delta: (ev, msg) => {
    const at = slotFor(traceArr(msg), ev, null);
    if (at) { at.result = String(at.result || '') + ev.text; at.state = 'running'; }
    touchSoon();
  },
  sub_tool: (ev, msg) => {
    const at = slotFor(traceArr(msg), ev, null);
    if (!at) return;
    at.result = String(at.result || '') + (at.result ? '\n' : '') + (ev.state === 'running' ? '· ' + ev.label : `· ${ev.label} ✓`);
    touchSoon();
  },
  sub_note: (ev, msg) => {
    const at = slotFor(traceArr(msg), ev, null);
    if (at) at.result = String(at.result || '') + (at.result ? '\n' : '') + `（子智能体）${ev.text}`;
    touchSoon();
  },
  sub_end: (ev, msg) => {
    const at = slotFor(traceArr(msg), ev, null);
    if (at) Object.assign(at, {
      state: 'done', ok: ev.ok !== false, ms: ev.ms,
      note: ev.ok === false ? ('失败' + (ev.error ? '：' + ev.error : '')) : `完成 · ${ev.rounds || 0} 轮 · ${ev.tools || 0} 次工具`,
      result: ev.text || at.result || '',
    });
    touchSoon();
  },
  steer_accepted: (ev, msg) => {
    const brief = String(ev.text).slice(0, 60);
    /* steerText/steerState 与服务端 markSteer 同一套结构化字段（label 只是给人看的）：
       服务端"原地更新"按字段寻址，不再拿渲染串反查（2026-10-06 审计）。 */
    traceArr(msg).push({ kind: 'steer', state: 'done', label: `已插话（待注入）：${brief}`, ok: true, note: '插话', steerText: brief, steerState: '待注入' });
    syncSteering(ev.sessionId, ev.pending);
    touchSoon();
  },
  steer_pending: (ev) => { syncSteering(ev.sessionId, ev.pending); },
  steer_leftover: (ev) => {
    /* 这一轮结束时还没注入的插话：回填输入框，绝不静默丢弃（只在**当前会话**回填——
       后台会话的插话不能跑到你现在正在写的输入框里）。 */
    const rec = runs.get(ev.sessionId);
    if (rec) rec.steering = 0;
    if (ev.sessionId === state.activeSessId) {
      patch({ steering: 0 });
      if (Array.isArray(ev.texts) && ev.texts.length) {
        patch({ draft: ev.texts.join('\n\n') + (state.draft ? '\n\n' + state.draft : '') });
        toast(`有 ${ev.texts.length} 条插话没有注入（这一轮已结束），已放回输入框`, 'info');
      }
    } else if (Array.isArray(ev.texts) && ev.texts.length) {
      toast(`会话「${sessionTitle(ev.sessionId)}」有 ${ev.texts.length} 条插话没注入（这一轮已结束）`, 'info');
    }
  },
  confirm: (ev) => askThenAnswer(ev),
  /* 服务端说"账号数据变了"（模型写了记忆/提示词/技能）：界面上的面板正显示着旧副本。
     这里不直接改，只通知宿主从服务端重拉面板数据（生成中会跳过，结束后还会再拉一次）。 */
  data_changed: () => hostHook('onRunDataChanged'),
  /* 待下载目录变了（模型刚 deliver_file）：菜单上的计数与列表跟上（见 ui/state/downloads.js） */
  files_changed: () => hostHook('onFilesChanged'),
  end: (ev) => settle(ev),
};

/** 待注入条数**以服务端的队列为准**（服务端按 run 记数，客户端不自己数）——
 *  steer_accepted / steer_pending 两个事件共用这同两行（原先逐字抄了两份） */
function syncSteering(sessionId, pending) {
  const rec = runs.get(sessionId);
  if (rec) { rec.steering = Number(pending) || 0; if (sessionId === state.activeSessId) patch({ steering: rec.steering }); }
}

const sessionTitle = (id) => {
  const s = sessionById(id);
  return (s && s.title) || '另一条对话';
};

/** 三份"合并式登记"（adoptRun / mergeRun / registerRun）共用的取记录外壳。
 *  字段保留规则三者**有意不同**（事件登记/快照合并/本窗口开跑），不强行并成一个 upsert。 */
const getOrCreate = (sessionId) => runs.get(sessionId) || { sessionId, steering: 0 };

/** 把一段运行登记进本地表（别处开的、刷新接上的、本窗口刚发的都走这里）。
 *  已有记录就只更新——**别丢掉 localId**，它要用来认领服务端那条占位消息。
 *  startedAt（服务端造运行的时间戳）给流式中的收尾条起算"本轮用时"；
 *  没有（旧协议/回放）就落到首次登记的这一刻——晚几百毫秒可接受。 */
function adoptRun(ev) {
  const rec = getOrCreate(ev.sessionId);
  rec.runId = ev.runId || rec.runId;
  if (ev.liveId) rec.liveId = ev.liveId;
  rec.startedAt = ev.startedAt || rec.startedAt || Date.now();
  rec.settled = false;
  runs.set(ev.sessionId, rec);
  publish();
  return rec;
}

/** 这两类事件带 runId/liveId，收到就把这一段登记进本地表（其余事件只是往它上面写） */
const ADOPTABLE = new Set(['replay_start', 'run_started']);

function applyEvent(ev) {
  const fn = HANDLERS[ev && ev.type];
  if (!fn || !ev.sessionId) return;                 // hub_snapshot / 无归属事件由调用方处理
  const rec = (ev.runId && ADOPTABLE.has(ev.type)) ? adoptRun(ev) : runs.get(ev.sessionId);
  const msg = msgFor(ev.sessionId, (rec && rec.liveId) || ev.liveId || '', rec);
  if (!msg) return;
  fn(ev, msg);
}

/* ============================ 宿主端口（避免与 session.js 成环） ============================ */
let hostMod = null;
function host() {
  if (!hostMod) hostMod = import('./host.js').catch(() => null);
  return hostMod;
}
function hostHook(name, arg) {
  host().then((h) => {
    const fn = h && h.hooks && h.hooks[name];
    if (typeof fn === 'function') fn(arg);
  }).catch(() => { /* 宿主没接线：最坏是面板晚一点刷新 */ });
}

/** 服务端要人点头：用**界面上原有的那几个确认框**（文案一处都不重复），再把人话回传。
 *  事件自带 runId：确认按它打到**那一段**运行（多段并行时不能串）。 */
async function askThenAnswer(ev) {
  const { askRunConfirm } = await import('./host.js');
  let ans = { ok: false, remember: false };
  try {
    ans = await askRunConfirm(ev.kind, ev.payload || {}, { session: sessionTitle(ev.sessionId) });
  } catch { /* 关掉弹窗 = 不同意 */ }
  try {
    await post(EP.runConfirm, { id: ev.runId || '', confirmId: ev.id, ok: !!ans.ok, remember: !!ans.remember });
  } catch (e) {
    toast('确认没能送达服务端：' + (e.message || e), 'err');
  }
}

/** 失败只**追加**一行说明，绝不清空已经生成的部分（那是用户等了半天的东西） */
function noteFailure(msg, error) {
  if (msg.content) msg.content += '\n\n' + FAIL_PREFIX + error + '*';
  else msg.error = FAIL_PREFIX + error;
}

/** **以服务端那份最终正文为准**（2026-10-03）：停止/失败/被掐断时，服务端会在流结束之后
 *  往正文尾巴补一句说明（`*[已停止生成]*` / `*[请求失败：…]*`），那句从未作为增量下发过。
 *  以前客户端只认自己拼的正文，于是：界面看不到说明，而且只要客户端回写一次会话
 *  （整份替换），服务端那句也会被抹掉——用户看到的就只剩"半句话"。
 *  @returns {boolean} 采纳了服务端正文 = true（说明的补写交给它，下面的兜底不用再补） */
function adoptServerContent(msg, ev) {
  if (typeof ev.content !== 'string' || !ev.content.length) return false;
  msg.content = ev.content;
  return true;
}

/** 服务端没给正文时的兜底：停止/失败各补一句说明（与 lib/agent/run-loop.js 的文案一致） */
function ensureStopMarker(msg, ev) {
  if (ev.status === 'error' && ev.error && !(msg.content || '').includes(FAIL_PREFIX)) noteFailure(msg, ev.error);
  if (ev.status === 'stopped' && msg.content && !msg.content.includes(STOP_MARKER)) {
    msg.content += '\n\n' + STOP_MARKER;
  }
}

/** 收尾时把这条消息结清：内容一律保留，停止/失败各补一句说明 */
function finishMsg(msg, ev) {
  delete msg.streaming;
  if (Number.isFinite(ev.ms)) msg.wallMs = ev.ms;
  /* 用量（tokens / gen_ms）：服务端在 end 里一并交回，tok/s 立刻更新（不用等重拉会话） */
  if (ev.stats) msg.stats = ev.stats;
  /* 本轮的文件改动摘要（服务端落盘那份的同一个对象）：界面据此画「撤销本轮文件改动」——
     关掉浏览器回来，它还在消息上（msg.undo 已随会话落盘）。没有改动时是 null，不挂。 */
  if (ev.undo) msg.undo = ev.undo;
  if (!adoptServerContent(msg, ev)) ensureStopMarker(msg, ev);
}

/** end 事件里"只有服务端才知道"的那几样（标题/摘要/会话记忆）写回会话对象 */
function applyEndMeta(sess, ev) {
  if (ev.title) sess.title = ev.title;
  if (ev.compaction !== undefined) { if (ev.compaction) sess.compaction = ev.compaction; else delete sess.compaction; }
  if (Array.isArray(ev.memory)) sess.memory = ev.memory;
  sess.ts = Date.now();
}

/** 收尾：整段结束（正常/停止/失败都走这里）。内容一律保留。 */
function settle(ev) {
  const rec = runs.get(ev.sessionId);
  const msg = msgFor(ev.sessionId, (rec && rec.liveId) || ev.liveId || '', rec);
  if (!msg) return;
  finishMsg(msg, ev);
  const sess = sessionById(ev.sessionId);
  if (sess) applyEndMeta(sess, ev);
  if (rec) { rec.settled = true; rec.status = ev.status || 'done'; rec.error = ev.error || ''; rec.steering = 0; }
  publish();
  touch();
  /* 这一轮是**服务端**跑的，落盘也由它做完（end 之前就写完了）。这里只按需把面板数据与
     当前会话的最新状态拉回来（后台会话不拉：它的内容已经在上面写进会话对象了）。 */
  hostHook('onRunEnded', ev.sessionId);
}

/* ============================ 统一事件口（一条 SSE 看全部会话） ============================ */

let hub = null;          // { ac, ended, retry }

/** 连上统一事件口（幂等：已经在连就什么都不做）。断线自动重连，重连时服务端会回放。 */
export function ensureHub() {
  /* 只有**明确知道未登录**才不连（首屏 info 还没探回来时照连不误：
     没登录服务端会回 401，dropped 里的退避重连兜住；而据 null 直接 return 会让
     "刷新后不续播"的旧毛病以另一种形式回来）。 */
  if (state.info && state.info.loggedIn === false) return;
  if (hub && !hub.ended) return;
  const mine = { ac: new AbortController(), ended: false, retry: 0 };
  hub = mine;
  patch({ hub: { connected: false, error: '' } });
  /* 读一行推一行；`alive` 只认"我这条连接"（换连接时旧流作废）。 */
  (async () => {
    try {
      const res = await request(EP.runHub, { raw: true, signal: mine.ac.signal });
      if (hub !== mine || mine.ended) return;
      patch({ hub: { connected: true, error: '' } });
      mine.retry = 0;
      mine.connectedAt = Date.now();     // 快照的"新鲜度"基准（见 adoptSnapshot）
      await pump(res, mine);
      if (hub === mine) dropped('连接已结束（服务端重启或登录失效）');
    } catch (e) {
      if (hub === mine) dropped(e && e.message ? e.message : String(e));
    }
  })();
}

/** 读这条 SSE：逐行解析并分发（换连接/关页面时旧流作废——只认"我这条"） */
async function pump(res, mine) {
  for await (const line of sseLines(res)) {
    if (hub !== mine || mine.ended) return;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'hub_snapshot') { adoptSnapshot(ev.runs || []); continue; }
    applyEvent(ev);
  }
}

/** 快照 = "这个账号现在有哪几段在跑"：本地没有的补上，本地有而快照里没有的（掉线期间跑完了）收尾。 */
/** 服务端的一条运行摘要 → 本地记录（**不覆盖本地已有的 localId**） */
function mergeRun(r) {
  const rec = getOrCreate(r.sessionId);
  rec.runId = r.runId || rec.runId;
  rec.liveId = r.liveId || rec.liveId || '';
  rec.title = r.title || rec.title || '';
  rec.startedAt = r.startedAt || rec.startedAt || 0;
  rec.settled = false;
  runs.set(r.sessionId, rec);
  return r.sessionId;
}

/** 服务端的运行摘要清单 → 本地记录（快照与 /state 两处共用），返回这次见到过的会话 id */
function adoptRuns(list) {
  const seen = new Set();
  for (const r of list || []) { if (r && r.sessionId) seen.add(mergeRun(r)); }
  return seen;
}

/** 掉线期间这一段跑完了：本地的正文可能不完整 → 结清 + 让宿主以服务端那份为准重拉这条会话。
 *  **只结清已有的那条消息**，不新造：这一段本来就没在本窗口显示过（比如是别处开的），
 *  造一条空消息只会让界面多一个空气泡。 */
function settleVanished(sid, rec) {
  rec.settled = true; rec.status = 'done';
  const sess = sessionById(sid);
  const msgs = (sess && Array.isArray(sess.msgs)) ? sess.msgs : [];
  const msg = rec.liveId ? msgs.find((m) => m && m.id === rec.liveId) : null;
  if (msg) delete msg.streaming;
  hostHook('onSessionStale', sid);
}

function adoptSnapshot(list) {
  const seen = adoptRuns(list);
  /* 快照是**服务端在握手那一刻**生成的：比"连接建立之后才开始的运行"还旧。
     据此判"它跑完了"会误伤刚发出去的那一轮（实测：发出去的一瞬间收到空快照，
     界面立刻多出一条空气泡并把它标成已完成）。所以只结清"连上之前就存在、快照里却没有"的那些。 */
  const connAt = (hub && hub.connectedAt) || 0;
  for (const [sid, rec] of [...runs]) {
    if (rec.settled || seen.has(sid)) continue;
    if (rec.startedAt && rec.startedAt >= connAt) continue;
    settleVanished(sid, rec);
  }
  publish();
}

function dropped(reason) {
  if (!hub) return;
  hub.ended = true;
  patch({ hub: { connected: false, error: reason || '' } });
  const wait = Math.min(30000, 1500 * Math.pow(2, hub.retry++));
  setTimeout(() => { if (!state.info || state.info.loggedIn !== false) ensureHub(); }, wait).unref?.();
}

/** 换账号/登出：断开这条流（运行本体在服务端，按账号存，与本窗口无关）。 */
export function reset() {
  if (hub) { try { hub.ac.abort(); } catch { /* 已断 */ } hub = null; }
  runs.clear();
  patch({ hub: { connected: false, error: '' } });
  publish();
}

/* ============================ 对外动作 ============================ */

/**
 * 开一轮托管运行。
 * @param {{sessionId:string, text:string, providerId:string, live:object, before:Array}} p
 *        live   = 界面上那条助手占位消息（事件都落在它身上）
 *        before = **本轮之前**的历史（不含本条提问与占位）——服务端在它后面追加，
 *                 两边都追加会让同一条提问写两遍
 */
export async function startRun(p) {
  const body = {
    sessionId: p.sessionId, text: p.text, providerId: p.providerId || '',
    // 服务端接手后看到的消息必须与用户屏幕上的一致（含未落盘的改动）
    history: Array.isArray(p.before) ? p.before : state.history.slice(0, -2),
    /* 本地还有没落盘的编辑（回撤/删除/改名）→ 服务端**以这份历史为准**：
       否则"我这边刚删掉最后一轮"会被服务端的对账规则当成"我落后了"而把它变回来
       （见 core/sessions.js 的 reconcileHistory）。 */
    localEdits: !!p.localEdits,
  };
  /* **先登记再发请求**：统一口是长连接，服务端的 run_started 会**比这个 POST 的响应更早**
     到达客户端（服务端写完事件才回响应）。不先登记的话，那一条事件会被当成"别处开的运行"，
     按服务端的 liveId 另建一条消息——本窗口的占位就成了永远空着的第二个气泡（实测）。
     登记时 runId 还空着，拿到响应后再补（registerRun 是合并式的）。 */
  registerRun(p.sessionId, '', p.live);
  let r;
  try {
    r = await post(EP.runStart, body);
  } catch (e) {
    unregisterLocal(p.sessionId);
    throw e;
  }
  if (!r || !r.runId) { unregisterLocal(p.sessionId); throw new Error((r && r.error) || '服务端没有返回运行 id'); }
  registerRun(p.sessionId, r.runId, p.live);
  ensureHub();
  return r.runId;
}

/** 把"这一段是我刚开的"记进本地表（**合并进已有记录**而不是整个替换：
 *  统一口的快照可能已经先一步登记了它、带着服务端的 liveId——替换会把 liveId 抹掉，
 *  后面的事件就找不到该写哪条消息了）。localId = 本窗口插的那条占位，等 liveId 到了再认领。 */
/** 摘掉本窗口那条多余的占位气泡（事件比 POST 响应先到时会这样：
 *  那时已经按服务端的 liveId 建过一条消息，占位就成了永远空着的那条）。 */
function dropPlaceholder(sessionId, placeholderId) {
  /* 与 liveId 同名的那条就是"正文正在写进去的那条"，绝不能摘（调用方已保证不同名，这里是双保险） */
  if (!placeholderId) return;
  const sess = sessionById(sessionId);
  const keep = (m) => !(m && m.id === placeholderId);
  if (sess && Array.isArray(sess.msgs) && sess.msgs.some((m) => m && m.id === placeholderId)) {
    sess.msgs = sess.msgs.filter(keep);
  }
  if (state.activeSessId === sessionId && state.history.some((m) => m && m.id === placeholderId)) {
    patch({ history: state.history.filter(keep) });
  }
}

/** 这一段在本窗口的占位消息 id（没给就沿用记录里的；都没有就是 ''） */
const placeholderOf = (live, rec) => (live && live.id) || rec.localId || '';

/** 事件先到 → 已经按 liveId 建过消息 → 本窗口那条占位是多余的（摘掉，别留一个空气泡）。
 *  **占位已经被认领成 liveId 时绝不能摘**（claimLocal 会给它改名）——那正是正文写着的那一条。 */
function dropStalePlaceholder(sessionId, rec, placeholder) {
  if (!rec.liveId || !placeholder || placeholder === rec.liveId) return;
  dropPlaceholder(sessionId, placeholder);
}

function registerRun(sessionId, runId, live) {
  const rec = getOrCreate(sessionId);
  const placeholder = placeholderOf(live, rec);
  Object.assign(rec, {
    runId: runId || rec.runId,
    /* 已经知道 liveId（事件先到）就不必再记占位：那一条已经按 liveId 建好了 */
    localId: rec.liveId ? '' : placeholder,
    settled: false, status: 'running', steering: 0,
    title: rec.title || '', startedAt: rec.startedAt || Date.now(),
  });
  runs.set(sessionId, rec);
  dropStalePlaceholder(sessionId, rec, placeholder);
  publish();
  return rec;
}

/** 起跑失败（POST 没成功）：把刚才那条"我先开一段"的登记撤掉（只撤还没拿到 runId 的） */
function unregisterLocal(sessionId) {
  const rec = runs.get(sessionId);
  if (rec && !rec.runId) { runs.delete(sessionId); publish(); }
}

/** 生成中插话（下一轮开始前注入；不打断当前调用） */
export async function steerRun(text) {
  const id = activeRunId();
  const t = String(text || '').trim();
  if (!id || !t) return false;
  try {
    await post(EP.runSteer, { id, text: t });
    return true;
  } catch (e) {
    toast('插话没送出去：' + (e.message || e), 'err');
    return false;
  }
}

/** 停止：让**服务端**停下当前会话这一轮（不是断开观看——断开不影响它） */
export async function stopRun(sessionId) {
  const sid = sessionId || state.activeSessId;
  const rec = runs.get(sid);
  if (!rec || rec.settled) return;
  try { await post(EP.runStop, { id: rec.runId }); }
  catch (e) {
    /* "已经结束"（409/404 之类）确实可以吞；网络错误吞掉的话界面继续转圈、用户以为没点上 */
    if (e && e.network) toast('停止请求没有送达（网络问题）：回答还在生成，稍后再点一次', 'err');
  }
}

/**
 * 撤销：把某一次运行的文件改动恢复原状——**默认整轮，传 paths 时只恢复这几个文件**
 * （抽屉里与撤销菜单里的"仅恢复这一个"）。
 *
 *  请求打到服务端（原内容备份与改动日志都在**账号目录**里，不在浏览器里）；
 *  成功后服务端会把落盘那条消息的 `undo` 进度更新掉（所有窗口/刷新后一致），
 *  本地这份也同步（applyUndoSummary）——不同步的话，本窗口下一次整体写回会话会把它覆盖回去。
 *  @param {string} runId
 *  @param {string[]} [paths] 只恢复这些路径；缺省 = 整轮
 */
export async function undoRun(runId, paths) {
  const body = { id: String(runId || '') };
  if (Array.isArray(paths) && paths.length) body.paths = paths.map(String);
  const d = await post(EP.runUndo, body, { timeoutMs: 120000 });
  /* 服务端同步过进度（marked）才写回本地；一处都没恢复时它不同步，本地也不能自作主张 */
  if (d && d.marked !== false) applyUndoSummary(d.summary, d);
  return d;
}

/** 服务端摘要 → 进度字段（undoneAt 为 0 时不带，保持本地已有的那个值）。
 *  别把局部变量叫 patch：本模块顶部就导入了 store 的 patch（no-shadow）。 */
function undoProgressPatch(summary) {
  const rec = {
    undone: !!summary.undone,
    undoneCount: summary.undoneCount, pendingCount: summary.pendingCount,
    fileList: summary.fileList, lastFailed: summary.lastFailed,
  };
  if (summary.undoneAt) rec.undoneAt = summary.undoneAt;
  return rec;
}

/** 更新一条消息的 undo 进度：有完整 summary 用它的；没有（精简响应）按旧语义标全恢复 */
function applyOneUndo(msg, summary, d) {
  if (!summary) {
    msg.undo.undone = true;
    msg.undo.undoneAt = (d && d.undoneAt) || Date.now();
    return;
  }
  msg.undo = Object.assign({}, msg.undo, undoProgressPatch(summary));
}

/** 把服务端的撤销进度（summary = undo.summaryOf 的形状）写回本地那份 msg.undo。
 *  逐个文件撤销之后，按钮文案、菜单里每行的"已恢复"、收尾条都靠它立刻跟上。 */
export function applyUndoSummary(summary, d) {
  const runId = String((summary && summary.runId) || (d && d.runId) || '');
  if (!runId) return;
  for (const sess of state.sessions) {
    const msg = (sess.msgs || []).find((m) => m && m.undo && m.undo.runId === runId);
    if (msg) applyOneUndo(msg, summary, d);
  }
  touch();
}

/** 子智能体的完整转录（界面展开看"它到底做了什么"）；失败回 null。 */
export async function subagentRecord(runId, subId) {
  if (!runId || !subId) return null;
  try {
    const d = await request(`${EP.runSubagent}?id=${encodeURIComponent(runId)}&sub=${encodeURIComponent(subId)}`);
    return (d && d.sub) || null;
  } catch { return null; }
}

/** 回到前台 / 网络恢复：补一次连接（服务端会回放，画面自己补齐） */
if (typeof document !== 'undefined') {
  let lastWake = 0;
  const wake = () => {
    const now = Date.now();
    if (now - lastWake < 4000) return;
    lastWake = now;
    if (!hub || hub.ended) { ensureHub(); return; }
    if (state.activeSessId) reattach(state.activeSessId).catch(() => { /* 下次再试 */ });
  };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wake(); });
  window.addEventListener('online', wake);
}

/** detach() 已删（2026-10-06 审计）：统一事件口下切会话本来就不断流，
   唯一的调用方（session.js 的 selectSession）也一并摘掉。

/** 换会话/刷新后：把"这个会话有没有在跑的运行"与服务端对齐一次。
 *  · 有 → 接上（登记进 runs，界面继续显示"正在生成"）；
 *  · 没有 → 把本地还挂着 streaming 的孤儿占位结清（站点重启丢在途运行的那条路）。
 *  判"本地是不是已经在跟了"要看 **runs 记录**，不能看消息上的 streaming：
 *  服务端在运行开始时就把 streaming:true 写进了会话，刷新后从服务端拉到的历史里它就是 true，
 *  可这条连接其实并不存在——据它 early-return 会让刷新后永远停在半截内容上（踩过的坑）。 */
export async function reattach(sessionId) {
  if (!sessionId) return null;
  ensureHub();
  let d;
  try { d = await request(`${EP.runState}?sessionId=${encodeURIComponent(sessionId)}`); } catch { return null; }
  if (!d || state.activeSessId !== sessionId) return null;   // 期间换了会话：结果作废
  /* 服务端给的是**本账号全部在跑的运行**，一次把所有会话都登记上（不只当前这条）——
     侧栏的小标、切过去时的实时显示都要靠它。 */
  if (Array.isArray(d.runs)) { adoptRuns(d.runs); publish(); }
  if (d.run) return d.run;
  /* 服务端说这条会话没有在跑的运行了（刚跑完 / 站点重启丢了在途那轮）：界面必须退出生成态。
     接着先把服务端最新落盘拉回来再判定占位——否则刚跑完的那一轮会被误标成"没有跑完"，
     而正确的内容明明就躺在服务端的会话文件里。 */
  settleLocal(sessionId);
  touch();
  await pullLatest(sessionId);
  /* **不管拉没拉成功都要结清孤儿占位**：服务端已经明确说了"这条会话没有在跑的运行"。
     拉回来的那份里，被中断的那一轮照样带着 streaming:true（服务端也没机会清——进程重启时
     它是在途的），于是界面上永远挂着"正在思考…"。内容一律保留，只把生成态放掉
     （一个字都没有的那种标成"没有跑完"，与旧行为一致）。 */
  clearOrphanPlaceholders(sessionId);
  return null;
}

/** 服务端说这条会话没有在跑的运行了：本地记录同步收尾（已有记录才动） */
function settleLocal(sessionId) {
  const rec = runs.get(sessionId);
  if (!rec || rec.settled) return;
  rec.settled = true; rec.status = 'done';
  publish();
}

/** 重新拉一份服务端数据（会话 + 面板数据），只在"以为还在跑、其实已经结束"这条路上用。
 *  期间用户换了会话/登出就放弃这次结果。实现落在 session.js（通过钩子，避免模块环）。 */
async function pullLatest(sessionId) {
  try {
    const h = await import('./host.js');
    const fn = h.hooks && h.hooks.onPullLatest;
    if (typeof fn !== 'function' || state.activeSessId !== sessionId) return false;
    return !!(await fn(sessionId));
  } catch { return false; }
}

/** 没有在跑的运行了：把**这条会话里**还挂着 streaming 的助手消息结清（与"生成被中断"同一呈现） */
/** 一条会话里还挂着"正在生成"的助手消息（孤儿占位） */
const streamingMsgs = (sess) => ((sess && sess.msgs) || []).filter((m) => m.role === 'assistant' && m.streaming);

function clearOrphanPlaceholders(sessionId) {
  const sess = sessionById(sessionId);
  const orphans = streamingMsgs(sess);
  if (!orphans.length) return;
  for (const m of orphans) {
    delete m.streaming;
    const empty = !m.content && !m.thinking && !(m.trace || []).length && !m.error;
    if (empty) m.error = '这一轮没有跑完（服务端重启或生成被中断），没有内容保存下来，可以重新提问。';
  }
  if (state.activeSessId === sessionId) patch({ history: ensureMsgs(sess).slice() });
  // 落盘交给宿主（它会写回会话对象并排队）——run.js 不直接依赖会话存储。
  // 2026-10-06 修复：原先调的 hostHook('persistSession') 在 hooks 表里根本没有这个键，
  // 是个静默空操作（清理结果要等下一次别的动作才被顺带落盘）。现在接的是真钩子。
  hostHook('persistSession', sessionId);
  touch();
}

/** 整份数据重拉之后（session.js 的 applyServerData）：把还在跑的那几条重新认到新对象上。
 *  `state.sessions` 被换成了服务端那份，正在流式的消息对象也跟着换了——
 *  后续事件本来就按 liveId 寻址，这里只负责把"本地还挂着 streaming"这件事对齐，
 *  免得刚拉回来的那条显示成"没有跑完"。 */
export function rehydrate() {
  for (const [sid, rec] of runs) {
    if (rec.settled) continue;
    const msg = msgFor(sid, rec.liveId, rec);
    if (msg) msg.streaming = true;
  }
  publish();
}
