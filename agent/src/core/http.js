/* core/http.js —— 统一的请求层（同源 + 单窗口标识 + 错误归类）
 *
 *  为什么单独一层：单窗口互斥靠请求头 X-Agent-Client（服务端按它判断"这个窗口是否已被顶掉"），
 *  所有请求都必须带上；错误也要分类（要登录 / 被顶掉 / 上游报错 / 普通失败），
 *  否则界面只能一律显示"请求失败"，用户不知道下一步该做什么。
 *
 *  这里不碰 DOM，也不 import 任何 UI —— core 层可以整体在 Node 下跑单测。
 */
import { CLIENT_HEADER, AUTH_HEADER, PROXY_HEADER, LOCK_HEADER } from './endpoints.js';

/** 本窗口的随机标识（只放内存，刷新即换；服务端用它做单窗口占用） */
let clientId = '';
export function cid() {
  if (!clientId) {
    const rnd = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID().replace(/-/g, '')
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
    clientId = 'c' + rnd.slice(0, 30);
  }
  return clientId;
}
/** 业务错误：带上分类标记，界面据此决定弹什么 */
export class ApiError extends Error {
  constructor(message, opts = {}) {
    super(message || '请求失败');
    this.name = 'ApiError';
    Object.assign(this, opts);          // status / needLogin / kicked / upstream / needBind / needUnlock ...
  }
}

/** 错误体 → 人话：本站是 {error:'文本'}，OpenAI/Anthropic 是 {error:{message}} */
function errText(data, status) {
  if (data && typeof data.error === 'string' && data.error) return data.error;
  if (data && data.error && typeof data.error.message === 'string') return data.error.message;
  if (data && typeof data.message === 'string' && data.message) return data.message;
  return 'HTTP ' + status;
}

/** 传输实现可替换：浏览器用全局 fetch（相对路径 = 同源 /agent/*）；
 *  服务端托管运行（lib/agent/run.js）装一份"进程内直调"的实现——按路径直接调用
 *  真实的处理函数，于是 core/tool-runner.js 那条 HTTP 链路**一行不改**就能在服务端跑，
 *  工具执行只有一份实现（审计：同一件事只许一份实现）。
 *  注入点在 fetch 这一层而不是 request 这一层：request() 的超时、中断、
 *  错误分类（needLogin/needUnlock/needGrant…）必须照旧生效。 */
let fetchImpl = null;
export function setFetchImpl(fn) { fetchImpl = fn; }
const doFetch = (url, init) => (fetchImpl ? fetchImpl(url, init) : fetch(url, init));

/** 三个"响应头或响应体里说"的判定（判据见 endpoints.js 的头标记） */
function classify(res, d) {
  return {
    upstream: res.headers.get(PROXY_HEADER) === 'upstream' || !!d.upstream,
    needLogin: res.headers.get(AUTH_HEADER) === 'need-login' || !!d.needLogin,
    kicked: !!d.kicked || res.headers.get(LOCK_HEADER) === 'taken',
  };
}

/** 非 2xx / ok:false → **统一分类**的 ApiError。raw 与非 raw 共用这一处：
 *  错误分类不该由"调用方走哪条分支"决定——raw 那条（模型流量、SSE）原先不判状态码，
 *  401/404 会被当作"一个普通的流"交回去解析，错误就被静默吞掉了。 */
function apiError(res, data) {
  const d = data || {};
  return new ApiError(errText(d, res.status), Object.assign({
    status: res.status,
    code: d.code,
    hit: d.hit || '',
    osUser: d.osUser || '',
    payload: d,
  }, classify(res, d), {
    needBind: !!d.needBind,
    needUnlock: !!d.needUnlock,
    needGrant: !!d.needGrant,
    needPermission: !!d.needPermission,
    needRoots: !!d.needRoots,
  }));
}

/** raw 路径的错误响应：错误响应**不是流**，把正文读出来分类（读不动就按状态码兜底） */
async function throwIfBadRaw(res) {
  if (res.ok) return;
  let data = {};
  try { data = await res.json(); } catch { /* 非 JSON（错误原文）或空体：交给状态码 */ }
  throw apiError(res, data);
}

/** 统一 fetch：带窗口标识、归类错误、解析 JSON 体。
 *  @param {string} url
 *  @param {{method?, body?, signal?, timeoutMs?, raw?}} opts  raw=true 时直接返回 Response（流式） */
