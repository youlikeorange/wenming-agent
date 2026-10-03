/* protocol/openai.js —— OpenAI 兼容协议（含一切"说 OpenAI 话"的本地与云端实现）
 *
 *  这一条协议同时覆盖：OpenAI、DeepSeek、硅基流动、Moonshot、智谱、OpenRouter、通义千问…
 *  以及本地 Ollama(/v1)、llama.cpp、vLLM、LM Studio、SGLang。**本地模型不另开协议分支**。
 *
 *  统一事件流：thinking | content | tool_calls | stats | stop | error
 */
import { upstreamChat, upstreamModels, refOf } from './transport.js';
import { sseLines, safeJson, stopReason } from './sse.js';
import { thinkSplitter } from './think.js';
import { textCallSplitter } from './textcalls.js';

/** 内部消息 → OpenAI 线格式 */
export function toMsg(m) {
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length) {
    return {
      role: 'assistant', content: m.content || null,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
      })),
    };
  }
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  return { role: m.role, content: m.content };
}

/** 内部工具定义 → OpenAI tools（两边形状本来就一样，只做字段筛选） */
export function toTools(tools) {
  return (tools || []).map((t) => ({
    type: 'function',
    function: { name: t.function.name, description: t.function.description, parameters: t.function.parameters },
  })).filter((t) => t.function.name);
}

/** 请求体构造（canonical 参数 → 线格式） */
export function buildBody(cfg, messages, params, opts = {}) {
  const p = params || {};
  /* 工具定义的口径兼容：宿主既可能放在 opts.tools（旧口径：opts 里参数与工具混装），
     也可能放进 params.tools。漏掉的后果很严重——模型收不到工具清单，会把调用**写成正文**
     （实测：正文里出现 <tool_call><function=read_file>… 的 XML，而界面上没有任何工具卡片）。 */
  const tools = (opts && opts.tools) || p.tools || [];
  const body = {
    model: cfg.model,
    messages: messages.map(toMsg),
    stream: true,
    stream_options: { include_usage: true },
    temperature: p.temperature,
    top_p: p.topP,
  };
  if (Number.isFinite(p.maxTokens) && p.maxTokens >= 0) body.max_tokens = p.maxTokens;
  if (p.stop && p.stop.length) body.stop = p.stop;
  if (p.seed !== undefined) body.seed = p.seed;
  if (p.topK !== undefined) body.top_k = p.topK;
  if (p.freqPenalty !== undefined) body.frequency_penalty = p.freqPenalty;
  if (p.presPenalty !== undefined) body.presence_penalty = p.presPenalty;
  if (p.reasoning && p.reasoning !== 'default') {
    body.reasoning_effort = p.reasoning === 'off' ? 'none' : p.reasoning;
  }
  if (tools.length) { body.tools = toTools(tools); body.tool_choice = 'auto'; }
  return body;
}

export async function listModels(cfg, signal) {
  const d = await upstreamModels(refOf(cfg), signal);
  const ids = (d.data || []).map((m) => m.id).filter(Boolean);
  // 有的兼容实现把清单放在 models 字段（Ollama 的 /v1/models 就是 data，但网关类五花八门）
  if (!ids.length && Array.isArray(d.models)) return d.models.map((m) => m.name || m.id).filter(Boolean).sort();
  return ids.sort();
}

/** 上游报错时把**它自己说的话**带上：只给一句"HTTP 401"，用户既不知道是密钥错了、
 *  额度用完了还是模型名写错了，也就无从修起（2026-10-01：要求"LLM 出问题要能在会话里
 *  反映出来"）。读一小段响应体，尽量抽出 error.message / message / detail，读不动就退回状态码。
 *  这里是**失败响应**，没有 SSE 流要留给下游解析，把 body 读掉是安全的。 */
function pickMessage(txt) {
  try {
    const j = JSON.parse(txt);
    const m = (j && ((j.error && (j.error.message || j.error.type)) || j.message || j.detail)) || '';
    if (m) return String(m).slice(0, 400);
  } catch { /* 不是 JSON：当纯文本用 */ }
  return txt.replace(/\s+/g, ' ').slice(0, 300);
}

async function errorText(r) {
  const head = 'HTTP ' + r.status;
  let txt = '';
  try { txt = String(await r.text()).slice(0, 800); } catch { return head; }
  return txt.trim() ? head + '：' + pickMessage(txt) : head;
}

