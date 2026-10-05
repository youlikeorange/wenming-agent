/** lib/upstream-http.js —— 出站 HTTP 的公共传输层（给模型代转用，零依赖）
 *
 *  智能体 Agent 的模型代转（lib/agent/upstream.js）与用户级代转（lib/llm-proxy.js）共用同一套：
 *    · 出口代理支持（HTTPS_PROXY / HTTP_PROXY + CONNECT 隧道 + NO_PROXY）
 *    · 建连超时（只守建连；长回答不做整体超时，由前端的「停止」中止）
 *    · SSRF 基线：云元数据地址与链路本地地址一律不发
 *  用法：upstreamRequest({ url, method, headers, body, timeoutMs }, (err, upstreamRes) => …)
 */
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');

const CONNECT_TIMEOUT_MS = Number(process.env.UPSTREAM_CONNECT_TIMEOUT_MS || 20000);

/* 出口地址策略（**只允许公网**）—— 标准的服务端出站做法
 *
 *  为什么不是"只拦元数据"：那是个黑名单，永远补不完（2026-09-30 实测旧实现漏了
 *  [::ffff:169.254.169.254]、metadata.google.internal.（尾点）、169.254.169.254.nip.io、
 *  fd00::1 等写法）。白名单方向才是可穷举的：**公网地址才放行**，
 *  回环 / 私网 / 链路本地 / 保留段 / 云元数据一律拒绝。
 *
 *  与"本机模型"的关系：本应用**不再支持本机模型**（模型一律走远程 API 服务商）。
 *  这既是安全取舍也是产品定位——服务端代转的出口只该通往公网，
 *  否则任何登录用户都能拿它探测内网（SSRF）。
 *
 *  两道判定：
 *    ① 主机名/字面量形态（下面的 hostBlocked）：拦字面 IP 与元数据主机名；
 *    ② DNS 解析后的实际地址（resolvesToBlocked）：拦"域名指向内网"的写法（nip.io 之类）。
 *  两者都不做"域名白名单"——那会把用户的自建网关挡在门外，而本项目的用法是
 *  "用户自己填 Base URL"。公网可达性 + 密钥绑定主机（见 lib/agent/settings.js 的 keyHost）
 *  已经覆盖了主要风险面。
 */
const BLOCKED_HOSTS = /^(metadata\.google\.internal|metadata\.goog|metadata\.azure\.com|100\.100\.100\.200|instance-data|metadata)$/i;

/** 归一化主机名：小写、去尾点、剥 IPv6 方括号；IPv4-mapped 的 IPv6 还原成 IPv4 */
function normalizeHost(hostname) {
  let h = String(hostname || '').trim().toLowerCase();
  h = h.replace(/\.+$/, '');                                   // 尾点：metadata.google.internal.
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1); // IPv6 字面量
  // IPv4-mapped：::ffff:169.254.169.254 与 ::ffff:a9fe:a9fe 两种写法都还原
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (mapped) return mapped[1];
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (hexMapped) {
    const n = parseInt(hexMapped[1], 16) * 65536 + parseInt(hexMapped[2], 16);
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
  }
  return h;
}

/** 字面 IPv4 → 是否属于"非公网"段（回环/私网/链路本地/保留/组播/广播） */
function nonPublicV4(h) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return null;                       // 不是 IPv4 字面量
  const [a, b] = [Number(m[1]), Number(m[2])];
  const c = Number(m[3]), d = Number(m[4]);
  if ([a, b, c, d].some((n) => n > 255)) return '地址不合法';
  if (a === 0) return '保留地址（0.0.0.0/8）不在公网出口范围内';
  if (a === 127) return '回环地址（127.0.0.0/8）不在公网出口范围内';
  if (a === 10) return '私有地址（10.0.0.0/8）不在公网出口范围内';
  if (a === 172 && b >= 16 && b <= 31) return '私有地址（172.16.0.0/12）不在公网出口范围内';
  if (a === 192 && b === 168) return '私有地址（192.168.0.0/16）不在公网出口范围内';
  if (a === 169 && b === 254) return '链路本地地址（169.254.0.0/16）不在公网出口范围内';
  if (a === 100 && b >= 64 && b <= 127) return '运营商级 NAT 地址（100.64.0.0/10）不在公网出口范围内';
  if (a === 192 && b === 0 && c === 0) return '保留地址（192.0.0.0/24）不在公网出口范围内';
  if (a === 198 && (b === 18 || b === 19)) return '基准测试地址（198.18.0.0/15）不在公网出口范围内';
  if (a >= 224) return '组播/保留地址不在公网出口范围内';
  return '';
}

