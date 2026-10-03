/* core/store.js —— 服务端数据的客户端（配置 / 会话 / 全局记忆 / 提示词登记表）
 *
 *  设计取舍：**服务端是唯一真源**（不再有 localStorage 兜底——一个浏览器副本两处真源，
 *  迟早出现"到底哪份是新的"）。未登录时数据只活在本页内存里，界面明确提示"登录后才保存"。
 *
 *  写入策略（沿用旧实现里踩出来的三条）：
 *    · 设置（含模型/参数/外观）与单个会话各自**防抖合并**后发送，避免每敲一个字符一个请求；
 *    · 失败**放回待写队列并重新排定时器**——只放回不重排的话，这份数据要等到下次改动或
 *      关页面才会再写，期间刷新就丢了；
 *    · 413（超过服务端上限）是**永久失败**：重发一百次也还是 413，立刻放手并明确告诉用户；
 *    · 退出/换账号时清空待写队列，否则 A 的数据会被写进 B 的账号（旧实现真踩过）。
 */
import { EP } from './endpoints.js';
import { get, post, request, ApiError } from './http.js';

const SETTINGS_DEBOUNCE = 500;
const SESSION_DEBOUNCE = 400;
const MEMORY_DEBOUNCE = 600;
const PROMPTS_DEBOUNCE = 600;
const RETRY_DELAY = 5000;
const MAX_RETRIES = 20;

const TOO_LARGE_MSG = '这个对话已经太大，超过服务器单次写入上限，最新内容没能保存。'
  + '请新建一个对话继续，或清空当前对话（原文可在页面上先复制走）。';

const handlers = { needLogin: [], error: [], dropped: [], kicked: [], memoryConflict: [] };
export const on = (evt, fn) => { if (handlers[evt] && typeof fn === 'function') handlers[evt].push(fn); };
const emit = (evt, arg) => { for (const fn of handlers[evt] || []) { try { fn(arg); } catch { /* 回调异常不影响主流程 */ } } };

let user = null;
let info = null;              // /agent/info 的完整响应（绑定状态、协议、本机默认地址）

/* 通用发送：把 ApiError 的分类翻译成宿主能用的信号 */
async function send(path, body, method) {
  try {
    return await request(path, { method: method || (body ? 'POST' : 'GET'), body });
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.needLogin) { emit('needLogin', e.message); throw e; }
      if (e.kicked) { emit('kicked', e); throw e; }
      if (e.status === 413) { e.oversize = true; emit('error', TOO_LARGE_MSG); throw e; }
      /* 409 conflict = 服务端拒绝了这次"整份覆盖"（典型：拿一份空的/陈旧的列表去写项目记忆）。
         这不是"重试就能好"的错误——重发一百次还是 409。报一条事件让宿主重新取回那份数据，
         并标记成永久失败（makeWriter 不再重排）。 */
      if (e.status === 409 && e.conflict) { e.conflictRejected = true; emit('memoryConflict', e); throw e; }
    }
    throw e;
  }
}

/* ============================ 初始化与拉取 ============================ */

export async function init() {
  try {
    info = await get(EP.info, { timeoutMs: 8000 });
  } catch {
    info = { ok: false, loggedIn: false, binding: null, protocols: [], defaultLocalBase: '' };
  }
  user = info.loggedIn ? info.user : null;
  return { loggedIn: !!user, user, binding: info.binding, info };
}

/** 已登录则拉取服务端数据；未登录返回 null（由调用方退回内存态）。
 *  **形状不对一律返回 null**：`request()` 只在"响应有 JSON 体"时才返回对象，
 *  但一个 2xx 的兜底页/半截响应仍可能解析出 `{}` 或缺字段。空对象是真值，
 *  直接喂给 applyServerData 会把界面清空、并让 Memory.load([], []) 把账号记忆写没
 *  （2026-10-01 审计）。这里按必需字段做一次形状校验。 */
const looksLikeStore = (d, { light } = {}) => !!(d && typeof d === 'object' && d.ok !== false
  && Array.isArray(d.projects) && Array.isArray(d.memory) && d.prompts && typeof d.prompts === 'object'
  && (light || Array.isArray(d.sessions)));

