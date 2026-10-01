/** lib/agent/presence.js —— 单客户端占用（同一文档站账号，同一时刻只放行一个窗口）
 *
 *  为什么需要：会话 / 参数 / 模型配置 / 技能 / 记忆全部按账号存在服务器端，但每个窗口在内存里
 *  各有一份副本、又各自整份写回——两个窗口同开就是"后写的把先写的抹掉"。与其做字段级合并
 *  （复杂且仍会丢并发编辑），不如直接约定：**同一账号同时只允许一个客户端在用**，
 *  后到的窗口顶掉先到的，先到的一方界面冻结，直到用户点「在此窗口继续」把它夺回来。
 *
 *  身份（key）：已登录 = a:<文档站账号>；未登录 = anon:<来源地址>。
 *  机制：
 *    · 页面每次加载生成一个随机 cid（只放内存，刷新即换），随请求头 X-Agent-Client 发给服务端；
 *    · POST /agent/presence { cid, claim }：claim=true 直接上位（顶掉别人），false 只查询状态；
 *    · 所有实际干活的端点（store / upstream / search / tools）都校验这个头：
 *      被顶掉的 cid 一律 409（响应带 X-Agent-Client-Lock: taken，前端据此弹"被顶掉"遮罩）；
 *    · 顶替发生时，被顶掉一方的**在途流**（正在生成的回答）由服务端直接掐断，不留给它继续烧 token；
 *    · 占用权只由 claim 转移：占用者超过 STALE_MS 没有任何请求（心跳 5s 一次）视为已离开。
 *  兼容：没有该请求头的请求（curl / 脚本）照旧放行；可用 AGENT_SINGLE_CLIENT=0 关掉。
 */
const { json } = require('../http');
const { auditLog } = require('../auth');

const ENABLED = String(process.env.AGENT_SINGLE_CLIENT === undefined
  ? (process.env.LLMCHAT_SINGLE_CLIENT === undefined ? '1' : process.env.LLMCHAT_SINGLE_CLIENT)
  : process.env.AGENT_SINGLE_CLIENT) !== '0';
/** 占用者多久没有任何请求算"已离开"（客户端心跳 5s；后台标签页被节流到 1 分钟也能覆盖） */
const STALE_MS = 75e3;
/** 被顶掉的 cid 继续拒绝多久（之后视作陌生客户端，重新 claim 即可） */
const FORGET_MS = 10 * 60e3;
const CID_RE = /^[A-Za-z0-9._-]{6,40}$/;
const HEADER = 'x-agent-client';

const owners = new Map();     // key -> { cid, user, ip, ua, since, at }
const seen = new Map();       // cid -> { key, active, at }
const streams = new Map();    // cid -> Set<res>

/** 来源地址（去掉 IPv6 映射前缀） */
function clientIp(req) {
  const raw = String((req.socket && req.socket.remoteAddress) || '');
  return raw.replace(/^::ffff:/, '') || 'unknown';
}

const shortUa = (ua) => String(ua || '').replace(/\s+/g, ' ').slice(0, 90);

/** 身份 key：已登录按文档站账号，未登录按来源地址 */
const keyOf = (account, ip) => (account ? 'a:' + account : 'anon:' + ip);

const cidOf = (req) => {
  const v = String(req.headers[HEADER] || '').trim();
  return CID_RE.test(v) ? v : '';
};

const publicOwner = (o) => (o ? { ip: o.ip, ua: o.ua, since: o.since, at: o.at, user: o.user || '' } : null);

function markSeen(cid, key, active) {
  if (!cid) return;
  seen.set(cid, { key, active, at: Date.now() });
}

/** 占用者被顶掉时：在途流全部掐断（客户端也会自己中止，这里是服务端兜底） */
function killStreams(cid) {
  const set = streams.get(cid);
  if (!set || !set.size) return 0;
  let n = 0;
  for (const res of set) { try { res.destroy(new Error('已被另一个窗口接管')); n++; } catch { /* 已断开 */ } }
  streams.delete(cid);
  return n;
}

function claim(key, cid, meta) {
  const prev = owners.get(key);
  const takeover = !!prev && prev.cid !== cid;
  if (takeover) {
    markSeen(prev.cid, key, false);
    const killed = killStreams(prev.cid);
    auditLog(`agent-presence-takeover key=${key} new=${cid}@${meta.ip} old=${prev.cid}@${prev.ip} killed=${killed}`);
  }
  owners.set(key, {
    cid, ip: meta.ip, ua: meta.ua, user: meta.user || '',
    since: prev && prev.cid === cid ? prev.since : Date.now(), at: Date.now(),
  });
  markSeen(cid, key, true);
  return { active: true, takeover };
}