/** 字面 IPv6 → 是否属于"非公网"段。只判常见的几类（回环、链路本地、ULA、v4-mapped 已归一化） */
function nonPublicV6(h) {
  if (!h.includes(':')) return null;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return '回环地址（::1）不在公网出口范围内';
  if (h === '::' ) return '未指定地址不在公网出口范围内';
  if (/^fe[89ab][0-9a-f]:/.test(h)) return '链路本地地址（fe80::/10）不在公网出口范围内';
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return '唯一本地地址（fc00::/7）不在公网出口范围内';
  if (/^ff[0-9a-f]{2}:/.test(h)) return '组播地址（ff00::/8）不在公网出口范围内';
  return '';
}

/** 主机名形态判定。@returns {string} 非空 = 拒绝的理由 */
function hostBlocked(hostname) {
  const h = normalizeHost(hostname);
  if (!h) return '地址不合法';
  if (BLOCKED_HOSTS.test(h)) return '该地址属于云元数据服务，已禁止代转';
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) {
    return '本机/局域网主机名不在公网出口范围内（本应用不再支持本机模型）';
  }
  const v4 = nonPublicV4(h);
  if (v4 !== null) return v4;
  const v6 = nonPublicV6(h);
  if (v6 !== null) return v6;
  return '';
}

/** 域名**解析后**是否落进非公网段（拦 `169.254.169.254.nip.io` 这类"域名指向内网"的写法）。
 *  解析失败按"放行"处理：连不上时上游自己会报错，不该把 DNS 故障说成"地址被禁"。 */
async function resolvesToBlocked(hostname) {
  const h = normalizeHost(hostname);
  if (!h) return '地址不合法';
  // 字面量已由 hostBlocked 判过，不必解析
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(h) || h.includes(':')) return '';
  const dns = require('dns');
  const lookupAll = () => new Promise((res) => {
    dns.lookup(h, { all: true }, (e, r) => res(e ? [] : (Array.isArray(r) ? r : [r])));
  });
  const addrs = await lookupAll();
  for (const a of addrs) {
    const ip = normalizeHost((a && a.address) || a || '');
    if (!ip) continue;
    if (BLOCKED_HOSTS.test(ip)) return '该域名解析到云元数据服务，已禁止代转';
    const v4 = nonPublicV4(ip); if (v4) return `该域名解析到${v4.replace('不在公网出口范围内', '')}，已禁止代转`;
    const v6 = nonPublicV6(ip); if (v6) return `该域名解析到${v6.replace('不在公网出口范围内', '')}，已禁止代转`;
  }
  return '';
}

/* ============================ 出口代理（HTTP_PROXY / HTTPS_PROXY） ============================ */

const proxyConfig = (() => {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (!u.hostname) return null;
    const auth = u.username
      ? 'Basic ' + Buffer.from(decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password || '')).toString('base64') : '';
    return { host: u.hostname, port: Number(u.port || 80), auth };
  } catch { return null; }
})();
const NO_PROXY = String(process.env.NO_PROXY || process.env.no_proxy || '').split(',').map((s) => s.trim()).filter(Boolean);
function noProxy(host) {
  const h = String(host || '').toLowerCase();
  /* 注：原先这里对回环地址无条件返回 true（"本机 Ollama 不该因为设了 HTTPS_PROXY 而绕一圈"）。
     本机模型支持已移除，出口只剩公网，所以这条特例没有意义了——
     现在完全按 NO_PROXY 环境变量来（标准行为，不再有隐含例外）。 */
  return NO_PROXY.some((d) => d === '*' || h === d.toLowerCase() || h.endsWith('.' + d.toLowerCase().replace(/^\./, '')));
}

