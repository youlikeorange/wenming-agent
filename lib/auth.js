/** lib/auth.js —— 认证与会话（密码哈希、Cookie、登录限流、审计日志）
 *  依赖：crypto、./config、./state、./security */
const crypto = require('crypto');
const { SESSION_COOKIE } = require('./config');
const { AUTH_LOG, loadPermissions, loadSessions, saveSessions, sweepExpiredSessions } = require('./state');

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), String(salt), 64).toString('hex');
}
function verifyPassword(password, user) {
  try {
    const a = Buffer.from(hashPassword(password, user.salt), 'hex');
    const b = Buffer.from(user.passwordHash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i <= 0) return;
    const name = p.slice(0, i).trim();
    const raw = p.slice(i + 1).trim();
    // 非法百分号编码（`%ZZ`）会让 decodeURIComponent 抛 URIError——parseCookies 经 authUser
    // 出现在每个 API 与媒体请求上，抛出即整站 500（受害者得手动清 Cookie 才能恢复）。
    // 解不开就按原样留着，认不出的 token 自然会走 401。
    try { out[name] = decodeURIComponent(raw); } catch { out[name] = raw; }
  });
  return out;
}

/** 会话 Cookie 构造：HTTPS 下附加 Secure（OWASP Session Management：Secure+HttpOnly+SameSite）。
 *  2026-09-20 审计修正：此前注释写着「自动附加 Secure」，函数体却从未加过（isSecureReq 在
 *  本模块 import 后一直闲置）——经 --public 隧道走 HTTPS 时，同一 Cookie 会被浏览器在
 *  **明文 HTTP** 请求上一并发出（降级/被中间人取走）。改为由调用方传入 secure。 */
function sessionCookie(token, hours, secure) {
  return [`${SESSION_COOKIE}=${token}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${Math.round(hours * 3600)}`]
    .concat(secure ? ['Secure'] : []).join('; ');
}

/** 从请求 Cookie 解析会话，返回用户对象或 null */
async function authUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  sweepExpiredSessions().catch(() => { /* 清扫失败不影响请求 */ });
  const sessions = await loadSessions();
  const s = sessions[token];
  if (!s) return null;
  if (s.expires < Date.now()) { delete sessions[token]; await saveSessions(sessions); return null; }
  return (await loadPermissions()).users.find((u) => u.username === s.username) || null;
}

/** 审计日志（异步追加，不阻塞事件循环——Node.js 安全最佳实践）
 *  每条一行：内容里的控制字符（换行/回车/制表等）转成可见转义——agent 工具的错误消息、
 *  多行命令都进这条日志，实测换行会把一行拆成多行、破坏 grep/逐行取证（2026-09-19 修）。 */
const CTL_RE = /[\x00-\x1f\x7f]/g;
const escCtl = (s) => String(s).replace(CTL_RE, (c) => (
  c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0')));

function auditLog(line) {
  require('fs/promises').appendFile(AUTH_LOG, new Date().toISOString() + '  ' + escCtl(line) + '\n').catch(() => { /* 忽略 */ });
}

/* ---- 登录限流（10 分钟 5 次，按 ip|username）---- */
const loginFails = new Map(); // ip|username -> {count, first}

/** 清理过期限流条目：登录时顺带清理 + 后台定时兜底（防内存无限增长，审计项⑮） */
function pruneLoginFails(now = Date.now()) {
  for (const [k, v] of loginFails) {
    if (now - v.first >= 10 * 60e3) loginFails.delete(k);
  }
}
const pruneTimer = setInterval(pruneLoginFails, 10 * 60e3);
if (pruneTimer.unref) pruneTimer.unref();

/** 是否处于锁定；失败计数与解锁窗口判定 */
function checkLoginLock(key, now) {
  const fail = loginFails.get(key);
  if (fail && fail.count >= 5 && now - fail.first < 10 * 60e3) return true;
  return false;
}
function recordLoginFail(key, now) {
  const fail = loginFails.get(key);
  const f = fail && now - fail.first < 10 * 60e3 ? fail : { count: 0, first: now };
  f.count += 1;
  loginFails.set(key, f);
  return f.count;
}
function clearLoginFails(key) {
  loginFails.delete(key);
}

module.exports = {
  hashPassword, verifyPassword, parseCookies, sessionCookie, authUser, auditLog,
  checkLoginLock, recordLoginFail, clearLoginFails, pruneLoginFails,
};
