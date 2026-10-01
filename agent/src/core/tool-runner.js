/* 工具执行层：按名字分发 + 单轮预算 + 调服务端工具端点（ESM 模块） */
/* ToolRunner —— 工具执行层：runTool 按名字分发 + 单轮预算 + 调服务端插件端点
 *
 *  与 agent-defs.js（登记表）配对：那边决定"给模型看哪些工具"，这边决定"调用怎么落地"。
 *  分四路：
 *    web_search   —— 同源搜索代理（/agent/search）
 *    memory_*     —— core/memory.js（会话 / 项目 / 全局三类记忆；项目记忆与服务端 .md 文件夹同步）
 *    list/use/skill_* —— js/prompts.js 的技能登记表（渐进披露 + 自造）
 *    插件（文件与目录 / 命令行）—— POST /agent/tools/call，服务端以**绑定的本机账号**的权限执行
 *
 *  预算口径（一条原则，与 agent.js 的 REPEAT_OK 同源）：**改东西的扣、只读的不扣**。
 *    search / memory_write / memory_forget / skill_write / skill_delete / 插件全部 → 扣；
 *    memory_search / memory_read / list_skills / use_skill → 不扣（读类无害，读多少次都不该被拦）。
 *  扣费时机：凡是"要过确认框"的操作，一律**确认通过后才扣**——用户拒绝几次就见底的预算
 *  等于骗模型"没额度了"（插件类 2026-09-17 实测复现过，技能类这次一并修正）。
 *
 *  init({ Prompts, Memory, AgentPolicy, AgentDefs, val2, me, accessOf, AGENT_API, SEARCH_API,
 *         save, persistSession, renderMemoryPanel, renderPromptPanel, updateCtxMeter,
 *         toast, openLogin, confirmPluginAction, confirmSkillChange, askDangerGrant,
 *         onExecAllow, onSkillRemember, runSignal })
 *  runSignal 提供本轮的 AbortSignal：工具请求用它 + 自身超时合成一个信号，用户点「停止」
 *  才真的能中断在途的工具执行（缺省 null = 只有超时兜底）。
 *  onExecAllow/onSkillRemember：确认框里勾了「以后不再问我」时的落点
 *  （分别写进命令允许清单 exec_allow、技能确认开关 skill_write_confirm）。
 *  读取侧不需要钩子：exec_allow 走 val2、skillAsk 走 accessOf，都是既有通路。
 */
import { EP } from './endpoints.js';
import { get, post, ApiError } from './http.js';

let C = {
  Prompts: null, Memory: null, AgentPolicy: null, AgentDefs: null,
  val2: () => undefined, me: () => null, accessOf: () => ({}), runSignal: () => null,
  AGENT_API: '',
  save: () => {}, persistSession: () => {}, renderMemoryPanel: () => {}, renderPromptPanel: () => {},
  updateCtxMeter: () => {}, toast: () => {}, openLogin: () => {},
  onStatus: null, onNeedBind: () => {}, onNeedUnlock: () => {},
  confirmPluginAction: () => Promise.resolve({ ok: false }), confirmSkillChange: () => Promise.resolve({ ok: false }),
  askDangerGrant: () => Promise.resolve({ ok: false }),
  onExecAllow: () => {}, onSkillRemember: () => {},
};
function init(ctx) { C = Object.assign(C, ctx || {}); }
/** 当前访问级别下"技能改动是否要问人"（真源是宿主注入的 accessOf → AgentPolicy.eff 的 skillAsk） */
const skillAsk = () => {
  try {
    const e = C.accessOf && C.accessOf();
    return e && 'skillAsk' in e ? !!e.skillAsk : true;   // 算不出来就问（保守方向）
  } catch { return true; }
};

/* ======================= 服务端插件桥 ======================= */

let agentStatus = null;
/** 服务端插件状态（可访问目录 / 上限 / 黑名单），面板展开时拉一次。
 *  拉到后经 C.onStatus 回调同步给宿主（面板直接读自己的本地变量）。 */
