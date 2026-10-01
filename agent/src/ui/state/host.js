/* ui/state/host.js —— 把 core 层模块接到界面上（依赖注入的宿主对象）
 *
 *  core 层（agent/src/core/*）刻意不认识 React：它们要的东西全部通过 init(deps) 注入，
 *  这里就是那份 deps 的唯一来源。好处有两个：
 *    · core 能在 Node 下单测（注入假依赖），不必拖一个 DOM；
 *    · 换界面（本次从手写 DOM 换成 React）时 core 一行不用改。
 *
 *  本文件还负责**提示词组装**（system 区块 + 技能清单 + 记忆 + 插件闸门说明 + 访问级别说明），
 *  以及"发给模型的 messages 怎么拼"——界面上的"发送预览"与实际发送共用这一份，不会两处走偏。
 */
import { Prompts } from '../../core/prompts.js';
import { Memory } from '../../core/memory.js';
import { Agent } from '../../core/agent.js';
import { AgentDefs } from '../../core/agent-defs.js';
import { AgentContext } from '../../core/context.js';
import { Assemble } from '../../core/assemble.js';
import { titleFrom } from '../../core/sessions.js';
import { getProtocol } from '../../core/protocol.js';
import { AgentPolicy } from '../../core/policy.js';
import { TOOL_DEFAULTS, ctxLimitOf } from '../../core/params.js';
import { Store } from '../../core/store.js';
import { Presence } from '../../core/presence.js';
import { ToolRunner } from '../../core/tool-runner.js';
import { EP } from '../../core/endpoints.js';
import { patch, state, touch } from './store.js';
import { fmtChars } from '../lib/format.js';
import { toast } from '../components/ui/toast.jsx';

/* ============================ 直接读 state 的小访问器 ============================ */

export const me = () => (state.info && state.info.loggedIn ? state.info.user : null);
export const bound = () => !!(state.info && state.info.binding && state.info.binding.bound);
const hasServer = () => !!EP.info;
/** 提示词登记表里有几条未应用的草稿（徽章与发送前提醒共用这一处口径；
 *  放在这里而不是 settings.js：session.js 要用它，而 session.js 不能反向 import settings.js）。 */
export const promptDraftCount = () => Object.keys(state.promptDrafts || {}).length;

export const providers = () => (state.settings ? state.settings.providers || [] : []);
export function activeProvider() {
  const list = providers();
  if (!list.length) return null;
  const id = state.settings.activeId;
  return list.find((p) => p.id === id) || list[0];
}

/** 参数取值：出厂 → 全局 → 每模型覆盖（唯一真源在 core/params.js） */
export function paramsOf(providerId, model) {
  return Assemble.paramsOf(state.settings || {}, providerId, model);
}

/* 组装逻辑本身在 core/assemble.js（**纯函数**）——服务端托管运行（lib/agent/run.js）
   用同一份实现，两端的 system 区块 / 工具清单 / 访问级别判定因此不会分叉。
   这里只负责把界面 state 包成它要的 env。 */
const assembleEnv = () => ({
  settings: state.settings || {},
  history: state.history,
  curSess,
  Prompts, Memory, AgentDefs, AgentPolicy, AgentContext,
  TOOL_DEFAULTS,
});

export function val2(key) {
  return Assemble.val2Of(assembleEnv(), key);
}
/* 四档访问级别 → "哪些操作要问"的实际判定。
   参数取**生效值**（全局 + 每模型覆盖），兜底取工具参数的出厂默认——与旧实现
   `AgentPolicy.eff(S.params, TOOL_DEFAULTS)` 同一口径（只在「自定」档下才会读那四个开关）。 */
export const accessOf = () => Assemble.accessOfEnv(assembleEnv(), TOOL_DEFAULTS);

/* ============================ 提示词组装 ============================ */

/** 本轮注入的区块与工具（界面展示与实际发送同源） */
export function promptBlocks() {
  return Assemble.promptBlocks(assembleEnv());
}

