/** lib/security.js —— 路径安全与 HTTP 安全头（依赖：path、fs/promises） */
const path = require('path');
const fsp = require('fs/promises');

/** 统一安全响应头（OWASP / MDN 建议基线）：
 *   nosniff 防 MIME 嗅探；CSP 白名单同源资源（应用无内联脚本/远程资源）；
 *   frame-ancestors none + X-Frame-Options 防嵌入；Referrer-Policy 防外链泄露路径。
 *   注意：style-src 'unsafe-inline' 是应用内嵌 style 属性所需；脚本/媒体/连接均为 'self'。 */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
};

/** 智能体 Agent（/llm-chat/）安全头。
 *  2026-09-16 起与站点基线完全一致：服务商配置（含 API Key）改为服务端保存、模型流量经
 *  /agent/upstream/* 同源代转（lib/agent/upstream.js），浏览器不再直连任何远程 API，
 *  于是原先为远程 https 地址放宽的 connect-src 已收回，恢复严格同源。 */
const SECURITY_HEADERS_LLM = SECURITY_HEADERS;

/** 按路径选择安全头（保留这个分叉函数：日后某子项目需要单独放宽时在这里加分支） */
function securityHeadersFor(pathname) {
  return pathname === '/llm-chat' || pathname.startsWith('/llm-chat/') ? SECURITY_HEADERS_LLM : SECURITY_HEADERS;
}

/** 请求是否走 HTTPS（直连 TLS 或反向代理转发，如 cloudflared 的 X-Forwarded-Proto） */
function isSecureReq(req) {
  if (req.socket.encrypted === true) return true;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return proto === 'https';
}

/** 严格相对路径规范化（OWASP Path Traversal 标准做法：授权前先规范化、显式拒绝 .. 穿越——
 *  https://owasp.org/www-community/attacks/Path_Traversal / https://portswigger.net/web-security/file-path-traversal）。
 *  按 / 拆分后丢弃空段与 . 段；出现 .. 段即整体拒绝。合法文件名如 "1..2.md" 不受影响。
 *  注意：调用方须先 decodeURIComponent（百分号编码的 .. 解码后同样会被拒绝）。 */
function normalizeRelPath(p) {
  const segs = String(p || '').trim().replace(/\\/g, '/').split('/')
    .filter((s) => s !== '' && s !== '.');
  return segs.some((s) => s === '..') ? '' : segs.join('/');
}

/** rel 路径是否在用户 scope 内（'*'=全局；目录 scope 以 / 结尾按前缀匹配）。
 *  调用前提：rel 已 normalizeRelPath 规范化（否则 .. 可绕过前缀检查）。 */
function pathAllowed(rel, scopes) {
  if (!rel || !Array.isArray(scopes)) return false;
  for (const s of scopes) {
    if (s === '*') return true;
    const ss = String(s).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '');
    if (!ss) continue;
    if (rel === ss) return true;
    if (rel.startsWith(ss.endsWith('/') ? ss : ss + '/')) return true;
  }
  return false;
}

/** 词法解析：把 URL 路径约束在 root 内 */
function safeResolve(root, urlPath) {
  const abs = path.resolve(root, '.' + (urlPath.startsWith('/') ? urlPath : '/' + urlPath));
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

/** 解析后确认真实路径仍在根内（防 DOC_ROOT 内符号链接把文件/目录链到根之外——
 *  OWASP Path Traversal 的 canonicalization 校验：词法解析之外再对真实路径做约束）。
 *  目标已存在时取其 realpath；不存在时逐级向上找最近已存在父目录的 realpath 再拼回剩余段。 */
async function realpathContained(root, abs) {
  try {
    const rootReal = await fsp.realpath(root);
    let cur = abs;
    const tail = [];
    for (let depth = 0; depth < 64; depth++) {
      try {
        const real = await fsp.realpath(cur);
        const full = tail.length ? path.join(real, ...tail.slice().reverse()) : real;
        return full === rootReal || full.startsWith(rootReal + path.sep);
      } catch { /* 该段不存在，继续向上 */ }
      const parent = path.dirname(cur);
      if (parent === cur) return false;
      tail.push(path.basename(cur));
      cur = parent;
    }
    return false;
  } catch {
    return false;
  }
}

module.exports = { SECURITY_HEADERS, SECURITY_HEADERS_LLM, securityHeadersFor, isSecureReq, normalizeRelPath, pathAllowed, safeResolve, realpathContained };