async function loadAgentStatus(force) {
  if (!C.AGENT_API) return null;
  if (agentStatus && !force) return agentStatus;
  try {
    const d = await get(EP.toolsStatus, { timeoutMs: 8000 });
    agentStatus = d && d.ok ? d : null;
  } catch (e) { console.warn('[tools] 拉取插件状态失败（未登录或后端未接入）', e && e.message); agentStatus = null; }
  if (C.onStatus) { try { C.onStatus(agentStatus); } catch { /* 宿主回调失败不影响工具执行 */ } }
  return agentStatus;
}

/** 面板上的限额随每次调用下发给服务端（服务端会再 clamp 一次，只能比硬上限更小）。 */
const pluginLimits = () => ({
  read_kb: Number(C.val2('plugin_fs_read_kb')) || undefined,
  out_kb: Number(C.val2('plugin_exec_out_kb')) || undefined,
  timeout_sec: Number(C.val2('plugin_exec_timeout')) || undefined,
});

/** 去掉参数里的 __badArgs / __raw 标记（providers.js 的解析失败标记，只给内核看） */
function stripBadArgs(args) {
  if (!args || typeof args !== 'object') return {};
  if (args.__badArgs !== true) return args;
  const out = {};
  for (const [k, v] of Object.entries(args)) if (k !== '__badArgs' && k !== '__raw') out[k] = v;
  return out;
}

/** 危险命令预检（2026-09-19 七轮）：run_command 执行前先问服务端命中与否；
 *  命中则弹「危险命令授权」窗（不受访问级别/允许清单影响），同意后携一次性票据执行。
 *  预检失败不拦截——服务端 /call 仍会兜底要求票据（needGrant），不会静默放行。 */
async function denyCheck(command) {
  try {
    return await post(EP.toolsDenyCheck, { command }, { timeoutMs: 8000 });
  } catch { return { hit: '' }; }
}

/* ---------- 插件工具的错误分类：表格驱动 ----------
 *  服务端把"为什么不让做"分成若干类（要登录 / 要绑定 / 要解锁 / 权限不足 / 路径越界 / 要授权票据），
 *  每一类都要「告诉模型怎么办」+「把用户引到该去的地方」。原先是一串 9 个 if 的链（复杂度 44），
 *  新增一类就得往链子中间插，容易插错顺序（审计）。现在按顺序查表：**顺序即优先级**，新增只加一行。
 *  note/text/effect 都可给函数（依错误内容而变的那些）。 */
const safeCall = (fn) => { try { if (fn) fn(); } catch { /* 宿主回调失败不影响工具执行 */ } };
const pick = (v, e, body) => (typeof v === 'function' ? v(e, body) : v);

const PLUGIN_ERROR_RULES = [
  {
    when: (e) => !!e.needLogin,
    note: '需要登录',
    text: () => C.Prompts.text('plugin.need_login'),
    effect: () => C.openLogin('插件工具需要登录后才能用——它们以登录的系统账号身份执行。'),
  },
  {
    when: (e) => !!e.needBind,
    note: '需要绑定本机账号',
    text: () => '需要在设置里绑定本机账号后我才能读写文件/执行命令——文件与命令工具以绑定账号的身份执行。'
      + '不要重试：请提醒用户在设置抽屉 → 本机账号里完成绑定。',
    effect: () => {
      C.toast('还没有绑定本机账号：绑定之后我才能读写文件、执行命令');
      C.onNeedBind();
    },
  },
  {
    when: (e) => !!e.needUnlock,
    note: '需要解锁',
    text: () => '需要在界面里解锁绑定账号（输入该账号的密码）后，我才能读写文件/执行命令。'
      + '请等用户在解锁框里解锁后再重试这次调用。',
    effect: (e) => {
      const osUser = String(e.osUser || '');
      C.toast('绑定账号还没有解锁：请在解锁框里输入该账号的密码' + (osUser ? `（${osUser}）` : ''));
      C.onNeedUnlock(osUser);
    },
  },
  {   // needPermission / needRoots：服务端错误文本里已经写清了原因与怎么办，原样交给模型
    when: (e) => !!e.needPermission || !!e.needRoots,
    note: (e) => (e.needPermission ? '权限不足' : '路径不可访问'),
    text: (e, body) => String(body.error || e.message || '服务端拒绝了这次调用。'),
  },
  {   // needGrant：没有有效授权票据（正常流程不会到这——前端已弹过窗；到这多半是前端没接好）
    when: (e) => !!e.needGrant,
    note: '需要授权',
    text: (e, body) => String(body.error || '这条命令需要用户在界面上授权后才会执行。'),
  },
];