const toApiMsg = Assemble.toApiMsg;

/** 组装发给模型的 messages：system 区块 + （压缩摘要）+ 历史 + 本条输入 */
export function buildMessages(extraUser) {
  return Assemble.buildMessages(assembleEnv(), extraUser);
}

/** 「发送预览」用：区块清单 + 实际 messages（JSON）+ 工具 schema */
export function sendPreview() {
  return Assemble.sendPreview(assembleEnv());
}

/* ============================ 当前会话 / 当前项目 ============================ */

export const curSess = () => state.sessions.find((s) => s.id === state.activeSessId) || null;

/** 把"当前项目"灌进 core（项目记忆 + 项目事实）与 Store（项目记忆写给谁）。
 *  **顺序不能反**：Memory.setProject 会 emit → 宿主的 Memory.onChange 立刻
 *  `Store.queueProjectMemory(...)` 入队，而写入目标 id 是 flush 时才读的（core/store.js 的
 *  projectWriter）。先 setProject 后 setProjectId 的话，入队那一刻 id 还是上一个项目——
 *  在项目 A 里写的记忆会落到项目 B 的文件夹（服务端是全量重写，还会顺手删掉 B 的条目）。
 *  所以**先告诉 Store 写给谁，再让 core 触发入队**。
 *  放在 host.js 是因为"切项目"有两个入口（设置里选项目、点开别的项目的会话），
 *  两个入口必须走同一份实现，否则又会出现"一边换了一边没换"。
 *  @param {object|null} project 项目（含 id/name/root/memoryDir；null = 没有当前项目）
 *  @param {Array} [entries] 该项目在服务端的记忆条目；**不给 = 保持 core 里现有的条目**。
 *        硬约定：给了就必须是**服务端那一次 GET 的结果**（含"服务端确实是空的"这种空数组），
 *        或者干脆不给——**不许拿本地拼出来的（尤其是空）数组**：Memory.setProject 会 emit →
 *        宿主立刻整份写回服务端，一个空数组就把那个项目的记忆抹了（踩过两次的坑）。 */
export function adoptProject(project, entries) {
  Store.setProjectId(project ? project.id : '');
  Memory.setProject(project
    ? { id: project.id, name: project.name, root: project.root, memoryDir: project.memoryDir }
    : null, entries);
}

/** 把当前 history 写回会话对象并排队落盘（生成中也会定期调，刷新不丢） */
export function persistSession(sessionId) {
  const s = sessionId ? state.sessions.find((x) => x.id === sessionId) : curSess();
  if (!s) return;
  /* 只在"这一份 history 就是它的"时候写：托管运行结束时带着 sessionId 调进来，
     而那时用户可能已经切走了（切走后 state.history 是别的会话的）。 */
  if (sessionId && state.activeSessId !== sessionId) return;
  s.msgs = state.history.slice();
  s.memory = Memory.serialize('session');      // 会话记忆随会话落盘（跨会话的那份走 queueMemory）
  s.ts = Date.now();
  if (!s.title || s.title === '新对话') s.title = titleFrom(s.msgs) || '新对话';   // 规则与托管运行共用一份（core/sessions.js）
  Store.queueSession(s);
  touch();
}

export const saveSettings = () => { Store.queueSettings(settingsForSave()); };

/** 交给服务端的配置快照（密钥字段只在"新填/改过"时带上，其余保持服务端原值）
 *  **白名单是硬约束**：这里没列出的字段服务端收不到，界面上改了也存不下来
 *  （2026-09-29 实测踩到：新增的 sessionHeader 漏在这份清单外，表单保存后配置里始终没有它）。 */
