/** lib/state.js —— 状态文件读写（permissions/sessions/uploads）、原子写、迁移与轻缓存
 *  依赖：fs、fs/promises、path、./config、./paths */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { STATE_DIR, WEB_ROOT, DOC_ROOT } = require('./config');
/* 四个站点级状态文件的路径**唯一真源**在 ./paths（与账号级目录一起收口，见那份文件头） */
const { PERM_FILE, SESSIONS_FILE, UPLOADS_FILE, AUTH_LOG } = require('./paths');
// 旧版状态文件位置（迁移前），迁移完成后会删除以移除 NTFS 上世界可读的敏感副本
const LEGACY_STATE_FILES = [
  ['permissions.json', PERM_FILE],
  ['sessions.json', SESSIONS_FILE],
  ['uploads.json', UPLOADS_FILE],
  ['auth.log', AUTH_LOG],
];

/** 启动时初始化 STATE_DIR：建目录(0700)、把旧位置的状态文件迁移过来(0600)、删除旧副本 */
function initStateDir() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    fs.chmodSync(STATE_DIR, 0o700);
    for (const [name, target] of LEGACY_STATE_FILES) {
      const legacy = path.join(WEB_ROOT, name);
      if (!fs.existsSync(target) && fs.existsSync(legacy)) {
        fs.copyFileSync(legacy, target);
        console.log(`  📦 状态文件已迁移: ${name} → ${target}`);
      }
      try { fs.chmodSync(target, 0o600); } catch { /* 非致命 */ }
      if (fs.existsSync(legacy) && fs.existsSync(target) && fs.statSync(target).size > 0) {
        fs.unlinkSync(legacy); // 已安全迁移，移除 NTFS 上的世界可读副本
      }
    }
  } catch (e) {
    console.error('  ⚠ 状态目录初始化失败（将回退到项目目录）:', e.message);
  }
}

/** 原子写 JSON（write-file-atomic 模式：先写同盘临时文件再 rename，崩溃不产生半截文件——
 *  参照 https://stackoverflow.com/questions/17047994/transactionally-writing-files-in-node-js）
 *  同一文件的多次写**排队执行**：并发写各自写临时文件再 rename 时，后 rename 的会盖掉先写的，
 *  排队后至少保证"每次写的内容完整、顺序确定"（缓存失效也按序发生）。 */
const writeChains = new Map();
function atomicWriteJson(file, obj, pretty) {
  const prev = writeChains.get(file) || Promise.resolve();
  const next = prev.then(() => atomicWriteJsonNow(file, obj, pretty),
    () => atomicWriteJsonNow(file, obj, pretty));
  writeChains.set(file, next.then(() => {}, () => {}));
  return next;
}
async function atomicWriteJsonNow(file, obj, pretty) {
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  await fsp.writeFile(tmp, JSON.stringify(obj, null, pretty || 0));
  await fsp.rename(tmp, file);
  jsonCache.delete(file); // 写后失效缓存
  try { await fsp.chmod(file, 0o600); } catch { /* 忽略 */ }
}

/** 状态 JSON 轻缓存：按 mtime+size 失效（写后清空），避免每个请求都整文件读 */
const jsonCache = new Map();
async function readJsonCached(file, legacyName, fallback) {
  const c = jsonCache.get(file);
  try {
    const st = await fsp.stat(file);
    if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.data;
    const data = JSON.parse(await fsp.readFile(file, 'utf8'));
    jsonCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, data });
    return data;
  } catch {
    try {
      return JSON.parse(await fsp.readFile(path.join(WEB_ROOT, legacyName), 'utf8'));
    } catch { return fallback; }
  }
}

async function loadPermissions() {
  return readJsonCached(PERM_FILE, 'permissions.json', { sessionHours: 168, users: [] });
}
async function savePermissions(cfg) {
  await atomicWriteJson(PERM_FILE, cfg, 2);
}
async function loadSessions() {
  return readJsonCached(SESSIONS_FILE, 'sessions.json', {});
}
async function saveSessions(s) {
  await atomicWriteJson(SESSIONS_FILE, s);
}
async function loadUploads() {
  return readJsonCached(UPLOADS_FILE, 'uploads.json', {});
}
async function saveUploads(u) {
  await atomicWriteJson(UPLOADS_FILE, u, 2);
}

// 过期会话清扫节流（避免每次请求都写盘）：最长每 10 分钟扫一次
let lastSessionsSweep = 0;
async function sweepExpiredSessions() {
  const now = Date.now();
  if (now - lastSessionsSweep < 10 * 60e3) return;
  lastSessionsSweep = now;
  const sessions = await loadSessions();
  let changed = false;
  for (const k of Object.keys(sessions)) {
    if (!sessions[k] || typeof sessions[k].expires !== 'number' || sessions[k].expires < now) {
      delete sessions[k];
      changed = true;
    }
  }
  if (changed) await saveSessions(sessions);
}

/** 统计某用户仍存在于磁盘的上传文件总量；顺带清理失效记录。
 *  只在**确实清理掉了失效项**时才写盘：它每次上传/权限面板都会调用，
 *  无脑写盘（旧实现）等于把 uploads.json 变成高频写目标，还会和别的写互相覆盖。 */
async function usageFor(username) {
  const all = await loadUploads();
  const before = all[username] || [];
  const list = [];
  for (const e of before) {
    try { if ((await fsp.stat(path.join(DOC_ROOT, e.path))).isFile()) list.push(e); } catch { /* 已失效 */ }
  }
  if (list.length !== before.length) {
    all[username] = list;
    await saveUploads(all);
  }
  return { used: list.reduce((s, e) => s + (e.size || 0), 0), list };
}

/** 重命名/删除文件后重映射上传账本 */
async function remapUploads(from, to) {
  const all = await loadUploads();
  let changed = false;
  for (const user of Object.keys(all)) {
    for (const e of all[user]) {
      if (e.path === from) { e.path = to; changed = true; }
      else if (e.path.startsWith(from + '/')) { e.path = to + e.path.slice(from.length); changed = true; }
    }
  }
  if (changed) await saveUploads(all);
}
async function removeFromUploads(rel) {
  const all = await loadUploads();
  let changed = false;
  for (const user of Object.keys(all)) {
    const before = all[user].length;
    all[user] = all[user].filter((e) => e.path !== rel && !e.path.startsWith(rel + '/'));
    if (all[user].length !== before) changed = true;
  }
  if (changed) await saveUploads(all);
}

module.exports = {
  PERM_FILE, SESSIONS_FILE, UPLOADS_FILE, AUTH_LOG,
  initStateDir, atomicWriteJson, loadPermissions, savePermissions,
  loadSessions, saveSessions, loadUploads, saveUploads,
  sweepExpiredSessions, usageFor, remapUploads, removeFromUploads,
};
