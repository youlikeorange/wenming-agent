/* ui/state/run.js —— 托管运行的**客户端一半**：开跑、看直播、插话、停止、回来接上
 *
 *  循环本身在服务端（lib/agent/run.js），这里只做三件事：
 *    ① 把这一轮的用户输入与当前历史交给服务端（POST /agent/run/start）；
 *    ② 订阅它的 SSE 事件流，把事件**照着原来的样子**写进 state.history 的那条助手消息
 *       （界面因此一行渲染代码都不用改：正文/思考/追踪条的形状与浏览器自己跑时完全一致）；
 *    ③ 把人做的决定送回去（插话 / 停止 / 确认框的同意与否）。
 *
 *  为什么值得这么绕：浏览器从此只是"观众"。关掉页面、断网、换窗口，服务端照样把这一轮跑完
 *  并落盘——人回来时用 GET /agent/run/state 找到还在跑的那一段，接上继续看。
 */
import { state, patch, touch } from './store.js';
import { post, request } from '../../core/http.js';
import { EP } from '../../core/endpoints.js';
import { sseLines } from '../../core/protocol/sse.js';
import { toast } from '../components/ui/toast.jsx';

/* 生成中的重绘节流：与浏览器自己跑时同一口径（见 session.js 的 touchSoon 注释）。
   这里不用 import session.js（会成环），就地实现一份最小的。 */
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

/** 当前这段运行的客户端状态（同一时刻只跟一段）
 *  `dropped` = 读取连接断了但"这一轮还在服务端跑"（自动重连途中）——这时 stop/steer 依旧可用
 *  （它们按 runId 打到服务端，服务端说了算），界面也保持"生成中"，不闪一下"被打断"。 */
let cur = null;      // { runId, sessionId, live, ac, ended, dropped }

export const activeRunId = () => (cur && !cur.ended ? cur.runId : '');

/** 那一轮助手消息（state.history 的最后一条）——服务端事件都落在它身上 */
function liveMessage() {
  const last = state.history[state.history.length - 1];
  return last && last.role === 'assistant' ? last : null;
}

function traceArr(msg) {
  if (!Array.isArray(msg.trace)) msg.trace = [];
  return msg.trace;
}

/** 事件 → 状态。**形状与 core/agent.js 的 hooks 一致**，所以渲染层不需要知道
 *  这一轮是浏览器跑的、还是服务端跑的。
 *  按类型查表分派（不是一条长 if 链）：事件种类会随功能增加，链式判断每次都要重读一遍。 */
