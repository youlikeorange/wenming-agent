/** lib/agent/undo.js —— 一次运行的**文件改动日志**：行数统计 + 「一键撤销」的原内容快照
 *
 *  用户要的三件事都长在这一份日志上：
 *    ① 追踪条（信息卡片）上的「+N 行 / −M 行」：工具执行前后各拍一次快照，比出行数差；
 *    ② 「一键撤销」：写/改/删/移动/建目录**之前**把原内容备份下来，
 *       撤销 = 按相反顺序把每个受影响路径恢复成运行前的样子；
 *    ③ 「关了浏览器回来还看得到」：日志按 **账号 / 会话 / 运行** 落在
 *       `STATE_DIR/agent/<账号>/undo/<会话id>/<运行id>/`（meta.json + blobs/），
 *       界面只是显示；撤销状态同时写回会话消息（`msg.undo`，见 lib/agent/store.js 的白名单），
 *       刷新、换窗口、换设备都不丢。
 *
 *  只覆盖**文件工具**（write_file / edit_file / create_directory / move_file / delete_path）：
 *  `run_command` 改了什么，进程外无从知晓——界面上如实写清这一点，不做"看起来能撤销"的假象。
 *
 *  三条纪律：
 *    · 记录失败（文件太大、读不到、超上限）**绝不阻断工具执行**，只记一条 skipped，
 *      撤销时如实回报"有 N 处没能记录、只能恢复其余部分"；
 *    · 撤销走与工具**同一套闸门**（roots 白名单 + 绑定账号权限 + 解锁），绝不为了让撤销成功而放行；
 *    · 备份/恢复都在服务端账号目录内，界面只拿一句摘要（文件清单 + 条数），不碰文件内容。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { AGENT_ROOT, accountDir } = require('../paths');
const { atomicWriteJson } = require('../state');
const { auditLog } = require('../auth');
const S = require('./sanitize');

/* ---------- 上限（数据保留类，刻意不上面板；环境变量可调，改这里要同步改 docs/MODULE-MAP.md） ---------- */
/** 单文件备份上限：超过就不备份（该文件撤销时如实报"没有备份"） */
const MAX_FILE_BYTES = Number(process.env.AGENT_UNDO_FILE_BYTES) || 8 * 1024 * 1024;
/** 目录备份的总字节/文件数上限（删目录、移动目录时才用） */
const MAX_TREE_BYTES = Number(process.env.AGENT_UNDO_TREE_BYTES) || 32 * 1024 * 1024;
const MAX_TREE_FILES = Number(process.env.AGENT_UNDO_TREE_FILES) || 500;
/** 一次运行最多记多少条改动（超过就停记 + 标 incomplete）与总备份字节 */
const MAX_ENTRIES = Number(process.env.AGENT_UNDO_MAX_ENTRIES) || 200;
const MAX_RUN_BYTES = Number(process.env.AGENT_UNDO_RUN_BYTES) || 128 * 1024 * 1024;
/** 每个账号保留多少份日志、最多占多少字节、最长留多久（写新日志时顺手清理） */
const MAX_JOURNALS = Number(process.env.AGENT_UNDO_MAX_JOURNALS) || 200;
const MAX_ACCOUNT_BYTES = Number(process.env.AGENT_UNDO_ACCOUNT_BYTES) || 512 * 1024 * 1024;
const KEEP_DAYS = Number(process.env.AGENT_UNDO_KEEP_DAYS) || 30;

/** 会被记录/可撤销的工具（与 lib/agent/tools/index.js 的分发表同名） */
const MUTATING = new Set(['write_file', 'edit_file', 'create_directory', 'move_file', 'delete_path']);

/** runId → 内存态日志（收尾时落盘；进程重启丢在途那一轮，与"运行本体在内存"同一约定） */
const live = new Map();

/* ============================ 路径 ============================ */

const undoRoot = (account) => {
  const d = accountDir(AGENT_ROOT, account);
  return d ? path.join(d, 'undo') : null;
};
const sessionDir = (account, sessionId) => {
  const r = undoRoot(account);
  return r && S.ID_RE.test(String(sessionId || '')) ? path.join(r, String(sessionId)) : null;
};
const runDir = (account, sessionId, runId) => {
  const d = sessionDir(account, sessionId);
  return d && S.ID_RE.test(String(runId || '')) ? path.join(d, String(runId)) : null;
};
const metaFile = (dir) => path.join(dir, 'meta.json');

/* ============================ 行数：信息卡片上的 +N / −M ============================ */