/** 调服务端执行一次插件工具；失败把服务端的理由原样回给模型（它据此改参数或改口） */
async function callAgentTool(name, args, takeExecBudget) {
  if (!C.AGENT_API) return { ok: false, note: '独立运行', text: '当前没有接入站点后端，插件工具不可用。' };
  // 未登录一律不给用：服务端也会 401，这里提前拦下并给一句人话
  if (!C.me()) return { ok: false, note: '需要登录', text: C.Prompts.text('plugin.need_login') };
  // 危险命令授权：命中即弹窗（人人一样），同意才拿票据执行，拒绝就回给模型一句明确的话。
  // 票据来自 deny-check 的响应（chk.grant），授权窗只负责"人点头"，不携带票据。
  let grant = '';
  if (name === 'run_command' && String(args.command || '').trim()) {
    const chk = await denyCheck(String(args.command));
    if (chk && chk.hit) {
      const auth = await C.askDangerGrant(chk.hit, String(args.command));
      if (!auth || !auth.ok) {
        return { ok: false, note: '用户拒绝授权',
          text: '用户在授权窗口点了拒绝：这条危险命令没有执行。请换更安全的做法；若确实需要，'
            + '告诉用户这条命令做什么，让用户自己在终端里执行。' };
      }
      grant = chk.grant || '';
    }
  }
  // 授权通过（或本来就不需要授权）之后才扣执行预算，见调用点注释
  if (takeExecBudget) {
    const bt = takeExecBudget();
    if (bt) return bt;
  }
  const clean = stripBadArgs(args);
  let d = {};
  try {
    d = await post(EP.toolsCall, { name, args: clean, limits: pluginLimits(), grant: grant || undefined },
      /* 超时要**比服务端硬超时（AGENT_EXEC_MAX_SEC，默认 600s）更长**：客户端先断的话命令
         还在服务端跑着，模型却拿到"请求失败"、输出也丢了（旧值 300s 对不上，2026-09-19 审计修正）。
         再并上本轮的 run signal：用户点「停止」要能立刻掐断在途的工具调用，否则界面要一直
         等到 660s 才退出"生成中"。 */
      { signal: mergedSignal(660000) });
  } catch (e) {
    // 传输层没拿到响应（断网 / 超时 / 被停止）：与旧实现同一句话
    if (!(e instanceof ApiError) || e.network || e.aborted) {
      return { ok: false, note: '请求失败', text: '调用服务端工具失败：' + (e && e.message ? e.message : e) };
    }
    // 以下是服务端给了响应体、http.js 按业务失败抛出的情形；原始错误体在 e.payload 里。
    const body = e.payload || {};
    for (const rule of PLUGIN_ERROR_RULES) {
      if (!rule.when(e, body)) continue;
      if (rule.effect) safeCall(() => rule.effect(e, body));   // effect 一定是有副作用的函数
      return { ok: false, note: pick(rule.note, e, body), text: pick(rule.text, e, body) };
    }
    // 工具**执行了、但结果不成功**（命令非 0 退出 / 超时 / 工具报错）时服务端仍回 HTTP 200，
    // 真正的输出在 body.text / body.note 里——http.js 把 ok:false 归为业务失败抛出，这里取回来原样回给模型，
    // 别把输出丢掉换成 "HTTP 200"。
    if (body.text) return { ok: false, note: body.note || '失败', text: String(body.text) };
    return { ok: false, note: e.kicked ? '已被顶掉' : '拒绝/失败', text: String(body.error || e.message || ('HTTP ' + e.status)) };
  }
  return { ok: d.ok !== false, note: d.note || '完成', text: String(d.text || '(无输出)') };
}

