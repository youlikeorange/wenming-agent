/* ui/state/session.js —— 对话动作：发送 / 插话 / 停止 / 回撤 / 清空 / 会话增删改
 *
 *  这里是"一轮对话"的**编排层**：把用户输入交给服务端的托管运行（ui/state/run.js →
 *  lib/agent/run.js），并把过程反映到界面状态里（React 只负责画）。
 *  **循环本身不在这里跑**：它跑在服务端，所以关掉浏览器这一轮照样跑完（详见 run.js 的头注）。
 *
 *  沿用旧实现里几条硬约束（都是踩出来的）：
 *    · 用户消息与助手占位**立刻**进历史——页面当场就能看到这一轮已经开始；
 *    · 生成中**不自动滚动**（用户往上翻看时不能被拽回来）；播放中间态只更新内容；
 *    · 三条中断路径（被顶掉 / 用户停止 / 请求失败）收尾同构：已流出的内容一律保留、
 *      一个字都没有才删占位；停止时没注入的插话由服务端交回，回填输入框，绝不静默丢弃。
 */
import { state, patch, touch, defaultSettings } from './store.js';
import { Store as StoreApi } from '../../core/store.js';
import { EP } from '../../core/endpoints.js';
import { get } from '../../core/http.js';
import { Presence } from '../../core/presence.js';
import { ctxLimitOf } from '../../core/params.js';
import { newMsgId } from '../../core/sessions.js';
import { getProtocol } from '../../core/protocol.js';
import { AgentDefs } from '../../core/agent-defs.js';
import { AgentContext } from '../../core/context.js';
import { Prompts } from '../../core/prompts.js';
import { Memory } from '../../core/memory.js';
import { ToolRunner } from '../../core/tool-runner.js';
import * as Run from './run.js';
import {
  me, activeProvider, paramsOf, promptBlocks, guardStreaming, adoptProject,
  curSess, persistSession, saveSettings, askConfirm, hooks, promptDraftCount,
} from './host.js';
import { toast } from '../components/ui/toast.jsx';

/* ============================ 初始化 ============================ */

export async function bootstrap() {
  const r = await StoreApi.init();
  // 单窗口占用：被顶掉的窗口冻结（点一下可夺回）
  Presence.onChange(() => patch({ presence: { active: Presence.isActive(), owner: Presence.ownerOf(), enforce: Presence.enforced() } }));
  Presence.start();

  if (!r.loggedIn) {
    patch({ ready: true, info: r.info, settings: defaultSettings(), sessions: [], history: [], projects: [], currentProjectId: '' });
    return;
  }
  const d = await StoreApi.pull();
  if (!d) {
    patch({ ready: true, info: r.info, settings: defaultSettings(), sessions: [], history: [], projects: [], currentProjectId: '' });
    toast('服务端数据拉取失败：先用默认设置启动，可稍后刷新重试', 'err');
    return;
  }
  applyServerData(d);
  patch({ ready: true, info: r.info });
  checkStatus();
  loadAgentStatus();
  updateCtx();
  /* 当前项目跟着当前会话走（服务端 projects.json 的 current 也对齐过去）：
     刷新前停在哪条对话，回来就还是哪个项目——菜单（项目卡/记忆面板）显示的就是它的数据。 */
  syncProjectWithSession();
  /* 上一次离开时可能还有一轮在服务端跑着（托管运行就是为此存在的）：
     有就接上继续看，没有就什么都不做。 */
  Run.reattach(state.activeSessId).catch(() => {});
}

/** 把服务端数据灌进 core 层的登记表与界面状态
 *  @param {object} d 服务端 /agent/store 的响应
 *  @param {{preferSess?:string}} [opts] preferSess = 优先保持"用户正在看的会话"（整份重拉时用：
 *         服务端的 currentSess 指针可能还没来得及写，跟着它走会让画面自己跳回上一条对话）。 */
