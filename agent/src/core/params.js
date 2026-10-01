/* core/params.js —— 参数 schema 的**唯一真源**（默认值 / 范围 / 说明 / 适用协议）+ 取值解析
 *
 *  为什么把 schema 与界面分开：参数不只在设置抽屉里用——Agent 循环、工具预算、请求体构造、
 *  上下文裁剪都要读它。以前默认值散在 params-ui.js 与 agent-defs.js 两处，改一处忘一处就会
 *  出现"面板显示了但实际不生效"。现在只有这一份 FIELDS / TOOL_FIELDS。
 *
 *  三层取值（后者覆盖前者）：
 *      出厂默认（本文件） → 全局设置（settings.params） → 每模型覆盖（settings.paramsByModel['<服务商id>::<模型>'])
 *  每模型覆盖是"这个模型特殊，别的照旧"的标准做法：换模型不用手改一串数字。
 *
 *  下发约定：**默认值 = 不下发**。各家的扩展字段（top_k / seed / 惩罚项）名字与语义差异很大，
 *  对不认识的字段有的忽略、有的直接 400；只在用户主动改过时才发出去最稳。
 *  只有 temperature / top_p / max_tokens / stop 这几个"谁都有"的字段按下发值给。
 */

/* ============================ 生成参数（标准协议字段） ============================ */
export const FIELDS = {
  temperature: {
    label: '温度', group: 'sampling', kind: 'range', def: 0.7, min: 0, max: 2, step: 0.01, always: true,
    tip: '采样随机性。0 最确定、2 最发散；做代码/事实验证时调低（0.1~0.3），创意写作用 0.8~1.2。',
  },
  topP: {
    key: 'top_p', label: 'top_p（核采样）', group: 'sampling', kind: 'range', def: 0.8, min: 0, max: 1, step: 0.01, always: true,
    tip: '只从累积概率前 p 的词里取。与温度配合：温度调高时通常把 top_p 收到 0.9 以内。',
  },
  maxTokens: {
    key: 'max_tokens', label: '单次最多输出（max_tokens）', group: 'generation', kind: 'number', def: -1, min: -1, step: 1, always: true,
    tip: '一次回答最多生成多少 token。-1 = 不下发（用模型/服务端默认）；Anthropic 协议必须给值，未设时用 4096。',
  },
  stop: {
    key: 'stop', label: '停止序列', group: 'generation', kind: 'lines', def: '', always: true,
    tip: '每行一条。生成的文本命中其中任一条就立刻停下（常用于截住模型自己编的下一轮对话开头）。',
  },
  seed: {
    key: 'seed', label: '随机种子', group: 'sampling', kind: 'number', def: -1, min: -1, step: 1,
    tip: '同一种子 + 同一输入 = 同样的输出（服务端支持时才有效）。-1 = 每次随机。默认不下发。',
  },
  topK: {
    key: 'top_k', label: 'top_k（候选词数）', group: 'sampling', kind: 'number', def: 0, min: 0, max: 1000, step: 1,
    tip: '只从概率最高的 k 个词里取，0 = 关闭。多数云端 API 不支持（默认不下发）；本地模型（llama.cpp/vLLM/Ollama）支持。',
  },
  frequencyPenalty: {
    key: 'frequency_penalty', label: '频率惩罚', group: 'penalty', kind: 'range', def: 0, min: -2, max: 2, step: 0.1,
    tip: '按出现次数惩罚已用过的词，减少复读。0 = 关闭；过高会让句子变得不自然。默认不下发。',
  },
  presencePenalty: {
    key: 'presence_penalty', label: '存在惩罚', group: 'penalty', kind: 'range', def: 0, min: -2, max: 2, step: 0.1,
    tip: '只要出现过就惩罚，鼓励引入新话题。默认不下发。',
  },
  reasoning: {
    label: '推理强度', group: 'generation', kind: 'select', def: 'default',
    options: [['default', '默认（不下发）'], ['off', '关闭'], ['low', '低'], ['medium', '中'], ['high', '高']],
    tip: 'OpenAI 协议下发 reasoning_effort；Anthropic 协议开启扩展思考并给出思考预算（低 4K / 中 8K / 高 16K token）。'
      + '"默认" = 完全不下发，交给服务端自己决定。',
  },
  ctxLimit: {
    label: '上下文上限（本界面的用量环）', group: 'context', kind: 'number', def: 32768, min: 512, step: 512, always: false,
    tip: '只影响本界面的用量显示与自动压缩阈值——它不发给模型（协议里没有这个字段）。'
      + '本地模型请填该模型实际加载的上下文长度（如 32768），云端模型填服务端上限。',
  },
  extraBody: {
    label: '额外请求体（JSON）', group: 'context', kind: 'json', def: '',
    tip: '直接合并进请求体，给"协议之外"的厂商扩展用。'
      + '例：火山方舟写 {"thinking":{"type":"disabled"}}。'
      + '核心字段（messages/model/stream/tools）不允许被覆盖。',
  },
};

