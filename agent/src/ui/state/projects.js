/* ui/state/projects.js —— 项目动作：选/建/改名/删项目、目录浏览、会话与项目记忆的跟随
 *
 *  「项目」= 一个根目录（用户挑的），会话归属项目、项目记忆跟着项目走。
 *  四条约定（都是踩过的那类坑）：
 *    · **切项目 = 真的换会话**：项目是"我在做的这件事"，切过去就该看到这件事的对话
 *      （没有就新建一条归属它的），否则侧栏分组与当前对话会对不上；
 *    · **反过来，切会话也要换项目**（followSessionProject）：会话的 project 是"当前项目"的
 *      唯一真源——你看哪条对话，菜单/记忆面板就显示哪个项目的数据。两个方向必须是同一份
 *      adoptProject，不然又会出现"一边换了一边没换"（2026-10-01 用户报的就是这个）；
 *    · **项目记忆与服务端同步靠 Memory.onChange**（host.js 里接线）：这里只负责把
 *      服务端返回的条目灌进 core，别在这里手动排队写盘（会重复写、也会把空数组写回去）；
 *    · **写项目记忆前必须先把当前项目 id 灌给 Store**（core/store.js 的 setProjectId）——
 *      否则那份记忆会被写到一个不存在的地方（或者上一个项目）。顺序由 adoptProject 保证。
 */
import { state, patch } from './store.js';
import { EP } from '../../core/endpoints.js';
import { get, post } from '../../core/http.js';
import { Memory } from '../../core/memory.js';
import { Store } from '../../core/store.js';
import { selectSession, newSession } from './session.js';
import { adoptProject, guardStreaming, hooks } from './host.js';
import { toast } from '../components/ui/toast.jsx';

const byId = (id) => (state.projects || []).find((p) => p.id === id) || null;

/** 读某个项目的记忆条目（服务端账号目录里的 Markdown 文件夹，唯一真源）。
 *  失败返回 **null**（调用方据此放弃这次切换，绝不拿空数组当"这个项目没有记忆"——
 *  那会把服务端那份覆盖成空的）。quiet = 不弹提示（后台刷新用）。 */
async function fetchProjectMemory(id, { quiet } = {}) {
  if (!id) return [];
  try {
    const d = await get(`${EP.projectsMemory}?id=${encodeURIComponent(id)}`, { timeoutMs: 10000 });
    return Array.isArray(d.entries) ? d.entries : [];
  } catch (e) {
    if (!quiet) toast('读取项目记忆失败：' + e.message, 'err');
    return null;
  }
}

/** 把"当前项目"写到服务端（projects.json 的 current）。返回是否成功。 */
async function setServerCurrent(id) {
  try { await post(EP.projectCurrent, { id }, { timeoutMs: 10000 }); return true; }
  catch (e) { toast('切换项目失败：' + e.message, 'err'); return false; }
}

/** 当前项目 id（'' = 不归属任何项目）——读写 state 的口径集中在这一处 */
const currentProjectId = () => String(state.currentProjectId || '');

/** 换项目成功后的提示（名字可能已不在清单里，兜底用 id） */
function toastSwitched(want) {
  const name = (byId(want) || {}).name || want;
  toast(want ? `已切换到项目「${name}」` : '已退出项目（对话不再归属项目）', 'ok');
}

/** **换"当前项目"的唯一实现**（两个入口共用：设置里选项目、点开别的项目的会话）。
 *  顺序：先拉这个项目的记忆（服务端真源）→ 写服务端 current → 灌 core。
 *  @param {string} want 目标项目 id（'' = 不归属任何项目）
 *  @param {() => boolean} [stillWanted] 每个 await 之后问一句"还要不要换"（连续切换时防串台） */
async function applyCurrentProject(want, stillWanted) {
  const lapsed = () => !!stillWanted && !stillWanted();
  const entries = await fetchProjectMemory(want);
  if (entries === null || lapsed()) return false;
  if (!(await setServerCurrent(want)) || lapsed()) return false;
  patch({ currentProjectId: want });
  adoptProject(want ? (byId(want) || { id: want, name: want, root: '', memoryDir: '' }) : null, entries);
  return true;
}

/** 该项目最近处理过的会话（侧栏排序口径：ts 最新） */
const latestSessionOf = (id) => (state.sessions || [])
  .filter((s) => (s.project || '') === id)
  .sort((a, b) => (b.ts || 0) - (a.ts || 0))[0] || null;