const HANDLERS = {
  replay_start: (ev, msg) => {
    /* 回放前先把这条消息清空：事件流是完整的（从本轮的 content/thinking 累积），
       叠加在已有内容上会翻倍。截断（超长运行）时另说——那时以落盘的会话为准。
       `error` 也一起清：那条"没有跑完"是**上一次**判定留下的（比如断线时误判过），
       现在服务端说这一轮还在跑、正按事件重建这条消息，就不该再挂着。 */
    if (!ev.truncated) { msg.content = ''; msg.thinking = ''; msg.trace = []; delete msg.error; }
  },
  content: (ev, msg) => { msg.content = (msg.content || '') + ev.text; touchSoon(); },
  thinking: (ev, msg) => { msg.thinking = (msg.thinking || '') + ev.text; touchSoon(); },
  stats: (ev, msg) => { msg.stats = ev.raw; touchSoon(); },
  notice: (ev, msg) => {
    traceArr(msg).push({ kind: 'notice', state: 'done', label: ev.text, ok: true, note: '提示' });
    touchSoon();
  },
  tool_start: (ev, msg) => {
    traceArr(msg)[ev.token] = { kind: 'tool', state: 'running', label: ev.label, name: ev.name, ok: true, note: '' };
    touchSoon();
  },
  tool_end: (ev, msg) => {
    const at = traceArr(msg)[ev.token];
    const done = { kind: 'tool', state: 'done', label: ev.label, name: ev.name, ok: ev.ok !== false, note: ev.note || '', args: ev.args, result: ev.result, ms: ev.ms };
    if (at) Object.assign(at, done); else traceArr(msg).push(done);
    touchSoon();
  },
  steer_accepted: (ev, msg) => {
    traceArr(msg).push({ kind: 'steer', state: 'done', label: `已插话（待注入）：${String(ev.text).slice(0, 60)}`, ok: true, note: '插话' });
    /* 待注入条数**以服务端的队列为准**（st.steering 只用来显示"已排队 N 条"）：
       客户端不再自己排队，就不要再自己数。 */
    patch({ steering: Number(ev.pending) || 0 });
    touchSoon();
  },
  steer_pending: (ev) => { patch({ steering: Number(ev.pending) || 0 }); },
  steer_leftover: (ev) => {
    /* 这一轮结束时还没注入的插话：回填输入框，绝不静默丢弃（与旧行为同一约定） */
    patch({ steering: 0 });
    if (!Array.isArray(ev.texts) || !ev.texts.length) return;
    patch({ draft: ev.texts.join('\n\n') + (state.draft ? '\n\n' + state.draft : '') });
    toast(`有 ${ev.texts.length} 条插话没有注入（这一轮已结束），已放回输入框`, 'info');
  },
  confirm: (ev) => askThenAnswer(ev),
  /* 服务端说"账号数据变了"（模型写了记忆/提示词/技能）：界面上的记忆面板等正显示着旧副本。
     这里不直接改，只通知宿主从服务端重拉面板数据（生成中会跳过，结束后 settle 里还会再拉一次）。 */
  data_changed: () => hostHook('onRunDataChanged'),
  end: (ev) => settle(ev),
};

/** 宿主端口：**本模块与 ui/state/session.js 之间的唯一通道**。
 *  run ↔ session 天然互相需要（session 要开运行，运行结束要通知 session 收尾），
 *  直接 import 会成模块环，所以宿主在 host.js 的 hooks 上回填实现，这里只按名字取。
 *  动态 import 只出现在这一个函数里（旧实现四处各写一遍 import('./host.js')），
 *  依赖边界因此只有一处需要看。 */
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

function applyEvent(ev) {
  const fn = HANDLERS[ev && ev.type];
  if (!fn || !cur) return;
  const msg = cur.live || liveMessage();
  if (!msg) return;
  fn(ev, msg);
}

/** 服务端要人点头：用**界面上原有的那几个确认框**（文案一处都不重复），再把人话回传 */
async function askThenAnswer(ev) {
  /* host.js 的 askRunConfirm 把 (kind, payload) 映射到既有的三个确认框
     （插件 / 技能 / 危险命令授权）。动态 import 避免与 host.js 成环。 */
  const { askRunConfirm } = await import('./host.js');
  let ans = { ok: false, remember: false };
  try { ans = await askRunConfirm(ev.kind, ev.payload || {}); } catch { /* 关掉弹窗 = 不同意 */ }
  try {
    await post(EP.runConfirm, { id: cur ? cur.runId : '', confirmId: ev.id, ok: !!ans.ok, remember: !!ans.remember });
  } catch (e) {
    toast('确认没能送达服务端：' + (e.message || e), 'err');
  }
}

/** 失败只**追加**一行说明，绝不清空已经生成的部分（那是用户等了半天的东西） */
function noteFailure(msg, error) {
  if (msg.content) msg.content += '\n\n*[请求失败：' + error + ']*';
  else msg.error = '请求失败：' + error;
}

