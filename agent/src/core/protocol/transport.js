/* protocol/transport.js —— 模型流量的同源传输（协议适配器共用的唯一出口）
 *
 *  浏览器不直连任何模型 API：请求交给本站 /agent/upstream/*，由服务端注入密钥并按协议拼路径。
 *  这样密钥永不下发浏览器，CSP 也保持 connect-src 'self'（跨域/混合内容问题一并消失）。
 *
 *  ref 两种形态：
 *    { provider: '<服务商 id>' }                  用服务端保存的配置（推荐）
 *    { type, baseUrl, apiKey, extraBody }         临时配置（"测试连接"用，不落盘）
 */
import { EP } from '../endpoints.js';
import { request } from '../http.js';

/**
 * 组装 ref（发给 /agent/upstream/* 的"用哪套配置"说明）。
 *
 * **只有两种形态**，判据必须严格——错判的后果是"界面上明明填了密钥，上游却说没带密钥"：
 *   · 有 id（= 客户端里那个脱敏过的服务商对象，或 settings.js 传的 {provider:id}）
 *     → `{ provider: id }`：密钥由服务端注入，浏览器连密钥字符串都没有；
 *   · 没有 id（= 表单里刚填好、还没保存的临时配置，"测试连接"用）
 *     → 把 type/baseUrl/apiKey/extraBody/headers 一并带上，不落盘。
 *
 * 2026-09-29 修：此前只认 `cfg.provider`，而对话与状态探测传进来的是**服务端下发脱敏过的
 * provider 对象**（只有 id，没有 apiKey），于是被判成"临时配置 + 空密钥"——
 * 服务端存着密钥也不会用，表现就是"密钥填了、显示末四位了，一发消息却报没有 API Key"。
 * 显式标记 `adHoc: true` 可强制走临时形态（表单里改了密钥但还没保存时测试连接要用新值）。
 */
export function refOf(cfg, opts = {}) {
  if (!cfg) return {};
  const adHoc = !!(opts.adHoc || cfg.adHoc);
  if (!adHoc) {
    const id = cfg.provider || cfg.id;
    if (id) return { provider: id };
  }
  return {
    type: cfg.type || 'openai',
    baseUrl: cfg.baseUrl || '',
    apiKey: cfg.apiKey || '',
    extraBody: cfg.extraBody || '',
    headers: cfg.headers,
    sessionHeader: cfg.sessionHeader,   // "测试连接"要能试出自填的会话标识头
  };
}

/** 首字节超时：上游"接上了但永不响应"时请求会一直挂着，读取阶段的看门狗（sse.js 的
 *  IDLE_TIMEOUT_MS）根本没机会跑。只守"建连 + 首响应头"，之后由空闲看门狗接管。 */
export const FIRST_BYTE_TIMEOUT_MS = 90000;

/** 统一的分类在 core/http.js（needLogin / kicked / upstream / 状态码，从响应头与响应体判）；
 *  这里只补一句人话——**仅当拿到的是一句光秃秃的 HTTP 状态码**时（有错误正文时，
 *  服务端/上游已经把原因写清楚了，不再画蛇添足）。 */
function modelError(e) {
  if (e && e.upstream && /^HTTP \d+$/.test(String(e.message || ''))) {
    e.message = `${e.message}（模型服务返回，请检查密钥、额度与模型名）`;
  }
  return e;
}

/** 模型流量也走**统一请求层**（core/http.js 的 request）：窗口标识头 X-Agent-Client、
 *  建连超时、abort 转发、错误分类（needLogin/kicked/upstream）都在那一处，不再自己 fetch。
 *  这里只是"raw=true 拿原始 Response 自己读流"的调用形态。 */
async function upstream(url, opts) {
  try { return await request(url, opts); } catch (e) { throw modelError(e); }
}

/** 会话标识只带**形状合法**的值（服务端还会再校验一次）；拿不到就不带，由服务端回落成账号级 id。
 *  为什么必须带：opencode Go 这类网关要求客户端为每段对话声明稳定 id（缺了直接 400
 *  MissingSessionID），而且同一段对话恒定不变才能吃到上游的提示词缓存。 */
const sessionIdOf = (id) => (typeof id === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(id) ? { sessionId: id } : null);

/** 流式对话：body 由适配器按协议构造，响应（SSE）原样回给解析器
 *  @param {AbortSignal} [signal] 用户点「停止」时中断在途请求（漏传的话上游会一直跑到写完）
 *  @param {string} [sessionId] 本次对话的 id（服务端写进"会话标识头"） */
async function browserChat(ref, body, signal, sessionId) {
  return upstream(EP.chat, {
    method: 'POST', signal, timeoutMs: FIRST_BYTE_TIMEOUT_MS, raw: true,   // raw：SSE 由适配器逐块读
    body: Object.assign({}, ref, { body }, sessionIdOf(sessionId)),
  });
}

/** 模型清单：原样回上游 JSON（openai/anthropic 都是 {data:[{id}]}） */
function browserModels(ref, signal) {
  return upstream(EP.models, { method: 'POST', body: ref, signal, timeoutMs: FIRST_BYTE_TIMEOUT_MS });
}

/* 传输实现可在**同一份协议适配器**下替换：浏览器默认走同源 /agent/upstream/*；
   服务端（lib/agent/run.js 的托管运行）装一份直连上游的实现，于是 openai.js/anthropic.js
   的解析、think 拆分、正文型调用识别这些**只写一遍**，两端行为不会分叉。 */
let impl = { chat: browserChat, models: browserModels };
/** 只在服务端启动时装一次；浏览器侧永不调用 */
export function setTransport(next = {}) {
  impl = { chat: next.chat || impl.chat, models: next.models || impl.models };
}

export const upstreamChat = (ref, body, signal, sessionId) => impl.chat(ref, body, signal, sessionId);
export const upstreamModels = (ref, signal) => impl.models(ref, signal);

