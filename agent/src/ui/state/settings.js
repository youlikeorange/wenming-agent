/* ui/state/settings.js —— 设置类动作：外观 / 模型 / 参数 / 本机账号 / 工具目录 / 记忆 / 数据
 *
 *  一条原则：**任何改动都先落到 state，再交给 Store 防抖写服务端**。
 *  界面永远读 state（不读服务端的返回值），所以"改完立刻可见"；服务端失败由 Store 重试，
 *  密钥字段的"留空 = 保持原值"语义由 lib/userdata.js 保证（前端拿不到密钥原文）。
 */
import { state, patch, defaultSettings } from './store.js';
import { EP } from '../../core/endpoints.js';
import { post } from '../../core/http.js';
import { getProtocol } from '../../core/protocol.js';
import { Prompts } from '../../core/prompts.js';
import { Memory } from '../../core/memory.js';
import { AgentContext } from '../../core/context.js';
import { Binding } from '../../core/binding.js';
import { asStringList, normalizeValue, normalizeParam, TOOL_FIELDS } from '../../core/params.js';
import { curSess, persistSession, saveSettings, hooks, val2 } from './host.js';
import { applyAppearance, updateCtx, checkStatus } from './session.js';
import { toast } from '../components/ui/toast.jsx';

const copy = (o) => JSON.parse(JSON.stringify(o));

/** 配置快照取值：登出后 state.settings 是 null，直接解引用会抛 "Cannot read properties of null"
 *  —— 用户看到的是"点了没反应"（2026-10-01 实测：登出后点侧栏"按时间分组"就会触发）。
 *  统一走这个取值：未登录时用出厂默认，改动只落在内存里，登录后由服务端那份覆盖。 */
const S = () => state.settings || defaultSettings();

/* ============================ 外观 ============================ */

export function setTheme(patchTheme) {
  const cur = S();
  const theme = Object.assign({}, cur.theme, patchTheme);
  patch({ settings: Object.assign({}, cur, { theme }) });
  applyAppearance();
  saveSettings();
}

/* ============================ 界面偏好（纯客户端：侧栏收没收、会话怎么分组…） ============================ */

export function setUi(key, value) {
  const cur = S();
  const ui = Object.assign({}, cur.ui, { [key]: value });
  patch({ settings: Object.assign({}, cur, { ui }) });
  saveSettings();
}

/* ============================ 模型（服务商） ============================ */

const newProviderId = () => 'p-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

export function addProvider(preset) {
  const id = newProviderId();
  const proto = getProtocol(preset.type);
  const p = {
    id,
    name: preset.name || '新模型',
    type: preset.type || 'openai',
    baseUrl: preset.baseUrl !== undefined ? preset.baseUrl : (proto.defaults.baseUrl || ''),
    model: preset.model || proto.defaults.model || '',
    apiKey: preset.apiKey || '',
    keyDirty: !!preset.apiKey,
  };
  const settings = copy(S());
  settings.providers.push(p);
  if (!settings.activeId) settings.activeId = id;
  patch({ settings });
  saveSettings();
  checkStatus();
  return id;
}

export function updateProvider(id, patchFields) {
  const settings = copy(S());
  const p = settings.providers.find((x) => x.id === id);
  if (!p) return;
  Object.assign(p, patchFields);
  if (typeof patchFields.apiKey === 'string') p.keyDirty = true;   // 真的输过才回传（空串=保持服务端原值）
  patch({ settings });
  saveSettings();
}

export function removeProvider(id) {
  const settings = copy(S());
  settings.providers = settings.providers.filter((p) => p.id !== id);
  if (settings.activeId === id) settings.activeId = settings.providers[0] ? settings.providers[0].id : '';
  patch({ settings });
  saveSettings();
  checkStatus();
  toast('已删除该模型配置');
}

export function setActiveProvider(id) {
  const cur = S();
  if (!cur.providers.some((p) => p.id === id)) return;
  patch({ settings: Object.assign({}, cur, { activeId: id }) });
  const s = curSess();
  if (s) { s.provider = id; persistSession(); }
  saveSettings();
  updateCtx();
  checkStatus();
}

/** 拉模型清单（写回 provider.models 缓存，供下拉用） */
export async function listModels(id) {
  const p = S().providers.find((x) => x.id === id);
  if (!p) return [];
  try {
    // 已保存的服务商只传 id，让服务端用它自己的密钥（浏览器拿不到密钥原文）
    const models = await getProtocol(p.type).listModels(Object.assign({}, p, { provider: p.id }));
    updateProvider(id, { models: models.slice(0, 500) });
    return models;
  } catch (e) {
    toast('拉取模型清单失败：' + e.message, 'err');
    return [];
  }
}

