/* ui/state/store.js —— 界面状态的容器（最小订阅模型，React 用 useSyncExternalStore 订阅）
 *
 *  为什么不引状态库：这份状态只有一个来源（本文件的 `state`）、只有一种变更方式（patch），
 *  订阅者也只有 React 一层。引 Redux/Zustand 只会多一层概念，不会少一行代码。
 *
 *  约定：
 *    · 任何改动都走 patch()，改动后 emit()；React 组件用 useApp() 读它关心的切片；
 *    · 组件**不直接改 state**，一律调 actions（ui/state/*.js 里的函数）。
 */
import { useSyncExternalStore } from 'react';

export const state = {
  ready: false,            // 首次初始化（探针 + 拉取）是否完成
  bootError: '',           // 初始化失败的说明（白屏兜底时显示）
  info: null,              // /agent/info：登录态、绑定状态、协议清单、本机默认地址
  settings: null,          // 服务端配置（已脱敏：没有 apiKey，只有 hasKey/keyHint）
  sessions: [],            // 会话索引（含 msgs，就是完整会话；量级可控，一次全拉）
  activeSessId: null,
  projects: [],            // 项目清单（每个项目 = 一个根目录 + 一份项目记忆文件夹）
  currentProjectId: '',    // 当前项目（'' = 不归属任何项目）；会话默认归属它
  history: [],             // 当前会话的消息（含 thinking/trace/injected）
  runs: {},                // 正在跑的托管运行：sessionId → { runId, liveId, status, title, startedAt, steering, error }
                           // —— **多会话并行**就靠它：每条会话各有一条正在生成的运行，互不影响
  streaming: false,        // **当前会话**是否正在生成（= runs[activeSessId] 有值；给 Composer/停止按钮用）
  steering: 0,             // 当前会话待消费的插话条数（界面提示用）
  hub: { connected: false, error: '' },   // 统一事件口（一条 SSE 收全部会话的运行事件）的连接状态
  downloads: { open: false, entries: [], dir: '', loading: false, error: '' },  // 「📥 待下载」目录（传输文件插件）
  status: { connected: false, checking: false, models: [], error: '', model: '' },
  agentStatus: null,       // /agent/tools/status：绑定、白名单、上限、危险清单
  ctx: { used: 0, limit: 32768, pct: 0, state: 'ok' },   // 用量环
  presence: { active: true, owner: null, enforce: true },
  drawer: { open: false, section: 'appearance' },
  confirm: null,           // 当前确认框（见 askConfirm）
  promptDrafts: {},        // 提示词登记表的未应用草稿（id → 补丁 {text?, name?, description?, auto?}；点「应用」才写进登记表）
  draft: '',               // 输入框草稿（Composer 是文本源，这里存一份供 token 估算与插话回填）
  confirmQueue: [],        // 排队中的确认框（同一时刻只显示一个）
  requestOptions: null,    // 本轮请求参数（Agent 循环与压缩读它；send() 每次重建）
  abortSignal: null,       // 本轮的中断信号（「停止」按钮）
  revision: 0,             // 粗粒度版本号：core 层对象（Prompts/Memory）改动时自增，触发重绘
};

const listeners = new Set();
let pending = false;

/** 出厂配置的形状（与服务端 lib/agent/settings.js 的 DEFAULTS 同形）。
 *  放在这里而不是 session.js：**状态的形状归状态容器管**。它现在有三个使用方
 *  （数据载入、设置动作、登录/登出）——原先只长在会话模块里，另外两处要么绕圈 import、
 *  要么干脆把 settings 置成 null（那正是"登出后点设置没反应"的来源）。 */
export function defaultSettings() {
  return {
    providers: [], activeId: '', params: {}, paramsByModel: {},
    theme: { mode: 'dark', accent: 'blue', density: 'cozy', scale: 1 },
    ui: {}, tools: { roots: [], start: '' }, currentSess: null,
  };
}

/* 快照（snapshot）与可写状态（state）分开：
   useSyncExternalStore 只在**快照引用变化**时才重渲，而 patch() 是就地赋值——
   直接返回 state 的话引用永远不变，界面一次都不会更新（实测确认过的坑）。
   所以每次 emit 前重建一份浅拷贝当作快照；嵌套对象仍是同一引用，组件读到的就是最新值。 */
let snapshot = Object.assign({}, state);

export const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const getState = () => snapshot;

/** 合并式更新：只覆盖传进来的键 */
export function patch(partial) {
  Object.assign(state, partial);
  schedule();
}

/** 触发重绘（core 层对象被改动、但 state 引用没变时用） */
export function touch() {
  state.revision++;
  schedule();
}

function schedule() {
  if (pending) return;
  pending = true;
  queueMicrotask(() => {
    pending = false;
    snapshot = Object.assign({}, state);       // 新引用 = React 认得出"变了"
    for (const fn of [...listeners]) { try { fn(); } catch { /* 单个订阅者出错不影响其它 */ } }
  });
}

/** React 侧读状态：读整个快照（组件少且树不深，够用；要精细切片就在组件里自己挑）。 */
export const useApp = () => useSyncExternalStore(subscribe, getState, getState);