/** 分组（设置抽屉里的分区顺序与标题） */
export const GROUPS = [
  { id: 'generation', label: '生成控制' },
  { id: 'sampling', label: '采样' },
  { id: 'penalty', label: '重复惩罚' },
  { id: 'context', label: '上下文与扩展' },
];

/** 快速预设（只写 FIELDS 里存在的键） */
export const PRESETS = [
  { id: 'precise', label: '精确', params: { temperature: 0.2, topP: 0.5, topK: 10 } },
  { id: 'balanced', label: '平衡', params: { temperature: 0.7, topP: 0.8, topK: 20 } },
  { id: 'creative', label: '创意', params: { temperature: 1.0, topP: 0.95, topK: 40 } },
  { id: 'code', label: '代码', params: { temperature: 0.2, topP: 0.95, topK: 20 } },
  { id: 'longcontext', label: '长文 128K', params: { temperature: 0.7, topP: 0.8, ctxLimit: 131072 } },
];

/* ============================ 工具 / Agent 行为参数 ============================ */
export const TOOL_FIELDS = {
  tool_search_max: { label: '单轮最多检索', group: 'search', kind: 'number', def: 3, min: 1, step: 1,
    tip: '一轮对话里模型最多调用几次联网搜索（搜索消耗服务端配额）。' },
  tool_mem_on: { label: '启用记忆能力', group: 'memory', kind: 'switch', def: true,
    tip: '关掉后模型既看不到记忆，也不能写记忆；已有条目仍保留在面板里。' },
  mem_auto: { label: '允许模型自己写记忆', group: 'memory', kind: 'switch', def: true,
    tip: '关掉后记忆只读：模型不能自己记新条目（你仍可手工添加）。' },
  session_mem_on: { label: '会话记忆整段注入', group: 'memory', kind: 'switch', def: true,
    tip: '开启时本对话的记忆条目每轮都随上下文发出；关掉后条目保留但不再进上下文（省 token）。' },
  mem_inject: { label: '全局记忆注入方式', group: 'memory', kind: 'select', def: 'index',
    options: [['index', '只给目录（推荐）'], ['full', '整段注入'], ['off', '不注入']],
    tip: '全局记忆跨对话有效。条目多时"只给目录"最省 token，模型需要哪条再用工具取全文。' },
  project_mem_inject: { label: '项目记忆注入方式', group: 'memory', kind: 'select', def: 'index',
    options: [['index', '只给目录（推荐）'], ['full', '整段注入'], ['off', '不注入']],
    tip: '项目记忆跟着"当前项目"（设置 → 项目 里选的根目录）走，存在服务端的项目记忆文件夹里。'
      + '选"不注入"后条目仍保留，只是不再进上下文。' },
  tool_mem_max: { label: '单轮记忆/技能调用上限', group: 'memory', kind: 'number', def: 8, min: 1, step: 1,
    tip: '一轮里"写记忆 / 忘记忆 / 加载技能"合计最多几次。' },
  skill_tools_on: { label: '启用技能能力', group: 'skills', kind: 'switch', def: true,
    tip: '技能 = 你写的一段方法论，模型按需加载。关掉后不注册技能工具、也不注入技能清单。' },
  skill_write_confirm: { label: '模型改技能前先问我', group: 'skills', kind: 'switch', def: true,
    tip: '开启时模型新建/修改/删除技能都要你点确认。' },
  plugin_fs_on: { label: '文件与目录工具', group: 'fs', kind: 'switch', def: true,
    tip: '读文件/列目录/目录树/找文件/文件属性 + 写文件/改文件/建目录/移动/删除。' },
  plugin_fs_write: { label: '允许写入', group: 'fs', kind: 'switch', def: true,
    tip: '关掉后只剩只读工具（写文件/改文件/建目录/移动一律拒绝）。' },
  plugin_fs_delete: { label: '允许删除', group: 'fs', kind: 'switch', def: false,
    tip: '删除不可逆，默认不给模型。' },
  plugin_fs_confirm: { label: '写前确认', group: 'fs', kind: 'switch', def: false, customOnly: true,
    tip: '只在访问级别为「自定」时生效：每次写入都先给你看 diff。' },
  plugin_fs_delete_confirm: { label: '删除前确认', group: 'fs', kind: 'switch', def: true, customOnly: true,
    tip: '只在访问级别为「自定」时生效：删除前列出将删除的内容。' },
  plugin_fs_max: { label: '单轮文件操作上限', group: 'fs', kind: 'number', def: 12, min: 1, step: 1,
    tip: '只读操作不计入；写/改/建/移/删才扣次数。' },
  plugin_fs_read_kb: { label: '单次读取上限', group: 'fs', kind: 'number', def: 64, min: 1, step: 1, unit: 'KB',
    tip: '一次 read_file 最多返回多少（超出部分用 start_line/end_line 分段读）。服务端另有硬上限。' },
  plugin_exec_on: { label: '命令行工具', group: 'exec', kind: 'switch', def: true,
    tip: '以**绑定的本机账号**执行 shell 命令——能做到什么完全由那个账号在系统里的权限决定。' },
  plugin_exec_confirm: { label: '执行前确认', group: 'exec', kind: 'switch', def: true, customOnly: true,
    tip: '只在访问级别为「自定」时生效：每条命令都先给你看原文。' },
  plugin_exec_max: { label: '单轮命令上限', group: 'exec', kind: 'number', def: 6, min: 1, step: 1,
    tip: '一轮里最多执行几条命令。' },
  plugin_exec_timeout: { label: '单条命令超时', group: 'exec', kind: 'number', def: 60, min: 1, step: 1, unit: '秒',
    tip: '超过就杀掉整个进程组。服务端硬上限（默认 600 秒）之下才有效。' },
  plugin_exec_out_kb: { label: '输出上限', group: 'exec', kind: 'number', def: 16, min: 1, step: 1, unit: 'KB',
    tip: 'stdout+stderr 各自的上限，超出截断（并注明已截断）。' },
  agent_access: { label: '访问级别', group: 'access', kind: 'select', def: 'custom',
    options: [['custom', '自定（按开关逐项决定）'], ['ask', '每次都问'], ['auto_edit', '自动改文件'], ['full', '完全访问']],
    tip: '四档决定"哪些操作要你点头"。无论哪一档，都不超过绑定账号在系统里的权限。' },
  exec_allow: { label: '命令允许清单', group: 'access', kind: 'list', def: [],
    tip: '命中的命令不再询问（任何档位都生效）。只支持"整条命令的前缀"匹配；含管道/串联的整行不给豁免。' },
};