/** 经代理建立到目标的隧道（CONNECT），回调一个已连通的 socket */
function tunnel(proxy, tgt, cb) {
  const sock = net.connect({ host: proxy.host, port: proxy.port });
  let done = false;
  const fail = (e) => { if (!done) { done = true; sock.destroy(); cb(e); } };
  sock.setTimeout(CONNECT_TIMEOUT_MS, () => fail(new Error('出口代理连接超时')));
  sock.once('error', fail);
  // 代理直接断开（域名解析不了、拒绝转发等）时不能一直挂着等响应
  sock.once('close', () => fail(new Error('出口代理未完成 CONNECT（连接被关闭）')));
  sock.once('connect', () => {
    sock.write([`CONNECT ${tgt.host}:${tgt.port} HTTP/1.1`, `Host: ${tgt.host}:${tgt.port}`]
      .concat(proxy.auth ? [`Proxy-Authorization: ${proxy.auth}`] : []).concat('', '').join('\r\n'));
  });
  let buf = Buffer.alloc(0);
  const onData = (d) => {
    buf = Buffer.concat([buf, d]);
    const end = buf.indexOf('\r\n\r\n');
    if (end === -1) { if (buf.length > 8192) fail(new Error('出口代理响应异常')); return; }
    sock.removeListener('data', onData);
    const line = buf.slice(0, end).toString('latin1').split('\r\n')[0];
    if (!/^HTTP\/\d\.\d 200/.test(line)) return fail(new Error('出口代理拒绝连接：' + line));
    const rest = buf.slice(end + 4);
    if (rest.length) sock.unshift(rest);
    sock.setTimeout(0);
    done = true;
    cb(null, tgt.protocol === 'https:' ? tls.connect({ socket: sock, servername: tgt.host }) : sock);
  };
  sock.on('data', onData);
}


/** 统一出站请求：url/headers/body 由调用方构造（上游路径必须写死，不做开放代理） */
function upstreamRequest({ url, method = 'GET', headers = {}, body = null, timeoutMs = CONNECT_TIMEOUT_MS }, cb) {
  let u;
  try { u = new URL(url); } catch { return cb(Object.assign(new Error('上游 URL 不合法'), { status: 400 })); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return cb(Object.assign(new Error('只支持 http/https 的 Base URL'), { status: 400 }));
  }
  const bad = hostBlocked(u.hostname);
  if (bad) return cb(Object.assign(new Error(bad), { status: 400 }));
  /* 域名还要看**解析后**的地址：`169.254.169.254.nip.io` 这类写法主机名完全合法，
     但指向内网/元数据（审计 S4）。这一步是异步的，所以放在这里再进真正的连接。 */
  resolvesToBlocked(u.hostname).then((why) => {
    if (why) return cb(Object.assign(new Error(why), { status: 400 }));
    sendRequest({ url, method, headers, body, timeoutMs }, u, cb);
  }).catch(() => {
    // 判定本身出错（不该发生）：不放行也不报"地址被禁"，按上游不可达处理
    cb(Object.assign(new Error('无法校验上游地址'), { status: 502 }));
  });
}

/** 连接用的主机名：URL 的 hostname 对 IPv6 字面量**带着方括号**（`[240e:…]`），而 http.request
 *  要的是裸地址——带方括号会被当成主机名去查 DNS，必然 ENOTFOUND（实测：IPv6 字面量的网关
 *  一个请求都发不出去）。Host 头与代理 CONNECT 仍用带括号的原样（那才是正确的写法）。 */
const connectHostOf = (hostname) => {
  const h = String(hostname || '');
  return (h.startsWith('[') && h.endsWith(']')) ? h.slice(1, -1) : h;
};

/** 真正的出站连接（地址判定已通过） */
function sendRequest({ url, method, headers = {}, body = null, timeoutMs }, u, cb) {
  const isHttps = u.protocol === 'https:';
  const out = Object.assign({}, headers);
  let payload = null;
  if (body !== null && body !== undefined) {
    payload = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    out['content-type'] = out['content-type'] || 'application/json';
    out['content-length'] = String(payload.length);
  }
  out.host = u.host;

  const opts = { method, headers: out, hostname: connectHostOf(u.hostname), port: u.port || (isHttps ? 443 : 80), path: u.pathname + u.search };
  const lib = isHttps ? https : http;

  const fire = (extra) => {
    const req = lib.request(Object.assign({}, opts, extra), (r) => { clearTimeout(guard); cb(null, r); });
    const guard = setTimeout(() => {
      const sock = req.socket;
      if (sock && (sock.connecting || sock.pending)) {
        req.destroy(Object.assign(new Error('连接上游超时'), { code: 'ETIMEDOUT' }));
      }
    }, timeoutMs);
    if (guard.unref) guard.unref();
    req.on('error', (e) => { clearTimeout(guard); cb(e); });
    req.end(payload || undefined);
    return req;
  };

  if (!proxyConfig || noProxy(u.hostname)) return fire();
  tunnel(proxyConfig, { protocol: u.protocol, host: u.hostname, port: opts.port }, (err, socket) => {
    if (err) return cb(Object.assign(new Error('出口代理不可用：' + err.message), { status: 502 }));
    fire({ createConnection: () => socket });
  });
}

module.exports = { upstreamRequest, hostBlocked, resolvesToBlocked, normalizeHost, connectHostOf, proxyConfig, noProxy, tunnel, CONNECT_TIMEOUT_MS };