export async function request(url, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  /* 窗口标识**每个请求都带**（cid() 自己会缓存）。它是服务端单窗口互斥的唯一凭据，
     原先写成 `if (clientId)`（要等别处先调过一次 cid()）——"谁先谁后"会决定一条请求
     能不能被服务端拦住；模型流量（protocol/transport.js）当年自己 fetch 也正是漏在这一点上。 */
  headers[CLIENT_HEADER] = cid();
  /* method 与"带不带 body"必须一起决定：
     GET/HEAD **不能有 body**——浏览器会直接抛 TypeError（"Request with GET/HEAD method cannot
     have body"），而调用方传 body:null 表示"没有 body"这种写法很自然（send(store, null, 'GET')）。
     两个条件合起来判，否则 GET 一律失败（实测：拉取服务端数据整条链路 500 一样静默）。 */
  const method = String(opts.method || (opts.body === undefined || opts.body === null ? 'GET' : 'POST')).toUpperCase();
  const hasBody = opts.body !== undefined && opts.body !== null && method !== 'GET' && method !== 'HEAD';
  let body;
  if (hasBody) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const ac = new AbortController();
  const outer = opts.signal;
  const relay = () => { try { ac.abort(outer && outer.reason); } catch { /* 忽略 */ } };
  if (outer) { if (outer.aborted) relay(); else outer.addEventListener('abort', relay, { once: true }); }
  let timer = null;
  if (opts.timeoutMs) {
    timer = setTimeout(() => {
      try { ac.abort(new DOMException(`请求超过 ${Math.round(opts.timeoutMs / 1000)} 秒没有响应`, 'TimeoutError')); } catch { ac.abort(); }
    }, opts.timeoutMs);
  }
  let res;
  try {
    res = await doFetch(url, { method, headers, body, signal: ac.signal });
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') throw new ApiError('已停止', { aborted: true });
    throw new ApiError(e && e.name === 'TimeoutError' ? e.message : `无法连接服务端：${e.message}`, { network: true });
  }
  /* **不摘 relay**：raw 模式下 body 由调用方流式读取，ac.signal 仍管辖那条读取——
     旧实现在这里（以及上面的 catch 里）`outer.removeEventListener('abort', relay)`，
     于是响应头一到就断了转发，用户点「停止」再也中断不了在读的 body
     （实测：服务端发完头就挂住时只能干等；流式则会把上游整段读完）。
     relay 用 { once: true } 注册，触发即自摘；未触发时随 outer 一起被回收
     （outer 是每轮对话/每次工具调用新建的 signal）。 */
  if (opts.raw) {
    /* 流式：超时只守"建连 + 首响应头"。body 由调用方逐块读，另有空闲看门狗兜底
       （protocol/sse.js 的 IDLE_TIMEOUT_MS），这里不能继续计时——长回答会被误杀。
       非 2xx 在这里就地分类抛出（见 throwIfBadRaw）。 */
    clearTimeout(timer);
    await throwIfBadRaw(res);
    return res;
  }

  let data = {};
  try {
    data = await res.json();
  } catch (e) {
    /* body 阶段被中断（用户点「停止」或上面的超时）：**必须报错**，不能静默当成空对象——
       否则 `res.ok === true` + `data = {}` 会被下面的判断当成"成功但无内容"返回，
       调用方拿到一个空结果还以为一切正常（审计 C8 的连带项）。 */
    clearTimeout(timer);
    const reason = ac.signal.reason;
    if ((reason && reason.name === 'TimeoutError') || (e && e.name === 'TimeoutError')) {
      throw new ApiError((reason && reason.message) || '请求超时', { network: true });
    }
    if (ac.signal.aborted || (e && e.name === 'AbortError')) throw new ApiError('已停止', { aborted: true });
    data = undefined;            // 非 JSON / 空体：见下面那条"不能当成功"的判断
  }
  /* 非流式：计时器**覆盖到 body 读完**。旧实现在拿到响应头就 clearTimeout，
     于是"服务端发完头就不结束 body"这一形态下 timeoutMs 形同虚设——调用会无限挂住
     （审计 C8 实测：进程被外层 15s timeout 杀掉，请求始终没返回）。 */
  clearTimeout(timer);
  if (!res.ok || (data && data.ok === false)) throw apiError(res, data || {});
  /* 2xx 但**不是 JSON**：不能当成"成功但无内容"。真实形态是隧道/反代用 200 返回一张
     HTML 兜底页、或响应被截断 —— 空对象交给调用方就是"服务端数据是空的"，
     界面会把账号的记忆/会话整份清空（2026-10-01 审计）。这里明确报错。 */
  if (data === undefined) throw new ApiError('服务端返回的不是 JSON（可能是代理兜底页或响应被截断）', { network: true, status: res.status });
  return data;
}

/** GET JSON */
export const get = (url, opts) => request(url, Object.assign({ method: 'GET' }, opts));
/** POST JSON */
export const post = (url, body, opts) => request(url, Object.assign({ body }, opts));
