/* core/assemble.js —— 提示词组装与参数取值（**UI 无关的纯函数**，两端共用）
 *
 *  为什么单独一层：这套东西原先只长在 ui/state/host.js 里，于是"服务端托管运行"
 *  （lib/agent/run.js，关掉浏览器也不中断的那条路）要自己再写一遍——两份组装逻辑
 *  一分叉，同一句提问在两条路上发给模型的 system 区块、工具清单、访问级别判定就会不同。
 *  审计的结论是"同一件事只许一份实现"，所以这里按**显式依赖**（env）抽出来：
 *    · 浏览器：ui/state/host.js 把 state 包成 env 传进来；
 *    · 服务端：lib/agent/run.js 把账号数据包成 env 传进来。
 *  两个宿主都只做"取数"，判定与拼装全在这里。
 *
 *  env 的形状（缺哪个就是"那个能力不可用"，函数自己会跳过）：
 *    settings   配置（providers/params/paramsByModel…）
 *    history    当前会话的消息数组（内部形状，含 toolCalls/thinking/trace）
 *    curSess()  取当前会话对象（压缩摘要 compaction 从它读）
 *    Prompts / Memory / AgentDefs / AgentPolicy / AgentContext   core 层的登记表与工具
 *    params     **已生效的参数对象**（可选；不给就按 settings 现算）
 */
import { resolve as resolveParams, TOOL_FIELDS, FIELDS, toRequestParams } from './params.js';

/** 当前服务商（activeId 指向的那个；找不到就用第一个） */
export function activeProviderOf(settings) {
  const list = (settings && settings.providers) || [];
  if (!list.length) return null;
  const id = settings.activeId;
  return list.find((p) => p.id === id) || list[0];
}

/** 参数取值：出厂 → 全局 → 每模型覆盖（唯一真源在 core/params.js） */
export const paramsOf = (settings, providerId, model) => resolveParams(settings || {}, providerId, model);

/** 生效参数对象（env.params 优先，否则按服务商现算） */
export function effParams(env) {
  if (env.params && typeof env.params === 'object') return env.params;
  const p = activeProviderOf(env.settings);
  return paramsOf(env.settings, p && p.id, p && p.model);
}

/** 单个参数：生效值 → 工具参数出厂默认 → 普通参数出厂默认 */
export function val2Of(env, key) {
  const v = effParams(env)[key];
  if (v !== undefined && v !== '') return v;
  if (TOOL_FIELDS[key]) return TOOL_FIELDS[key].def;
  if (FIELDS[key]) return FIELDS[key].def;
  return undefined;
}

/** 四档访问级别 → "哪些操作要问"的实际判定。
 *  与旧实现 `AgentPolicy.eff(S.params, TOOL_DEFAULTS)` 同一口径（只在「自定」档下才读那四个开关）。 */
export function accessOfEnv(env, toolDefaults) {
  return env.AgentPolicy.eff(effParams(env), toolDefaults);
}

/** 本轮注入的区块与工具名（界面展示与实际发送同源） */
export function promptBlocks(env) {
  const { Prompts, Memory, AgentDefs } = env;
  const val2 = (k) => val2Of(env, k);
  let blocks = Prompts.systemBlocks();
  // 插件说明只在对应插件开着**且插件工具真的可用**时注入（关掉/未登录/未绑定 = 连工具都不注册）
  const allow = AgentDefs.pluginsAllowed();
  blocks = blocks.filter((b) => (b.id === 'plugin.fs.usage' ? (allow && !!val2('plugin_fs_on'))
    : b.id === 'plugin.exec.usage' ? (allow && !!val2('plugin_exec_on')) : true));
  const skillIndex = Prompts.skillIndexBlock();
  if (skillIndex) blocks.push(skillIndex);
  const gate = AgentDefs.pluginGateNote();
  if (gate) blocks.push(gate);
  // 「完全访问」档追加一句"不必再逐条问"——不然模型明明拿着工具，还是会停下来等你点头
  if (accessOfEnv(env, env.TOOL_DEFAULTS).mode === 'full' && Prompts.enabled('plugin.access.full.note')) {
    blocks.push({ id: 'plugin.access.full.note', title: '访问级别 · 完全访问', text: Prompts.text('plugin.access.full.note') });
  }
  if (val2('tool_mem_on')) {
    const mode = val2('mem_inject') || 'index';
    const gb = mode === 'full' ? Memory.fullBlock() : mode === 'index' ? Memory.indexBlock() : null;
    if (gb) blocks.push(gb);                                            // 全局记忆（索引或全文）
    /* 项目记忆：跟着"当前项目"走。**即使一条记忆都没有也要注入**——它同时告诉模型
       "现在在哪个项目、根目录在哪"，那是项目记忆里最有用的一条事实。 */
    const pb = Memory.projectBlock(val2('project_mem_inject') || 'index');
    if (pb) blocks.push(pb);
    if (val2('session_mem_on')) { const sb = Memory.sessionBlock(); if (sb) blocks.push(sb); }
  }
  const tools = AgentDefs.activeToolDefs().map((d) => d.function.name);
  return { blocks, tools };
}

