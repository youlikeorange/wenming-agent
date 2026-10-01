/** lib/agent/session.js —— Agent 的身份层：文档站账号 → 绑定的本机账号 → 可执行的权限
 *
 *  **登录用文档站账号**（lib/auth.js 的 scrypt 校验 + Cookie 会话，与文档编辑器同一套）。
 *  本机账号是**绑定**关系，不是登录方式：
 *    · 绑定（POST /agent/binding）：填本机账号名 + 该账号的系统密码，用 su 验一次证明归属；
 *      验证通过只记录账号名与 uid/gid/home（**密码绝不落盘**）。
 *    · 解锁（POST /agent/unlock）：真正以它执行命令前，需在**本次会话**里再给一次密码，
 *      密码只留在这个进程的内存里（vault），到期或退出登录即丢。
 *    · 绑定的账号就是站点进程自己的用户时（本机自用最常见）无需密码，直接执行。
 *  这样"绑定信息是用户资料的一部分（与模型配置同处一份数据）"，而"能执行什么"仍由
 *  操作系统的权限决定——Agent 的可达范围就是绑定账号能做的全部事情，不多不少。
 *
 *  为什么密码不落盘：落盘的密码等于把本机账号交给任何能读 STATE_DIR 的人，也等于
 *  "站点被拖库 = 机器被登录"。代价是站点重启后 su 类账号要重新解锁一次，这个代价值得。
 *
 *  root 运行的坑（保留）：PAM 对 root 调用者是 pam_rootok（/etc/pam.d/su），root 执行
 *  `su <任意账号> -c true` 根本不要密码 —— 于是"验证绑定密码"这一步在 root 下形同虚设。
 *  代码里没法改变 su 的行为，只能明确拒绝：以 root 跑站点时绑定/解锁默认停用，
 *  确实要这么跑就显式设置 AGENT_ALLOW_ROOT=1（等同旧名 LLMCHAT_ALLOW_ROOT）认账。
 */
const os = require('os');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { auditLog } = require('../auth');
const settings = require('./settings');

/** 站点进程自身的用户：以它作绑定 = 不改身份（无需 su，也不需要密码） */
const SITE_USER = (() => { try { return os.userInfo().username; } catch { return ''; } })();

const SU_BIN = (() => {
  const raw = process.env.AGENT_SU_BIN || process.env.LLMCHAT_SU_BIN || 'su';
  if (raw.includes('/')) return raw;
  for (const p of ['/usr/bin/su', '/bin/su', '/usr/sbin/su']) if (fs.existsSync(p)) return p;
  return raw;
})();

const AUTH_TIMEOUT_MS = Number(process.env.AGENT_AUTH_TIMEOUT_MS || process.env.LLMCHAT_AUTH_TIMEOUT_MS || 15000);
/** 解锁凭据在内存里的存活时间（默认 12 小时；退出登录 / 解绑会立刻清掉） */
const UNLOCK_TTL_MS = Number(process.env.AGENT_UNLOCK_TTL_HOURS || 12) * 3600e3;
/** 解绑/解锁失败的重试限速（同一 ip|账号 10 分钟 5 次） */
const TRY_MAX = 5;
const TRY_WINDOW = 10 * 60e3;
const USER_RE = require('./sanitize').OS_USER_RE;   // 规则的真源在 sanitize.js

const RUN_AS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const ALLOW_ROOT = process.env.AGENT_ALLOW_ROOT === '1' || process.env.LLMCHAT_ALLOW_ROOT === '1';
/** root 下 su 不要密码：绑定/解锁整体停用（除非显式认账） */
const OS_VERIFY_DISABLED = RUN_AS_ROOT && !ALLOW_ROOT;
if (RUN_AS_ROOT) {
  console.warn(OS_VERIFY_DISABLED
    ? '  ⚠ Agent：站点以 root 运行，su 校验在 root 下不设防，本机账号绑定/解锁已停用；请用普通账号启动，或显式设置 AGENT_ALLOW_ROOT=1'
    : '  ⚠ Agent：站点以 root 运行且已设 AGENT_ALLOW_ROOT=1 —— 任何人绑定/解锁任意本机账号都不会被密码拦住');
}

/* ============================ 账号查询与密码校验 ============================ */

