/* protocol/anthropic.js —— Anthropic Messages 协议（api.anthropic.com/v1 或任何兼容网关）
 *
 *  与 OpenAI 协议的三处结构差异（都在这里吸收掉，上层只认统一事件流）：
 *    ① system 是**顶层字段**，不是 messages 里的一条；
 *    ② 工具结果走 user 消息里的 tool_result 块，且 user/assistant 必须**严格交替**
 *      （并行工具调用的多条 tool_result、或滤掉空 assistant 后相邻的两条 user，都要合并）；
 *    ③ 流式事件是"带事件名的 SSE"（content_block_start/delta/stop、message_delta…）。
 */
import { upstreamChat, upstreamModels, refOf } from './transport.js';
import { sseEvents, safeJson, stopReason } from './sse.js';
import { textCallSplitter } from './textcalls.js';

/** 内部消息 → Anthropic 线格式（工具结果包成 user 的 tool_result 块）
 *
 *  **扩展思考必须原样回传**：开启 thinking 后，带 tool_use 的 assistant 轮里那只
 *  thinking 块（含 signature）是上游校验的一部分——不回传就整轮 400，
 *  表现为"一开推理强度、只要模型调用工具就彻底不能用"（2026-10-01 审计）。
 *  顺序也有要求：thinking / redacted_thinking 必须在最前。 */
export function toMsg(m) {
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length) {
    const blocks = [];
    /* signature 是上游给的完整性凭据，缺了就不能构造这个块（伪造一个只会换来另一种 400）——
       没有签名的历史（旧数据 / 从别的协议切过来）跳过，让请求至少能发出去。 */
    if (m.thinking && m.thinkingSig) blocks.push({ type: 'thinking', thinking: m.thinking, signature: m.thinkingSig });
    if (m.redactedThinking) blocks.push({ type: 'redacted_thinking', data: m.redactedThinking });
    if (m.content) blocks.push({ type: 'text', text: m.content });
    m.toolCalls.forEach((c) => blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args || {} }));
    return { role: 'assistant', content: blocks };
  }
  if (m.role === 'tool') {
    return { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }] };
  }
  return { role: m.role, content: m.content };
}

/** 合并相邻的同角色 user 消息（Anthropic 要求严格交替，否则直接 400） */
export function mergeAdjacent(msgs) {
  const merged = [];
  for (const m of msgs) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === 'user' && m.role === 'user') {
      const a = Array.isArray(prev.content) ? prev.content : [{ type: 'text', text: prev.content || '' }];
      const b = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content || '' }];
      prev.content = a.concat(b);
    } else merged.push(m);
  }
  return merged;
}

/** 内部工具定义 → Anthropic tools（把 function 摊平） */
export function toTools(tools) {
  return (tools || []).map((t) => ({
    name: t.function.name, description: t.function.description, input_schema: t.function.parameters,
  })).filter((t) => t.name);
}

/** 推理强度 → 扩展思考预算（token） */
const THINK_BUDGET = { low: 4096, medium: 8192, high: 16384 };
/** 思考预算的最小可用值（Anthropic 要求 ≥1024） */
const MIN_THINK_BUDGET = 1024;

export function buildBody(cfg, messages, params, opts = {}) {
  const p = params || {};
  /* 工具定义的口径兼容：宿主既可能放在 opts.tools（旧口径：opts 里参数与工具混装），
     也可能放进 params.tools。漏掉的后果很严重——模型收不到工具清单，会把调用**写成正文**
     （实测：正文里出现 <tool_call><function=read_file>… 的 XML，而界面上没有任何工具卡片）。 */
  const tools = (opts && opts.tools) || p.tools || [];
  const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const msgs = mergeAdjacent(messages.filter((m) => m.role !== 'system').map(toMsg));
  // Anthropic 的 max_tokens 是必填项：未设时用 4096
  const maxTokens = (Number.isFinite(p.maxTokens) && p.maxTokens > 0) ? p.maxTokens : 4096;
  const body = { model: cfg.model, messages: msgs, stream: true, max_tokens: maxTokens };
  if (sys) body.system = sys;
  if (p.stop && p.stop.length) body.stop_sequences = p.stop;
  const thinking = p.reasoning && p.reasoning !== 'default' && p.reasoning !== 'off';
  if (thinking) {
    /* Anthropic 硬约束：**max_tokens 必须大于 thinking.budget_tokens**，否则整轮 400。
       旧实现把预算写死成 4096/8192/16384 而 max_tokens 默认 4096 —— 于是默认参数下
       把推理强度从「默认」改成 low/medium/high，每一轮请求都被上游拒绝（审计 C5）。
       这里把预算压到 max_tokens-1 以内（且不低于 1024）；max_tokens 太小时干脆不开思考，
       让请求能正常发出——比 400 更接近用户想要的"能回答"。 */
    const budget = Math.min(THINK_BUDGET[p.reasoning] || 8192, maxTokens - 1);
    if (budget >= MIN_THINK_BUDGET) body.thinking = { type: 'enabled', budget_tokens: budget };
    // 开启扩展思考时 Anthropic 要求 temperature 必须为 1（否则 400），这里干脆不指定
  } else {
    if (Number.isFinite(p.temperature)) body.temperature = p.temperature;
    if (Number.isFinite(p.topP)) body.top_p = p.topP;
  }
  if (tools.length) body.tools = toTools(tools);
  return body;
}