export async function pull() {
  if (!user) return null;
  try { const d = await send(EP.store, null, 'GET'); return looksLikeStore(d) ? d : null; } catch { return null; }
}

/** 轻量拉取：只有面板数据（记忆/提示词/项目清单），**不含会话**。
 *  托管运行改了账号数据之后要刷新面板，但生成中不能把整份 store 拉回来——那会把正在流式
 *  写入的消息对象换掉（见 ui/state/session.js 的 refreshLightSoon）。 */
export async function pullLight() {
  if (!user) return null;
  try { const d = await send(`${EP.store}?light=1`, null, 'GET'); return looksLikeStore(d, { light: true }) ? d : null; } catch { return null; }
}

/** 有没有还没落到服务端的本地改动（"面板要跟服务端对齐"之前必须问一句：
 *  有的话那份本地改动还没写上去，用旧快照盖回来等于把它删了）。 */
export const pendingWrites = () => settingsWriter.hasPending() || memoryWriter.hasPending()
  || projectWriter.hasPending() || promptsWriter.hasPending() || pendingSessions.size > 0;

/** 只问**项目记忆**那条链路有没有待写。面板刷新用这个而不是上面那个"全都在内"的口径：
 *  采纳服务端数据本身会顺手排一条（幂等的）回写，用宽口径会把紧接着的那次刷新自己挡住
 *  （实测：整份重拉之后项目记忆一次都没去取）。而真正怕被覆盖的是**本地刚改的项目记忆**，
 *  那正好由这一条回答。 */
export const hasPendingProjectWrites = () => projectWriter.hasPending();

/** 重新探一次登录态与绑定状态（登录/解绑后调用） */
export async function refreshInfo() {
  try { info = await get(EP.info, { timeoutMs: 8000 }); } catch { /* 保持旧值 */ }
  user = info && info.loggedIn ? info.user : null;
  return info;
}

/* ============================ 写入器（防抖 + 失败重排，唯一实现） ============================ */

/** "整份覆盖"链路共用的小写入器：防抖合并 + **失败放回并重排定时器** + 超过 MAX_RETRIES 放手并报一条。
 *  为什么必须只有一处：这几条链路（设置 / 全局记忆 / 项目记忆 / 提示词登记表）原先各写一遍，
 *  行为还会走偏——失败只放回不重排的话，这份数据要等到下次改动或关页面才再写一次，期间刷新就丢
 *  （设置与会话两条链路一直是"放回 + 重排"，后面三条漏了）。写在一处，改口径不会再漏掉其中一条。 */
function makeWriter(label, debounceMs, put) {
  let timer = null, pending = null, retries = 0;
  const flushNow = async () => {
    if (!pending || !user) return;
    const payload = pending; pending = null;
    clearTimeout(timer); timer = null;
    try { await put(payload); retries = 0; }
    catch (e) {
      /* 永久失败：重发多少次都一样 —— 要登录/被顶掉/超上限，以及 409 冲突
         （整份覆盖被拒：手里那份是空的/陈旧的，重发还是被拒；宿主已收到事件去重新取回）。 */
      if (e.needLogin || e.kicked || e.oversize || e.conflictRejected) return;
      /* await 期间可能又排进了更新的数据（queue 会填 pending 并起一个新定时器）。
         只在槽位空着时把失败的那份放回去——无条件覆盖会把"更新的那份"丢掉（审计发现）。
         定时器统一由这里重排（上面 clearTimeout 掉 queue 起的那个），避免两个定时器各冲一次。 */
      pending = pending || payload;
      if (retries >= MAX_RETRIES) { emit('error', `${label}连续 ${MAX_RETRIES} 次保存失败，已暂停重试：${e.message}`); return; }
      retries++;
      clearTimeout(timer);
      timer = setTimeout(() => { flushNow(); }, RETRY_DELAY);
    }
  };
  return {
    queue(payload) {
      if (!user) return;                                     // 未登录：调用方留在内存里
      pending = payload;
      clearTimeout(timer);
      timer = setTimeout(() => { flushNow(); }, debounceMs);
    },
    flushNow,
    hasPending: () => !!pending,
    reset() { clearTimeout(timer); timer = null; pending = null; retries = 0; },
  };
}