export function applyServerData(d, opts = {}) {
  Prompts.load(d.prompts || {});
  const projects = Array.isArray(d.projects) ? d.projects : [];
  const curProject = projects.find((p) => p.id === d.currentProject) || null;
  const sessions = Array.isArray(d.sessions) ? d.sessions : [];
  const wantId = opts.preferSess || (d.settings && d.settings.currentSess);
  const active = sessions.find((s) => s.id === wantId) || sessions[0] || null;
  /* 会话记忆必须跟着**当前会话**灌进 core（第二个实参）。
     原先这里硬编码 []，而同函数的下一段明明加载了 active.msgs —— 于是刷新后会话记忆永远是空的，
     紧接着任何一次 persistSession（发送/改名/回撤/换 provider…）都会把这份空数组写回会话对象；
     服务端 store.js 只在 memory 非空时才写，于是**服务端那份也被空数组抹掉**：模型用
     memory_write(scope:'session') 记下的东西刷新即永久消失。与项目记忆"空列表回写"是同一类 bug。 */
  /* 项目记忆**不在这份数据里**（2026-10-01 归口）：全量 store 只给"当前项目指针"，
     项目记忆的唯一取数路径是 GET /agent/projects/memory?id=（见 projects.js 的
     refreshCurrentMemory / applyCurrentProject）。这里先把指针与项目事实灌好，
     条目由调用方紧接着的 syncProjectWithSession() 从服务端取回来。 */
  Memory.load(d.memory || [], active ? (active.memory || []) : []);
  // 项目事实（名字/根目录/记忆文件夹位置）灌给 core：注入区块与 memory_write 的 scope="project" 都靠它
  Memory.setProject(curProject
    ? { id: curProject.id, name: curProject.name, root: curProject.root, memoryDir: curProject.memoryDir }
    : null);
  StoreApi.setProjectId(curProject ? curProject.id : '');
  patch({
    settings: d.settings || defaultSettings(),
    sessions,
    activeSessId: active ? active.id : null,
    history: active ? (active.msgs || []).slice() : [],
    projects,
    currentProjectId: curProject ? curProject.id : '',
  });
  applyAppearance();
  updateCtx();
  /* 会话对象被换成服务端那份了：还在跑的那几条运行要把"正在生成"重新认到新对象上
     （事件按 liveId 寻址，认领这一步在 run.js 里）。 */
  Run.rehydrate();
}

/* ============================ 与服务端对齐（唯一真源=服务端） ============================
 *  三条链路，职责分开：
 *    syncProjectWithSession()  当前会话 → 当前项目（切换会话、载入数据后对齐；实现落在 projects.js）
 *    refreshLightSoon()        面板数据（记忆/提示词/项目清单）从服务端重拉——托管运行改过它们之后
 *    refreshAll()              整份重拉（含会话）——只在"以为还在跑、其实已经结束"那条路上用
 */

/** 当前项目 = 当前会话归属的项目（这就是"直接关联"的落点）。
 *  会话是用户此刻在看的东西，项目菜单/记忆面板都该显示它的数据；实现落在 ui/state/projects.js
 *  （它才持有项目清单与项目记忆端点；这里通过 hooks 调用，避免 session ↔ projects 循环 import）。 */
export function syncProjectWithSession(session) {
  const s = session || state.sessions.find((x) => x.id === state.activeSessId);
  if (!s || typeof hooks.onSessionChange !== 'function') return Promise.resolve(true);
  return Promise.resolve(hooks.onSessionChange(s)).catch(() => false);
}

