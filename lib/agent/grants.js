/** lib/agent/grants.js —— 危险命令的一次性授权票据（纯内存）
 *
 *  流程：前端执行 run_command 前先调 /agent/deny-check → 命中则服务端签发票据 →
 *  用户在授权窗点「授权执行」后前端携票据调 /agent/call → 这里校验放行。
 *
 *  安全边界：
 *    · 一次性（取走即作废，无论是否匹配）；
 *    · 5 分钟过期（给人留出读警示、做决定的时间）、绑定命令全文（改一个字符都不认）；
 *    · 只有 deny-check 会签发，而它不在模型的工具清单里——模型拿不到票据，
 *      只有**人**点过授权窗，命令才可能被执行。
 */
const crypto = require('crypto');

const GRANT_TTL_MS = 300e3;
const MAX_GRANTS = 500;
const grants = new Map();          // ticket -> { cmd, exp }

function issueGrant(cmd) {
  const t = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  /* 每次签发先清过期票：票据只有 5 分钟寿命，过期即无效——留着既占内存又让
     "数量上限"的判据失真（旧写法只在超过 MAX_GRANTS 时才扫，500 张都在有效期内就不收缩）。 */
  for (const [k, g] of grants) if (g.exp < now) grants.delete(k);
  grants.set(t, { cmd: String(cmd), exp: now + GRANT_TTL_MS });
  if (grants.size > MAX_GRANTS) {
    // 极端情况下（窗口内签发超过上限）再按过期时间丢最旧的一批
    const sorted = [...grants.entries()].sort((a, b) => a[1].exp - b[1].exp);
    for (const [k] of sorted.slice(0, grants.size - MAX_GRANTS)) grants.delete(k);
  }
  return t;
}

/** 消费一张票据：命中则放行（返回 true）。取走即删——重放、复用一律不认。 */
function takeGrant(ticket, cmd) {
  const g = grants.get(String(ticket || ''));
  if (!g) return false;
  grants.delete(String(ticket));
  return g.exp >= Date.now() && g.cmd === String(cmd);
}

module.exports = { issueGrant, takeGrant, GRANT_TTL_MS };