/** 查询（claim=false）：自己仍是占用者 → 续期；占用者已离开（超过 STALE_MS）→ 自动上位 */
function status(key, cid, meta) {
  const o = owners.get(key);
  const now = Date.now();
  if (!o) return Object.assign(claim(key, cid, meta), { owner: null });
  if (o.cid === cid) { o.at = now; o.ip = meta.ip; o.ua = meta.ua; markSeen(cid, key, true); return { active: true, owner: publicOwner(o) }; }
  if (now - o.at > STALE_MS) {
    const r = claim(key, cid, meta);
    auditLog(`agent-presence-adopt key=${key} cid=${cid}@${meta.ip} (原占用者 ${o.cid}@${o.ip} 超过 ${Math.round(STALE_MS / 1000)}s 无请求)`);
    return Object.assign(r, { owner: null });
  }
  return { active: false, owner: publicOwner(o) };
}

/** 让位（关页/跳转时前端说一声）：只有占用者本人能让位；**不是被顶掉**，
 *  所以直接删除 seen 记录，免得 bfcache 恢复/回退导航的窗口白吃一阵遮罩。 */
function release(key, cid) {
  const o = owners.get(key);
  if (!o || o.cid !== cid) return false;
  owners.delete(key);
  seen.delete(cid);
  return true;
}

/** 干活端点上的校验：被顶掉的 cid 一律拒绝；带占用的请求顺带续期；无头请求放行（脚本） */
function guard(req, res, account) {
  if (!ENABLED) return true;
  const cid = cidOf(req);
  if (!cid) return true;
  const ip = clientIp(req);
  const key = keyOf(account, ip);
  const o = owners.get(key);
  if (o && o.cid === cid) { o.at = Date.now(); markSeen(cid, key, true); return true; }
  const rec = seen.get(cid);
  if (!o && rec && rec.active) { markSeen(cid, key, true); return true; }   // 服务重启后 owners 为空：认这个客户端
  if (rec && !rec.active && Date.now() - rec.at < FORGET_MS) {
    res.setHeader('X-Agent-Client-Lock', 'taken');
    json(res, 409, { ok: false, kicked: true, error: '这个窗口已被顶掉：同一时间只允许一个窗口使用（在另一个窗口里点了继续）', owner: publicOwner(o) });
    return false;
  }
  return true;
}

/** 登记在途响应（流式回答）：被顶替时由 killStreams 掐断 */
function trackStream(cid, res) {
  if (!cid || !res) return;
  let set = streams.get(cid);
  if (!set) streams.set(cid, set = new Set());
  set.add(res);
  const off = () => { set.delete(res); if (!set.size) streams.delete(cid); };
  res.on('close', off);
  res.on('finish', off);
}

/**
 * POST /agent/presence  { cid, claim?, leave? }
 *   → { ok, active, owner, enforce }   active=false 表示自己已被别的窗口顶掉
 */
async function handlePresence(req, res, session, pathname) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' });
  let body;
  try { body = await require("./store").readAgentJson(req, pathname); } catch (e) { return json(res, e.status || 400, { ok: false, error: 'invalid json' }); }
  const cid = String((body && body.cid) || '').trim();
  if (!CID_RE.test(cid)) return json(res, 400, { ok: false, error: 'cid 不合法' });

  const account = session ? session.username : '';
  const ip = clientIp(req);
  const key = keyOf(account, ip);
  const meta = { ip, ua: shortUa(req.headers['user-agent']), user: account };

  if (!ENABLED) return json(res, 200, { ok: true, active: true, owner: null, enforce: false, loggedIn: !!session });

  if (body && body.leave) return json(res, 200, { ok: true, active: false, left: release(key, cid), enforce: true, loggedIn: !!session });

  const r = body && body.claim ? claim(key, cid, meta) : status(key, cid, meta);
  return json(res, 200, {
    ok: true,
    active: !!r.active,
    takeover: !!r.takeover,
    owner: r.active ? null : r.owner,
    enforce: true,
    loggedIn: !!session,
    user: account,
  });
}

/* 上限：seen 的键是**客户端自由生成的 cid**（未登录也能提交），只清理 !active 会让 active 条目永不回收 */
const SEEN_MAX = 5000;
const OWNERS_MAX = 2000;

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [cid, r] of seen) if (now - r.at > FORGET_MS) seen.delete(cid);
  for (const [key, o] of owners) if (now - o.at > FORGET_MS) owners.delete(key);
  if (seen.size > SEEN_MAX) {
    const old = [...seen.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, seen.size - SEEN_MAX);
    for (const [cid] of old) seen.delete(cid);
  }
  if (owners.size > OWNERS_MAX) {
    const old = [...owners.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, owners.size - OWNERS_MAX);
    for (const [key] of old) owners.delete(key);
  }
}, 5 * 60e3);
if (sweeper.unref) sweeper.unref();

module.exports = { handlePresence, guard, trackStream, cidOf, keyOf, clientIp, ENABLED, STALE_MS };