const splitLines = (s) => String(s).split('\n');

/** 行数（`a\nb\n` 是 2 行，不是 3 行——空文件 0 行） */
function countLines(s) {
  const t = String(s == null ? '' : s);
  if (!t) return 0;
  const n = splitLines(t).length;
  return t.endsWith('\n') ? n - 1 : n;
}

const countMap = (lines) => {
  const m = new Map();
  for (const l of lines) m.set(l, (m.get(l) || 0) + 1);
  return m;
};

/** 行数差：先按公共前缀/后缀收窄，再按"行的多重集"计增删。
 *  对"改一行 / 加一段 / 删一段"给出的数与 `git diff --stat` 一致；
 *  纯行序调整会算成 0（不追求逐行对齐——那要 LCS，几万行的文件会把工具调用拖慢）。 */
function lineDiff(before, after) {
  const A = splitLines(before), B = splitLines(after);
  let i = 0;
  while (i < A.length && i < B.length && A[i] === B[i]) i++;
  let j = 0;
  while (j < A.length - i && j < B.length - i && A[A.length - 1 - j] === B[B.length - 1 - j]) j++;
  const m1 = countMap(A.slice(i, A.length - j));
  const m2 = countMap(B.slice(i, B.length - j));
  let added = 0, removed = 0;
  for (const [l, n] of m2) added += Math.max(0, n - (m1.get(l) || 0));
  for (const [l, n] of m1) removed += Math.max(0, n - (m2.get(l) || 0));
  return { added, removed };
}

/** 二进制（含 NUL）不逐行比、也不算行数：行数对二进制没有意义 */
const textOf = (buf) => {
  if (!buf || !buf.length) return buf ? '' : null;
  return buf.includes(0) ? null : buf.toString('utf8');
};
const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

/* ============================ 快照（撤销的唯一依据） ============================ */

/** 记一个 blob（原内容）；返回文件名（日志内引用它） */
async function putBlob(st, buf) {
  st.seq++;
  const name = `b${st.seq}`;
  await fsp.mkdir(path.join(st.dir, 'blobs'), { recursive: true, mode: 0o700 });
  await fsp.writeFile(path.join(st.dir, 'blobs', name), buf, { mode: 0o600 });
  st.bytes += buf.length;
  return name;
}

/** 目录快照：列出整棵树（含每个文件的原内容）。超过上限就 truncated=true——
 *  撤销时只恢复能恢复的，并在结果里如实标出。 */
async function captureDir(real, st, mode, blobs) {
  const files = [];
  let bytes = 0, truncated = false;
  const walk = async (dir, rel) => {
    if (truncated) return;
    const ents = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (truncated) return;
      const p = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) { files.push({ rel: r, kind: 'link', target: await fsp.readlink(p).catch(() => '') }); continue; }
      if (e.isDirectory()) { files.push({ rel: r, kind: 'dir' }); await walk(p, r); continue; }
      const fst = await fsp.lstat(p).catch(() => null);
      if (!fst) continue;
      if (files.length >= MAX_TREE_FILES || bytes + fst.size > MAX_TREE_BYTES) { truncated = true; return; }
      const buf = await fsp.readFile(p).catch(() => null);
      if (!buf) { truncated = true; return; }
      bytes += buf.length;
      const rec = { rel: r, kind: 'file', mode: fst.mode & 0o7777, size: buf.length, hash: sha1(buf) };
      const t = textOf(buf);
      if (t !== null) rec.lines = countLines(t);
      if (blobs) rec.blob = await putBlob(st, buf);
      files.push(rec);
    }
  };
  await walk(real, '');
  return { kind: 'dir', mode, files: files.sort((a, b) => a.rel.localeCompare(b.rel)), truncated, bytes };
}

/** 拍一个路径的快照。`blobs=true` 时把文件内容落到 blobs/（撤销要用的那份）。
 *  返回 { snap, text }：text 只在内存里用于比差（不落盘，别把整篇文件塞进 meta.json）。 */