/** skill_import 的失败出口：把服务端的分类错误翻成模型看得懂的话（与插件工具同一套口径） */
function importFail(e) {
  const body = (e && e.payload) || {};
  if (e && e.needBind) {
    if (C.onNeedBind) { try { C.onNeedBind(); } catch { /* 宿主回调失败不影响工具执行 */ } }
    return { ok: false, note: '需要绑定本机账号',
      text: '读技能文件要以绑定账号的权限进行：请在设置抽屉 → 本机账号里绑定后再试。' };
  }
  if (body.needPermission || body.needRoots) {
    return { ok: false, note: body.needRoots ? '路径不可访问' : '权限不足',
      text: String(body.error || (e && e.message) || '服务端拒绝了这次安装。') };
  }
  return { ok: false, note: '安装失败', text: '安装技能失败：' + String(body.error || (e && e.message) || e) };
}

/** 固定超时 + 本轮 run signal 合并成一个信号。
 *  AbortSignal.any 是基线 API（Node 20+/Chrome 116+），拿不到就退回纯超时。 */
function mergedSignal(ms) {
  const t = AbortSignal.timeout(ms);
  const run = C.runSignal && C.runSignal();
  if (!run || !AbortSignal.any) return t;
  return AbortSignal.any([t, run]);
}

/* ======================= 联网搜索 ======================= */

/** 调用同源代理（host 缺席时退回独立代理）。2026-09-19 起服务端要求登录：
 *  401 时给模型一句明确的话（而不是把它当普通搜索失败反复重试）。 */
async function doSearch(query, n) {
  let d;
  try {
    d = await post(EP.search, { query, max_results: Math.max(1, Math.min(10, n)) }, { signal: mergedSignal(45000) });
  } catch (e) {
    if (e && e.needLogin) {
      throw new Error('联网搜索需要登录：搜索消耗服务端配额，未登录一律拒绝。请告知用户先登录（页面右上角 👤）。');
    }
    if (e && e.network) throw e;   // http.js 的归类错误已是人话（无法连接服务端：…），原样抛
    throw new Error((e && e.payload && e.payload.error) || `搜索服务返回 HTTP ${e && e.status}`);
  }
  return d.markdown || '';
}

/* ======================= 单轮预算 ======================= */

/** 扣一格预算；超额返回拒绝结果（ok:false，模型据此收尾），null = 扣费成功继续执行 */
function takeBudget(budget, key, maxKey, textKey) {
  if (budget[key] >= budget[maxKey]) return { ok: false, note: '已达上限', text: C.Prompts.text(textKey) };
  budget[key]++;
  return null;
}

/* ======================= 各工具族（runTool 的分片） =======================
 *  runTool 原先是一个 151 行、复杂度 87 的巨型分发：联网搜索 / 记忆 / 技能 / 插件四族、
 *  加上预算扣减、确认框、危险命令授权全挤在一个函数里，改任何一个分支都要在两百行里找位置（审计）。
 *  现在每族一个函数（这一层只认识"工具名"），runTool 只管分派。
 *
 *  两条贯穿全族的规矩（每一族里都别再各自发明）：
 *    · 预算口径：**改东西的扣、只读的不扣**（读多少次都不该被拦，轮次上限兜底）；
 *    · 扣费时机：要过确认框/授权窗的，**确认通过后才扣**（拒绝不该烧额度）。
 */

/** 有哪些工具属于哪一族（名字与 agent-defs.js 的注册表一一对应） */
const MEMORY_TOOL_NAMES = new Set(['memory_write', 'memory_search', 'memory_read', 'memory_forget']);
const SKILL_TOOL_NAMES = new Set(['list_skills', 'use_skill', 'skill_write', 'skill_delete', 'skill_import']);