/** 收尾：整轮结束（正常/停止/失败都走这里）。内容一律保留。 */
function settle(ev) {
  const msg = cur && (cur.live || liveMessage());
  if (!msg) return;
  delete msg.streaming;
  if (ev && Number.isFinite(ev.ms)) msg.wallMs = ev.ms;
  if (ev && ev.status === 'error' && ev.error) noteFailure(msg, ev.error);
  /* 压缩摘要是**服务端**的产物（循环跑在服务端）：把它写进会话对象，紧接着那次写回才完整
     （否则客户端会用"没有摘要"的旧副本盖掉服务端刚写的摘要）。 */
  if (ev && ev.compaction !== undefined && cur) {
    const s = state.sessions.find((x) => x.id === cur.sessionId);
    if (s) { if (ev.compaction) s.compaction = ev.compaction; else delete s.compaction; }
  }
  if (cur) cur.ended = true;
  patch({ streaming: false, abortSignal: null, steering: 0 });
  touch();
  finishPending();
  /* 这一轮是**服务端**跑的：标题、最终内容、以及模型顺手写的记忆/技能/提示词都只在
     服务端那份数据里。结束后整份重拉一次（稍等片刻，等服务端那几笔异步写盘落地）。 */
  hostHook('onRunEnded', (cur && cur.sessionId) || state.activeSessId);
}

let pendingDone = [];
function finishPending() { const fns = pendingDone; pendingDone = []; for (const fn of fns) { try { fn(); } catch { /* 单个回调出错不影响其它 */ } } }

/** 订阅事件流。signal 只管"这一条读取连接"——断了服务端照跑（那正是托管运行的意义）。 */
async function subscribe(runId, sessionId, live) {
  const mine = { runId, sessionId, live, ac: new AbortController(), ended: false };
  cur = mine;
  patch({ streaming: true, abortSignal: mine.ac.signal });
  /* 判"我还活着"一律看 **mine 是不是当前那条连接**（而不是模块级的 cur）：
     换订阅时旧流的 abort 会在微任务里到达，那时 cur 已经是新连接了——按 cur 判会把
     新连接标成"已结束"（停止/插话消失、消息被当成"没有跑完"），而服务端那一轮还在跑。 */
  const alive = () => cur === mine && !mine.ended;
  try {
    const res = await request(`${EP.runEvents}?id=${encodeURIComponent(runId)}`, { raw: true, signal: mine.ac.signal });
    for await (const line of sseLines(res)) {
      if (!alive()) return;                       // 期间已经换过订阅/被关掉：这一条流的内容作废
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      applyEvent(ev);
    }
    /* 流正常结束但没收到 end（服务端只 end 响应、不保证事件都到了）：也按"断线"处理，
       下面那段会去问服务端要最终状态——绝不把界面留在"正在思考…"上。 */
    if (alive()) dropConnection(sessionId, null, mine);
  } catch (e) {
    if (cur === mine || !cur) dropConnection(sessionId, e, mine);
  }
}

/** 读取断开（关页面/断网/服务端重启/被顶掉）：**不当作失败**——运行还在服务端跑着。
 *  与旧行为的两点区别（就是"刷新后不再续播"那个 bug 的另一半）：
 *    · 不再删掉 msg.streaming——"连接断了"不等于"这一轮结束了"；
 *    · 界面**保持生成态**（否则会先闪一句"这一轮没有跑完（生成被中断）"，而它其实还在跑），
 *      紧接着自动重连；连不上或服务端说已经结束，由 reattach 收尾（结清占位 / 换成落盘那份）。
 *  页面真的要走了（刷新/关标签）就什么都不排：新页面会自己接上。 */
/** 结清这一条连接的生成态（内容保留，只把"正在生成"的界面标记放掉） */
function endConn(conn) {
  conn.ended = true;
  patch({ streaming: false, abortSignal: null });
  touch();
  finishPending();
}