/** 读取系统账号信息（uid/gid/home/shell）；不存在返回 null */
function lookupUser(user) {
  return new Promise((resolve) => {
    if (!USER_RE.test(String(user || ''))) return resolve(null);
    execFile('getent', ['passwd', user], { timeout: 5000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const f = String(stdout).trim().split(':');
      if (f.length < 6 || f[0] !== user) return resolve(null);
      resolve({ user: f[0], uid: Number(f[2]), gid: Number(f[3]), home: f[5], shell: f[6] });
    });
  });
}

/** 用 su 校验密码：成功 = 该账号的密码正确。
 *  密码只经 stdin（无 tty 时 su 从 stdin 读，提示信息只走 stderr），不进命令行、不进日志。 */
function verifyPassword(user, password) {
  return new Promise((resolve) => {
    if (OS_VERIFY_DISABLED) return resolve({ ok: false, error: '站点以 root 运行，su 密码校验形同虚设，绑定/解锁已停用' });
    let settled = false;
    let stderr = '';
    const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
    let child;
    try {
      child = spawn(SU_BIN, ['-s', '/bin/sh', '-c', 'true', user], { stdio: ['pipe', 'ignore', 'pipe'] });
    } catch (e) {
      return finish({ ok: false, error: '无法执行 su：' + (e && e.message) });
    }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } finish({ ok: false, error: '认证超时' }); }, AUTH_TIMEOUT_MS);
    child.stderr.on('data', (b) => { stderr += b; });
    child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, error: '无法执行 su：' + e.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return finish({ ok: true });
      // 不把 su 的原始信息回给前端（可能透露账号是否存在），只留在审计日志里
      finish({ ok: false, error: '账号或密码错误', detail: stderr.trim().slice(0, 200) });
    });
    child.stdin.on('error', () => { /* 认证失败时管道会提前关闭 */ });
    child.stdin.write(String(password) + '\n');
    child.stdin.end();
  });
}

/* ---- 尝试限速（挡暴力破解绑定窗口；与登录限流同一套做法） ---- */
const tries = new Map();          // ip|account -> { count, first }
function rateLimited(key, now) {
  const f = tries.get(key);
  if (f && now - f.first < TRY_WINDOW && f.count >= TRY_MAX) return true;
  if (f && now - f.first >= TRY_WINDOW) tries.delete(key);
  return false;
}
function noteTry(key, now) {
  const f = tries.get(key);
  const cur = (f && now - f.first < TRY_WINDOW) ? f : { count: 0, first: now };
  cur.count += 1;
  tries.set(key, cur);
  return cur.count;
}
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of tries) if (now - v.first >= TRY_WINDOW) tries.delete(k);
  for (const [k, v] of vault) if (v.exp < now) vault.delete(k);
}, 5 * 60e3);
if (sweeper.unref) sweeper.unref();

/* ============================ 解锁凭据（只活在内存） ============================ */

const vault = new Map();          // account -> { osUser, password, exp }

function putUnlock(account, osUser, password) {
  vault.set(String(account), { osUser: String(osUser), password: String(password), exp: Date.now() + UNLOCK_TTL_MS });
}
function getUnlock(account, osUser) {
  const v = vault.get(String(account));
  if (!v) return null;
  if (v.exp < Date.now()) { vault.delete(String(account)); return null; }
  if (osUser && v.osUser !== String(osUser)) return null;     // 换绑过：旧密码作废
  return v;
}
function dropUnlock(account) { return vault.delete(String(account)); }
const unlockedAt = (account) => { const v = getUnlock(account); return v ? v.exp - UNLOCK_TTL_MS : 0; };

/* ---- 退出登录的副作用（清凭据 + 杀掉以该身份在跑的子进程）----
 *  工具模块（tools/exec.js）在这里注册"杀子进程"，避免 session → tools 的反向依赖。 */
const logoutHooks = [];
const onLogout = (fn) => { if (typeof fn === 'function') logoutHooks.push(fn); };

/** 文档站账号登出时调用（lib/api.js 的 handleLogout 挂上）：立刻收回该账号的一切 */
function logout(account) {
  const who = String(account || '');
  if (!who) return;
  const dropped = dropUnlock(who);
  for (const fn of logoutHooks) { try { fn(who); } catch { /* 钩子失败不影响登出 */ } }
  if (dropped) auditLog(`agent-unlock-dropped account=${who} reason=logout`);
}

