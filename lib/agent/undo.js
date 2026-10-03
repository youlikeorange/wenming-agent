/** lib/agent/undo.js —— 一次运行的**文件改动日志**：行数统计 + 「比对修改」+ 「撤销」的原内容快照
 *
 *  用户要的四件事都长在这一份日志上：
 *    ① 追踪条（信息卡片）上的「+N 行 / −M 行」：工具执行前后各拍一次快照，比出行数差；
 *    ② 「比对修改」：点追踪条那条 +N/−M（或撤销菜单里的一个文件）→ 抽屉里看前后差异。
 *       后端只提供**读两侧内容**（readDiff）——内容按需、一次一个文件、有大小上限，
 *       界面上渲染差异（core 的 LCS 纯函数）；diff 计算与展示全是前端的事；
 *    ③ 「撤销」：写/改/删/移动/建目录**之前**把原内容备份下来，
 *       撤销 = 按相反顺序把受影响路径恢复成运行前的样子；**可整轮、也可只选一个文件**（opts.paths）；
 *    ④ 「关了浏览器回来还看得到」：日志按 **账号 / 会话 / 运行** 落在
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
 *    · 备份/恢复都在服务端账号目录内；比对内容只在**按路径点开时**读那一个文件的备份与当前版本
 *      （路径必须是日志里记过的，这不是通用文件读接口），并受 MAX_DIFF_CHARS 截断。
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
 *  返回 { added, removed, per }——per 是**按路径**的明细（同一个路径在本轮被改过多次时，
 *  「比对修改」抽屉与撤销菜单要按文件显示各自的 +N/−M，不能只有整条命令的合计）。
 *  移动的**源路径**不计行数：文件没被删掉，只是换了地方（源路径的 after 是"不存在"，
 *  照删文件算会显示成"删了 N 行"——那是在骗人）；目标路径照常比（覆盖了旧文件才算删除）。 */
function statOf(name, before, after, changed, paths) {
  let added = 0, removed = 0;
  const per = {};
  /* 移动的源路径（paths[0] 由 pathsFor 保证）不计行数——文件没被删掉，只是换了地方；
     目标路径只在**覆盖了原有文件**时才算（否则"新位置出现了一份"也不是新增了几行）。 */
  const skip = name === 'move_file' ? paths[0] : null;
  for (const p of changed) {
    if (p === skip) continue;
    if (name === 'move_file' && (!before[p] || before[p].kind === 'missing')) continue;
    const b = before[p], a = after ? after[p] : null;
    let d = { added: 0, removed: 0 };
    if (isFileSnap(b) && isFileSnap(a)) d = lineDiff(b.text, a.text);
    else if (isFileSnap(a)) d = { added: a.lines || 0, removed: 0 };
    else if (isFileSnap(b)) d = { added: 0, removed: b.lines || 0 };
    else if (b && b.kind === 'dir') d = { added: 0, removed: sumTreeLines(b) };
    else if (a && a.kind === 'dir') d = { added: sumTreeLines(a), removed: 0 };
    per[p] = d;
    added += d.added; removed += d.removed;
  }
  return { added, removed, per };
}

const actionOf = (b, a) => (!b || b.kind === 'missing' ? 'create' : (!a || a.kind === 'missing' ? 'delete' : 'modify'));