/** 会话跟着项目走（切项目 / 建项目共用）：
 *  · 当前会话已经属于它 → 不动；
 *  · 当前会话是**空的新对话** → 直接归过去（它就是为"接下来这件事"开的，改归属没有副作用）；
 *  · 否则 → 切到该项目最近处理过的对话；一条都没有才新建。
 *  **绝不能把有消息的会话改归属**：那是把用户的历史对话搬进另一个项目（实测踩过：
 *  新建项目时把当前那条"你是什么agent"改成了新项目，侧栏一看像是对话被搬走了）。 */
function followProject(id) {
  const cur = state.sessions.find((s) => s.id === state.activeSessId);
  if (cur && (cur.project || '') === id) return;
  if (cur && !(cur.msgs || []).length) {
    cur.project = id;
    Store.queueSession(cur);
    return;
  }
  const next = latestSessionOf(id);
  if (next) selectSession(next.id);
  else newSession({ project: id });
}

/** 切到某个项目（id 传 '' = 不归属任何项目）：换项目记忆 + 换到该项目的最近会话 */
export async function selectProject(id, { silent } = {}) {
  if (guardStreaming('切换项目')) return false;
  const want = String(id || '');
  if (want && !byId(want)) return false;
  /* 已经是它、而且当前会话也在它下面 → 什么都不用做。
     注意不能只看 currentProjectId：用户可能"在看 A 项目的对话、当前项目却是 B"，
     这时点 B 要做的正是 followProject（换回 B 的对话）。 */
  const curSess = state.sessions.find((s) => s.id === state.activeSessId);
  const sameProject = want === currentProjectId();
  const sameSession = String((curSess && curSess.project) || '') === want;
  if (sameProject && sameSession) return true;
  /* 连续点两个项目时防串台：applyCurrentProject 里有两次 await（拉记忆、写 current），
     解析顺序不一定等于点击顺序——没有这道序号，最后停下的可能是**先点**的那个
     （本地指针、服务端 current、以及项目记忆的写入目标一起错，2026-10-01 审计）。
     与 followSessionProject 用同一套写法。 */
  const stillWanted = nextAlignGuard();
  if (!(await applyCurrentProject(want, stillWanted)) || !stillWanted()) return false;   // 期间又点了别的项目：不 follow、不提示

  followProject(want);
  if (!silent) toastSwitched(want);
  return true;
}

/** 切会话 → 对齐"当前项目"，并把**这个项目的记忆**从服务端取回来
 *  （session.js 通过 hooks.onSessionChange 调这里；全量 store 里不再带项目记忆，
 *   所以"载入数据 / 换会话 / 打开面板"都靠这里那一次 GET 把条目带回来）。
 *  与 selectProject 的分工：**这个不动会话**（会话正是用户刚点开的那条），
 *  只把当前项目、项目记忆与服务端的 current 指针换过去——"当前项目"的唯一真源就是当前会话的 project。
 *  会话切换可能连着点好几条，所以带序号防串台：期间又切走了就丢弃这次结果。 */
let alignSeq = 0;
/** "还要不要这次切换"的判据：连续切换时只有**最后一次**算数（切项目/切会话共用） */
function nextAlignGuard() {
  const seq = ++alignSeq;
  return () => seq === alignSeq;
}
export function followSessionProject(session) {
  const sessionId = session && session.id;
  const want = String((session && session.project) || '');
  if (!sessionId) return Promise.resolve(true);
  /* 项目没变（同项目里换对话）：也要把记忆取一遍——它可能被模型刚改过，
     而且这是唯一取数路径；有没落盘的本地改动时 refreshCurrentMemory 会自己跳过。 */
  if (want === currentProjectId()) return refreshCurrentMemory();
  const seq = ++alignSeq;
  return applyCurrentProject(want, () => seq === alignSeq && state.activeSessId === sessionId);
}

/** 当前项目的记忆从服务端重拉一份（界面显示的唯一来源就是它）。
 *  调用点：打开「设置 → 记忆」面板时 / 托管运行结束或改过数据后（见 session.js 的 refreshLightSoon）。
 *  **本地待写先落地再取**（2026-10-03 改）：旧实现在"有本地待写"时**直接跳过取数**，
 *  于是那份陈旧的（往往是空的）快照一直留在手里，紧接着就被整份写回服务端——
 *  抖音热点项目被清空的事故就是这么发生的。正确顺序是：把本地改动先写上去（幂等），
 *  再用服务端那份刷新显示；两边的写目标是同一个项目，后到的服务端数据才是真源。 */