function settingsForSave() {
  const s = state.settings || {};
  const list = (s.providers || []).map((p) => {
    const out = {
      id: p.id, name: p.name, type: p.type, baseUrl: p.baseUrl, model: p.model,
      ctxLimit: p.ctxLimit, extraBody: p.extraBody, headers: p.headers, models: p.models,
      sessionHeader: p.sessionHeader,
    };
    // keyDirty 是前端标记：用户在这台浏览器上真的输过/改过密钥 → 才回传（空串/null 语义见 lib/userdata.js）
    if (p.keyDirty) out.apiKey = p.apiKey || null;
    return out;
  });
  return {
    providers: list, activeId: s.activeId, params: s.params, paramsByModel: s.paramsByModel,
    theme: s.theme, ui: s.ui, tools: s.tools, currentSess: s.currentSess,
  };
}

/* ============================ 追踪条（工具调用 / 提示 / 压缩） ============================ */

let traceSeq = 0;
/* token -> { msg, entry }：**记消息对象与条目本身，不记数组下标**。
   下标寻址会在历史被裁剪/回撤（shift/slice 换了数组内容）时静默错位——那时 fillTraceStrip
   找不到条目就 return，追踪条永远停在"进行中"（审计）。记对象则最坏情况是"更新了一条已经
   不在历史里的消息"，无害。 */
const traceStrips = new Map();

/** 往"当前正在生成的助手消息"上挂一条状态条；返回 token（内核会原样回传到 onToolEnd）
 *  @param {string} label 标题
 *  @param {'tool'|'notice'|'steer'|'compact'} [kind] 类别（判据用结构化字段，不用文案，见 ui/lib/trace.js） */
export function addTraceStrip(label, kind) {
  const msg = state.history[state.history.length - 1];
  if (!msg) return null;
  const token = { id: ++traceSeq };
  msg.trace = Array.isArray(msg.trace) ? msg.trace : [];
  const entry = { kind: kind || 'tool', state: 'running', name: '', label: String(label || ''), ok: true, note: '' };
  msg.trace.push(entry);
  traceStrips.set(token, { msg, entry });
  touch();
  return token;
}

export function fillTraceStrip(token, info) {
  if (!token) return;
  const at = traceStrips.get(token);
  if (!at) return;
  const t = at.entry;
  Object.assign(t, {
    label: info.label || t.label, ok: info.ok !== false, note: info.note || '',
    state: 'done',
    /* kind 一旦定为 notice 就不再改回 tool：收尾合并时据此把提示原样留在实时位置上
       （见 ui/lib/trace.js 的 mergeTrace）。 */
    kind: info.kind || t.kind || 'tool',
    /* 参数同样要瘦身：write_file 的参数里带着整个文件内容，直接挂在追踪条上
       = 每次落盘序列化几 MB、展开详情时在 DOM 里放几 MB（写大文件卡死的主因之一）。
       与内核 trace 用同一个 shrinkArgs，实时显示与落盘记录口径一致。 */
    args: Agent.shrinkArgs(info.args), result: String(info.result || '').slice(0, 4000), ms: info.ms,
  });
  traceStrips.delete(token);
  touch();
}

/* ============================ 确认框（人工闸门） ============================ */

/** 弹一个确认框，返回 Promise<{ok, remember}>；同一时刻只处理一个（排队） */
export function askConfirm(opts) {
  return new Promise((resolve) => {
    const prev = state.confirm;
    const item = Object.assign({}, opts, { resolve });
    if (prev) {
      // 串行队列：把"后面还有 N 个确认在排队"写进正文，避免用户以为同一条被问了两次
      const queued = state.confirmQueue || (state.confirmQueue = []);
      queued.push(item);
      return;
    }
    patch({ confirm: item });
  });
}

/** 确认框的结算（由 ConfirmDialog 组件调用） */
export function resolveConfirm(ok, remember) {
  const cur = state.confirm;
  if (cur) { try { cur.resolve({ ok, remember: !!remember }); } catch { /* 回调异常不影响后续 */ } }
  const queue = state.confirmQueue || [];
  patch({ confirm: queue.shift() || null });
}

/* ============================ 宿主对象组装 ============================ */

