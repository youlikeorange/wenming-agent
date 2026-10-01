/** lib/agent/upstream.js —— 模型流量代转（同源，密钥只在服务端；**只认标准协议**）
 *
 *  为什么代转：服务商配置（含 API Key）按文档站账号存在服务器端，浏览器拿不到密钥，所以前端
 *  不直连各家 API，而是把请求交给本站代转、由服务端注入密钥。好处：① 密钥永不下发浏览器；
 *  ② 浏览器侧 CSP 收紧回 connect-src 'self'；③ 跨域（CORS）与混合内容问题一并消失。
 *
 *  **协议只有两家标准**（"彻底切换"的落点）：
 *    openai    → {base}/chat/completions、{base}/models      （OpenAI 及一切兼容实现）
 *    anthropic → {base}/messages、{base}/models              （Anthropic 官方）
 *
 *  **只连公网**：出口地址由 lib/upstream-http.js 判定，回环/私网/链路本地/云元数据一律拒绝。
 *  因此本应用**不支持本机模型**（Ollama 之类），模型一律用远程 API 服务商——
 *  这既是安全取舍（服务端代转不能变成内网探测器，见审计 S4），也是"标准做法"：
 *  出站白名单朝公网收敛，而不是维护一张永远补不完的内网黑名单。
 *  旧的 type:'ollama' 记录在读取时升级成 openai 兼容，地址保留（若指向本机则会在请求时被拒）。
 *
 *  端点（都在 /agent/ 下，属 Agent 子项目的同源契约）：
 *    GET  /agent/info   → { ok, loggedIn, user, protocols }
 *    POST /agent/upstream/models → 模型清单（原样转发上游 JSON）
 *    POST /agent/upstream/chat   → 对话（流式原样回传：SSE，前端按协议解析）
 *
 *  请求体：
 *    { provider: '<服务商 id>', body: {...} }   → 用服务端保存的配置与密钥（推荐）
 *    { type, baseUrl, apiKey, body: {...} }     → 临时配置（"测试连接"用，不落盘）
 *    { sessionId: '<对话 id>', … }               → 可选：本次请求的会话标识（写进会话标识头，
 *                                                 网关据此做路由/提示词缓存；见 sessionHeaderFor）
 *
 *  安全：上游路径按协议类型写死（客户端不能指定任意 URL/路径，这不是开放代理）；
 *  只允许 http/https，屏蔽云元数据与链路本地地址；不跟随重定向；除 body 外的请求头全由服务端构造；
 *  响应里的 set-cookie 一律丢弃；支持 HTTPS_PROXY/HTTP_PROXY/NO_PROXY（经本机代理访问境外 API）。
 */
const { json } = require('../http');
const { upstreamRequest } = require('../upstream-http');
const settings = require('./settings');
const presence = require('./presence');

const MODELS_TIMEOUT_MS = Number(process.env.UPSTREAM_MODELS_TIMEOUT_MS || 30000);
const MAX_UPSTREAM_CHARS = 4 * 1024 * 1024;

/** 逐跳首部 + 长度类首部：转发响应时不带上（由本次连接自行协商） */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length']);
/** 响应侧额外必须丢弃的头：set-cookie 绝不能透传——上游（用户可自填的 Base URL）能借此在本站域
 *  写 cookie，覆盖登录态或塞任意持久数据；这是"代转"与"开放代理"之间的关键差别之一。 */
const RESP_DROP = new Set([...HOP_BY_HOP, 'set-cookie', 'set-cookie2']);

/** 协议 → 上游路径（写死；客户端无法指定任意路径） */
const ROUTES = {
  openai: { chat: '/chat/completions', models: '/models' },
  anthropic: { chat: '/messages', models: '/models' },
};
const PROTOCOLS = [
  { id: 'openai', label: 'OpenAI 兼容', hint: 'Base URL 需含版本段，如 https://api.deepseek.com/v1（程序自动接 /chat/completions）' },
  { id: 'anthropic', label: 'Anthropic', hint: 'Base URL 形如 https://api.anthropic.com/v1（程序自动接 /messages）' },
];

