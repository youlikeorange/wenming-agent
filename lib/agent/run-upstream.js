/** lib/agent/run-upstream.js —— 托管运行的上游一跳（把"浏览器代转"换成服务端直连）
 *
 *  浏览器里的协议适配器（core/protocol/openai.js、anthropic.js）通过 transport.js 发
 *  POST /agent/upstream/chat，由服务端注入密钥。托管运行本来就在服务端，再绕一次 HTTP
 *  没有意义，所以这里提供同形状的实现：**构造同样的请求、走同样的出口校验**（公网白名单 +
 *  密钥主机绑定都在 lib/upstream-http.js / lib/agent/upstream.js 里，不因为换了一跳就绕过），
 *  然后把 Node 的响应包成 web Response —— 适配器那边的 SSE 解析一行不用改。
 */
const { upstreamRequest } = require('../upstream-http');
const upstream = require('./upstream');
const settings = require('./settings');
const { als } = require('./run-bridge');

/** Node 的 IncomingMessage → web Response（适配器只用到 status/ok/headers/body.getReader） */
function toResponse(up) {
  const stream = new ReadableStream({
    start(controller) {
      up.on('data', (c) => { try { controller.enqueue(new Uint8Array(c)); } catch { /* 已取消 */ } });
      up.on('end', () => { try { controller.close(); } catch { /* 已取消 */ } });
      up.on('error', (e) => { try { controller.error(e); } catch { /* 已取消 */ } });
    },
    cancel() { try { up.destroy(); } catch { /* 已结束 */ } },
  });
  const headers = new Headers();
  for (const [k, v] of Object.entries(up.headers || {})) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(', '));
  }
  return new Response(stream, { status: up.statusCode || 502, headers });
}

function requestOnce(up, body, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => { if (!settled) { settled = true; reject(Object.assign(new Error('已停止'), { name: 'AbortError' })); } };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    upstreamRequest({ url: up.url, method: 'POST', headers: up.headers, body }, (err, res) => {
      if (settled) { try { res && res.destroy(); } catch { /* 已丢 */ } return; }
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      if (err) return reject(err);
      // 用户点「停止」→ 把上游也掐掉（否则模型继续跑完，白烧 token）
      if (signal) signal.addEventListener('abort', () => { try { res.destroy(); } catch { /* 已结束 */ } }, { once: true });
      resolve(toResponse(res));
    });
  });
}

/** 本次运行用哪套服务商配置（账号从异步上下文取——见 run-bridge.js 的说明） */
function targetOf(ref) {
  const ctx = als.getStore();
  const account = (ctx && ctx.account) || '';
  const id = ref && (ref.provider || ref.id);
  const p = id ? settings.providerFor(account, id) : null;
  if (!p) throw Object.assign(new Error('服务商不存在（可能已被删除）'), { status: 404 });
  const norm = upstream.normalizeRef(p);
  if (!norm.baseUrl) throw Object.assign(new Error('该服务商未填写 Base URL'), { status: 400 });
  return { target: Object.assign(norm, { source: 'stored' }), account };
}

/** 与浏览器侧 /agent/upstream/chat 同形状：ref 里带 provider id，body 是协议请求体 */
async function nodeChat(ref, body, signal, sessionId) {
  const { target, account } = targetOf(ref);
  const up = upstream.buildUpstream(target, 'chat', { session: upstream.sessionValue({ sessionId }, account) });
  if (up.error) throw Object.assign(new Error(up.error), { status: 400 });
  const finalBody = upstream.applyExtraBody(body, target.extraBody);
  if (finalBody.model === undefined && target.model) finalBody.model = target.model;
  return requestOnce(up, finalBody, signal);
}

/** 模型清单（设置面板/探测用；托管运行本身不需要，保持同形状以免适配器分支） */
async function nodeModels(ref, signal) {
  const { target, account } = targetOf(ref);
  const up = upstream.buildUpstream(target, 'models', { session: upstream.sessionValue({}, account) });
  if (up.error) throw Object.assign(new Error(up.error), { status: 400 });
  const res = await requestOnce(up, null, signal);
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw new Error('上游返回的不是 JSON：' + text.slice(0, 200)); }
}

module.exports = { nodeChat, nodeModels, toResponse };