export async function* chat(cfg, messages, params, opts = {}) {
  const body = buildBody(cfg, messages, params, opts);
  const r = await upstreamChat(refOf(cfg), body, opts.signal, opts.sessionId);
  if (!r.ok) yield { type: 'error', message: await errorText(r), status: r.status };
  // 流式 tool_calls 分片累积（按 index 还原分片顺序）
  const acc = new Map();   // index -> {id,name,argsStr}
  const takeCalls = () => [...acc.entries()].sort((a, b) => a[0] - b[0]).map(([i, c]) => ({
    id: c.id || ('call_' + i + '_' + Date.now()), name: c.name, args: safeJson(c.argsStr),
  }));
  const split = thinkSplitter();
  /* 有的上游不把工具调用放进 delta.tool_calls，而是**写进正文**（DSML 标记 / XML 形态，
     见 protocol/textcalls.js 的文件头）。正文一律再过一道"正文调用"拆分器：
     认出来的变成结构化 tool_calls（recovered 标记），认不出的原样当正文——
     旧实现不做这道工序，整块标记被当成"最终回答"，循环就此收尾（用户看到标记、模型没干活）。 */
  const tc = textCallSplitter();
  const bodyEvents = (evs) => {
    const out = [];
    for (const ev of evs) {
      if (ev.type === 'content') out.push(...tc.feed(ev.text));
      else out.push(ev);
    }
    return out;
  };
  /** 累积一条 delta 里的工具调用分片（按 index 还原顺序） */
  const absorbCalls = (list) => {
    for (const t of list) {
      const i = t.index === undefined ? 0 : t.index;
      const cur = acc.get(i) || { id: t.id || '', name: '', argsStr: '' };
      if (t.id) cur.id = t.id;
      if (t.function && t.function.name) cur.name = t.function.name;
      if (t.function && t.function.arguments) cur.argsStr += t.function.arguments;
      acc.set(i, cur);
    }
  };
  /* 这条流的"结束形态"：见过 finish_reason 或 [DONE] = 上游**正常收尾**；
     两者都没见过 = 半路被掐断（没有结束标记的半截响应，内核据此不当成"回答完了"）。 */
  const meta = { sawDone: false, sawFinish: false };
  for await (const line of sseLines(r, meta)) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.error) { yield { type: 'error', message: o.error.message || JSON.stringify(o.error) }; return; }
    const ch = (o.choices || [])[0];
    if (ch) {
      const d = ch.delta || {};
      const think = d.reasoning_content !== undefined ? d.reasoning_content : d.reasoning;
      if (think) yield { type: 'thinking', text: think };
      if (d.content) for (const ev of bodyEvents(split.feed(d.content))) yield ev;
      if (d.tool_calls) absorbCalls(d.tool_calls);
      if (ch.finish_reason) { meta.sawFinish = true; yield { type: 'stop', reason: stopReason(ch.finish_reason) }; }
      if (ch.finish_reason === 'tool_calls' && acc.size) {
        yield { type: 'tool_calls', calls: takeCalls() };
        acc.clear();
      }
    }
    if (o.usage) {
      yield { type: 'stats', raw: { eval_count: o.usage.completion_tokens, prompt_eval_count: o.usage.prompt_tokens } };
    }
  }
  // 兜底：有些服务商不发 finish_reason 就结束
  for (const ev of bodyEvents(split.flush())) yield ev;
  for (const ev of tc.flush()) yield ev;
  if (acc.size) yield { type: 'tool_calls', calls: takeCalls() };
  yield { type: 'stream_end', clean: meta.sawFinish || meta.sawDone };
}

export const openai = {
  id: 'openai',
  label: 'OpenAI 兼容',
  hint: 'Base URL 需含版本段，程序自动接 /chat/completions。\n'
    + '云端：https://api.deepseek.com/v1、https://api.openai.com/v1、https://api.siliconflow.cn/v1…\n'
    + '自建网关：http://your-host:8080/v1、'
    + 'http://127.0.0.1:8000/v1（vLLM）——只要实现 OpenAI 兼容协议就同样接纳。',
  defaults: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  listModels, chat, buildBody, toMsg, toTools,
};