/** 出站 UA：网关按它识别"这是哪个客户端"。**不能填通用 HTTP 库的名字**——
 *  opencode Go 的接入要求写明客户端要用自家 UA（形如 my-coding-agent/1.0），
 *  通用名字会被当成"不像编码智能体"的流量。 */
const CLIENT_UA = 'wenming-agent/2.0';

/** "会话标识头"的自动判定（按 Base URL 域名认网关）。
 *  有些网关要求客户端为**每段对话**带一个稳定 id，否则直接 400——opencode Go 就是：
 *    HTTP 400 {"type":"error","error":{"type":"MissingSessionID",
 *      "message":"Request is missing x-opencode-session and cannot be routed efficiently…"}}
 *  命中下表就自动带上（用户可在服务商配置里手填 sessionHeader 覆盖，自建网关用）。 */
const SESSION_HEADER_BY_HOST = [
  { suffix: 'opencode.ai', header: 'x-opencode-session' },
];
function sessionHeaderFor(target, base) {
  if (target.sessionHeader) return target.sessionHeader;
  const host = String((base && base.hostname) || '').toLowerCase();
  for (const it of SESSION_HEADER_BY_HOST) {
    if (host === it.suffix || host.endsWith('.' + it.suffix)) return it.header;
  }
  return '';
}

/** 会话标识的**值**：前端带上"这次对话"的 id（同一段对话恒定不变 → 上游据此做路由与
 *  提示词缓存）。没带值（模型清单这类辅助请求）就回落成本账号的稳定 id：既不留空
 *  （空值同样被判成 MissingSessionID），又不会把不同对话串成同一段。 */
function sessionValue(cfg, account) {
  const raw = String((cfg && cfg.sessionId) || '').trim();
  if (/^[A-Za-z0-9._:-]{1,128}$/.test(raw)) return raw;
  const seed = String(account || 'anon');
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return 'wm-' + (h >>> 0).toString(36);
}

/** 旧数据的类型升级：ollama 原生 → openai 兼容，其余非法值回落 openai。
 *  **不在这里补任何默认地址**：地址只以用户填的为准。旧 ollama 记录若指向本机，
 *  会在出站判定时被明确拒绝（本应用不支持本机模型），而不是被静默改成别的地址——
 *  那正是审计修过的"Base URL 填错被静默替换"的假象。 */
function normalizeRef(ref) {
  const type = ref.type === 'anthropic' ? 'anthropic' : 'openai';
  const baseUrl = String(ref.baseUrl || '').trim();
  return { type, baseUrl, apiKey: String(ref.apiKey || ''), model: ref.model || '', extraBody: ref.extraBody, headers: ref.headers, sessionHeader: ref.sessionHeader };
}

/** 本次请求用哪套配置：已保存的（带密钥）或临时传入的（"测试连接"） */
function resolveTarget(cfg, account) {
  if (cfg.provider) {
    const p = settings.providerFor(account, cfg.provider);
    if (!p) return { error: '服务商不存在（可能已被删除）', status: 404 };
    const norm = normalizeRef(p);
    if (!norm.baseUrl) return { error: '该服务商未填写 Base URL', status: 400 };
    return Object.assign(norm, { source: 'stored' });
  }
  const norm = normalizeRef(cfg);
  if (!ROUTES[norm.type]) return { error: '不支持的协议类型', status: 400 };
  if (!norm.baseUrl) return { error: '缺少 Base URL', status: 400 };
  return Object.assign(norm, { source: 'ad-hoc' });
}

/** 配置 → 上游 URL 与首部（密钥在这里注入，浏览器永远看不到）
 *  @param {{session?: string}} extra 本次请求的会话标识（对话 id；见 sessionValue） */