/** 工具参数的默认值表（供其它模块直接取用）。**从上面的 TOOL_FIELDS 推导**，是唯一真源——
 *  审计前 core/agent-defs.js 里另有一份手抄副本（零消费、还得靠人肉同步），已删除。 */
export const TOOL_DEFAULTS = Object.fromEntries(Object.entries(TOOL_FIELDS).map(([k, f]) => [k, f.def]));

/* ============================ 取值解析 ============================ */

const isBlank = (v) => v === undefined || v === null || v === '';

/** 覆盖链：出厂 → 全局 → 每模型。空值（''/undefined）= 用上一层，不是"设为空"。 */
export function resolve(settings, providerId, model) {
  const out = {};
  for (const [k, f] of Object.entries(FIELDS)) out[k] = f.def;
  for (const [k, f] of Object.entries(TOOL_FIELDS)) out[k] = f.def;
  Object.assign(out, pickNonBlank(settings && settings.params));
  const key = modelKey(providerId, model);
  if (key && settings && settings.paramsByModel) Object.assign(out, pickNonBlank(settings.paramsByModel[key]));
  return out;
}

function pickNonBlank(src) {
  const out = {};
  if (!src || typeof src !== 'object') return out;
  for (const [k, v] of Object.entries(src)) if (!isBlank(v)) out[k] = v;
  return out;
}

export const modelKey = (providerId, model) => (providerId && model ? `${providerId}::${model}` : '');

/** 该键在"全局"与"每模型"上的差异（面板上标出被覆盖的项） */
export function overriddenBy(settings, providerId, model, key) {
  const key2 = modelKey(providerId, model);
  const perModel = key2 && settings && settings.paramsByModel ? settings.paramsByModel[key2] : null;
  return !!(perModel && !isBlank(perModel[key]));
}