async function capture(real, st, blobs) {
  const lst = await fsp.lstat(real).catch(() => null);
  if (!lst) return { snap: { kind: 'missing' }, text: null };
  const mode = lst.mode & 0o7777;
  if (lst.isSymbolicLink()) {
    return { snap: { kind: 'link', mode, target: await fsp.readlink(real).catch(() => '') }, text: null };
  }
  if (lst.isDirectory()) return { snap: await captureDir(real, st, mode, blobs), text: null };
  const buf = lst.size <= MAX_FILE_BYTES ? await fsp.readFile(real).catch(() => null) : null;
  const text = textOf(buf);
  const snap = { kind: 'file', mode, size: lst.size, mtimeMs: Math.round(lst.mtimeMs) };
  if (text !== null) { snap.text = text; snap.lines = countLines(text); } else snap.lines = null;
  if (buf && blobs) snap.blob = await putBlob(st, buf);
  else if (!buf) snap.unbacked = true;              // 太大 / 读不到：撤销时如实说
  return { snap, text };
}

/** 落盘前把内存里的 text 摘掉（它可能是一整篇文件，不进 meta.json） */
function toStored(snap) {
  if (!snap || snap.kind === 'missing') return { kind: 'missing' };
  const out = Object.assign({}, snap);
  delete out.text;
  return out;
}

/** 快照内容没变吗（缺一边当"没变"——宁可不记，也不记错） */
function sameSnap(a, b) {
  if (!a || !b) return true;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'missing') return true;
  if (a.kind === 'link') return a.target === b.target;
  if (a.kind === 'dir') {
    return a.truncated === b.truncated && a.files.length === b.files.length
      && a.files.every((f, i) => f.rel === b.files[i].rel && f.kind === b.files[i].kind && f.hash === b.files[i].hash);
  }
  if (a.text != null && b.text != null) return a.text === b.text;
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/* ============================ 记录（工具执行前后各一次） ============================ */

/** 这个工具动了哪些路径（原样入参，解析交给 roots——`~` 展开、相对路径、白名单都在那一处） */
function pathsFor(name, args) {
  const a = args || {};
  const one = (v) => (typeof v === 'string' && v.trim() ? [v] : []);
  if (name === 'move_file') return [...one(a.source), ...one(a.destination)];
  return one(a.path);
}

/** 入参路径 → 真实路径（解析不了就跳过记录：工具自己会拒绝，这边的错误不该抢在它前面） */
function resolvePaths(actor, name, args) {
  const roots = require('./roots');
  const out = [];
  for (const raw of pathsFor(name, args)) {
    try { out.push(roots.resolveInRoots(actor, raw, { write: true }).real); } catch { /* 越界/空：不记 */ }
  }
  return out;
}

function stateFor(meta, run) {
  let st = live.get(run.id);
  if (!st) {
    const dir = runDir(meta.account, run.sessionId, run.id);
    if (!dir) return null;
    st = {
      dir, account: meta.account, runId: run.id, sessionId: run.sessionId,
      liveId: (run.live && run.live.id) || '', ts: Date.now(),
      entries: [], skipped: [], seq: 0, bytes: 0, complete: true,
    };
    live.set(run.id, st);
  }
  return st;
}

/** 还能记吗（条数 / 备份字节）——到顶就停记并标 incomplete，撤销时会如实说明 */
function canRecord(st) {
  if (st.entries.length >= MAX_ENTRIES || st.bytes >= MAX_RUN_BYTES) {
    st.complete = false;
    return false;
  }
  return true;
}

const sumTreeLines = (snap) => (snap.files || []).reduce((n, f) => n + (f.lines || 0), 0);
const isFileSnap = (s) => s && s.kind === 'file';

/** 这一条改动的行数（+写入 / −删除）：改文件用逐行比，建/删按整篇行数算。
 *  移动的**源路径**不计行数：文件没被删掉，只是换了地方（源路径的 after 是"不存在"，
 *  照删文件算会显示成"删了 N 行"——那是在骗人）；目标路径照常比（覆盖了旧文件才算删除）。 */
function statOf(name, before, after, changed, paths) {
  let added = 0, removed = 0;
  /* 移动的源路径（paths[0] 由 pathsFor 保证）不计行数——文件没被删掉，只是换了地方；
     目标路径只在**覆盖了原有文件**时才算（否则"新位置出现了一份"也不是新增了几行）。 */
  const skip = name === 'move_file' ? paths[0] : null;
  for (const p of changed) {
    if (p === skip) continue;
    if (name === 'move_file' && (!before[p] || before[p].kind === 'missing')) continue;
    const b = before[p], a = after ? after[p] : null;
    if (isFileSnap(b) && isFileSnap(a)) { const d = lineDiff(b.text, a.text); added += d.added; removed += d.removed; }
    else if (isFileSnap(a)) added += a.lines || 0;
    else if (isFileSnap(b)) removed += b.lines || 0;
    else if (b && b.kind === 'dir') removed += sumTreeLines(b);
    else if (a && a.kind === 'dir') added += sumTreeLines(a);
  }
  return { added, removed };
}