export async function refreshCurrentMemory({ quiet = true } = {}) {
  const id = currentProjectId();
  if (!id || !Store.user) return null;
  if (Store.flushProjectMemory) { try { await Store.flushProjectMemory(); } catch { /* 写不上去就按下面的取数兜底 */ } }
  const entries = await fetchProjectMemory(id, { quiet });
  if (entries === null || currentProjectId() !== id) return null;
  adoptProject(byId(id) || Memory.projectMeta, entries);
  return entries;
}

/* session.js 切会话时回调这里（循环 import 的替代：会话那边只认钩子，不认项目模块） */
hooks.onSessionChange = (s) => followSessionProject(s);
/* 项目记忆的整份覆盖被服务端拒了（409 conflict）→ 把真实那份取回来。
   走到这里说明手里那份是空的/陈旧的（正常路径不该发生，是兜底自愈）。 */
hooks.onMemoryConflict = () => refreshCurrentMemory({ quiet: false });

/** 新建项目：选一个根目录 → 服务端建项目记忆文件夹 → 设为当前项目 */
export async function createProject(root, name) {
  const path = String(root || '').trim();
  if (!path) { toast('先选一个目录', 'err'); return null; }
  if (guardStreaming('新建项目')) return null;
  try {
    const d = await post(EP.projectCreate, { root: path, name }, { timeoutMs: 20000 });
    const p = d.project;
    /* 服务端在建项目时会种下"项目根目录"那条记忆；这里**必须拿到真实条目**再灌给 core ——
       灌空列表会让 Memory.onChange 把空数组写回去，刚生成的种子记忆当场被抹掉（实测踩过）。 */
    let entries = Array.isArray(d.entries) ? d.entries : [];
    if (!entries.length) {
      try { entries = (await get(`${EP.projectsMemory}?id=${encodeURIComponent(p.id)}`, { timeoutMs: 10000 })).entries || []; }
      catch { /* 拉不到就按空处理，下次进记忆面板会重新拉 */ }
    }
    patch({ projects: [...(state.projects || []).filter((x) => x.id !== p.id), p], currentProjectId: p.id });
    adoptProject(p, entries);
    followProject(p.id);
    toast(`已建立项目「${p.name}」，项目记忆文件夹已生成`, 'ok');
    return p;
  } catch (e) {
    toast('建立项目失败：' + e.message, 'err');
    return null;
  }
}

export async function renameProject(id, name) {
  try {
    const d = await post(EP.projectRename, { id, name }, { timeoutMs: 10000 });
    patch({ projects: (state.projects || []).map((p) => (p.id === id ? d.project : p)) });
    if (state.currentProjectId === id) adoptProject(d.project);
    toast('项目已改名', 'ok');
  } catch (e) { toast('改名失败：' + e.message, 'err'); }
}

/* 注：这里原有 removeProject()（调 EP.projectDelete 彻底删项目）。界面上"删除项目"已改成
   **归档**（侧栏/设置 → 存档里可恢复，见 archiveProject 与 lib/agent/archive.js），
   该函数全仓零调用 —— 审计时删除。服务端端点仍在（存档里的"彻底删除"走它）。 */

/** 目录浏览（选择器用；path 省略 = 从**项目起点**起步，一路只能在起点内往下走） */
export async function browseDir(path) {
  const q = path ? `?path=${encodeURIComponent(path)}` : '';
  return get(`${EP.projectsBrowse}${q}`, { timeoutMs: 10000 });
}

/** 改项目起点（默认 /media/leo/DATA/workspace）：只约束"项目放哪"，不影响 agent 能读写哪些目录 */
export async function setStart(path) {
  const p = String(path || '').trim();
  if (!p) { toast('先填一个目录', 'err'); return false; }
  try {
    const d = await post(EP.toolsStart, { action: 'start', path: p }, { timeoutMs: 10000 });
    const settings = Object.assign({}, state.settings, {
      tools: Object.assign({}, (state.settings && state.settings.tools) || {}, { start: d.start }),
    });
    patch({ settings });
    const st = state.agentStatus;
    if (st) patch({ agentStatus: Object.assign({}, st, { start: d.start }) });
    toast('起点已更新：' + d.start, 'ok');
    return true;
  } catch (e) { toast('改起点失败：' + e.message, 'err'); return false; }
}

/* ============================ 归档（存档） ============================ */