/* ============================ 设置（防抖合并） ============================ */

const settingsWriter = makeWriter('设置', SETTINGS_DEBOUNCE, (payload) => send(EP.settings, { settings: payload }));

export const queueSettings = (settings) => settingsWriter.queue(settings);

/* ============================ 会话（按 id 防抖） ============================ */

const pendingSessions = new Map();
const sessTimers = new Map();
const sessRetries = new Map();

/** 这条会话有没有还没落到服务端的本地编辑：托管运行拿它判断"该以谁的历史为准"
 *  （见 core/sessions.js 的 reconcileHistory —— 用户刚删掉一轮时不能被服务端那份变回来）。 */
export const hasPendingSession = (id) => pendingSessions.has(String(id || ''));

export function queueSession(session) {
  if (!user) return;
  pendingSessions.set(session.id, session);
  clearTimeout(sessTimers.get(session.id));
  sessTimers.set(session.id, setTimeout(() => { flushSession(session.id); }, SESSION_DEBOUNCE));
}

async function flushSession(id) {
  const payload = pendingSessions.get(id);
  if (!user || !payload) return;
  pendingSessions.delete(id);
  clearTimeout(sessTimers.get(id)); sessTimers.delete(id);
  try {
    const d = await send(EP.sessions, { session: payload });
    sessRetries.delete(id);
    if (d && d.dropped > 0) emit('dropped', { kind: 'sessions', n: d.dropped });
  } catch (e) {
    if (e.needLogin || e.kicked || e.oversize) return;
    const n = (sessRetries.get(id) || 0) + 1;
    if (n > MAX_RETRIES) {
      emit('error', `这个对话连续 ${MAX_RETRIES} 次保存失败，已暂停重试（网络恢复后随便改一下内容会再试）：${e.message}`);
      return;
    }
    sessRetries.set(id, n);
    /* 失败的那份**只在槽位空着时**放回去（与 makeWriter 同口径）。
       旧写法无条件 `pendingSessions.set(id, payload)` 并清掉定时器：
       那次 await 期间用户又改了这条会话（新对象已排队、新定时器已起）时，
       会被这份**旧快照**顶掉，最新的编辑要等到下次改动才会再写——静默丢内容（2026-10-01 审计）。 */
    if (!pendingSessions.has(id)) {
      pendingSessions.set(id, payload);
      clearTimeout(sessTimers.get(id));
      sessTimers.set(id, setTimeout(() => { flushSession(id); }, RETRY_DELAY));
    }
  }
}

/* 注：这里原有 putSessions()（批量上传会话）与 deleteSession()（彻底删会话）两个包装。
   界面上"删除"已改成归档（archiveSession），批量导入也没了入口——两者全项目零调用，审计时删除。
   服务端端点仍在（/agent/store/sessions 的批量形态、/session/delete），要用时照 send() 的写法加一个即可。 */

/** 归档一个会话（搬进归档区，可恢复）。**先取消它在途的落盘**：否则排队中的写入会把它又写回列表。 */
export async function archiveSession(id) {
  pendingSessions.delete(id);
  sessRetries.delete(id);
  clearTimeout(sessTimers.get(id)); sessTimers.delete(id);
  if (!user) return null;
  try { return await send(EP.sessionArchive, { id }); } catch { return null; }
}

/* ============================ 全局记忆 / 项目记忆 / 提示词登记表 ============================ */

/* 当前项目 id：由宿主在切换项目时灌进来（写项目记忆时要知道写给哪个项目） */
let currentProjectId = '';
export const setProjectId = (id) => { currentProjectId = String(id || ''); };