function dropConnection(sessionId, e, mine) {
  const conn = mine || cur;
  if (!conn || conn.ended || (cur && cur !== conn)) return;
  /* 断线的原因决定怎么处理（按类型分派，不是一条 if 链——判据会随运行状态增加）：
       kicked    被别的窗口顶掉：重连多少次都一样，直接退出生成态（界面有顶部横幅提示）
       needLogin 登录失效：连"停止/插话"也会被拒，必须让用户看见并去登录
       gone      服务端没有这一段了（跑完很久被回收 / 站点重启丢了在途那轮）：去取落盘那份
       leave     页面要走/主动断开：什么都不做——运行还在服务端跑，新页面自己会接上
       drop      普通网络抖动：保持生成态，2.5 秒后自动重连一次 */
  const kind = dropKind(e);
  if (kind === 'kicked') return endConn(conn);
  if (kind === 'needLogin') {
    endConn(conn);
    hooksOpenLogin();
    toast('登录状态已失效：这一轮的进度仍在服务端，重新登录后回到这条会话即可接上', 'err');
    return;
  }
  if (kind === 'gone') {
    conn.dropped = true;
    scheduleReattach(sessionId, 500);
    toast('这一轮在服务端已经结束或已过期：正在取回落盘的结果', 'info');
    return;
  }
  if (kind === 'leave') return endConn(conn);
  conn.dropped = true;
  scheduleReattach(sessionId, 2500);
  toast('与生成进度断开了：正在自动重连（这一轮仍在服务端继续）', 'info');
}

function dropKind(e) {
  if (!e) return 'drop';
  if (e.kicked) return 'kicked';
  if (e.needLogin) return 'needLogin';
  if (e.status === 404) return 'gone';
  if (e.aborted || e.name === 'AbortError') return 'leave';
  return 'drop';
}

/** 打开登录框（宿主端口；拿不到就不弹，至少 toast 已经说了要重新登录） */
function hooksOpenLogin() {
  return host().then((h) => {
    try { h && h.hooks && h.hooks.openLogin && h.hooks.openLogin('登录状态已失效，请重新登录'); } catch { /* 忽略 */ }
  });
}

/** 自动重连：一次延迟重试（页面还在、还在看同一条会话时才做） */
let reattachTimer = null;
function scheduleReattach(sessionId, delay) {
  if (reattachTimer) return;
  reattachTimer = setTimeout(() => {
    reattachTimer = null;
    if (!sessionId || state.activeSessId !== sessionId) return;
    reattach(sessionId).catch(() => { /* 下次可见性变化 / 重新打开页面还会再试 */ });
  }, delay);
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
  const r = await post(EP.runStart, body);
  if (!r || !r.runId) throw new Error((r && r.error) || '服务端没有返回运行 id');
  await subscribe(r.runId, p.sessionId, p.live);
  return r.runId;
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

/** 停止：让**服务端**停下这一轮（不是断开观看——断开不影响它） */
export async function stopRun() {
  const id = activeRunId();
  if (!id) return;
  try { await post(EP.runStop, { id }); } catch { /* 已经结束了 */ }
}

/** 关掉这条读取连接（页面卸载/切会话时用）。运行不受影响。 */
export function detach() {
  if (cur && cur.ac) { try { cur.ac.abort(); } catch { /* 已断 */ } }
  cur = null;
}

/** 换账号/登出：断开观看流，并把"正在生成"的界面标记清掉。
 *  运行本体在服务端（按账号存），与本窗口无关——新身份拉完数据后由 reattach 决定接不接。 */
export function reset() {
  detach();
  if (reattachTimer) { clearTimeout(reattachTimer); reattachTimer = null; }
  patch({ streaming: false, abortSignal: null, steering: 0 });
}

/* 回到前台 / 网络恢复：界面上还挂着"正在生成"、本地却没有连接时补一次 reattach。
   服务端说了算：还在跑就接上继续看（有回放），已经结束/被重启丢了就结清占位。
   为什么需要它：后台标签页会被浏览器节流、隧道抖动会掐断长连接，而这一轮仍在服务端跑着；
   断线后的那次自动重连如果也失败了（还在离线），回到前台时这里就是第二次机会。 */
if (typeof document !== 'undefined') {
  let lastWake = 0;
  const wake = () => {
    const sid = state.activeSessId;
    if (!sid) return;
    if (cur && !cur.ended && !cur.dropped) return;              // 正挂着一条读取连接
    const last = state.history[state.history.length - 1];
    const looksLive = !!state.streaming || !!(last && last.role === 'assistant' && last.streaming);
    if (!looksLive) return;
    const now = Date.now();
    if (now - lastWake < 4000) return;
    lastWake = now;
    reattach(sid).catch(() => { /* 下次再试 */ });
  };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wake(); });
  window.addEventListener('online', wake);
}

