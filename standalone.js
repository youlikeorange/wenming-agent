#!/usr/bin/env node
/**
 * standalone.js —— 不带宿主站点，把智能体 Agent 单独跑起来（**下载即可运行**）
 *
 *   node standalone.js [选项]
 *
 *     --port <n>        监听端口（默认 4174；也可用环境变量 PORT）
 *     --host <addr>     监听地址（默认 127.0.0.1；局域网用 --host 0.0.0.0）
 *     --state-dir <dir> 数据目录（默认 ~/.local/share/wenming-agent；也可用 STATE_DIR）
 *     --help            显示帮助
 *
 * 它替宿主站点做三件事，其余一律复用仓库里的 lib/：
 *   ① 静态服务：把 public/ 下的页面发出去（界面是 public/llm-chat/，构建产物已随仓库提供）；
 *   ② 登录三端点：/api/login、/api/logout、/api/session —— 逻辑与宿主 lib/api.js 的同名处理器
 *      一致（scrypt 校验 + Cookie 会话 + 登录限流 + 审计日志），只是不依赖文档站；
 *   ③ 挂载 /agent/*：直接交给 lib/agent/index.js 的 handleAgent（登录闸门、单窗口互斥、
 *      请求体上限、全部业务路由都在它内部，这里不重复实现）。
 *
 *  首次启动会自动创建一个管理员账号并把随机密码打印在控制台上（只显示这一次）；
 *  要指定密码用环境变量 AGENT_ADMIN_PASSWORD。增删账号 / 改密码用 tools/users.js。
 *
 *  与宿主站点（文档站）的关系：**同一个子项目，两种宿主**。宿主站点那套的入口是仓库根的
 *  server.js（还挂着文档/媒体/剧本编辑器，需要缺失的 lib/docs.js、lib/media.js 等，仓库里
 *  只有留档、跑不起来）；本文件是「只跑 Agent」的最小宿主，依赖全部在仓库内。
 *  数据格式与宿主完全一致（STATE_DIR/permissions.json、agent/<账号>/…），所以同一个数据目录
 *  在两个入口之间是通用的——但**不要两个进程同时写同一个 STATE_DIR**（锁与单窗口互斥都在
 *  进程内存里，见 lib/lock.js 与 lib/agent/presence.js）。
 */
'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

/* ============================ 命令行与环境 ============================ */

const HELP = `
智能体 Agent · 独立运行

  node standalone.js [--port 4174] [--host 127.0.0.1] [--state-dir <目录>]

  --port <n>        监听端口（默认 4174）          环境变量：PORT
  --host <addr>     监听地址（默认 127.0.0.1）     环境变量：HOST
  --state-dir <dir> 数据目录（默认 ~/.local/share/wenming-agent）  环境变量：STATE_DIR
  --help            显示本帮助

  首次启动会创建管理员账号并打印随机密码；之后在页面右上角登录。
  模型服务商在 设置 → 模型 里配置（密钥只存服务端，不下发浏览器）。
  账号管理：node tools/users.js list | add <名字> [密码] | passwd <名字> [密码]
`;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--port') out.port = argv[++i];
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--state-dir') out.stateDir = argv[++i];
    else { console.error(`未知参数：${a}（--help 查看用法）`); process.exit(2); }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) { console.log(HELP.trim()); process.exit(0); }

/** 数据目录的默认值（与 tools/users.js 保持一致：两处都写 ~/.local/share/wenming-agent）。
 *  **必须在 require lib/config 之前落到环境变量**：config.js 是在加载那一刻读 STATE_DIR/PORT/HOST 的。 */
const DEFAULT_STATE_DIR = path.join(os.homedir(), '.local', 'share', 'wenming-agent');
const expandHome = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
if (args.stateDir) process.env.STATE_DIR = expandHome(args.stateDir);
if (!process.env.STATE_DIR) process.env.STATE_DIR = DEFAULT_STATE_DIR;
if (args.port) process.env.PORT = args.port;
if (!process.env.PORT) process.env.PORT = '4174';
if (args.host) process.env.HOST = args.host;