/* ---------- 联网搜索 ---------- */

async function runSearch(args, userText, budget) {
  const bt = takeBudget(budget, 'search', 'maxSearch', 'loop.budget_search');
  if (bt) return bt;
  const q = String(args.query || args.q || '').trim() || userText;
  return { ok: true, text: await doSearch(q, 5) };
}

/* ---------- 记忆：会话 + 项目 + 全局 ---------- */

function runMemoryTool(name, args, budget) {
  if (name === 'memory_write') {
    if (!C.val2('mem_auto')) {
      return { ok: false, note: '已关闭', text: '用户关闭了"模型自己写记忆"。请把想记的内容直接说给用户，让他决定要不要存。' };
    }
    const scope = ['global', 'project'].includes(args.scope) ? args.scope : 'session';
    // 项目记忆要有当前项目才写得了（没项目时落到会话记忆，别静默丢弃）
    const wantProject = scope === 'project' && !C.Memory.projectMeta;
    const realScope = wantProject ? 'session' : scope;
    if (!String(args.content || '').trim() && !String(args.title || '').trim()) {
      return { ok: false, note: '缺内容', text: 'memory_write 需要 title 或 content。' };
    }
    // 预算在校验通过后才扣：参数残缺的调用不该烧额度
    const bt = takeBudget(budget, 'aux', 'maxAux', 'loop.budget_aux');
    if (bt) return bt;
    const r = C.Memory.write({ scope: realScope, title: args.title, content: args.content, tags: args.tags, source: 'model' });
    C.persistSession(); C.renderMemoryPanel(); C.updateCtxMeter();
    const where = { global: '全局', project: '项目', session: '会话' }[realScope];
    return { ok: true, note: r.updated ? '已更新记忆' : '已记住',
      text: `已写入${where}记忆「${r.entry.title}」（id ${r.entry.id}）。`
        + (wantProject
          ? '当前没有选中项目，所以先记在了**会话记忆**里；要按项目长期保留，请用户先在「设置 → 项目」里选一个项目根目录。'
          : realScope === 'global' ? '它会出现在之后每轮对话的记忆索引里。'
            : realScope === 'project' ? '它只在这个项目里有效，会出现在之后每一轮的项目记忆索引里。'
              : '它只在本会话有效。') };
  }
  if (name === 'memory_search') {
    const hits = C.Memory.search(args.query, ['session', 'global', 'project'].includes(args.scope) ? args.scope : null);
    return { ok: true, text: hits.length
      ? hits.map(h => `[${C.Memory.scopeCn(h.scope)}·${h.id}] ${h.title}${h.tags.length ? '（' + h.tags.join('/') + '）' : ''}：${h.excerpt}`).join('\n')
      : `没有与「${args.query}」相关的记忆。` };
  }
  if (name === 'memory_read') {
    const e = C.Memory.find(args.id, null);
    if (!e) return { ok: false, note: '未找到', text: `没有这条记忆：${args.id}` };
    const scope = C.Memory.scopeCn(C.Memory.project.includes(e) ? 'project' : C.Memory.listOf('global').includes(e) ? 'global' : 'session');
    return { ok: true, note: '已读取', text: `【${scope}记忆 · ${e.title}】\n${e.content}` };
  }
  // memory_forget：改动类，删记忆要扣，但"没找到"这种空手不扣
  const e = C.Memory.find(args.id, null);
  if (!e) return { ok: false, note: '未找到', text: `没有这条记忆：${args.id}` };
  const bt = takeBudget(budget, 'aux', 'maxAux', 'loop.budget_aux');
  if (bt) return bt;
  C.Memory.remove(e.id, null);
  C.persistSession(); C.renderMemoryPanel(); C.updateCtxMeter();
  return { ok: true, note: '已删除', text: `已删掉记忆「${e.title}」。` };
}

/* ---------- 技能（Pi 的渐进披露 + 自造 + 从 Markdown 安装） ---------- */