/** 换会话/刷新后：这个会话有没有还在跑的运行？有就接上；没有就把"孤儿占位"结清。
 *
 *  孤儿占位是什么：托管运行在服务端是内存里的（见 lib/agent/run.js），站点一重启它就没了。
 *  而运行**开始时**就把"助手占位（streaming:true）"写进了会话（这样刷新能看到"正在生成"），
 *  于是重启后这条占位会永远停在"正在思考…"——每次打开都像卡住了。
 *  这里以服务端的回答为准：它说没有运行，就把占位标成"被打断"（内容留着，一个字没生成就删掉）。
 *
 *  **一个踩了很久的坑（"刷新之后就不再更新"的真根因）**：判"本地是不是已经在跟了"**不能看
 *  msg.streaming** —— 服务端在运行开始时就把 streaming:true 写进了会话，刷新后从服务端拉到的
 *  历史里它就是 true，可这条连接其实并不存在；旧实现据此直接 return，于是刷新后永远不订阅、
 *  界面停在半截内容上（服务端其实跑完了、也落盘了，用户只看到"agent 停了"）。
 *  正确的判据是**本模块的 cur**（真的挂着一条读取连接才是"在跟"）。 */
export async function reattach(sessionId) {
  if (!sessionId) return null;
  let d;
  try { d = await request(`${EP.runState}?sessionId=${encodeURIComponent(sessionId)}`); } catch { return null; }
  if (!d || state.activeSessId !== sessionId) return null;   // 期间换了会话：结果作废
  if (d.run) return attachToRun(d.run, sessionId);

  /* 服务端说没有在跑的运行了（刚跑完 / 站点重启丢了在途那轮）：界面必须退出生成态。
     接着先把服务端最新落盘拉回来再判定占位——否则刚跑完的那一轮会被误标成"没有跑完"，
     而正确的内容明明就躺在服务端的会话文件里。 */
  cur = null;
  patch({ streaming: false, abortSignal: null });
  touch();
  finishPending();
  const pulled = await pullLatest(sessionId);
  if (!pulled) clearOrphanPlaceholders();
  return null;
}

/** 接上服务端在跑的那一段（已经挂着一条在跟同一段的连接就什么都不做）。 */
async function attachToRun(run, sessionId) {
  const following = cur && !cur.ended && !cur.dropped && cur.runId === run.runId;
  if (following) return run;
  if (cur && !cur.ended) detach();                    // 跟着别的运行 / 刚断线：先断开（不影响服务端）
  const live = liveMessage();
  if (!live || live.role !== 'assistant') return null;
  live.streaming = true;
  if (!Array.isArray(live.trace)) live.trace = [];
  touch();
  await subscribe(run.runId, sessionId, live);
  return run;
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

/** 没有在跑的运行了：把还挂着 streaming 的助手消息结清（与"生成被中断"同一呈现） */
function clearOrphanPlaceholders() {
  const orphans = (state.history || []).filter((m) => m.role === 'assistant' && m.streaming);
  if (!orphans.length) return;
  for (const m of orphans) {
    delete m.streaming;
    if (!m.content && !m.thinking && !(m.trace || []).length && !m.error) {
      m.error = '这一轮没有跑完（服务端重启或生成被中断），没有内容保存下来，可以重新提问。';
    }
  }
  // 落盘交给宿主（它会写回会话对象并排队）——run.js 不直接依赖会话存储
  import('./host.js').then((h) => h.persistSession()).catch(() => {});
  touch();
}