/** 把任意输入收敛成 schema 允许的形状（保存前调用；越界一律夹回范围） */
export function normalizeValue(field, v) {
  if (!field) return v;
  if (v === '' || v === null || v === undefined) return field.kind === 'switch' ? !!field.def : '';
  if (field.kind === 'switch') return !!v;
  if (field.kind === 'number' || field.kind === 'range') {
    const n = Number(v);
    if (!Number.isFinite(n)) return '';
    const lo = field.min === undefined ? -Infinity : field.min;
    const hi = field.max === undefined ? Infinity : field.max;
    return Math.max(lo, Math.min(hi, n));
  }
  if (field.kind === 'select') {
    return (field.options || []).some(([id]) => id === v) ? v : field.def;
  }
  if (field.kind === 'list') return Array.isArray(v) ? v.map((x) => String(x)) : [];
  return String(v);
}

/** 停止序列：每行一条（空行丢掉） */
export function toStopList(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean).slice(0, 8);
  return String(v || '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 8);
}

/** kind:'list' 参数的取值收敛（唯一真源）：数组原样、换行/逗号分隔的字符串拆成数组、其余当空。
 *  为什么要容忍字符串：exec_allow 曾被两个写入方写成两种形状——界面写数组、
 *  托管运行写 `list.join('\n')` 字符串，而读取端只认数组，于是"以后不再问"永不生效，
 *  面板在字符串上 concat 还会把整份清单收敛成 []（2026-10-01 实测）。
 *  写入端一律用 normalizeValue(field, v) 收敛；读取端用这个兜住已经在盘上的旧数据。 */
export const asStringList = (v) => (Array.isArray(v)
  ? v.map((x) => String(x).trim()).filter(Boolean)
  : String(v == null ? '' : v).split(/[\n,]+/).map((s) => s.trim()).filter(Boolean));

/**
 * 参数 → 各协议通用的请求字段（canonical）。
 *   · always 字段（temperature/top_p/max_tokens/stop）照发；
 *   · 其余字段**只在用户改过**（与出厂默认不同）时才带上——各家扩展字段名同义差，乱发会 400；
 *   · 返回 { temperature, topP, maxTokens, stop, seed, topK, freqPenalty, presPenalty, reasoning, think }
 */
export function toRequestParams(p) {
  const q = p || {};
  const changed = (k, def) => !isBlank(q[k]) && q[k] !== def && q[k] !== '';
  const out = {
    temperature: Number.isFinite(Number(q.temperature)) ? Number(q.temperature) : FIELDS.temperature.def,
    topP: Number.isFinite(Number(q.topP)) ? Number(q.topP) : FIELDS.topP.def,
    maxTokens: Number.isFinite(Number(q.maxTokens)) ? Number(q.maxTokens) : FIELDS.maxTokens.def,
    stop: toStopList(q.stop),
    reasoning: q.reasoning || 'default',
  };
  if (changed('seed', FIELDS.seed.def) && Number(q.seed) >= 0) out.seed = Math.floor(Number(q.seed));
  if (changed('topK', FIELDS.topK.def) && Number(q.topK) > 0) out.topK = Math.floor(Number(q.topK));
  if (changed('frequencyPenalty', FIELDS.frequencyPenalty.def)) out.freqPenalty = Number(q.frequencyPenalty);
  if (changed('presencePenalty', FIELDS.presencePenalty.def)) out.presPenalty = Number(q.presencePenalty);
  return out;
}

/** 每模型生效的上下文上限（用量环的分母）：参数 > 服务商设置 > 出厂默认 */
export function ctxLimitOf(settings, provider, params) {
  const fromParams = Number(params && params.ctxLimit);
  if (Number.isFinite(fromParams) && fromParams >= 512) return Math.floor(fromParams);
  const fromProvider = Number(provider && provider.ctxLimit);
  if (Number.isFinite(fromProvider) && fromProvider >= 512) return Math.floor(fromProvider);
  return FIELDS.ctxLimit.def;
}

/** 额外请求体：JSON 文本 → 对象（解析失败返回 null，调用方给提示） */
export function parseExtraBody(text) {
  const s = String(text || '').trim();
  if (!s) return {};
  try {
    const o = JSON.parse(s);
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    return o;
  } catch { return null; }
}