/* ============================ 绑定 / 解锁 ============================ */

/** 绑定：验证归属后记录本机账号（不存密码） */
async function bind(account, rawUser, password, ip) {
  const user = String(rawUser || '').trim();
  if (!USER_RE.test(user)) throw Object.assign(new Error('本机账号名不合法'), { status: 400 });
  const now = Date.now();
  const key = String(ip || '') + '|' + account;
  if (rateLimited(key, now)) throw Object.assign(new Error(`尝试次数过多，请 ${Math.ceil(TRY_WINDOW / 60000)} 分钟后再试`), { status: 429 });

  const info = await lookupUser(user);
  if (!info) {
    noteTry(key, now);
    auditLog(`agent-bind-fail account=${account} osUser=${user} ip=${ip} reason=no-such-user`);
    throw Object.assign(new Error('本机不存在这个账号'), { status: 404 });
  }
  const same = info.user === SITE_USER;
  /* 归属校验对两种绑定**一视同仁**：原先 same 分支直接跳过校验（"绑定站点自己的账号不用证明"），
     于是任何登录用户 POST /agent/binding/bind {"osUser":"<站点账号>"} 不填密码就能绑上，
     拿到 method:'same' → run_command 直接以站点进程身份执行，文档站自己的 admin/scopes 授权全绕过
     （实测：零密码拿到命令执行）。而站点账号名是公开的（GET /agent/info 免登录就回 siteUser），
     所以这条路径连猜测都不需要。归属证明统一用系统密码——su 到自身同样会校验密码
     （实测错口令被拒："su: 认证失败"），所以同一套 verifyPassword 对两种绑定都成立。 */
  if (OS_VERIFY_DISABLED) throw Object.assign(new Error('站点以 root 运行，无法校验本机账号密码（su 在 root 下不设防），绑定已停用'), { status: 403 });
  if (!password) throw Object.assign(new Error('请填写该账号的系统密码（用它证明这个账号是你的）'), { status: 400 });
  const r = await verifyPassword(user, password);
  if (!r.ok) {
    const n = noteTry(key, now);
    auditLog(`agent-bind-fail account=${account} osUser=${user} ip=${ip} (${n}) ${r.error}${r.detail ? ' :: ' + r.detail : ''}`);
    throw Object.assign(new Error(r.error), { status: 401 });
  }
  // 刚验过密码：两种绑定都顺手解锁，省得用户马上再输一次（凭据只在内存，登出即收回）
  putUnlock(account, user, password);
  tries.delete(key);
  const rec = await settings.setBinding(account, {
    osUser: info.user, uid: info.uid, gid: info.gid, home: info.home, shell: info.shell,
    method: same ? 'same' : 'su', boundAt: now,
  });
  auditLog(`agent-bind-ok account=${account} osUser=${info.user} uid=${info.uid} method=${rec.method} ip=${ip}`);
  return rec;
}

async function unbind(account) {
  const prev = settings.getBinding(account);
  await settings.clearBinding(account);
  dropUnlock(account);
  for (const fn of logoutHooks) { try { fn(String(account)); } catch { /* 同上 */ } }
  auditLog(`agent-unbind account=${account} osUser=${prev ? prev.osUser : '(none)'}`);
}

/** 解锁：以绑定账号的密码换一段内存凭据。
 *  **两种绑定都要校验**：'su' 档自不必说；'same' 档（绑定站点进程自己的账号）原先直接
 *  `return {ok:true}`，等于免证明——配合"绑定也不校验密码"就成了完整提权链。
 *  现在 same 档同样要求口令（su 到自身也会校验），除非这条绑定是刚刚在本会话里
 *  由 bind() 验过密码建立的（那种情况 vault 里已有凭据，无需重复输入）。 */