/* 注：这里原有 syncPrompts()（手工落盘登记表 + 重绘）。审计发现它已经**冗余**——
   core 的登记表在任何写入路径上都会 notify()，宿主的 Prompts.onChange 就是同一个保存 + 重绘
   （见下面的 wireCore），所以调用方再补一次只是双写；那段"core 不发变更事件"的理由是修复前的旧认知。 */

/** "这条会话生成中不许做某事"的统一拦截（清空/回撤/删一轮/重新生成…）。
 *  **判据是"当前会话在跑"**（state.streaming 的含义，2026-10-01 收窄）：别的会话在跑，
 *  不该挡住你在这条会话里做任何事；新建对话与切换会话也不再受它影响。
 *  返回 true = 已拦截（并且已经提示）。 */
export function guardStreaming(what) {
  if (!state.streaming) return false;
  toast(`这条对话正在生成回答：先点「停止」或等它结束再${what}`, 'info');
  return true;
}

/** 界面侧动作（由 ui/state/*.js 实现后回填，避免循环 import） */
export const hooks = {
  openLogin: () => {},
  onNeedBind: () => {},
  onNeedUnlock: () => {},
  onStatus: null,
  scrollBottom: () => {},
  /* 切会话 → 对齐"当前项目"（实现落在 ui/state/projects.js：它才知道项目清单与项目记忆端点）。
     回填为 no-op 时最坏情况是"当前项目不跟着会话走"（就是加这条钩子之前的老行为），不会出错。 */
  onSessionChange: null,
  /* 托管运行的三条"该跟服务端对齐了"通知（实现落在 ui/state/session.js，它才持有拉动逻辑）。
     run.js 通过这里回调，而不是直接 import session.js——那会成模块环（session ↔ run）。
       onRunDataChanged()          模型改了账号数据（记忆/技能/提示词）→ 重拉面板数据
       onRunEnded(sessionId)       一轮结束 → 稍后整份重拉（标题/最终内容/落盘的项目归属）
       onPullLatest(sessionId)     回来接上时发现"运行已经没了" → 立刻整份重拉，再判定孤儿 */
  onRunDataChanged: null,
  onRunEnded: null,
  onPullLatest: null,
  /* 待下载目录变了（模型刚把文件交给用户）→ 刷新菜单列表与计数（实现落在 ui/state/downloads.js） */
  onFilesChanged: null,
  /* 确认框里「以后不再问我」的落点（实现在 ui/state/settings.js，它才持有 setParam）。
     留着空实现是**刻意的**：没接线时勾选框点了也不生效，但绝不会因此放宽任何闸门。 */
  onExecAllow: () => {},
  onSkillRemember: () => {},
};