/** 测试连接：拉一次模型清单就够了（能列出来说明地址/密钥/协议都对） */
export async function testProvider(cfg) {
  try {
    // 有 id 且没现填密钥 → 让服务端用存着的那把；现填了密钥 → 用临时配置（不落盘）
    const ref = (cfg.id && !cfg.apiKey) ? Object.assign({}, cfg, { provider: cfg.id }) : cfg;
    const models = await getProtocol(ref.type).listModels(ref);
    return { ok: true, models };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

/* ============================ 参数 ============================ */

/** scope: '' = 全局；否则是该模型 key（'<providerId>::<model>'）。
 *  **归一化在这里做**（不只是控件层）：setParam 是参数写入的唯一 action，
 *  预设重放、插话钩子、"以后不再问"这类直连调用也走它——口径收在一处，
 *  越界/非法值不会因为"绕过了控件"就原样进 state 与磁盘。 */
export function setParam(key, value, scope) {
  const v = normalizeParam(key, value);
  const settings = copy(S());
  if (!scope) {
    settings.params = Object.assign({}, settings.params, { [key]: v });
  } else {
    const cur = settings.paramsByModel[scope] || {};
    settings.paramsByModel = Object.assign({}, settings.paramsByModel, {
      [scope]: Object.assign({}, cur, { [key]: v }),
    });
  }
  patch({ settings });
  saveSettings();
  updateCtx();
}

export function resetParamSection(keys, scope) {
  const settings = copy(S());
  if (!scope) {
    settings.params = Object.assign({}, settings.params);
    for (const k of keys) delete settings.params[k];
  } else {
    const cur = Object.assign({}, settings.paramsByModel[scope] || {});
    for (const k of keys) delete cur[k];
    settings.paramsByModel = Object.assign({}, settings.paramsByModel, { [scope]: cur });
  }
  patch({ settings });
  saveSettings();
  toast('已恢复本节的出厂值');
}

export function applyPreset(preset, scope) {
  for (const [k, v] of Object.entries(preset.params || {})) setParam(k, v, scope);
  toast(`已套用预设「${preset.label}」`, 'ok');
}

/** 清掉某个模型的全部覆盖（回到全局参数） */
export function clearModelOverrides(scope) {
  const settings = copy(S());
  delete settings.paramsByModel[scope];
  patch({ settings });
  saveSettings();
  toast('已清除该模型的单独覆盖，改用全局参数');
}

/* ============================ 工具配置 ============================ */

export async function setRoots(action, payload) {
  try {
    const d = await post(EP.toolsRoots, Object.assign({ action }, payload), { timeoutMs: 10000 });
    const settings = copy(S());
    settings.tools = Object.assign({}, settings.tools, { roots: d.roots });
    patch({ settings });
    const st = state.agentStatus;
    if (st) patch({ agentStatus: Object.assign({}, st, { roots: d.roots }) });
    toast('可访问目录已更新', 'ok');
  } catch (e) {
    toast('保存可访问目录失败：' + e.message, 'err');
  }
}

/* ============================ 本机账号绑定 ============================ */

const setInfoBinding = (binding) => {
  patch({ info: Object.assign({}, state.info, { binding }) });
};

export async function bindOsAccount(osUser, password) {
  const binding = await Binding.bind(osUser, password);
  setInfoBinding(binding);
  toast(`已绑定本机账号 ${binding.osUser}`, 'ok');
  return binding;
}

export async function unbindOsAccount() {
  const binding = await Binding.unbind();
  setInfoBinding(binding);
  toast('已解除绑定：文件与命令行工具将不再可用');
  return binding;
}

export async function unlockOsAccount(password) {
  const binding = await Binding.unlock(password);
  setInfoBinding(binding);
  toast('已解锁：现在可以以该账号执行命令', 'ok');
  return binding;
}

export async function lockOsAccount() {
  const binding = await Binding.lock();
  setInfoBinding(binding);
  toast('已锁定：解锁凭据已丢弃');
  return binding;
}

/* ============================ 提示词登记表 ============================ */

/* 「草稿 → 应用」这套语义（面板上的 NoteBox 与「应用」按钮都是这么写的）**只在前端**：
   草稿放 state.promptDrafts，不碰 core 的登记表；点「应用」才写进登记表（登记表自己会通知宿主落盘）。
   为什么要有草稿：登记表一变就会注入给模型（并落盘），逐字输入时每敲一下都生效等于没有"确认"这一步；
   而"有未应用的修改"必须能被看见，否则草稿就是无声的丢失（旧实现在 blur 时偷偷写进登记表，
   与按钮语义打架，且那两处 `Prompts.isDirty()` 调用指向一个**从未存在**的函数，徽章永远不显示）。

   草稿的形态是**补丁对象** { text?, name?, description?, auto? }：
     · 普通条目只会写 text；
     · 自定义技能（② 组里 custom: true 的条目）四个字段都可能在草稿里——
       技能不走覆盖表（Prompts.set 改不到技能记录），应用时整份交给 Prompts.updateSkill。 */
export function setPromptDraft(id, patchFields) {
  const cur = (state.promptDrafts || {})[id] || {};
  patch({ promptDrafts: Object.assign({}, state.promptDrafts, { [id]: Object.assign({}, cur, patchFields) }) });
}
/** 应用一条草稿（普通条目）：写进登记表（→ onChange → 落盘）+ 清掉草稿 */
export function applyPromptText(id, text) {
  Prompts.set(id, text);
  clearPromptDraft(id);
}
/** 自定义技能的立刻写入（不加草稿）：开关这类"一眼可见"的改动走这里；
 *  名称/用途/加载方式/正文与前者不同——它们也走草稿，点「应用」时由调用方整份传进来。 */
export function setSkillFields(id, patchFields) {
  Prompts.updateSkill(id, patchFields);
}
/** 丢掉一条草稿（应用后 / 恢复默认 / 删除条目时用） */
export function clearPromptDraft(id) {
  if (!(id in (state.promptDrafts || {}))) return;
  const next = Object.assign({}, state.promptDrafts);
  delete next[id];
  patch({ promptDrafts: next });
}

export function setPromptEnabled(id, enabled) {
  Prompts.setEnabled(id, enabled);
}
export function resetPrompt(id) {
  clearPromptDraft(id);
  Prompts.reset(id);
}
export function addPromptEntry(entry) {
  Prompts.addEntry(entry);
}
export function removePromptEntry(id) {
  clearPromptDraft(id);
  Prompts.removeEntry(id);
}
export function addSkill(skill) {
  Prompts.addSkill(skill);
}
export function removeSkill(id) {
  clearPromptDraft(id);
  Prompts.removeSkill(id);
}

/* ============================ 记忆 ============================ */

export function addMemory(scope, entry) {
  const r = Memory.write(Object.assign({ scope, source: 'user' }, entry));
  return r;
}
export function removeMemory(id, scope) {
  Memory.remove(id, scope);
}
export function memoryExport() {
  return JSON.stringify({
    global: Memory.listOf('global'),
    project: Memory.listOf('project'),
    projectMeta: Memory.projectMeta,
    session: Memory.listOf('session'),
  }, null, 2);
}
export function memoryImport(json) {
  const d = JSON.parse(json);
  let added = 0;
  // 项目记忆只在"有当前项目"时导入（没项目就没地方放，硬塞进全局记忆反而污染）
  const scopes = Memory.projectMeta ? ['global', 'project', 'session'] : ['global', 'session'];
  for (const scope of scopes) {
    for (const e of Array.isArray(d[scope]) ? d[scope] : []) {
      Memory.write({ scope, title: e.title, content: e.content, tags: e.tags, source: 'user' });
      added++;
    }
  }
  return added;
}

/* ============================ 数据（导出 / 压缩） ============================ */

export function exportAll() {
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    version: 2,
    settings: S(),
    sessions: state.sessions,
    projects: state.projects,
    prompts: Prompts.serialize(),
    memory: { global: Memory.listOf('global'), project: Memory.listOf('project'), session: Memory.listOf('session') },
  }, null, 2);
}