async function unlock(account, password, ip) {
  const b = settings.getBinding(account);
  if (!b) throw Object.assign(new Error('还没有绑定本机账号，请先在「本机账号」里绑定'), { status: 400, needBind: true });
  // 本会话已验过（bind 或上一次 unlock）且账号没换：直接算解锁
  if (getUnlock(account, b.osUser)) return { ok: true, method: b.method, expiresInMs: UNLOCK_TTL_MS };
  const now = Date.now();
  const key = String(ip || '') + '|' + account;
  if (rateLimited(key, now)) throw Object.assign(new Error(`尝试次数过多，请 ${Math.ceil(TRY_WINDOW / 60000)} 分钟后再试`), { status: 429 });
  if (!password) throw Object.assign(new Error('请填写该系统账号的密码'), { status: 400 });
  const info = await lookupUser(b.osUser);
  if (!info) throw Object.assign(new Error(`本机账号 ${b.osUser} 已不存在（换机器了？请重新绑定）`), { status: 404 });
  const r = await verifyPassword(b.osUser, password);
  if (!r.ok) {
    const n = noteTry(key, now);
    auditLog(`agent-unlock-fail account=${account} osUser=${b.osUser} ip=${ip} (${n}) ${r.error}${r.detail ? ' :: ' + r.detail : ''}`);
    throw Object.assign(new Error(r.error), { status: 401 });
  }
  tries.delete(key);
  putUnlock(account, b.osUser, password);
  if (info.home !== b.home || info.uid !== b.uid) {
    await settings.setBinding(account, Object.assign({}, b, { uid: info.uid, gid: info.gid, home: info.home }));
  }
  auditLog(`agent-unlock-ok account=${account} osUser=${b.osUser} method=${b.method} ip=${ip}`);
  return { ok: true, method: b.method, expiresInMs: UNLOCK_TTL_MS };
}

/* ============================ 身份解析（工具执行的入口） ============================ */

/**
 * 文档站账号 → 执行身份。工具层只认这个对象。
 *  @returns {{
 *    account, osUser, uid, gid, home, method:'same'|'su',
 *    bound:boolean, needBind:boolean, needUnlock:boolean, password:string
 *  }}
 */
function actorOf(account) {
  const b = settings.getBinding(account);
  if (!b) {
    return { account, osUser: '', uid: -1, gid: -1, home: '', method: 'same',
      bound: false, needBind: true, needUnlock: false, password: '' };
  }
  if (b.method === 'same') {
    /* 'same' 档（绑定账号 == 站点进程账号）执行时不走 su，但**同样要求先解锁**。
       为什么：早期实现让 same 档免解锁，于是"绑定站点自己的账号"成了一个不需要任何证明的
       提权入口——实测 tester（非管理员、文档权限只有 notes/）能以 leo 身份跑任意命令，
       而该绑定建立于修复之前、今天依然有效。仅在校验新绑定时要求密码不够：
       已经落盘的旧绑定必须同样过这道闸，否则修复只挡得住"新建"，挡不住"存量"。
       解锁用同一套密码校验（su 到自身同样会验证口令），凭据只在内存、登出即收回。 */
    const v = getUnlock(account, b.osUser);
    return { account, osUser: b.osUser, uid: b.uid, gid: b.gid, home: b.home || os.homedir(), method: 'same',
      bound: true, needBind: false, needUnlock: !v, password: v ? v.password : '' };
  }
  const v = getUnlock(account, b.osUser);
  return { account, osUser: b.osUser, uid: b.uid, gid: b.gid, home: b.home, method: 'su',
    bound: true, needBind: false, needUnlock: !v, password: v ? v.password : '' };
}

/** 面板展示用的绑定状态（不下发任何密码相关的东西） */
function bindingView(account) {
  const b = settings.getBinding(account);
  const a = actorOf(account);
  return {
    bound: !!b,
    osUser: b ? b.osUser : '',
    uid: b ? b.uid : -1,
    home: b ? b.home : '',
    method: b ? b.method : '',
    siteUser: SITE_USER,
    sameAsSite: !!b && b.method === 'same',
    unlocked: !a.needUnlock,
    unlockedAt: unlockedAt(account) || 0,
    canVerify: !OS_VERIFY_DISABLED,
    verifyNote: OS_VERIFY_DISABLED ? '站点以 root 运行，su 校验在此部署下不设防，绑定/解锁已停用' : '',
  };
}

module.exports = {
  SITE_USER, SU_BIN, USER_RE, OS_VERIFY_DISABLED, UNLOCK_TTL_MS,
  lookupUser, verifyPassword, bind, unbind, unlock, logout, onLogout,
  actorOf, bindingView, dropUnlock, _vault: vault,
};