const actionOf = (b, a) => (!b || b.kind === 'missing' ? 'create' : (!a || a.kind === 'missing' ? 'delete' : 'modify'));

function record(st, name, paths, before, after) {
  const changed = paths.filter((p) => !after || !sameSnap(before[p], after[p]));
  if (!changed.length) return null;
  const entry = {
    tool: name, ts: Date.now(), lines: statOf(name, before, after, changed, paths),
    paths: changed.map((p) => ({
      path: p, action: actionOf(before[p], after ? after[p] : null), before: toStored(before[p]),
    })),
  };
  st.entries.push(entry);
  return entry;
}

/**
 * 包住一次会改文件的工具调用：前后各拍一次快照 → 记录 → 把行数挂到工具结果上。
 * @param {{account:string, actor:object, run:object}} meta 当前运行上下文（没有 run 就不记——脚本直调没有卡片可撤）
 */
async function wrap(meta, name, args, fn) {
  const run = meta && meta.run;
  if (!run || !meta.account || !MUTATING.has(String(name))) return fn();
  const paths = resolvePaths(meta.actor, name, args);
  const st = paths.length ? stateFor(meta, run) : null;
  if (!st) return fn();
  if (!canRecord(st)) { st.skipped.push({ path: paths[0], reason: '超过单轮记录上限' }); return fn(); }

  const before = {};
  for (const p of paths) before[p] = (await capture(p, st, true)).snap;

  let result = null, err = null;
  try { result = await fn(); } catch (e) { err = e; }
  let after = null;
  try { after = {}; for (const p of paths) after[p] = (await capture(p, st, false)).snap; } catch { after = null; }

  try {
    const entry = record(st, name, paths, before, after);
    /* 工具**失败**但文件确实变了（比如删除删到一半）→ 日志保留（撤销要能修）；但标 partial，
       且不把行数挂到结果上（模型看到的是失败，不该同时看到"+3 行"这种成功口径）。 */
    if (entry) {
      if (err) entry.partial = true;
      else if (result && typeof result === 'object') result.lines = entry.lines;
    }
  } catch (e) {
    st.skipped.push({ path: paths[0], reason: '记录失败：' + (e.message || e) });
  }
  if (err) throw err;
  return result;
}

/* ============================ 落盘 / 清理 ============================ */

/** 交给界面/会话消息的那一句摘要（文件清单只给前 20 个，完整清单在服务端日志里） */
function summaryOf(meta) {
  const paths = [];
  let added = 0, removed = 0;
  for (const e of meta.entries || []) {
    added += (e.lines && e.lines.added) || 0;
    removed += (e.lines && e.lines.removed) || 0;
    for (const f of e.paths || []) if (!paths.includes(f.path)) paths.push(f.path);
  }
  const last = meta.lastResult || null;
  return {
    runId: meta.runId, sessionId: meta.sessionId, ts: meta.ts || Date.now(),
    count: paths.length, files: paths.slice(0, 20), more: Math.max(0, paths.length - 20),
    added, removed, skipped: (meta.skipped || []).length, complete: meta.complete !== false,
    undone: !!meta.undone, undoneAt: meta.undoneAt || 0,
    /* 上一次尝试的结果：失败过（但没全成）时界面要能说"还有 N 处没恢复，可以重试" */
    lastFailed: last ? last.failed : 0, lastAttemptAt: meta.lastAttemptAt || 0,
  };
}

/** 目录大小（清理用；备份文件不多，逐个 stat 足够） */
async function dirBytes(dir) {
  let total = 0;
  const walk = async (d) => {
    const ents = await fsp.readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else { const st = await fsp.stat(p).catch(() => null); if (st) total += st.size; }
    }
  };
  await walk(dir);
  return total;
}

/** 账号内的日志清理：先按天数，再按份数，最后按总字节（都是"最老的先走"） */
async function prune(account) {
  const root = undoRoot(account);
  if (!root) return;
  const rows = [];
  for (const sess of await fsp.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!sess.isDirectory()) continue;
    for (const run of await fsp.readdir(path.join(root, sess.name), { withFileTypes: true }).catch(() => [])) {
      if (!run.isDirectory()) continue;
      const dir = path.join(root, sess.name, run.name);
      const meta = await readJson(dir);
      rows.push({ dir, ts: (meta && meta.ts) || 0, bytes: await dirBytes(dir) });
    }
  }
  rows.sort((a, b) => b.ts - a.ts);
  const now = Date.now();
  let total = 0;
  const drop = [];
  rows.forEach((r, i) => {
    total += r.bytes;
    if (i >= MAX_JOURNALS || total > MAX_ACCOUNT_BYTES || (r.ts && now - r.ts > KEEP_DAYS * 86400e3)) drop.push(r.dir);
  });
  for (const d of drop) await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
  if (drop.length) auditLog(`agent-undo-prune account=${account} removed=${drop.length}`);
}