/** 本轮 system 消息（区块之间用 --- 分隔，与实际发送完全同源） */
export function systemMessage(env) {
  const { blocks } = promptBlocks(env);
  return blocks.length ? { role: 'system', content: blocks.map((b) => b.text).join('\n\n---\n\n') } : null;
}

const toApiMsg = (m) => ((m.toolCalls && m.toolCalls.length)
  ? { role: 'assistant', content: m.content || '', toolCalls: m.toolCalls }
  : { role: m.role, content: m.content });

/** 组装发给模型的 messages：system 区块 +（压缩摘要）+ 历史 + 本条输入 */
export function buildMessages(env, extraUser) {
  const msgs = [];
  const sys = systemMessage(env);
  if (sys) msgs.push(sys);
  const history = env.history || [];
  const sess = env.curSess ? env.curSess() : null;
  const cp = sess && sess.compaction;
  const from = cp && cp.text ? Math.min(cp.upTo || 0, history.length) : 0;
  /* 摘要抬头复用 core 的那一份实现（原先这里是逐字相同的第二份，审计） */
  if (from > 0) msgs.push({ role: 'user', content: env.AgentContext.compactHeader(cp) + '\n\n' + cp.text, __compaction: true });
  msgs.push(...history.slice(from).map(toApiMsg));
  if (extraUser !== undefined) msgs.push({ role: 'user', content: extraUser });
  // 空正文且没有工具调用的 assistant 消息不发：没有信息量，Anthropic 会直接 400
  return msgs.filter((m) => !(m.role === 'assistant' && !m.content && !(m.toolCalls && m.toolCalls.length)));
}

/** 「发送预览」用：区块清单 + 实际 messages（JSON）+ 工具 schema */
export function sendPreview(env) {
  const { blocks, tools } = promptBlocks(env);
  const msgs = buildMessages(env);
  const defs = env.AgentDefs.activeToolDefs();
  return { blocks, tools, messages: msgs, defs };
}

/** 本轮请求参数（**两端唯一的实现**）：参数表 → 协议字段；有工具就带上；extraBody 透传；模型名兜底。
 *  服务端托管运行（lib/agent/run.js 的 buildOpts）与浏览器宿主（ui/state/host.js 的 buildOptions）
 *  原先各写一份、只靠注释同步口径 —— 收敛到这里（压缩摘要也读它：context.js 会在副本上删掉 tools）。 */
export function buildRequestOptions({ params, defs, model, extraBody } = {}) {
  const opts = toRequestParams(params || {});
  if (defs && defs.length) opts.tools = defs;
  if (extraBody) opts.__extraBody = extraBody;      // 由适配器/传输层消费
  if (!opts.model && model) opts.model = model;
  return opts;
}

export const Assemble = {
  activeProviderOf, paramsOf, effParams, val2Of, accessOfEnv,
  promptBlocks, systemMessage, buildMessages, buildRequestOptions, sendPreview, toApiMsg,
};