async function runSkillTool(name, args, budget) {
  /* 清单只给名字与用途，正文按需加载并记为"已加载"。读类不占预算。 */
  if (name === 'list_skills') {
    const list = C.Prompts.skills().filter(s => s.enabled !== false);
    const loaded = C.Prompts.loadedList();
    return { ok: true, text: list.length
      ? list.map(s => `- ${s.name}：${s.description || '(未写用途)'}［${s.auto === false ? '常驻' : loaded.includes(s.id) ? '已加载' : '按需'}］`).join('\n')
      : '当前没有配置技能。' };
  }
  if (name === 'use_skill') {
    const s = C.Prompts.findSkill(args.name);
    // 禁用的技能同样不给加载：list_skills 不列它，但模型可能从旧上下文/猜测里拿到名字
    if (!s || s.enabled === false) {
      return { ok: false, note: '未找到',
        text: `没有名为「${args.name}」的技能。可用：` + C.Prompts.skills().filter(x => x.enabled !== false).map(x => x.name).join('、') };
    }
    C.Prompts.markLoaded(s.id);
    return { ok: true, note: '已加载技能', text: `【技能 ${s.name}】\n${s.text}` };
  }
  if (name === 'skill_import') return runSkillImport(args, budget);
  if (name === 'skill_write') {
    const skillName = String(args.name || '').trim();
    const existing = C.Prompts.findSkill(skillName);
    /* skillAsk（访问级别的"技能改动"开关）决定要不要问：
       full 档 = 免确认，其余档 = 弹确认框。原先这里无条件弹窗，
       于是「访问级别 → 完全」下仍然每次打断，skillAsk 成了只存在于文案里的字段（审计 C6）。 */
    if (skillAsk()) {
      const r = await C.confirmSkillChange(existing ? '改写' : '新建', skillName, args);
      if (!r.ok) return { ok: false, note: '用户未同意', text: C.Prompts.text('loop.skill_write.denied').replace(/\{name\}/g, skillName) };
      // 勾了「以后这类技能改动不用再问我」→ 关掉 skill_write_confirm（与 accessOf 的 skillAsk 同一开关）
      if (r.remember) C.onSkillRemember();
    }
    const bt = takeBudget(budget, 'aux', 'maxAux', 'loop.budget_aux');   // 同插件：同意后才扣
    if (bt) return bt;
    const item = existing
      ? C.Prompts.updateSkill(existing.id, { description: args.description, text: args.content, auto: args.auto !== false })
      : C.Prompts.addSkill({ name: skillName, description: args.description, text: args.content, auto: args.auto !== false });
    /* 落盘靠登记表自己的通知（Prompts.addSkill/updateSkill → emitChange → 宿主 queuePrompts）。
       这里**不要**再调 C.save()：那个存的是"设置"（服务商/参数/外观），跟技能无关——
       旧写法就是它，于是模型建的技能只活在内存里，刷新即丢。 */
    C.renderPromptPanel(); C.updateCtxMeter();
    return { ok: true, note: existing ? '已改写技能' : '已新建技能',
      text: `技能「${item.name}」已${existing ? '改写' : '创建'}（${item.auto === false ? '常驻注入' : '按需加载'}）。` };
  }
  // skill_delete
  const skillName = String(args.name || '').trim();
  const s = C.Prompts.findSkill(skillName);
  if (!s) return { ok: false, note: '未找到', text: `没有名为「${skillName}」的技能。` };
  /* 与 skill_write 同走 skillAsk（审计 C6 当时只接了 write，删除/导入这两条仍是死开关：
     完全访问档照样被打断，确认框上「以后不用再问我」勾了也没有消费点）。 */
  if (skillAsk()) {
    const r = await C.confirmSkillChange('删除', skillName, null);
    if (!r.ok) return { ok: false, note: '用户未同意', text: C.Prompts.text('loop.skill_write.denied').replace(/\{name\}/g, skillName) };
    if (r.remember) C.onSkillRemember();
  }
  const bt = takeBudget(budget, 'aux', 'maxAux', 'loop.budget_aux');
  if (bt) return bt;
  C.Prompts.removeSkill(s.id); C.renderPromptPanel(); C.updateCtxMeter();
  return { ok: true, note: '已删除', text: `技能「${skillName}」已删除。` };
}