export async function listModels(cfg, signal) {
  const d = await upstreamModels(refOf(cfg), signal);
  return (d.data || []).map((m) => m.id).filter(Boolean).sort();
}

export async function* chat(cfg, messages, params, opts = {}) {
  const body = buildBody(cfg, messages, params, opts);
  const r = await upstreamChat(refOf(cfg), body, opts.signal, opts.sessionId);
  let usage = null;
  let cur = null;          // 正在累积的 tool_use 块
  let jsonStr = '';
  /* 正文里"写成工具调用"的标记（DSML / XML）同样要认回来——有的兼容网关把
     tool_use 漏成 text_delta 下发，见 protocol/textcalls.js。 */
  const tc = textCallSplitter();
  for await (const evt of sseEvents(r)) {
    const { event, data } = evt;
    let o; try { o = JSON.parse(data); } catch { continue; }
    const type = o.type || event;          // 官方事件类型在 data 里；event: 行作兜底
    if (type === 'error') { yield { type: 'error', message: (o.error && o.error.message) || 'API error' }; return; }

    if (type === 'content_block_start' && o.content_block && o.content_block.type === 'tool_use') {
      cur = { id: o.content_block.id, name: o.content_block.name };
      jsonStr = '';
    } else if (type === 'content_block_start' && o.content_block && o.content_block.type === 'redacted_thinking') {
      /* 安全系统判红的那部分思考：原文不给，只给一段加密 data，回传时必须原样带上 */
      if (o.content_block.data) yield { type: 'thinking_redacted', text: String(o.content_block.data) };
    } else if (type === 'content_block_delta') {
      const d = o.delta || {};
      if (d.type === 'thinking_delta' && d.thinking) yield { type: 'thinking', text: d.thinking };
      else if (d.type === 'signature_delta' && d.signature) yield { type: 'thinking_sig', text: d.signature };
      else if (d.type === 'text_delta' && d.text) for (const ev of tc.feed(d.text)) yield ev;
      else if (d.type === 'input_json_delta') jsonStr += (d.partial_json || '');
    } else if (type === 'content_block_stop' && cur) {
      yield { type: 'tool_calls', calls: [{ id: cur.id, name: cur.name, args: safeJson(jsonStr) }] };
      cur = null; jsonStr = '';
    }
    if (type === 'message_delta') {
      if (o.usage) usage = o.usage;
      if (o.delta && o.delta.stop_reason) yield { type: 'stop', reason: stopReason(o.delta.stop_reason) };
    }
    if (type === 'message_start' && o.message && o.message.usage) usage = o.message.usage;
  }
  for (const ev of tc.flush()) yield ev;      // 收尾：正文里没闭合的调用块（流结尾）在这里结算
  if (usage) {
    yield { type: 'stats', raw: { eval_count: usage.output_tokens, prompt_eval_count: usage.input_tokens } };
  }
}

export const anthropic = {
  id: 'anthropic',
  label: 'Anthropic',
  hint: 'Base URL 形如 https://api.anthropic.com/v1，程序自动接 /messages。\n'
    + '请求由本站服务端代转（密钥保存在服务器端），因此不需要上游支持 CORS。',
  defaults: { baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5' },
  listModels, chat, buildBody, toMsg, toTools,
};