async function readJson(dir) {
  try { return JSON.parse(await fsp.readFile(metaFile(dir), 'utf8')); } catch { return null; }
}

/** 收尾：把内存态日志落盘并交回一句摘要（没有改动就什么都不留，返回 null） */
async function finishRun(run) {
  const st = live.get(run.id);
  if (!st) return null;
  live.delete(run.id);
  if (!st.entries.length) {
    await fsp.rm(st.dir, { recursive: true, force: true }).catch(() => {});
    return null;
  }
  const meta = {
    version: 1, runId: st.runId, sessionId: st.sessionId, account: st.account,
    liveId: (run.live && run.live.id) || st.liveId || '', ts: st.ts, endedAt: Date.now(),
    undone: false, undoneAt: 0, result: null, complete: st.complete, entries: st.entries, skipped: st.skipped,
  };
  try {
    await fsp.mkdir(st.dir, { recursive: true, mode: 0o700 });
    await atomicWriteJson(metaFile(st.dir), meta, 2);
    await prune(st.account);
  } catch (e) {
    auditLog(`agent-undo-save-fail account=${st.account} run=${st.runId} err=${String(e.message).slice(0, 160)}`);
    return null;
  }
  return summaryOf(meta);
}

/** 按 runId 找日志（会话 id 是提示，没有就逐个会话目录找一遍） */
async function readJournal(account, runId, sessionIdHint) {
  const root = undoRoot(account);
  if (!root || !S.ID_RE.test(String(runId || ''))) return null;
  const hint = String(sessionIdHint || '');
  const sess = S.ID_RE.test(hint)
    ? [hint]
    : (await fsp.readdir(root, { withFileTypes: true }).catch(() => []))
      .filter((e) => e.isDirectory()).map((e) => e.name);
  for (const s of sess) {
    const dir = runDir(account, s, runId);
    if (!dir) continue;
    const meta = await readJson(dir);
    if (meta) return { meta, dir };
  }
  return null;
}

/* ============================ 恢复（一键撤销） ============================ */

/** 按快照把一个路径恢复原状；返回 'removed'（删掉运行中新建的东西）| 'restored'（写回原内容）。
 *  **走与工具同一套闸门**（roots 白名单 + 绑定账号权限 + 解锁）：撤销不搞特权通道。 */
async function restoreOne(actor, real, snap, blobDir) {
  const fsTools = require('./tools/fs');            // 延迟 require：工具层也 require 本模块
  const target = await fsTools.guard(actor, real, 'write');
  const cur = await fsp.lstat(target).catch(() => null);
  if (!snap || snap.kind === 'missing') {
    if (cur) await fsp.rm(target, { recursive: true, force: false });
    return 'removed';
  }
  if (snap.kind === 'link') {
    if (cur) await fsp.rm(target, { recursive: true, force: false });
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.symlink(String(snap.target || ''), target);
    return 'restored';
  }
  if (snap.kind === 'file') {
    if (!snap.blob) {
      throw Object.assign(new Error('没有备份（文件超过单次备份上限或当时读不到），无法恢复原内容'), { status: 409 });
    }
    if (cur && cur.isDirectory()) await fsp.rm(target, { recursive: true, force: false });
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(path.join(blobDir, snap.blob), target);
    if (snap.mode != null) await fsp.chmod(target, snap.mode & 0o7777).catch(() => {});
    return 'restored';
  }
  await restoreTree(target, snap, cur, blobDir);
  return 'restored';
}