/** 从 Markdown（SKILL.md 那套热门结构）安装技能：两段式——先让服务端**只解析**（dryRun）
 *  拿预览，人点过确认再真正落盘（与 skill_write 同一道确认闸门、同一份预算口径）。 */
async function runSkillImport(args, budget) {
  const target = String(args.path || '').trim();
  if (!target) return { ok: false, note: '缺参数', text: 'skill_import 需要 path：一个 .md 文件，或装着 `<技能名>/SKILL.md` 的目录。' };
  if (!C.AGENT_API) return { ok: false, note: '独立运行', text: '当前没有接入站点后端，技能安装不可用。' };
  if (!C.me()) return { ok: false, note: '需要登录', text: C.Prompts.text('plugin.need_login') };
  let plan;
  try {
    plan = await post(EP.skillsImport, { path: target, auto: args.auto, dryRun: true }, { timeoutMs: 20000 });
  } catch (e) { return importFail(e); }
  const items = (plan && plan.items) || [];
  if (!items.length) {
    return { ok: false, note: '没找到技能',
      text: '这个路径下没有可安装的技能 Markdown（认 `<目录>/<技能名>/SKILL.md` 与 `<目录>/*.md`）。'
        + (plan && plan.errors && plan.errors.length ? '\n' + plan.errors.join('\n') : '') };
  }
  /* 同 skill_write/skill_delete：走 skillAsk。full 档免确认（勾过的也免），其余档弹框。 */
  if (skillAsk()) {
    const r = await C.confirmSkillChange('导入', '', { path: plan.path, items });
    if (!r.ok) {
      return { ok: false, note: '用户未同意',
        text: C.Prompts.text('loop.skill_write.denied').replace(/\{name\}/g, items.map((x) => x.name).join('、')) };
    }
    if (r.remember) C.onSkillRemember();     // 同上：勾了就不再问这类改动
  }
  const bt = takeBudget(budget, 'aux', 'maxAux', 'loop.budget_aux');
  if (bt) return bt;
  let done;
  try {
    done = await post(EP.skillsImport, { path: target, auto: args.auto }, { timeoutMs: 30000 });
  } catch (e) { return importFail(e); }
  C.renderPromptPanel(); C.updateCtxMeter();
  const list = (done.imported || []).map((x) => `${x.name}（${x.action}）`).join('、');
  return { ok: true, note: '已安装技能',
    text: `已从 ${done.path} 安装 ${done.count} 个技能：${list}。`
      + (done.errors && done.errors.length ? '\n没装的：' + done.errors.join('；') : '')
      + '\n（技能按账号保存、同名会改写；可用 list_skills 核对，正文按需加载。）' };
}

/* ---------- 插件：文件与目录 / 命令行（服务端以**绑定的本机账号**的权限执行） ---------- */