function buildUpstream(target, kind, extra = {}) {
  let base;
  try { base = new URL(target.baseUrl); } catch { return { error: 'Base URL 不是合法网址' }; }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') return { error: '只支持 http/https 的 Base URL' };
  const prefix = base.pathname.replace(/\/+$/, '');
  const url = base.protocol + '//' + base.host + prefix + ROUTES[target.type][kind];
  const headers = { accept: 'application/json', 'accept-encoding': 'identity', 'user-agent': CLIENT_UA };
  if (target.type === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
    if (target.apiKey) headers['x-api-key'] = target.apiKey;
  } else if (target.apiKey) {
    headers.authorization = 'Bearer ' + target.apiKey;
  }
  // 额外的请求头由用户在设置里填（给网关类服务加自定义头用），不允许覆盖上面注入的鉴权头
  const custom = new Set();
  if (target.headers && typeof target.headers === 'object') {
    for (const [k, v] of Object.entries(target.headers)) {
      const lk = String(k).toLowerCase();
      if (lk === 'authorization' || lk === 'x-api-key' || lk === 'host' || lk === 'content-length') continue;
      if (/^[a-z0-9-]{1,64}$/.test(lk) && typeof v === 'string') { headers[lk] = v.slice(0, 1000); custom.add(lk); }
    }
  }
  // 会话标识头：网关要求客户端为每段对话带稳定 id（opencode Go 缺它就 400）。
  // 用户在"额外请求头"里手填过同名头就以用户的为准，不覆盖。
  const sh = sessionHeaderFor(target, base);
  if (sh && !custom.has(sh) && extra.session) headers[sh] = extra.session;
  return { url, headers };
}