/** 本地还有没落盘的改动时先等它落地：否则"服务端旧快照"会把刚改的记忆/设置盖回去。 */
async function whenWritesSettled() {
  for (let i = 0; i < 8; i++) {
    if (!StoreApi.pendingWrites || !StoreApi.pendingWrites()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/** 读某个项目的记忆条目（服务端真源）；失败返回 null（调用方保持现状，别用空数组覆盖）。 */
async function fetchProjectEntries(id) {
  if (!id) return null;
  try {
    const r = await get(`${EP.projectsMemory}?id=${encodeURIComponent(id)}`, { timeoutMs: 10000 });
    return Array.isArray(r.entries) ? r.entries : null;
  } catch { return null; }
}

/** 把"轻量拉取"（GET /agent/store?light=1）的结果装进界面与 core。
 *  **不碰会话/历史/当前会话指针**：那些是这一页的浏览状态，后台刷新不该改它们。 */
async function applyServerLight(d, projectId) {
  Prompts.load(d.prompts || {});
  /* 只灌全局与会话两类：**项目条目不经 load()**（它只有 setProject(meta, entries) 一条来路，
     条目与项目 id 必须一起给，见 core/memory.js）。旧写法把 serialize('project') 塞成第三个
     参数"免得触发 emit"——那条路已作废，条目一律由下面的唯一取数路径取回。 */
  Memory.load(d.memory || [], Memory.serialize('session'));
  if (Array.isArray(d.projects)) patch({ projects: d.projects });
  if (!projectId || String(state.currentProjectId || '') !== projectId) return;
  const entries = await fetchProjectEntries(projectId);
  if (entries) adoptProject((state.projects || []).find((x) => x.id === projectId) || Memory.projectMeta, entries);
}

let lightTimer = null;
/** 面板数据从服务端重拉（合并成一次延迟执行：一轮里模型可能连写好几条记忆）。
 *  调用点：托管运行的 data_changed（模型写了记忆/技能/提示词）。生成中会跳过——事件流正
 *  写着消息对象，等这轮结束（settle → refreshAllSoon）再拉。 */
export function refreshLightSoon(delay = 1200) {
  if (lightTimer) return;
  lightTimer = setTimeout(async () => {
    lightTimer = null;
    const live = state.runs[state.activeSessId];
    if (!StoreApi.user || (live && !live.settled)) return;   // 当前这条在流式：先不拉（避免换掉直播对象）
    if (!(await whenWritesSettled())) return;
    const d = await StoreApi.pullLight();
    if (d) await applyServerLight(d, String(state.currentProjectId || ''));
  }, delay);
}

/** 整份重拉（含会话）并应用。@param {{onlyIfSession?:string}} 期间换了会话就放弃这次结果 */
const userKey = () => (StoreApi.user ? String(StoreApi.user.username || '') : '');

/** 这次重拉的结果还能不能用（await 期间世界可能已经变了 —— 重拉是锦上添花，
 *  绝不能拿旧快照去盖更新的东西）：
 *   · 又开了一轮（state.streaming=true）：刚乐观插入的提问/占位会被旧快照换掉；
 *   · 用户切了会话（onlyIfSession 之外）；
 *   · 换了身份（登出/换账号）：上一账号的 sessions/projects 不能灌进已登出的界面。 */
function canApply(who, onlyIfSession, force) {
  /* 正在流式的会话**不能**被服务端快照盖掉（会把它那条直播消息换回半截快照）。
     判据是"**这条**会话在跑"，不是 state.streaming —— 多会话并行时，
     别的会话在跑不该挡住这条会话的刷新（2026-10-01 起可以同时跑好几条）。 */
  if (!force && state.runs[state.activeSessId] && !state.runs[state.activeSessId].settled) return false;
  if (onlyIfSession && state.activeSessId !== onlyIfSession) return false;
  return userKey() === who;
}

export async function refreshAll({ onlyIfSession, force } = {}) {
  const who = userKey();
  if (!who || !(await whenWritesSettled())) return false;
  const d = await StoreApi.pull();
  if (!d || !canApply(who, onlyIfSession, force)) return false;
  applyServerData(d, { preferSess: onlyIfSession });
  /* 全量数据里没有项目记忆（唯一取数路径是 /agent/projects/memory）：紧接着取回来。
     这一轮可能是模型刚写完记忆（data_changed / 一轮结束），面板显示的就是服务端那份。 */
  await syncProjectWithSession();
  return true;
}

/** 一轮托管运行结束后（稍等一会儿再）整份重拉：会话标题、最终内容、项目归属、记忆面板
 *  都是**服务端写的那份**（服务端在广播 end 之前已经落盘，见 lib/agent/run.js 的 finish）。
 *  延迟是留给服务端那几笔"模型写记忆"的异步写盘落地。 */
export function refreshAllSoon(sessionId, delay = 1500) {
  setTimeout(async () => {
    if (!sessionId || state.activeSessId !== sessionId) return;
    const r = state.runs[sessionId];
    if (r && !r.settled) return;                 // 这条又开了一轮：别拿快照去盖正在流的消息
    await refreshAll({ onlyIfSession: sessionId }).catch(() => { /* 下次载入还会拉 */ });
  }, delay);
}

/* 托管运行（ui/state/run.js）通过 host 的钩子回调这里：它不直接 import 本文件，避免模块环 */
hooks.onRunDataChanged = () => refreshLightSoon();
hooks.onRunEnded = (sessionId) => {
  /* **不再由客户端把这一轮写回会话**：运行在服务端跑，落盘也在服务端做完了
     （lib/agent/run-loop.js 的 finish 是"写完再广播 end"），事件流已经把最终内容写进
     会话对象了。客户端再写一次只会有两种结果：要么内容一模一样（白写一次），
     要么客户端那份落后（用它覆盖服务端反而丢东西）。
     要拉的是"只有服务端才知道"的东西：标题/摘要/会话记忆（end 事件已带回）、
     面板数据（记忆/提示词/技能，模型可能刚写过）——所以下面只重拉面板 + 当前会话。 */
  refreshLightSoon();
  if (state.activeSessId === sessionId) refreshAllSoon(sessionId);
};
hooks.onPullLatest = (sessionId) => refreshAll({ onlyIfSession: sessionId });
/* 掉线期间某条会话跑完了（hub 重连时快照里已经没有它）：本地那份正文可能不完整，
   以服务端落盘的那份为准整份重拉（force：当前会话正在流式也要拉，拉完 rehydrate 会接回去）。 */
hooks.onSessionStale = () => { refreshAll({ force: true }).catch(() => { /* 下次载入还会拉 */ }); };

/** 主题/强调色/字号/密度 → <html> 上的 data 属性（CSS 只认属性，不认 JS） */
export function applyAppearance() {
  const t = (state.settings && state.settings.theme) || {};
  const mode = t.mode === 'system'
    ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : (t.mode === 'light' ? 'light' : 'dark');
  const el = document.documentElement;
  el.setAttribute('data-theme', mode);
  el.setAttribute('data-accent', t.accent || 'blue');
  el.setAttribute('data-density', t.density || 'cozy');
  el.setAttribute('data-fontscale', String(t.scale || 1));
}

/* ============================ 状态探测 ============================ */

export async function checkStatus() {
  const p = activeProvider();
  if (!p) { patch({ status: { connected: false, models: [], error: '还没有配置模型', model: '' } }); return; }
  patch({ status: Object.assign({}, state.status, { checking: true, model: p.model }) });
  try {
    const models = await getProtocol(p.type).listModels(p);
    patch({ status: { connected: true, checking: false, models, error: '', model: p.model } });
  } catch (e) {
    patch({ status: { connected: false, checking: false, models: [], error: e.message || String(e), model: p.model } });
  }
}

/* 工具/绑定状态：**只走 core/tool-runner.js 那一条**（它带缓存、失败只告警、拿到后经 onStatus
   回调写同一份 state.agentStatus）。这里原先又写了一遍 fetch + patch —— 同一份状态两条写入路径，
   缓存语义只在一条上生效（审计）。 */
export async function loadAgentStatus() {
  if (!me()) { patch({ agentStatus: null }); return null; }
  return ToolRunner.loadAgentStatus(true);
}

/* ============================ 上下文用量 ============================ */

export function updateCtx() {
  const p = activeProvider();
  const limit = ctxLimitOf(state.settings || {}, p, paramsOf(p && p.id, p && p.model));
  const c = AgentContext.ctxUsage('');
  patch({
    ctx: {
      used: c.total, limit,
      pct: limit ? Math.min(100, Math.round((c.total / limit) * 100)) : 0,
      state: c.total > limit * 0.9 ? 'danger' : c.total > limit * 0.7 ? 'warn' : 'ok',
      sysTok: c.sysTok, histTok: c.hist,
    },
  });
}

/* ============================ 会话 ============================ */

const newId = () => 's-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/** 新会话默认归属**当前项目**（有的话）：侧栏按项目分组、项目记忆跟着项目走 */
const projectOf = (opts) => (opts && opts.project !== undefined ? String(opts.project || '') : String(state.currentProjectId || ''));

/** 把"当前会话指针"写到服务端配置。**每次换会话都必须写**：
 *  它是"刷新/重开回到哪条对话"的唯一依据（`applyServerData` 按 settings.currentSess 挑当前会话）。
 *  原先只有 selectSession 写它——newSession/ensureSession 建完就走，
 *  于是新会话跑完一轮、下一次整份重拉（运行结束 / 换设备）会把画面切回**上一条**会话
 *  （实测：切项目建的"新对话"里跑完一轮，画面自己跳回旧会话，看着像这一轮没发生）。 */
function saveCurrentSess(id) {
  patch({ settings: Object.assign({}, state.settings, { currentSess: id }) });
  saveSettings();
}

export function ensureSession() {
  let s = curSess();
  if (s) return s;
  s = { id: newId(), title: '新对话', ts: Date.now(), provider: (activeProvider() || {}).id || '', project: projectOf(), msgs: [] };
  const sessions = [s, ...state.sessions];
  patch({ sessions, activeSessId: s.id, history: [] });
  StoreApi.queueSession(s);
  saveCurrentSess(s.id);
  return s;
}

export function newSession(opts) {
  /* 新建对话**不**受别的会话在跑影响（多会话并行的基本体验：一边跑一边开新话题） */
  /* 「新建」必须**真的换一条会话**（换 id）：旧实现拿 ensureSession() 的返回值当新会话，
     那函数在当前会话存在时原样返回它 —— 于是"新建"只是把当前会话挪到列表最前、界面上清空，
     旧消息仍留在 s.msgs 里，下一次 persistSession 才被新内容覆盖掉。两个后果：
       ① 侧栏"N 个对话"永远只有一条；
       ② 会话标识头（opencode 靠它做路由与提示词缓存）在两段对话里是同一个 id，缓存全打散。
     当前会话一条消息都没有时仍然复用它，免得连点两下堆出一串空"新对话"。 */
  const cur = curSess();
  if (cur && !(cur.msgs || []).length) {
    cur.project = projectOf(opts);
    patch({ sessions: [cur, ...state.sessions.filter((x) => x.id !== cur.id)], activeSessId: cur.id, history: [] });
    StoreApi.queueSession(cur);
    saveCurrentSess(cur.id);
  } else {
    const s = { id: newId(), title: '新对话', ts: Date.now(), provider: (activeProvider() || {}).id || '', project: projectOf(opts), msgs: [] };
    patch({ sessions: [s, ...state.sessions], activeSessId: s.id, history: [] });
    StoreApi.queueSession(s);
    saveCurrentSess(s.id);
  }
  Prompts.clearLoaded();
  Memory.clearSession();
  AgentContext.invalidateCompaction();
  Run.syncActive();
  updateCtx();
}

export function selectSession(id) {
  /* **生成中也能切会话**（多会话并行的一半就在这里）：统一事件口是一条 SSE 看全部，
     切走只是换个显示对象，服务端那几条运行照跑，界面照样实时更新。
     要拦的是"改这条会话内容"的动作（清空/回撤/归档），它们各自有 guardStreaming。 */
  const s = state.sessions.find((x) => x.id === id);
  if (!s) return;
  Run.detach();                     // 兼容旧语义（统一口下是空操作）
  patch({ activeSessId: id, history: (s.msgs || []).slice() });
  Prompts.clearLoaded();
  /* 只换"会话记忆"那一段：全局与项目记忆由各自的来源决定，不随会话变。
     Memory.load 只碰全局与会话两类、且各自有变化才 emit（2026-10-03 起事件还带作用域），
     所以这里不会排出"项目记忆整份覆盖"这类无用的写请求。
     审计 C11：旧写法把 global/project 也 serialize 一遍塞回去，注释说"只换会话那一段"、
     实现却会各自 emit 一次，平白排两条整份覆盖写请求。 */
  Memory.load(Memory.serialize('global'), s.memory || []);
  AgentContext.invalidateCompaction();
  /* currentSess 与 activeId 一次性写：两次 patch + 两次 saveSettings 会让
     Store 的防抖写入器白跑一轮（同一次点击内，中间那份快照没有任何人会读到）。 */
  const want = s.provider;
  const switchProvider = !!(want && state.settings.providers.some((p) => p.id === want) && want !== state.settings.activeId);
  patch({
    settings: Object.assign({}, state.settings, {
      currentSess: id,
      ...(switchProvider ? { activeId: want } : {}),
    }),
  });
  saveSettings();
  if (switchProvider) checkStatus();
  updateCtx();
  /* 会话即项目：切到哪条对话，"当前项目"就跟到它归属的项目。
     否则会出现"我在看 B 项目的对话，侧栏/记忆面板却还是 A 项目"——
     而服务端跑这一轮时用的是**会话**的项目记忆，两边就对不上了（实测复现过）。 */
  syncProjectWithSession(s);
  Run.syncActive();                 // 这条会话在跑吗？——决定 Composer 显示"停止"还是"发送"
}

export function renameSession(id, title) {
  const s = state.sessions.find((x) => x.id === id);
  if (!s) return;
  s.title = String(title || '').slice(0, 40) || '新对话';
  StoreApi.queueSession(s);
  touch();
}

/** 归档一个对话（侧栏的按钮，原先是"删除"）：搬进账号目录里的归档区，**不丢任何内容**，
 *  随时可以在「设置 → 存档」里恢复或彻底删除。所以这里不问确认——可逆的操作不该拦人。 */
export async function archiveSession(id) {
  /* 只拦"正在跑的那条会话"：归档会让服务端把它搬走，而运行还在往里写（会写回一个已归档的会话） */
  if (Run.isRunning(id)) { toast('这条对话正在生成回答：先点「停止」或等它结束再归档', 'info'); return; }
  const s = state.sessions.find((x) => x.id === id);
  const wasActive = state.activeSessId === id;
  const sessions = state.sessions.filter((x) => x.id !== id);
  patch({ sessions });
  await StoreApi.archiveSession(id);          // 先取消它在途的落盘，再让服务端搬走
  if (wasActive) {
    const next = sessions[0] || null;
    if (next) selectSession(next.id);
    else { patch({ activeSessId: null, history: [] }); ensureSession(); }
  }
  toast(`已归档「${(s && s.title) || '对话'}」——设置 → 存档 里可以恢复`, 'ok');
}

export function clearChat() {
  if (guardStreaming('清空对话')) return;
  const s = ensureSession();
  s.msgs = []; s.title = '新对话'; s.ts = Date.now(); s.memory = []; delete s.compaction;
  Memory.clearSession();
  Prompts.clearLoaded();
  AgentContext.invalidateCompaction();
  patch({ history: [] });
  persistSession();
  updateCtx();
  toast('已清空当前对话');
}

/** 回撤最后一轮（提问放回输入框） */
export async function undoLast() {
  if (guardStreaming('回撤')) return;
  const h = state.history;
  let i = -1;
  for (let k = h.length - 1; k >= 0; k--) if (h[k].role === 'user') { i = k; break; }
  if (i < 0) { toast('没有可回撤的提问'); return; }
  const text = h[i].content;
  if (!(await askConfirm({ title: '回撤最后一轮？', body: '这条提问与它后面的回答都会从对话里移除（提问会放回输入框）。', okText: '回撤' })).ok) return;
  patch({ history: h.slice(0, i) });
  persistSession();
  updateCtx();
  return text;
}

/** 删除某一轮的整对消息（用户 + 回答） */
export function deleteRound(msgIndex) {
  const h = state.history.slice();
  const i = msgIndex >= 0 && h[msgIndex] && h[msgIndex].role === 'user' ? msgIndex : h.findIndex((m, k) => k >= msgIndex && m.role === 'user');
  if (i < 0) return;
  let end = i + 1;
  while (end < h.length && h[end].role !== 'user') end++;
  patch({ history: h.slice(0, i).concat(h.slice(end)) });
  persistSession();
  updateCtx();
}

/* ============================ 发送 / 插话 / 停止 ============================ */

/* 以前这里有一整套"在浏览器里跑循环"的东西：abortCtl、steeringQueue、touchSoon/flushTouch
   节流、steerMessage/steerLabel、以及 send 拆出来的 runTurn / turnHooks / steeringTakers。
   循环搬去服务端（lib/agent/run.js）之后它们全部失去意义——插话队列、中断信号、重绘节流
   都跟着那一轮运行走（见 ui/state/run.js），留在客户端只会变成"看起来在管、其实管不着"的死代码。
   审计的教训正是这一类：**承重的判断要看行为，不看引用**。 */

/** 生成中的输入 = 插话（Steering，不打断当前调用，下一轮开始前注入）。
 *  队列在**服务端**那一段运行里（见 lib/agent/run.js 的 steering）：浏览器关掉再回来，
 *  排着的插话照样会被注入——放在这里的队列会随页面一起消失。 */
/** @returns {Promise<boolean>} 是否真的送到服务端——调用方（Composer）据此决定要不要清空草稿：
 *  失败还清空 = 用户刚打的一段字静默消失（2026-10-01 审计）。 */
export async function steer(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (!Run.activeRunId()) { toast('这一轮已经结束了，直接把刚才的话发出来吧', 'info'); return false; }
  const ok = await Run.steerRun(t);
  if (ok) toast('已插话：下一轮开始前生效', 'ok');
  return ok;
}

/** 停止：让服务端停下这一轮（不是断开观看——断开不影响它） */
export function stop() {
  Run.stopRun();
}

/** 重新生成最后一轮回答 */
export async function regenerateLast() {
  if (state.streaming) return;
  const h = state.history;
  let i = -1;
  for (let k = h.length - 1; k >= 0; k--) if (h[k].role === 'user') { i = k; break; }
  if (i < 0) { toast('没有可重新生成的提问'); return; }
  const text = h[i].content;
  patch({ history: h.slice(0, i) });
  persistSession();
  await send(text);
}

/* ============================ 一轮对话（send）的四个阶段 ============================
 *  send() 原先是一个 207 行、复杂度 45 的函数：前置校验、生成前组装、跑内核、收尾清理挤在一起，
 *  六个可变变量（content/thinking/stats/live/steeringTraces/lastSave）被 try/catch/finally 三个出口
 *  共享，任何改动都要在 200 行里找位置（审计）。现在按阶段拆开，每个阶段只做一件事：
 *    startTurn()    生成前的组装：消息与实时气泡、注入预览、预算、请求参数
 *    trimIfNeeded() 上下文超限的兜底裁剪（压缩提示词关掉时才用）
 *    runTurn()      跑内核（Agent.run + 回调），只回结果，不碰外部状态
 *    deliverTurn()  正常收尾：合并追踪条、写回内容、落盘
 *    failTurn()     三类中断（被顶 / 停止 / 失败）的收尾
 *  一次 send 的全部可变状态都装在 turn 对象里传，不再靠闭包散落。
 */

/** 生成前的组装：把"这一轮要发什么"记在消息上。
 *  **发给模型的那份组装在服务端做**（core/assemble.js，与这里同一份实现）——
 *  这里只负责界面上要显示的两件事：占位消息与"注入了哪些区块"的预览。 */
function startTurn(p, text) {
  const p0 = paramsOf(p.id, p.model);
  const inject = promptBlocks();
  const defs = AgentDefs.activeToolDefs();
  const injected = (defs.length || inject.blocks.length)
    ? { summary: injectSummary(inject, defs), text: injectText(inject, defs).slice(0, 8000) } : null;

  /* 本轮**之前**的历史单独留一份交给服务端：它接手后看到的消息必须与用户屏幕上的一致，
     而"本条提问 + 助手占位"由服务端自己追加（两边都追加 = 同一条提问写两遍，实测踩过）。 */
  const before = state.history.slice();
  const live = {
    id: newMsgId(),
    role: 'assistant', content: '', thinking: '', stats: null, trace: [],
    injected, wallMs: 0, streaming: true,
  };
  /* 这条提问与占位**同时写进会话对象与 history**（两边是同一批对象）：
     · history 是界面正在画的那份；会话对象是"切走再切回来 / 下一次发送的 before"那份。
       只写 history 的话，切到别的会话再切回来就看不到刚发的这一轮（实测踩到：
       新建对话甚至认不出"当前会话已经有消息了"，于是"新建"变成原地清屏）。
     · 服务端仍会按 run.history 整份落盘（下面**不落盘**：两边都写会在防抖窗口里互相覆盖，
       也修不掉"同一条提问写两遍"的根）。 */
  const next = before.concat([{ id: newMsgId(), role: 'user', content: text }, live]);
  const sess = curSess();
  if (sess) sess.msgs = next;
  patch({ history: next });
  return { p, text, defs, injected, live, p0, before, t0: (globalThis.performance || Date).now() };
}

/** 中断收尾：已流出的内容一律保留，一个字都没有才删占位；被顶掉的那次不落盘（别覆盖对方） */
/** **启动**失败（服务端没接上 / 已被另一段运行占用 / 未登录）：把占位换成一句可读的错误。
 *  注意分工：一旦 start 成功，这一轮的收尾就归服务端管（见 ui/state/run.js 的 settle）。
 *  客户端"跑到一半断线"不是失败——那只是观众走了，服务端继续跑并把内容留下。 */
function failTurn(turn, e) {
  const msg = (e && e.message) || String(e);
  Object.assign(turn.live, { content: '', error: '请求失败：' + msg });
  delete turn.live.streaming;
  persistSession();
  if (e && e.needLogin) hooks.openLogin('模型密钥保存在服务器端，请先登录');
}

/* 注：这里原有 requeueSteering()——把"队列里没注入的插话"放回输入框。
   插话队列已经跟着运行搬到服务端（lib/agent/run.js），服务端在停止时会把它交回给
   订阅者（steer_accepted / end 事件），客户端不再自己排队，也就没有"没注入的残留"。 */

/** 发送前的闸门：返回一句"为什么不能发"（null = 可以发）。
 *  集中在这里，send() 本体就只剩"组装 → 交给服务端"两步。 */
function blockReason() {
  if (!activeProvider()) return '先配置一个模型（设置抽屉 → 模型）';
  if (Presence.enforced() && !Presence.isActive()) return '这个窗口已被顶掉：点「在此窗口继续」接管后才能发送';
  /* 托管运行要有账号才有意义（模型配置、会话、记忆都按账号存在服务端）：
     未登录时不发——否则会走到一个必然 401 的路上。 */
  if (!me()) return '未登录：请先登录（模型配置与会话都按文档站账号保存）';
  return null;
}

export async function send(userText) {
  if (state.streaming) { steer(userText); return; }
  const why = blockReason();
  if (why) { toast(why, 'err'); return openDrawer(why.startsWith('先配置') ? 'models' : undefined); }
  const text = String(userText === undefined ? state.draft : userText).trim();
  if (!text) return;
  if (userText === undefined) patch({ draft: '' });

  ensureSession();
  // 提示词登记表是"草稿 → 应用"制：还有没应用的草稿就提醒一句，免得以为已经生效
  // （草稿的真源是 state.promptDrafts；旧实现调的是一个从未存在的 Prompts.isDirty()，永不触发）
  const pendingPrompts = promptDraftCount();
  if (pendingPrompts) toast(`提示：提示词登记表有 ${pendingPrompts} 处未应用的修改，点「应用」后才生效`, 'info');

  const p = activeProvider();
  const turn = startTurn(p, text);
  /* 交给服务端跑（ui/state/run.js）：循环在服务端，**关掉浏览器也会跑完并落盘**。
     界面的收尾不再由这里负责——run.js 收到 end 事件时会把这条消息结清。 */
  try {
    await Run.startRun({
      sessionId: state.activeSessId, text, providerId: p.id, live: turn.live, before: turn.before,
      /* 本地还有没落盘的编辑（回撤/删除/改名）时告诉服务端：**以我这份为准**。
         否则"我这边刚删掉最后一轮"会被服务端的对账规则当成"我落后了"而把它变回来
         （见 core/sessions.js 的 reconcileHistory）。 */
      localEdits: StoreApi.hasPendingSession(state.activeSessId),
    });
  } catch (e) {
    failTurn(turn, e);
  } finally {
    updateCtx();
  }
}

/* 注：这里原有 removeLive()（一个字都没生成时把助手占位删掉）与 mergeTrace 的收尾合并——
   它们服务于"浏览器自己跑循环"的失败路径。循环搬到服务端后，失败/停止都由服务端收尾
   （内容一定保留、绝不静默删占位），客户端只负责显示，这两件工具随之退场。 */

/* ---- 注入预览的摘要文本（给界面看：这一轮到底塞了哪些区块） ---- */
function injectSummary(inject, defs) {
  const names = inject.blocks.map((b) => b.title || b.id);
  return `注入 ${inject.blocks.length} 个区块、${defs.length} 个工具：${names.join(' · ')}`;
}
function injectText(inject, defs) {
  const blocks = inject.blocks.map((b) => `# ${b.title || b.id}\n${b.text}`).join('\n\n---\n\n');
  const tools = defs.map((d) => `- ${d.function.name}${d.function.description ? '：' + d.function.description : ''}`).join('\n');
  return `${blocks}\n\n# 注册的工具（${defs.length}）\n${tools}`;
}

/* 工具卡片标题（labelOf）搬去了 core/agent-defs.js：托管运行的 trace 是**服务端**落盘的，
   标题必须在两边同一处生成，否则会出现"浏览器里跑的是「命令：ls」、服务端落盘的是 run_command"。 */

/* ============================ 抽屉（仅界面状态） ============================ */

export function openDrawer(section) {
  patch({ drawer: { open: true, section: section || state.drawer.section } });
}
export function closeDrawer() {
  patch({ drawer: Object.assign({}, state.drawer, { open: false }) });
}