/** 装配 core 层：进程启动时调一次（main.jsx） */
export function wireCore() {
  AgentDefs.init({
    Prompts, val2, me, bound, AGENT_API: hasServer() ? EP.info : '',
  });

  ToolRunner.init({
    Prompts, Memory, AgentPolicy, AgentDefs, val2, me, accessOf,
    AGENT_API: hasServer() ? EP.info : '',
    runSignal: () => (state.abortSignal || null),
    save: saveSettings, persistSession,
    updateCtxMeter: () => {},                 // React 自己按 state 重绘
    toast: (msg, type) => toast(msg, type),
    openLogin: (...a) => hooks.openLogin(...a),
    onStatus: (s) => { patch({ agentStatus: s }); if (hooks.onStatus) hooks.onStatus(s); },
    onNeedBind: () => hooks.onNeedBind(),
    onNeedUnlock: (osUser) => hooks.onNeedUnlock(osUser),
    askConfirm,
    confirmPluginAction: (name, args) => askConfirmPlugin(name, args),
    confirmSkillChange: (action, name, args) => askConfirmSkill(action, name, args),
    askDangerGrant: (hit, command) => askDangerGrant(hit, command),
    /* 确认框勾了「以后不再问我」时的落点。读侧不需要钩子：
       exec_allow 走 val2、skillAsk 走 accessOf，都是既有通路；
       写侧交给 ui/state/settings.js（它才持有 setParam），避免 host → settings 的循环 import。 */
    onExecAllow: (rule) => hooks.onExecAllow(rule),
    onSkillRemember: () => hooks.onSkillRemember(),
  });

  AgentContext.init({
    /* Providers 是"按协议类型取适配器"的注册表，压缩取摘要模型时要用（core/context.js 的 summarize）。
       契约是 `.get(type)`，唯一真源是 core/protocol.js 的 getProtocol（其余四处调用点都用它）。
       原先这里传的是 null，而 summarize 会解引用它 → 压缩 100% 失败（界面上只看到"压缩失败：
       Cannot read properties of null"）。测试注入的是能用的桩，所以 119 项用例全绿而线上坏。 */
    Prompts, Providers: { get: getProtocol }, Agent,
    activeProvider, numCtx: () => ctxLimitOf(state.settings || {}, activeProvider(), paramsOf((activeProvider() || {}).id, (activeProvider() || {}).model)),
    /* 压缩用的请求参数：**现算**，不再读 state.requestOptions（那是"浏览器自己跑循环"时代的
       遗留——现在循环在服务端，客户端这边只有"手动压缩"会用到它）。
       口径与托管运行完全同源：同一份 Assemble.buildRequestOptions（context.js 会自行删掉 tools）。 */
    buildOptions: () => Assemble.buildRequestOptions({
      params: paramsOf((activeProvider() || {}).id, (activeProvider() || {}).model),
      defs: AgentDefs.activeToolDefs(),
    }),
    history: () => state.history,
    curSess,
    persistSession,
    addTraceStrip, fillTraceStrip,
    toast: (msg, type) => toast(msg, type),
    getInjectedBlocks: () => promptBlocks(),
    getActiveToolDefs: () => AgentDefs.activeToolDefs(),
    abortSignal: () => (state.abortSignal || null),
    toApiMsg,
  });

  Memory.init({ Prompts });

  /* core 层的事件总线接回界面。审计发现 Store 的 emit 原先**一个订阅者都没有**——
     下面这四件"该让用户知道"的事因此全被静默丢掉：
       · 401/登录失效（后台保存失败时用户只看到"没保存"，不知道为什么）
       · 413/连续失败（会话太大、网络长期不通——消息文本早就写好了，只是没人显示）
       · 服务端为腾空间丢弃了最旧的会话（这是**数据丢失**，必须说）
       · 被别的窗口顶掉（立刻冻结；原先只能等下一次心跳，最长 20 秒） */
  Store.on('needLogin', () => hooks.openLogin('登录状态已失效，请重新登录（数据按账号保存在服务端）'));
  Store.on('error', (msg) => toast(msg, 'err'));
  Store.on('dropped', (d) => toast(`服务端空间不足，已丢弃最旧的 ${d.n} 个会话（重要内容请先在设置 → 数据里备份）`, 'err'));
  Store.on('kicked', (e) => Presence.noteKicked(e && e.owner));

  /* core 层对象（登记表 / 记忆）自己改了就让界面重绘 + 落盘。
     两条链路各自独立：prompts → 提示词登记表端点；memory → 全局记忆端点（会话那段随会话落盘）。 */
  Prompts.onChange(() => {
    Store.queuePrompts(Prompts.serialize());
    touch();
  });
  Memory.onChange(() => {
    Store.queueMemory(Memory.serialize('global'));
    // 项目记忆写的是"当前项目"那份（真源在服务端账号目录的项目记忆文件夹里）；
    // 没有当前项目时**绝不发**——否则会把上一个项目的记忆写到一个不存在的地方
    if (Memory.projectMeta) Store.queueProjectMemory(Memory.serialize('project'));
    persistSession();
    touch();
  });
}