const { PORT, HOST, PUBLIC_ROOT, STATE_DIR, SESSION_COOKIE, MIME } = require('./lib/config');
const { securityHeadersFor, safeResolve, isSecureReq } = require('./lib/security');
const { json, readJson } = require('./lib/http');
const {
  initStateDir, loadPermissions, savePermissions, loadSessions, saveSessions, sweepExpiredSessions,
} = require('./lib/state');
const {
  hashPassword, verifyPassword, parseCookies, sessionCookie, authUser, auditLog,
  checkLoginLock, recordLoginFail, clearLoginFails,
} = require('./lib/auth');
const { handleAgent } = require('./lib/agent');
const agentSession = require('./lib/agent/session');

/* ============================ 首次启动：创建管理员 ============================ */

/** @returns {null | {username:string, password:string}} 本次新建的管理员（已有账号则 null） */
async function ensureAdmin() {
  const perms = await loadPermissions();
  if (Array.isArray(perms.users) && perms.users.length) return null;
  const password = process.env.AGENT_ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  const salt = crypto.randomBytes(16).toString('hex');
  const admin = {
    username: 'admin', displayName: 'admin', salt,
    passwordHash: hashPassword(password, salt),
    scopes: [], editScopes: [], uploadQuotaBytes: 0, admin: true,
  };
  await savePermissions({ sessionHours: perms.sessionHours || 168, users: [admin] });
  auditLog('standalone-admin-created user=admin');
  return { username: 'admin', password };
}

/* ============================ 登录三端点（对齐宿主 lib/api.js） ============================ */

const userView = (u) => ({
  username: u.username,
  displayName: u.displayName || u.username,
  admin: !!u.admin,
  scopes: Array.isArray(u.scopes) ? u.scopes : [],
  editScopes: Array.isArray(u.editScopes) ? u.editScopes : [],
  uploadQuotaBytes: Number(u.uploadQuotaBytes || 0),
});

async function handleLogin(req, res) {
  const body = await readJson(req);
  const username = String((body || {}).username || '');
  const password = String((body || {}).password || '');
  const perms = await loadPermissions();
  const user = perms.users.find((u) => u.username === username);
  const ip = req.socket.remoteAddress || '';
  const key = ip + '|' + username;
  const now = Date.now();
  if (checkLoginLock(key, now)) {
    auditLog(`login-lock user=${username} ip=${ip}`);
    return json(res, 429, { error: '尝试次数过多，请 10 分钟后再试' });
  }
  if (!user || !verifyPassword(password, user)) {
    const count = recordLoginFail(key, now);
    auditLog(`login-fail user=${username} ip=${ip} (${count})`);
    return json(res, 401, { error: '用户名或密码错误' });
  }
  clearLoginFails(key);
  const token = crypto.randomBytes(32).toString('hex');
  const hours = perms.sessionHours || 168;
  sweepExpiredSessions();
  const sessions = await loadSessions();
  sessions[token] = { username: user.username, expires: now + hours * 3600e3 };
  await saveSessions(sessions);
  auditLog(`login-ok user=${username} ip=${ip}`);
  res.setHeader('Set-Cookie', sessionCookie(token, hours, isSecureReq(req)));
  return json(res, 200, userView(user));
}

async function handleLogout(req, res) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) {
    const sessions = await loadSessions();
    const who = sessions[token] && sessions[token].username;
    delete sessions[token];
    await saveSessions(sessions);
    /* 与宿主一致：退出登录要收回 Agent 侧的执行权（丢掉本机账号解锁凭据、杀掉在跑的子进程） */
    if (who) agentSession.logout(who);
  }
  const secure = isSecureReq(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` + secure);
  return json(res, 200, { ok: true });
}

async function handleSession(req, res) {
  const user = await authUser(req);
  if (!user) return json(res, 401, { error: 'unauthorized' });
  return json(res, 200, userView(user));
}

/* ============================ 静态文件（只发 public/） ============================ */

function notFound(res, why) {
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>404</title>`
    + `<body style="font:14px/1.7 system-ui;padding:2rem;background:#0b0b0c;color:#e6e6e6">`
    + `<h1 style="font-size:1.1rem">404</h1><p>${why || '没有这个路径。'}</p>`
    + `<p>智能体界面在 <a style="color:#6cf" href="/llm-chat/">/llm-chat/</a>。</p></body>`);
}