function record(st, name, paths, before, after) {
  const changed = paths.filter((p) => !after || !sameSnap(before[p], after[p]));
  if (!changed.length) return null;
  const stat = statOf(name, before, after, changed, paths);
  const entry = {
    tool: name, ts: Date.now(), lines: { added: stat.added, removed: stat.removed },
    paths: changed.map((p) => Object.assign({
      path: p, action: actionOf(before[p], after ? after[p] : null),
      /* 这个路径自己的行数（菜单/抽屉按文件显示）；移动的源路径没有它，回退成 0/0 */
      lines: stat.per[p] || { added: 0, removed: 0 },
      before: toStored(before[p]),
      /* 执行后的快照（内容也在 blobs/ 里）：比对抽屉的"之后"用它——不受"之后又被改过/已撤销"
         影响，也不用读磁盘（未解锁也能看）。capture 整体失败时**不写这个字段**（缺 = 未知，
         与旧日志同形：读取端回退到"下一条改动前的快照 → 当前磁盘"）。 */
    }, after ? { after: toStored(after[p]) } : {})),
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
  /* after 的**内容也备份一份**（blobs=true）：「比对修改」要"之前/之后"两份，
     而磁盘上的当前文件既可能又被改过、也可能已经撤销回去了，还受解锁闸门约束——
     日志里存一份才可靠（读它不碰磁盘，未解锁也能看"这条命令改成了什么"）。
     代价是日志体积翻倍；上限（MAX_RUN_BYTES 等）按实际字节记账、到顶就停记并如实标 incomplete。 */
  try { after = {}; for (const p of paths) after[p] = (await capture(p, st, true)).snap; } catch { after = null; }

  try {
    const entry = record(st, name, paths, before, after);
    /* 工具**失败**但文件确实变了（比如删除删到一半）→ 日志保留（撤销要能修）；但标 partial，
       且不把行数挂到结果上（模型看到的是失败，不该同时看到"+3 行"这种成功口径）。 */
    if (entry) {
      if (err) entry.partial = true;
      else if (result && typeof result === 'object') {
        result.lines = entry.lines;
        /* 「比对修改」的定位信息（追踪条那条 +N/−M 卡片点击后用它取两者对比）：
           哪一轮、日志里的第几条、动了哪些路径。**不带内容**——内容到时候按需向服务端要
           （见 readDiff），追踪条上只多这几十个字节。 */
        result.undoRef = {
          runId: st.runId, sessionId: st.sessionId,
          entry: st.entries.length - 1, paths: entry.paths.map((f) => f.path),
        };
      }
    }
  } catch (e) {
    st.skipped.push({ path: paths[0], reason: '记录失败：' + (e.message || e) });
  }
  if (err) throw err;
  return result;
}

/* ============================ 落盘 / 清理 ============================ */

/** 交给界面/会话消息的那一句摘要（文件清单只给前 20 个，完整清单在服务端日志里）。
 *  `fileList` 是**按文件**的明细（追踪条下方的撤销菜单逐行显示）：路径、动作、
 *  +N/−M、是否已恢复——支持"一个个撤销"之后，光有总数不够用。 */
function summaryOf(meta) {
  const paths = [];
  let added = 0, removed = 0;
  const byPath = new Map();
  for (const e of meta.entries || []) {
    added += (e.lines && e.lines.added) || 0;
    removed += (e.lines && e.lines.removed) || 0;
    const solo = (e.paths || []).length === 1;
    for (const f of e.paths || []) {
      if (!paths.includes(f.path)) paths.push(f.path);
      let rec = byPath.get(f.path);
      if (!rec) {
        /* action 取**最早**一条（相对本轮开始的状态）：entries 是时间顺序，第一次遇到即最早 */
        rec = { path: f.path, action: f.action || 'modify', added: 0, removed: 0, undone: true, undoneAt: 0 };
        byPath.set(f.path, rec);
      }
      /* 行数优先取 path 级（新日志）；旧日志没有它，单路径的条目才回退到 entry 级合计 */
      const l = f.lines || (solo ? e.lines : null);
      if (l) { rec.added += l.added || 0; rec.removed += l.removed || 0; }
      if (!f.undoneAt) rec.undone = false;
      else if (!rec.undoneAt) rec.undoneAt = f.undoneAt;
    }
  }
  const fileList = paths.slice(0, 20).map((p) => byPath.get(p));
  const last = meta.lastResult || null;
  return {
    runId: meta.runId, sessionId: meta.sessionId, ts: meta.ts || Date.now(),
    count: paths.length, files: paths.slice(0, 20), more: Math.max(0, paths.length - 20),
    added, removed, skipped: (meta.skipped || []).length, complete: meta.complete !== false,
    undone: !!meta.undone, undoneAt: meta.undoneAt || 0,
    /* 逐文件撤销的进度：菜单显示"还剩 N 个可撤销"、已恢复的行置灰 */
    fileList,
    undoneCount: fileList.filter((f) => f.undone).length,
    pendingCount: fileList.filter((f) => !f.undone).length,
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

/* ============================ 比对（读两侧内容 → 界面的对比抽屉） ============================ */

/** 单边文本的上限（字符）：diff 是给人看的，超长截断并如实标记（界面会说"只显示前 N"） */
const MAX_DIFF_CHARS = Number(process.env.AGENT_UNDO_DIFF_CHARS) || 256 * 1024;

/** buffer → 一侧的内容（二进制判 NUL、超长截断、行数） */
function textSide(buf, snap) {
  const t = textOf(buf);
  if (t === null) return { text: null, binary: true, size: buf.length, lines: null, truncated: false };
  const cut = t.length > MAX_DIFF_CHARS;
  return {
    text: cut ? t.slice(0, MAX_DIFF_CHARS) : t, binary: false, truncated: cut, size: buf.length,
    lines: (snap && snap.lines != null) ? snap.lines : countLines(t),
  };
}

/** 一侧 = 日志里的快照（内容在 blobs/ 里）。source 标内容来自哪（journal=备份 / disk=当前文件） */
async function sideOfSnap(snap, blobDir, source) {
  const base = { source, exists: !!(snap && snap.kind !== 'missing'), binary: false, truncated: false, text: null };
  if (!snap || snap.kind === 'missing') return Object.assign(base, { exists: false, lines: 0, size: 0 });
  if (snap.kind === 'link') return Object.assign(base, { lines: null, size: 0, link: true, target: snap.target || '' });
  if (snap.kind === 'dir') {
    return Object.assign(base, { lines: null, size: snap.bytes || 0, dir: true,
      count: (snap.files || []).length, truncated: !!snap.truncated });
  }
  if (!snap.blob) {
    return Object.assign(base, { lines: snap.lines == null ? null : snap.lines, size: snap.size || 0,
      unavailable: '没有备份（文件超过单次备份上限或当时读不到），只能看个大概' });
  }
  const buf = await fsp.readFile(path.join(blobDir, snap.blob)).catch(() => null);
  if (!buf) {
    return Object.assign(base, { lines: snap.lines == null ? null : snap.lines, size: snap.size || 0,
      unavailable: '备份文件读不到（日志可能已被清理）' });
  }
  return Object.assign(base, textSide(buf, snap));
}

/** 另一侧 = **当前磁盘上的文件**（这条改动之后没有人再改过它时用）。
 *  走与工具同一套闸门；被闸门拦下（没解锁/越界）不抛——diff 仍要能看，只是这侧标 unavailable。 */
async function sideOfDisk(actor, real) {
  const fsTools = require('./tools/fs');
  const base = { source: 'disk', binary: false, truncated: false, text: null, lines: null, size: 0 };
  let target;
  try {
    target = await fsTools.guard(actor, real, 'read');
  } catch (e) {
    if (!fs.existsSync(real)) return Object.assign(base, { exists: false, lines: 0 });
    return Object.assign(base, { exists: true, unavailable: (e && e.message) || '读不到当前文件',
      needUnlock: !!(e && e.needUnlock), needBind: !!(e && e.needBind) });
  }
  const lst = await fsp.lstat(target).catch(() => null);
  if (!lst) return Object.assign(base, { exists: false, lines: 0 });
  if (lst.isDirectory()) return Object.assign(base, { exists: true, dir: true, count: null });
  if (lst.size > MAX_FILE_BYTES) {
    return Object.assign(base, { exists: true, size: lst.size,
      unavailable: `当前文件 ${Math.round(lst.size / 1024)}KB，超过单次读取上限，不展示差异` });
  }
  const buf = await fsp.readFile(target).catch(() => null);
  if (!buf) return Object.assign(base, { exists: true, size: lst.size, unavailable: '读不到当前文件' });
  return Object.assign(base, { exists: true }, textSide(buf, null));
}

/**
 * 读一次改动的**两侧内容**（界面的「比对修改」抽屉用）。
 *
 *  · `path` 必须出现在这轮的改动日志里（不接受任意路径——这不是通用文件读接口）；
 *  · before = 日志里的备份内容；after 三种来源（按优先级）：
 *      ① 这条改动**执行后的快照**（新日志都有，内容在 blobs/ 里）——不受"之后又被改过 / 已撤销 /
 *         有没有解锁"影响，永远显示"这条命令当时把它变成了什么"；
 *      ② 旧日志没有① → 用**下一条同路径改动之前的快照**（等价于"这条改完之后"的样子）；
 *      ③ 都没有（这个文件是本轮最后一次改动且日志是旧的）→ 读**当前磁盘**（标 source:'disk'，
 *         未解锁/越界时该侧标 unavailable，界面显示能读到的那一侧）；
 *  · scope：给了 `entry` 就是"这一条命令的改动"，否则是"这个文件在本轮的累计改动"。
 */
async function readDiff(account, actor, runId, sessionIdHint, opts) {
  const found = await readJournal(account, runId, sessionIdHint);
  if (!found) throw Object.assign(new Error('这一轮的改动日志不存在（可能已被清理）'), { status: 404 });
  const { meta, dir } = found;
  const want = String((opts && opts.path) || '');
  if (!want) throw Object.assign(new Error('缺少 path'), { status: 400 });
  const hits = [];
  (meta.entries || []).forEach((e, i) => { if ((e.paths || []).some((f) => f.path === want)) hits.push(i); });
  if (!hits.length) throw Object.assign(new Error('这个路径不在这轮的改动日志里'), { status: 404 });
  const asEntry = Number.isInteger(opts && opts.entry) && hits.includes(opts.entry) ? opts.entry : null;
  const idx = asEntry != null ? asEntry : hits[0];
  const entry = meta.entries[idx];
  const rec = (entry.paths || []).find((f) => f.path === want) || {};
  const blobDir = path.join(dir, 'blobs');
  const nextIdx = hits.find((i) => i > idx);
  const nextRec = nextIdx != null
    ? ((meta.entries[nextIdx].paths || []).find((f) => f.path === want) || {}).before
    : null;
  const afterSnap = rec.after || nextRec || null;
  const before = await sideOfSnap(rec.before, blobDir, 'journal');
  const after = afterSnap ? await sideOfSnap(afterSnap, blobDir, 'journal') : await sideOfDisk(actor, want);
  /* 行数：entry 模式 = 这条命令改了多少；file 模式 = 这个文件本轮累计改了多少 */
  let lines;
  if (asEntry != null) {
    lines = rec.lines || entry.lines || { added: 0, removed: 0 };
  } else {
    lines = { added: 0, removed: 0 };
    for (const i of hits) {
      const e = meta.entries[i];
      const f = (e.paths || []).find((x) => x.path === want);
      const l = (f && f.lines) || ((e.paths || []).length === 1 ? e.lines : null);
      if (l) { lines.added += l.added || 0; lines.removed += l.removed || 0; }
    }
  }
  const recs = hits.map((i) => (meta.entries[i].paths || []).find((x) => x.path === want)).filter(Boolean);
  const undone = recs.length > 0 && recs.every((f) => !!f.undoneAt);
  return {
    ok: true, runId, path: want, sessionId: meta.sessionId,
    scope: asEntry != null ? 'entry' : 'file',
    entry: idx, changes: hits.length, tool: entry.tool || '', ts: entry.ts || 0,
    action: rec.action || 'modify',
    undone, undoneAt: recs.reduce((n, f) => Math.max(n, f.undoneAt || 0), 0),
    lines, before, after,
  };
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
 * 撤销：把一次运行的文件改动恢复原状。**整轮或按文件**（opts.paths）都走这里。
 *
 *  · 按**相反顺序**重放日志（同一文件被改过两次时，先回到后一次之前的样子，再回到最初）；
 *  · 每个路径失败单独记账（权限、没备份…），**不中断**其余路径的恢复；
 *  · 成功与否都写回日志：`undone` 标记（整轮全恢复）+ 每个路径项上的 `undoneAt`
 *    （逐文件恢复的进度）。刷新后照样看得见，也不会被撤销第二次——已恢复的路径会跳过；
 *  · 指定 paths 时只处理这些路径（桌面端"仅对这一条恢复"），未指定的原样不动。
 * @param {{paths?: string[]}} [opts] 只撤销这些路径（缺省 = 整轮全部）
 * @returns {{journal:object, summary:object, result:object}}
 */
async function undo(account, actor, runId, sessionIdHint, opts) {
  const found = await readJournal(account, runId, sessionIdHint);
  if (!found) throw Object.assign(new Error('这一轮的改动日志不存在（可能已被清理）：无法撤销'), { status: 404 });
  const { meta, dir } = found;
  const want = Array.isArray(opts && opts.paths) ? opts.paths.map(String).filter(Boolean) : null;
  /* 待恢复清单：跳过已经恢复过的路径（逐文件撤销之后，重试只做剩下的那几个） */
  const todo = [];
  for (const entry of [...(meta.entries || [])].reverse()) {
    for (const f of entry.paths || []) {
      if (want && !want.includes(f.path)) continue;
      if (f.undoneAt) continue;
      todo.push(f);
    }
  }
  if (!todo.length) {
    throw Object.assign(new Error(want ? '选中的文件都已经恢复过了' : '这一轮的改动已经撤销过了'), { status: 409 });
  }
  const blobDir = path.join(dir, 'blobs');
  const result = { restored: [], removed: [], failed: [] };
  for (const f of todo) {
    try {
      const how = await restoreOne(actor, f.path, f.before, blobDir);
      (how === 'removed' ? result.removed : result.restored).push(f.path);
      f.undoneAt = Date.now();
      f.undoneHow = how;
    } catch (e) {
      /* 失败要连**原因的种类**一起记（needUnlock/needBind/权限）：界面据此把用户引到
         该去的地方（解锁框/绑定），而不是只给一句看不懂的报错 */
      result.failed.push({
        path: f.path, error: (e && e.message) || String(e), status: (e && e.status) || 0,
        needUnlock: !!(e && e.needUnlock), needBind: !!(e && e.needBind), needPermission: !!(e && e.needPermission),
      });
    }
  }
  result.skipped = (meta.skipped || []).length;
  const ok = result.restored.length + result.removed.length;
  /* **全部失败 = 这次不算撤过**：日志保持原样，用户解锁/绑定之后还能再点一次。
     旧的写法不管成败一律标 undone，于是"没解锁 → 一个文件都没恢复"却再也撤不了（实测）。 */
  meta.lastAttemptAt = Date.now();
  meta.lastResult = {
    restored: result.restored.length, removed: result.removed.length,
    failed: result.failed.length, skipped: result.skipped,
  };
  /* 整轮 undone = 日志里**每个**路径都被恢复过（不论这一趟撤的是不是全部） */
  const all = [];
  for (const e of meta.entries || []) for (const f of e.paths || []) all.push(f);
  meta.undone = all.length > 0 && all.every((f) => f.undoneAt);
  if (meta.undone) meta.undoneAt = Date.now();
  await atomicWriteJson(metaFile(dir), meta, 2).catch(() => {});
  auditLog(`agent-undo account=${account} run=${runId} scope=${want ? `paths:${want.length}` : 'all'} `
    + `restored=${result.restored.length} removed=${result.removed.length} failed=${result.failed.length} `
    + `skipped=${result.skipped} ok=${ok}`);
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
  MUTATING, wrap, finishRun, summaryOf, readJournal, readDiff, restoreOne, undo, dropSession,
  prune, dirBytes, lineDiff, countLines, capture, sameSnap, pathsFor, undoRoot, runDir, sessionDir,
};