const memoryWriter = makeWriter('全局记忆', MEMORY_DEBOUNCE, (entries) => send(EP.memory, { entries }));
/* 项目记忆：真源是服务端账号目录里的 Markdown 文件夹（每条记忆一个 .md），
   所以写的是"整份项目记忆"（全量覆盖），与全局记忆同一套防抖口径。
   **写入目标 id 在入队那一刻就定下来**（跟条目一起进 payload）——不能在 flush 时才读
   `currentProjectId`：用户在这 600ms 里切了项目的话，A 项目的条目会被写进 B 项目的文件夹
   （服务端是全量覆盖，等于把 B 的记忆删了）。
   **baseCount** = "取回这份条目时服务端有几条"，随请求一起发。服务端拿它做**空列表覆盖保护**：
   一份空的、且基准对不上的列表 = 拿陈旧/空快照去删别人的记忆 → 直接拒绝并回现状
   （2026-10-03 抖音热点项目被清空事故）。客户端收到 conflict 会重新取回，自愈。
   没有当前项目就**根本不发**：服务端对空 id 回 400，而 makeWriter 把它当"可重试"退回重排，
   于是白跑 20 次（每次间隔 5 秒）再给用户一条"连续 20 次保存失败"的错提示。
   约定 6 要求"没有当前项目时绝不发项目记忆写请求"——那道防线原先只在宿主的一处 if 上，
   这里补上 Store 自己的守卫，任何调用点都绕不过去。 */
const projectWriter = makeWriter('项目记忆', MEMORY_DEBOUNCE, ({ id, entries, baseCount }) => {
  if (!id) return Promise.resolve({ ok: true, skipped: 'no-project' });
  return send(EP.projectsMemory, { id, entries, baseCount });
});
const promptsWriter = makeWriter('提示词与技能', PROMPTS_DEBOUNCE, (prompts) => send(EP.prompts, { prompts }));

export const queueMemory = (entries) => memoryWriter.queue(entries);
/** @param {Array} entries 整份项目记忆
 *  @param {number} [baseCount] 取回这份条目时服务端有几条（空列表覆盖保护的基准；缺省不带） */
export const queueProjectMemory = (entries, baseCount) =>
  projectWriter.queue({ id: currentProjectId, entries, baseCount: Number.isFinite(Number(baseCount)) ? Number(baseCount) : undefined });
export const queuePrompts = (prompts) => promptsWriter.queue(prompts);

/** 只把**项目记忆**那条待写落地（刷新项目记忆前先调：让本地改动先上去，
 *  再用服务端那份覆盖显示——否则"本地刚改"与"服务端快照"互相盖，谁后谁赢）。
 *  没有待写就是空操作。 */
export async function flushProjectMemory() {
  if (projectWriter.hasPending()) await projectWriter.flushNow();
}

/* ============================ 收尾 ============================ */

function resetPending() {
  for (const t of sessTimers.values()) clearTimeout(t);
  sessTimers.clear(); pendingSessions.clear(); sessRetries.clear();
  settingsWriter.reset();
  memoryWriter.reset(); projectWriter.reset(); promptsWriter.reset();
}

/** 关页/切到后台前把待写数据发出去 */
export async function flush() {
  if (!user) { resetPending(); return; }
  const jobs = [];
  if (settingsWriter.hasPending()) jobs.push(settingsWriter.flushNow());
  if (memoryWriter.hasPending()) jobs.push(memoryWriter.flushNow());
  if (projectWriter.hasPending()) jobs.push(projectWriter.flushNow());
  if (promptsWriter.hasPending()) jobs.push(promptsWriter.flushNow());
  for (const id of [...pendingSessions.keys()]) jobs.push(flushSession(id));
  try { await Promise.allSettled(jobs); } catch { /* 关闭中，尽力而为 */ }
}

/* 关页/切后台自动 flush（页面生命周期只有这里碰 DOM，其余部分保持可 Node 单测） */
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => { flush(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
}

export const Store = {
  init, pull, pullLight, refreshInfo, on,
  queueSettings,
  queueSession, archiveSession, hasPendingSession,
  queueMemory, queueProjectMemory, setProjectId, queuePrompts,
  flush, flushProjectMemory, pendingWrites, hasPendingProjectWrites,
  get user() { return user; },
  get info() { return info; },
  get binding() { return (info && info.binding) || null; },
  /* 换身份（登录/退出）必须清掉待写队列：否则 A 的会话会被写进 B 的账号 */
  set user(u) { if (u !== user) resetPending(); user = u; },
};

export { post };