function sendFile(abs, req, res) {
  let st;
  try { st = fs.statSync(abs); } catch { return notFound(res, '文件不存在。'); }
  if (st.isDirectory()) return sendFile(path.join(abs, 'index.html'), req, res);
  const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': st.size,
    /* 不缓存：这是本地自用服务，改了源码重建后刷新就该看到新的（也让"改了没生效"不成为排查项） */
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(abs);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/* ============================ 请求分发 ============================ */

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch { return json(res, 400, { error: 'bad url' }); }
  try {
    for (const [k, v] of Object.entries(securityHeadersFor(url.pathname))) res.setHeader(k, v);
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (url.pathname === '/') { res.writeHead(302, { Location: '/llm-chat/' }); return res.end(); }

    // ① Agent 的全部能力（探针/登录闸门/单窗口/存储/工具/托管运行…都在 lib/agent 内部）
    if (url.pathname.startsWith('/agent/')) return await handleAgent(req, url, res);

    // ② 登录三端点（与宿主 lib/api.js 的同名处理器同行为，见文件头）
    if (url.pathname === '/api/login' && req.method === 'POST') return await handleLogin(req, res);
    if (url.pathname === '/api/logout' && req.method === 'POST') return await handleLogout(req, res);
    if (url.pathname === '/api/session') return await handleSession(req, res);
    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'unknown api' });

    // ③ 静态：只发 public/ 内的文件（界面与它引用的 css/js）
    if (req.method === 'GET' || req.method === 'HEAD') {
      let rel;
      try { rel = decodeURIComponent(url.pathname); } catch { return notFound(res, '路径编码不合法。'); }
      const inPublic = rel === '/llm-chat' || rel.startsWith('/llm-chat/');
      const abs = inPublic ? safeResolve(PUBLIC_ROOT, rel) : null;
      if (abs) return sendFile(abs, req, res);
      return notFound(res, inPublic ? '路径不合法。' : '独立运行只提供 /llm-chat/ 与 /agent/*。');
    }
    return json(res, 405, { error: 'method not allowed' });
  } catch (e) {
    // 已知客户端错误原样返回；其余走统一脱敏出口（与宿主 server.js 同样的口径）
    if (e && (e.status === 400 || e.status === 413)) return json(res, e.status, { error: e.message });
    console.error('  ⚠ 请求处理失败:', e && e.message);
    if (!res.headersSent) return json(res, 500, { error: '服务器内部错误' });
    try { res.end(); } catch { /* 已断开 */ }
  }
});

/* ============================ 启动 ============================ */

initStateDir();

(async () => {
  const created = await ensureAdmin();
  server.listen(PORT, HOST, () => {
    const shown = HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST;
    console.log('');
    console.log('  智能体 Agent · 独立运行');
    console.log('  ────────────────────────────────────────────');
    console.log(`  界面      http://${shown}:${PORT}/llm-chat/`);
    console.log(`  数据      ${STATE_DIR}`);
    if (created) {
      console.log(`  管理员    ${created.username} / ${created.password}`);
      console.log('            （首次启动自动创建，密码只显示这一次；');
      console.log(`             改密码：node tools/users.js passwd ${created.username}）`);
    } else {
      console.log('  账号      已存在（登录或改密码：node tools/users.js list / passwd <名字>）');
    }
    console.log('  模型      打开页面 → 设置 → 模型 里填服务商与密钥（密钥只存服务端）');
    console.log('  停止      Ctrl+C');
    console.log('');
  });
})().catch((e) => {
  console.error('启动失败：', e && e.message);
  process.exit(1);
});

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error(`\n端口 ${PORT} 已被占用。换一个：node standalone.js --port ${Number(PORT) + 1}\n`);
    process.exit(1);
  }
  console.error('服务错误：', e && e.message);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n  已停止。');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();   // 有长连接（SSE）时别卡住退出
  });
}