/** 把用户填的"额外请求体"（JSON 文本）合并进请求体；不允许覆盖核心字段 */
function applyExtraBody(body, extra) {
  if (!extra || typeof extra !== 'string' || !extra.trim()) return body;
  let obj;
  try { obj = JSON.parse(extra); } catch { return body; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return body;
  const protectedKeys = new Set(['model', 'messages', 'stream', 'tools', 'tool_choice', 'system']);
  for (const [k, v] of Object.entries(obj)) {
    if (protectedKeys.has(k) || k === '__proto__') continue;
    body[k] = v;
  }
  return body;
}

function sendUpstream(target, kind, method, bodyObj, extra, cb) {
  const up = buildUpstream(target, kind, extra);
  if (up.error) return cb(Object.assign(new Error(up.error), { status: 400 }));
  return upstreamRequest({ url: up.url, method, headers: up.headers, body: bodyObj }, cb);
}

/** 连接类错误翻译成人话（带上目标主机，便于区分"没启动"和"没登录"） */
function describe(err, target) {
  const where = tryOrigin(target.baseUrl);
  if (err.status) return err.message;
  const code = err.code || '';
  if (code === 'ECONNREFUSED') return `无法连接 ${where}（连接被拒绝：本机模型没启动？或地址/端口不对）`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `无法解析 ${where} 的域名（网络或代理问题？）`;
  if (code === 'ETIMEDOUT') return `连接 ${where} 超时`;
  return `请求 ${where} 失败：${err.message}`;
}
function tryOrigin(baseUrl) {
  try { return new URL(baseUrl).origin; } catch { return baseUrl || '(未设置地址)'; }
}

function proxyError(res, err, target) {
  res.setHeader('X-Agent-Proxy', 'error');
  return json(res, err.status || 502, { ok: false, error: describe(err, target) });
}

/* ============================ 端点 ============================ */

async function handleUpstream(req, url, res, _session, actor) {
  const path = url.pathname.slice('/agent/upstream'.length);

  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' });
  /* 登录闸门在 lib/agent/index.js 的路由前（/agent/upstream/* 未登录 → needLogin 401），
     这里拿到的 session 一定存在。原先那份自带的 401 分支不可达（审计），已删——
     若哪天有人绕过路由直接调本函数，下面的 actor.account 会立刻抛错，比静默放行更好。 */

  let cfg;
  try { cfg = await require("./store").readAgentJson(req, url.pathname); } catch (e) { return json(res, e.status || 400, { ok: false, error: 'invalid json' }); }
  const target = resolveTarget(cfg || {}, actor.account);
  if (target.error) return json(res, target.status || 400, { ok: false, error: target.error });
  // 会话标识头（网关路由用）：对话请求带"这段对话的 id"，其余请求回落到本账号的稳定 id
  const extra = { session: sessionValue(cfg, actor.account) };

  if (path === '/models') {
    return sendUpstream(target, 'models', 'GET', null, extra, (err, up) => {
      if (err) return proxyError(res, err, target);
      let data = '';
      up.setEncoding('utf8');
      /* 模型清单是一次性的小 JSON，可以整体超时（对话流不能——模型可能几十秒不出字）。
         没有这道闸，上游接了连接却永不回包时，请求会一直挂着、"模型管理"永久转圈。 */
      const guard = setTimeout(() => {
        up.destroy(Object.assign(new Error(`上游 ${MODELS_TIMEOUT_MS}ms 内未返回模型清单`), { code: 'ETIMEDOUT' }));
      }, MODELS_TIMEOUT_MS);
      if (guard.unref) guard.unref();
      up.on('data', (c) => { if (data.length < MAX_UPSTREAM_CHARS) data += c; });
      up.on('error', (e) => { clearTimeout(guard); if (!res.headersSent) proxyError(res, e, target); });
      up.on('end', () => {
        clearTimeout(guard);
        if (up.statusCode >= 200 && up.statusCode < 300) {
          res.setHeader('X-Agent-Proxy', 'upstream');
          res.writeHead(up.statusCode, { 'Content-Type': up.headers['content-type'] || 'application/json', 'Cache-Control': 'no-store' });
          return res.end(data);
        }
        return json(res, up.statusCode || 502, { ok: false, upstream: true, error: `上游返回 HTTP ${up.statusCode}：${data.slice(0, 300)}` });
      });
    });
  }

  if (path === '/chat') {
    if (!cfg || !cfg.body || typeof cfg.body !== 'object') return json(res, 400, { ok: false, error: '缺少 body' });
    const body = applyExtraBody(cfg.body, target.extraBody);
    if (body.model === undefined && target.model) body.model = target.model;
    // 从请求一开始就登记：等首字可能几十秒，这段时间里被顶掉也要能掐断
    presence.trackStream(presence.cidOf(req), res);
    return sendUpstream(target, 'chat', 'POST', body, extra, (err, up) => {
      if (err) return proxyError(res, err, target);
      const out = { 'X-Agent-Proxy': 'upstream' };    // 标记：这个状态码来自上游模型服务，不是本站的登录判断
      for (const [k, v] of Object.entries(up.headers)) if (!RESP_DROP.has(k.toLowerCase())) out[k] = v;
      if (!out['content-type']) out['content-type'] = 'text/event-stream; charset=utf-8';
      out['Cache-Control'] = 'no-store';
      out['X-Accel-Buffering'] = 'no';             // 隧道/反代下也不要缓冲，保证逐字流式
      res.writeHead(up.statusCode || 502, out);
      up.pipe(res);                                // 流式：边生成边下发，不缓冲整段回答
      req.on('aborted', () => up.destroy());
      up.on('error', () => { if (res.headersSent) res.destroy(); else proxyError(res, new Error('上游连接中断'), target); });
      // 客户端提前断开（用户点「停止」）时把上游也掐掉：不然模型继续跑完，白烧 token
      res.on('close', () => { if (!res.writableEnded) { try { up.destroy(); } catch { /* 已结束 */ } } });
    });
  }

  return json(res, 404, { ok: false, error: 'unknown upstream endpoint' });
}

module.exports = {
  handleUpstream, PROTOCOLS, ROUTES, normalizeRef, applyExtraBody,
  CLIENT_UA, SESSION_HEADER_BY_HOST, sessionHeaderFor, sessionValue, buildUpstream,
};