/** 目录：整棵树照快照重建（缺的建、多的删、内容写回） */
async function restoreTree(target, snap, cur, blobDir) {
  if (cur && !cur.isDirectory()) await fsp.rm(target, { recursive: true, force: false });
  await fsp.mkdir(target, { recursive: true });
  const keep = new Set();
  for (const f of snap.files || []) {
    const p = path.join(target, f.rel);
    keep.add(f.rel);
    if (f.kind === 'dir') { await fsp.mkdir(p, { recursive: true }); continue; }
    if (f.kind === 'link') {
      await fsp.rm(p, { recursive: true, force: true });
      await fsp.mkdir(path.dirname(p), { recursive: true });
      await fsp.symlink(String(f.target || ''), p);
      continue;
    }
    await fsp.mkdir(path.dirname(p), { recursive: true });
    if (f.blob) await fsp.copyFile(path.join(blobDir, f.blob), p);
    if (f.mode != null) await fsp.chmod(p, f.mode & 0o7777).catch(() => {});
  }
  await fsp.chmod(target, snap.mode & 0o7777).catch(() => {});
  /* 快照之后新加的东西：整棵树要恢复原样，多出来的删掉（备份截断时跳过，别误删） */
  if (!snap.truncated) await pruneTree(target, '', keep);
}

/** 删掉快照里没有的条目（恢复"原状"的必要一步） */
async function pruneTree(dir, rel, keep) {
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    const p = path.join(dir, e.name);
    if (!keep.has(r)) { await fsp.rm(p, { recursive: true, force: true }); continue; }
    if (e.isDirectory()) await pruneTree(p, r, keep);
  }
}

/**
 * 一键撤销：把一次运行的文件改动全部恢复原状。
 *
 *  · 按**相反顺序**重放日志（同一文件被改过两次时，先回到后一次之前的样子，再回到最初）；
 *  · 每个路径失败单独记账（权限、没备份…），**不中断**其余路径的恢复；
 *  · 成功与否都写回日志（undone 标记 + 结果），所以"撤销过了"这件事刷新后仍然看得见，
 *    也不会被撤销第二次。
 * @returns {{journal:object, summary:object, result:object}}
 */
async function undo(account, actor, runId, sessionIdHint) {
  const found = await readJournal(account, runId, sessionIdHint);
  if (!found) throw Object.assign(new Error('这一轮的改动日志不存在（可能已被清理）：无法撤销'), { status: 404 });
  const { meta, dir } = found;
  if (meta.undone) throw Object.assign(new Error('这一轮的改动已经撤销过了'), { status: 409 });
  const blobDir = path.join(dir, 'blobs');
  const result = { restored: [], removed: [], failed: [] };
  for (const entry of [...(meta.entries || [])].reverse()) {
    for (const f of entry.paths || []) {
      try {
        const how = await restoreOne(actor, f.path, f.before, blobDir);
        (how === 'removed' ? result.removed : result.restored).push(f.path);
      } catch (e) {
        /* 失败要连**原因的种类**一起记（needUnlock/needBind/权限）：界面据此把用户引到
           该去的地方（解锁框/绑定），而不是只给一句看不懂的报错 */
        result.failed.push({
          path: f.path, error: (e && e.message) || String(e), status: (e && e.status) || 0,
          needUnlock: !!(e && e.needUnlock), needBind: !!(e && e.needBind), needPermission: !!(e && e.needPermission),
        });
      }
    }
  }
  result.skipped = (meta.skipped || []).length;
  const ok = result.restored.length + result.removed.length;
  /* **全部失败 = 这次不算撤过**：日志保持 undone:false，用户解锁/绑定之后还能再点一次。
     旧写法不管成败一律标 undone，于是"没解锁 → 一个文件都没恢复"却再也撤不了（实测）。 */
  meta.lastAttemptAt = Date.now();
  meta.lastResult = {
    restored: result.restored.length, removed: result.removed.length,
    failed: result.failed.length, skipped: result.skipped,
  };
  if (result.failed.length === 0) { meta.undone = true; meta.undoneAt = Date.now(); }
  await atomicWriteJson(metaFile(dir), meta, 2).catch(() => {});
  auditLog(`agent-undo account=${account} run=${runId} restored=${result.restored.length} `
    + `removed=${result.removed.length} failed=${result.failed.length} skipped=${result.skipped} ok=${ok}`);
  return { journal: meta, summary: summaryOf(meta), result };
}

/** 会话被**彻底删除**时清掉它的撤销日志（归档保留——归档可恢复，日志也要跟着回去） */
async function dropSession(account, sessionId) {
  const dir = sessionDir(account, sessionId);
  if (!dir) return false;
  const existed = fs.existsSync(dir);
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  return existed;
}

module.exports = {
  MUTATING, wrap, finishRun, summaryOf, readJournal, restoreOne, undo, dropSession,
  prune, dirBytes, lineDiff, countLines, capture, sameSnap, pathsFor, undoRoot, runDir, sessionDir,
};