/* 压缩 / 取消压缩的**唯一入口**：界面上的三个入口（摘要条、用量环、设置 → 数据）都调这里的两个动作。
   原先四处各写一遍，行为还分岔——摘要条与用量环那两处**不拦流式**（生成中压缩会和本轮请求抢历史），
   提示文案也各不相同（审计）。失败/太短/被关掉的情况由 core 的 AgentContext 负责弹提示。 */
export async function compactNow() {
  if (state.streaming) { toast('正在生成回答：先点「停止」或等这轮结束再压缩', 'info'); return false; }
  await AgentContext.compactNow();
  updateCtx(); persistSession();
  return true;
}
export function uncompact() {
  AgentContext.uncompact();
  updateCtx();
  persistSession();
}


/* ============================ 确认框「以后不再问我」的落点 ============================
   两个钩子由 core/tool-runner.js 在用户勾选后调用，写回的都是**既有**的参数：
     · onExecAllow(rule)   → 追加进 exec_allow（命令允许清单，读取点在 runPluginTool 的 matchRule）
     · onSkillRemember()   → 把 skill_write_confirm 关掉（读取点在 AgentPolicy.eff 的 skillAsk）
   之前这两个勾选框都没有消费点：界面写着"以后不再问我"，勾了却每次都问
   （审计 C6 的后半条）。放在本文件是因为只有它持有 setParam。
   访问级别不是「自定」时 skillAsk 由档位决定、不读这个开关，所以勾选只在自定档下有意义
   —— 这与面板上的说明一致，不做特殊处理。 */
hooks.onExecAllow = (rule) => {
  const r = String(rule || '').trim();
  if (!r) return;
  /* 取值与写值都过**同一份收敛函数**（core/params.js 的 asStringList / normalizeValue）：
     旧写法 `val2('exec_allow') || []` 在"盘上是换行字符串"时会得到字符串，再 concat 出
     "a\nbc" 这种垃圾，随后被收敛成 [] —— 整份清单当场被抹掉（2026-10-01 实测）。
     收敛函数容忍两种形状，所以这一次写入同时把旧数据修回数组。 */
  const cur = asStringList(val2('exec_allow'));
  if (cur.includes(r)) return;
  setParam('exec_allow', normalizeValue(TOOL_FIELDS.exec_allow, cur.concat([r]).slice(-100)));
};
hooks.onSkillRemember = () => setParam('skill_write_confirm', false);