/* ---- 两个确认框的文案（与服务端闸门配套）---- */
function askConfirmPlugin(name, args, from) {
  const a = args || {};
  const isCmd = name === 'run_command';
  const isDelete = name === 'delete_path';
  const title = isCmd ? '执行命令？' : isDelete ? '删除？' : '写入文件？';
  let body;
  if (isCmd) body = `$ ${a.command || ''}\n\n（以绑定账号的权限执行；cwd 默认是可访问目录的第一项）`;
  else if (isDelete) body = `路径：${a.path || ''}\n${a.recursive ? '⚠ 递归删除：连目录内容一起删，不可恢复' : '（目录非空时会拒绝，需显式 recursive）'}`;
  else if (name === 'edit_file') body = `路径：${a.path || ''}\n\n--- 原文本 ---\n${String(a.old_text || '').slice(0, 600)}\n\n--- 新文本 ---\n${String(a.new_text || '').slice(0, 600)}`;
  else if (name === 'write_file') body = `路径：${a.path || ''}\n大小：${fmtChars(a.content)}\n\n${String(a.content || '').slice(0, 800)}`;
  else if (name === 'move_file') body = `${a.source || ''}\n  →  ${a.destination || ''}`;
  else body = JSON.stringify(a, null, 2).slice(0, 800);
  const rule = AgentPolicy.ruleFor(a.command || '') ;
  const canRemember = isCmd && !!rule;
  return askConfirm({
    title, body, okText: isCmd ? '执行' : isDelete ? '删除' : '写入', from,
    remember: canRemember ? { label: `以后「${rule}」开头的命令直接执行，不再问我` } : undefined,
  });
}

function askConfirmSkill(action, name, args, from) {
  const a = args || {};
  if (action === '导入') {
    const items = Array.isArray(a.items) ? a.items : [];
    const body = `从 ${a.path || '(未给路径)'} 安装 ${items.length} 个技能（同名会改写）：\n\n`
      + items.map((s) => `· ${s.name}：${String(s.description || '(未写用途)').slice(0, 70)}［${s.auto === false ? '常驻' : '按需'}］`).join('\n');
    return askConfirm({ title: '模型要安装技能', body, okText: '安装', from,
      remember: { label: '以后这类技能改动不用再问我' } });
  }
  const title = action === 'delete' ? '删除技能？' : '模型要写技能';
  const body = action === 'delete'
    ? `技能「${a.name || name}」将被删除，不可恢复。`
    : `名称：${a.name || name || '(未命名)'}\n用途：${a.description || ''}\n加载方式：${a.auto === false ? '常驻注入' : '按需加载'}\n\n--- 正文 ---\n${String(a.text || '').slice(0, 1200)}`;
  return askConfirm({ title, body, okText: action === 'delete' ? '删除' : '保存', from, remember: { label: '以后这类技能改动不用再问我' } });
}

/** 托管运行的确认（服务端把"要问什么"发过来，文案仍旧用上面那三个确认框：
 *  一处实现、两种跑法，界面不会出现"浏览器里问得详细、服务端问得潦草"）。 */
export function askRunConfirm(kind, payload, meta) {
  const p = payload || {};
  /* meta.session = 这条确认来自哪条会话（多段运行时同时可能有好几条在等），
     显示在确认框上——否则用户不知道这个框是谁弹的。 */
  const from = meta && meta.session ? String(meta.session) : '';
  if (kind === 'plugin') return askConfirmPlugin(p.name, p.args, from);
  if (kind === 'skill') return askConfirmSkill(p.action, p.name, p.args, from);
  if (kind === 'danger') return askDangerGrant(p.hit, p.command, from);
  return Promise.resolve({ ok: false });
}

/** 危险命令的一次性授权窗（票据由服务端签发，人点了才跑） */
function askDangerGrant(hit, command, from) {
  return askConfirm({
    title: '⚠ 危险命令授权', from,
    body: `这条命令命中了危险操作清单（${hit}）：\n\n$ ${command}\n\n`
      + '它会真的执行；授权只对这一次、这一条命令有效，改一个字符都需要重新授权。',
    okText: '授权执行',
    danger: true,
  });
}