async function runPluginTool(name, args, budget) {
  if (!C.AGENT_API) return { ok: false, note: '未接入后端', text: '当前没有接入站点后端，插件工具不可用。' };
  const isCmd = name === 'run_command';
  // 用户在面板里关掉了这一类插件：两类工具回同一句话（只差开关名）
  if (!C.val2(isCmd ? 'plugin_exec_on' : 'plugin_fs_on')) {
    return { ok: false, note: '已停用', text: C.Prompts.text('loop.plugin_off').replace(/\{name\}/g, name) };
  }
  // 未登录：插件工具整体不可用。这里挡在最前面，一是别让它白扣预算，二是给模型一句明确的理由。
  if (!C.me()) return { ok: false, note: '需要登录', text: C.Prompts.text('plugin.need_login') };

  // 要不要先问：访问级别定档；命令再看一眼允许清单（清单在非"完全访问"档都生效）
  const isDel = name === 'delete_path';
  const isWrite = C.AgentDefs.FS_WRITE_NAMES.includes(name);
  const acc = C.accessOf();
  const allowedRule = isCmd ? C.AgentPolicy.matchRule(args.command, C.val2('exec_allow')) : null;
  const needAsk = allowedRule ? false
    : isCmd ? acc.execAsk : isDel ? acc.delAsk : isWrite ? acc.fsAsk : false;
  if (needAsk) {
    const r = await C.confirmPluginAction(name, args);
    if (!r.ok) return { ok: false, note: '用户未同意', text: C.Prompts.text('loop.plugin_denied').replace(/\{name\}/g, name) };
    /* 勾了「以后「X」开头的命令直接执行，不再问我」就把规则写进**命令允许清单**。
       清单的真源是参数 exec_allow（面板上可手改，见 core/params.js），
       读取点就在上面那行 matchRule —— 原先 remember 没有任何消费点，
       界面写着"不再问我"、勾了却每次都问，清单永远是空的（审计 C6）。
       注意：这里只免掉**常规确认**；命中危险清单的命令仍会弹一次性授权窗
       （callAgentTool 里那道闸门独立于本清单，且 ruleFor 不对危险程序提议规则）。 */
    if (r.remember && isCmd) {
      const rule = C.AgentPolicy.ruleFor(args.command || '');
      if (rule) C.onExecAllow(rule);
    }
  }
  /* 预算在确认**通过后**才扣：拒绝、参数残缺都不该烧额度。
     命令还要再晚一步：callAgentTool 内部才有"危险命令授权窗"，用户点拒绝时不能已经扣过
     ——旧顺序（先扣再弹授权窗）会让"连拒几条危险命令"把 plugin_exec_max 烧空，
     模型收到"已达上限"，用户也看不懂为什么拒绝也扣。所以 exec 的扣费交给
     callAgentTool 在**真的要发请求之前**执行；文件类工具没有二次闸门，仍在这里扣。 */
  if (isCmd) return await callAgentTool(name, args, () => takeBudget(budget, 'exec', 'maxExec', 'loop.budget_exec'));
  /* 只读工具不扣 fs 预算：本文件头与界面上的参数说明都写着"改东西的扣、只读的不扣"，
     而实现里此前对全部文件工具一律扣费——于是"读满 12 次就再也改不了文件"，
     用户看到的解释还是"已达上限"。读类本身由轮次上限（maxRounds）兜底，不会无限跑。 */
  const readOnly = !!(C.AgentDefs && C.AgentDefs.FS_READ_NAMES && C.AgentDefs.FS_READ_NAMES.includes(name));
  if (!readOnly) {
    const bt = takeBudget(budget, 'fs', 'maxFs', 'loop.budget_fs');
    if (bt) return bt;
  }
  return await callAgentTool(name, args);
}

/* ======================= 分发 ======================= */

async function runTool(call, userText, budget) {
  const name = String(call.name || '');
  const args = call.args || {};
  if (name === 'web_search') return runSearch(args, userText, budget);
  if (SKILL_TOOL_NAMES.has(name)) return runSkillTool(name, args, budget);
  if (MEMORY_TOOL_NAMES.has(name)) return runMemoryTool(name, args, budget);
  if (C.AgentDefs.PLUGIN_TOOL_NAMES.has(name)) return runPluginTool(name, args, budget);
  return { ok: false, note: '未注册', text: C.Prompts.text('loop.unknown_tool').replace(/\{name\}/g, name || '(空)') };
}

/* 导出面说明：runTool 是生产入口；doSearch / callAgentTool / loadAgentStatus / pluginLimits /
   stripBadArgs 另被单元测试直接调用（错误分类表、限额下发、坏参数剥离都是独立单元），
   属**有意暴露的内部件**——改签名要同步 agent/test/tools.test.mjs。 */
export const ToolRunner = { init, runTool, doSearch, callAgentTool, loadAgentStatus, pluginLimits, stripBadArgs };