/** 归档一个项目：**连它下面的会话一起**搬进归档区（记忆文件夹整份搬走），随时可恢复 */
export async function archiveProject(id) {
  if (guardStreaming('归档项目')) return false;
  try {
    const d = await post(EP.projectArchive, { id }, { timeoutMs: 30000 });
    const projects = (state.projects || []).filter((p) => p.id !== id);
    const gone = (state.sessions || []).filter((s) => (s.project || '') === id).map((s) => s.id);
    const sessions = (state.sessions || []).filter((s) => !gone.includes(s.id));
    patch({ projects, sessions });
    if (state.currentProjectId === id) {
      /* 换了当前项目：只换**指针**（projects.json 的 current 服务端已经改好），
         **绝不能拿 `[]` 当条目灌进去**——那会 emit 一次"整份覆盖"，
         把新当前项目的记忆在服务端抹成空的（"空列表回写"的经典坑）。
         条目随后从唯一的取数路径取回来。 */
      const next = d.current ? projects.find((p) => p.id === d.current) || null : null;
      patch({ currentProjectId: d.current || '' });
      adoptProject(next);
      await refreshCurrentMemory();
    }
    if (gone.includes(state.activeSessId)) {
      const next = sessions[0] || null;
      if (next) selectSession(next.id);
      else { patch({ activeSessId: null, history: [] }); newSession({ project: d.current || '' }); }
    }
    toast(`已归档项目「${d.project.name}」：${d.sessions} 个对话一并收起，设置 → 存档 里可恢复`, 'ok');
    return true;
  } catch (e) { toast('归档项目失败：' + e.message, 'err'); return false; }
}

/** 拉归档清单（设置 → 存档） */
export async function loadArchive() {
  try { return await get(EP.archive, { timeoutMs: 10000 }); }
  catch (e) { toast('读取存档失败：' + e.message, 'err'); return { sessions: [], projects: [] }; }
}

/** 从存档里恢复（kind: 'session' | 'project'）；恢复项目会连它的会话一起回来 */
export async function restoreArchived(kind, id) {
  try {
    const d = await post(EP.archiveRestore, { kind, id }, { timeoutMs: 30000 });
    if (kind === 'project') {
      const p = d.project;
      // 会话与项目一起回来了：重新拉一次清单最省事（数量不多，一次请求换一份准确状态）
      const fresh = await Store.pull();
      if (fresh) {
        patch({
          projects: Array.isArray(fresh.projects) ? fresh.projects : state.projects,
          sessions: Array.isArray(fresh.sessions) ? fresh.sessions : state.sessions,
        });
        /* 当前项目指针可能随恢复而变：指针与项目事实跟上，条目仍由唯一取数路径取回来
           （恢复的项目自带记忆文件夹，取回来就能看到它原来的条目）。 */
        const want = String(fresh.currentProject || state.currentProjectId || '');
        if (want !== currentProjectId()) {
          patch({ currentProjectId: want });
          adoptProject((state.projects || []).find((x) => x.id === want) || null);
        }
        await refreshCurrentMemory();
      } else {
        patch({ projects: [...(state.projects || []).filter((x) => x.id !== p.id), p] });
      }
      toast(`已恢复项目「${p.name}」与它的 ${d.sessions} 个对话`, 'ok');
    } else {
      const s = d.session;
      patch({ sessions: [s, ...(state.sessions || []).filter((x) => x.id !== s.id)] });
      toast(`已恢复对话「${s.title}」`, 'ok');
    }
    return true;
  } catch (e) { toast('恢复失败：' + e.message, 'err'); return false; }
}

/** 彻底删除归档里的东西（不可逆） */
export async function purgeArchived(kind, id) {
  try {
    await post(EP.archiveDelete, { kind, id }, { timeoutMs: 20000 });
    toast(kind === 'project' ? '已彻底删除该项目（含记忆文件夹）' : '已彻底删除该对话');
    return true;
  } catch (e) { toast('删除失败：' + e.message, 'err'); return false; }
}

/** 把当前项目记忆整份写回服务端（界面里手工改完立刻落盘；模型写的那条走 Memory.onChange）。
 *  带 baseCount（取回时的条数）：服务端据此做空列表覆盖保护，陈旧快照会被拒（409）而不是删数据。 */
export async function syncProjectMemory() {
  if (!Memory.projectMeta) return null;
  try {
    const d = await post(EP.projectsMemory, {
      id: Memory.projectMeta.id,
      entries: Memory.serialize('project'),
      baseCount: Memory.projectBaseCount,
    }, { timeoutMs: 15000 });
    if (Array.isArray(d.entries)) adoptProject(Memory.projectMeta, d.entries);
    return d.entries;
  } catch (e) { toast('保存项目记忆失败：' + e.message, 'err'); return null; }
}
