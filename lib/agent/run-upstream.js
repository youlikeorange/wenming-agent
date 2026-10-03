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
  let done = false;
  const stream = new ReadableStream({
    start(controller) {
      /* 三种收尾**都要接**：end（正常读完）、error（出错 / 被 destroy(err)）、
         **close（兜底）**。Node 的 IncomingMessage 被 `destroy()`（不带错）时只发
         `aborted` + `close`，不发 end 也不发 error —— 漏了 close，web 流的读者
         会永远卡在 read()：整段运行收不了尾，界面永远"正在生成"
         （2026-10-01 实测的「点停止没反应」根因；上游半路断开也是同一形态）。 */
      const fin = (err) => {
        if (done) return;
        done = true;
        try { err ? controller.error(err) : controller.close(); } catch { /* 已取消 */ }
      };
      up.on('data', (c) => { try { controller.enqueue(new Uint8Array(c)); } catch { /* 已取消 */ } });
      up.on('end', () => fin(null));
      up.on('error', (e) => fin(e));
      /* 兜底 close：**不挂 aborted**（2026-10-03 修）。以前这里挂 aborted:true，内核的
         isAbort 就把它读成"用户点了停止"——真断线被记成正常结束：界面不报错、正文尾巴那句
         说明也留不下来（用户只看到"半句话停住"）。现在归成网络类错误：界面会报出来，
         内核按"上游出错"自动重试（等 30 秒，最多 3 次）。 */
      up.on('close', () => fin(Object.assign(new Error('上游连接中断：流还没结束，连接就断了'), { code: 'ECONNRESET' })));
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
      /* 用户点「停止」→ 把上游也掐掉（否则模型继续跑完，白烧 token）。
         **必须带错误 destroy**：不带错的 destroy 只发 close，toResponse 那头
         只能靠兜底 close 报"连接中断"，读者拿不到 AbortError，收尾会归到"请求失败"。 */
      if (signal) signal.addEventListener('abort', () => {
        try { res.destroy(Object.assign(new Error('已停止'), { name: 'AbortError', aborted: true })); } catch { /* 已结束 */ }
      }, { once: true });
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
