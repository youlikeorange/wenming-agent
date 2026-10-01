/** lib/agent/tools/fs.js —— 文件与目录工具（只读 5 个 + 写入 4 个 + 删除 1 个）
 *
 *  三重约束，缺一不可：
 *    ① 绑定账号的 POSIX 权限（lib/agent/osaccess.js）——读/写/进入逐级判定；
 *    ② 可访问目录白名单（lib/agent/roots.js）——符号链接解析后复核；
 *    ③ 服务端硬上限（read/write/output/treeNodes）——客户端只能收紧。
 *  工具名与主流 Agent / MCP filesystem 保持一致，模型换环境不用重新学。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');
const os = require('os');
const roots = require('../roots');
const osaccess = require('../osaccess');
const { kb, clamp } = require('../limits');

const fmtMode = (m) => (m & 0o777).toString(8).padStart(3, '0');

/** 路径解析 + 绑定账号权限判定：工具实现的第一步都走这里 */
async function guard(actor, input, need, opts) {
  const { real } = roots.resolveInRoots(actor, input, { write: need !== 'read', session: opts && opts.session });
  if (!actor.bound) {
    throw Object.assign(new Error('还没有绑定本机账号：Agent 的文件操作要以绑定账号的权限执行。'
      + '请在设置抽屉 → 本机账号 里绑定一个本机账号。'), { status: 403, needBind: true });
  }
  /* 未解锁不得动手，与命令工具（tools/exec.js 的 spawnSpec）同一口径。
     原先文件工具只看 bound、不看 needUnlock，于是 su 类绑定**没输密码**也能读写
     站点进程能碰的一切 —— 两条工具链对同一个 actor 的解读必须一致（审计 S7）。 */
  if (actor.needUnlock) {
    throw Object.assign(new Error(`需要先解锁：以 ${actor.osUser} 的身份操作文件需要在本次会话里输入一次该账号的密码`
      + '（密码只在内存里保存，从不落盘）。'), { status: 403, needUnlock: true, osUser: actor.osUser });
  }
  const ids = await osaccess.idsFor(actor);
  /* method 'same'（绑定账号就是站点进程自己的账号）时把判定交给内核：mode 位看不见 ACL，
     会误判——实测 /media/leo 靠 ACL 授权，纯 mode 位走查判成"没有 x 位"，整块数据盘的
     文件读写被全拒。详见 lib/agent/osaccess.js 的文件头。 */
  const r = await osaccess.check(real, need, ids, null, { sameAccount: actor.method === 'same' });
  if (!r.ok) {
    throw Object.assign(new Error(`${r.reason}\n（这是绑定账号 ${actor.osUser} 的权限判定；Agent 不会超过它的权限）`),
      { status: 403, needPermission: true });
  }
  return real;
}

/* ============================ 只读 ============================ */

async function readFile(actor, args, limits) {
  const real = await guard(actor, args.path, 'read');
  const st = await fsp.stat(real).catch(() => null);
  if (!st) throw Object.assign(new Error('文件不存在：' + real), { status: 404 });
  if (st.isDirectory()) throw Object.assign(new Error(`${real} 是目录，用 list_directory 或 directory_tree`), { status: 400 });
  const maxBytes = limits.readBytes;
  const from = clamp(args.start_line, 1, 1e9, 1);
  const to = args.end_line === undefined ? Infinity : clamp(args.end_line, from, 1e9, from);
  const big = st.size > maxBytes;
  const body = await readSlice(real, from, to, maxBytes);
  const head = `【${real}】${kb(st.size)} · ${new Date(st.mtimeMs).toLocaleString()} · 模式 ${fmtMode(st.mode)}`
    + (Number.isFinite(to) ? ` · 行 ${from}-${to}` : from > 1 ? ` · 从第 ${from} 行起` : '')
    + (big ? ` · 大文件：本次最多读 ${kb(maxBytes)}（可用 start_line/end_line 分段，或调大「单次读取上限」）` : '') + '\n';
  return { text: head + body };
}

/** 按行切片读取（向前流式扫描）：大文件分段读、限额、行号三者同时成立。
 *  旧实现"文件不到 8MB 就整篇读进来"，maxBytes 形同虚设；分段读又返回空内容。 */
async function readSlice(file, from, to, maxBytes) {
  const out = [];
  let bytes = 0, truncated = false, lastLine = 0, sawLine = false, endedAt = 0;
  const stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 64 * 1024 });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      lastLine++;
      if (lastLine < from) continue;                       // 目标区间之前：只数行、不留内容
      if (lastLine > to) { endedAt = lastLine - 1; break; }  // 越过 end_line：可以停了
      sawLine = true;
      const s = `${lastLine}\t${line}`;
      const n = Buffer.byteLength(s, 'utf8') + 1;
      if (bytes + n > maxBytes) { truncated = true; break; }  // 读满上限：从这里截断
      out.push(s);
      bytes += n;
    }
  } finally { rl.close(); stream.destroy(); }

  if (!sawLine && !truncated) return `(文件只有 ${lastLine} 行，没有第 ${from} 行)`;
  const range = Number.isFinite(to) ? `行 ${from}-${Math.min(to, from + out.length - 1)}` : `从第 ${from} 行起`;
  return out.join('\n')
    + (truncated ? `\n…（本次读到 ${kb(maxBytes)} 上限，止于第 ${lastLine} 行；`
      + `继续读请用 start_line=${lastLine + 1}${Number.isFinite(to) ? ' 且 end_line 不变' : ''}）`
      : Number.isFinite(to) && endedAt ? `\n（已到 end_line ${to}）` : '')
    + (out.length ? '' : `(${range} 无内容)`);
}

async function listDirectory(actor, args) {
  const real = await guard(actor, args.path, 'read');
  const entries = await fsp.readdir(real, { withFileTypes: true }).catch((e) => {
    throw Object.assign(new Error(`读目录失败：${e.code === 'ENOENT' ? '不存在 ' : ''}${real}${e.code === 'EACCES' ? '（权限不足）' : ''}`), { status: e.code === 'ENOENT' ? 404 : 403 });
  });
  const rows = [];
  for (const e of entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name))) {
    const p = path.join(real, e.name);
    let extra = '';
    try {
      const st = await fsp.lstat(p);
      if (e.isDirectory()) extra = '目录';
      else if (e.isSymbolicLink()) extra = '链接 → ' + (await fsp.readlink(p)).toString().slice(0, 120);
      else extra = kb(st.size) + ' · ' + new Date(st.mtimeMs).toLocaleString();
    } catch { extra = '（无法读取）'; }
    rows.push(`${e.isDirectory() ? '📁' : e.isSymbolicLink() ? '🔗' : '📄'} ${e.name}${extra ? '  ' + extra : ''}`);
  }
  return { text: `【${real}】${entries.length} 项\n` + (rows.join('\n') || '(空目录)') };
}

async function directoryTree(actor, args, limits) {
  const real = await guard(actor, args.path, 'read');
  const depth = clamp(args.depth, 1, 8, 3);
  const maxNodes = Math.min(limits.treeNodes, clamp(args.max_nodes, 10, limits.treeNodes, limits.treeNodes));
  let nodes = 0, truncated = false;
  const lines = [];
  const walk = async (dir, prefix, d) => {
    if (truncated) return;
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    const shown = entries.filter((e) => !/^(node_modules|\.git)$/.test(e.name))
      .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    const hidden = entries.length - shown.length;      // 省略掉的 node_modules / .git
    for (let i = 0; i < shown.length; i++) {
      const e = shown[i];
      if (nodes++ >= maxNodes) { truncated = true; break; }
      const last = i === shown.length - 1;
      lines.push(`${prefix}${last ? '└── ' : '├── '}${e.name}${e.isDirectory() ? '/' : ''}`);
      if (e.isDirectory() && d < depth) await walk(path.join(dir, e.name), prefix + (last ? '    ' : '│   '), d + 1);
    }
    if (hidden > 0) lines.push(`${prefix}…（另有 ${hidden} 项已省略）`);
  };
  await walk(real, '', 1);
  return { text: `【${real}】深度 ${depth}${truncated ? `，节点达上限 ${maxNodes} 已截断` : ''}\n` + lines.join('\n') };
}

async function searchFiles(actor, args, limits) {
  const real = await guard(actor, args.path, 'read');
  const pattern = String(args.pattern || '').trim();
  if (!pattern) throw Object.assign(new Error('缺少 pattern（文件名关键字、正则或 glob 通配）'), { status: 400 });
  // 三级匹配：合法正则 → 按 regex；非法但含 * ? → 按 glob 通配（`*.js` 曾静默零匹配，
  // 模型据此误判"没有这类文件"）；都不行 → 普通文本子串。结果头部注明实际用的哪种。
  let re = null, note = '';
  try { re = new RegExp(pattern, 'i'); }
  catch {
    if (/[*?]/.test(pattern)) {
      const rx = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
      try { re = new RegExp('^' + rx + '$', 'i'); note = '（pattern 不是合法正则，已按 glob 通配匹配：* 任意串、? 单字符）'; } catch { re = null; }
    }
    if (!re) note = '（pattern 不是合法正则，已按普通文本匹配）';
  }
  const max = Math.min(limits.treeNodes, clamp(args.max_results, 1, limits.treeNodes, 200));
  const hits = [];
  const walk = async (dir, d) => {
    if (hits.length >= max || d > 8) return;
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (hits.length >= max) return;
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      const hit = re ? re.test(e.name) : e.name.toLowerCase().includes(pattern.toLowerCase());
      if (hit) {
        const st = await fsp.lstat(p).catch(() => null);
        hits.push(`${e.isDirectory() ? '📁' : '📄'} ${p}${st && !e.isDirectory() ? '  ' + kb(st.size) : ''}`);
      }
      if (e.isDirectory()) await walk(p, d + 1);
    }
  };
  await walk(real, 1);
  return { text: hits.length ? `匹配 ${hits.length} 项（最多 ${max}）${note}\n` + hits.join('\n') : `没有匹配「${pattern}」的文件${note}` };
}

async function fileInfo(actor, args) {
  const real = await guard(actor, args.path, 'read');
  const st = await fsp.lstat(real).catch(() => null);
  if (!st) throw Object.assign(new Error('不存在：' + real), { status: 404 });
  const out = [
    `路径：${real}`,
    `类型：${st.isDirectory() ? '目录' : st.isSymbolicLink() ? '符号链接' : '文件'}`,
    `大小：${st.size} 字节（${kb(st.size)}）`,
    `权限：${fmtMode(st.mode)}  属主 uid=${st.uid} gid=${st.gid}`,
    `创建：${new Date(st.birthtimeMs).toLocaleString()}`,
    `修改：${new Date(st.mtimeMs).toLocaleString()}`,
    `访问：${new Date(st.atimeMs).toLocaleString()}`,
  ];
  if (st.isDirectory()) {
    const n = await fsp.readdir(real).then((l) => l.length).catch(() => -1);
    out.push(`目录项：${n < 0 ? '(无权限读取)' : n}`);
  }
  return { text: out.join('\n') };
}

/* ============================ 写入 ============================ */

async function writeFile(actor, args, limits) {
  const real = await guard(actor, args.path, 'write');
  const content = String(args.content == null ? '' : args.content);
  const bytes = Buffer.byteLength(content);
  if (bytes > limits.writeBytes) {
    throw Object.assign(new Error(`内容过大（${kb(bytes)}），超过服务端单次写入上限 ${kb(limits.writeBytes)}`), { status: 413 });
  }
  await fsp.mkdir(path.dirname(real), { recursive: true });
  const existed = fs.existsSync(real);
  if (existed && args.if_exists === 'fail') throw Object.assign(new Error('文件已存在，未覆盖：' + real), { status: 409 });
  await fsp.writeFile(real, content, 'utf8');
  return { text: `${existed ? '已覆盖' : '已创建'} ${real}（${kb(bytes)}，${content.split('\n').length} 行）` };
}

async function editFile(actor, args) {
  const real = await guard(actor, args.path, 'write');
  const oldText = String(args.old_text == null ? '' : args.old_text);
  const newText = String(args.new_text == null ? '' : args.new_text);
  if (!oldText) throw Object.assign(new Error('需要 old_text（要被替换的原文，必须与文件里的内容完全一致）'), { status: 400 });
  const src = await fsp.readFile(real, 'utf8').catch(() => { throw Object.assign(new Error('文件不存在：' + real), { status: 404 }); });
  const first = src.indexOf(oldText);
  if (first < 0) throw Object.assign(new Error('没找到 old_text 对应的原文（必须逐字一致，含缩进）'), { status: 409 });
  const count = src.split(oldText).length - 1;
  if (count > 1 && !args.replace_all) {
    throw Object.assign(new Error(`old_text 在文件里出现了 ${count} 次，无法确定改哪一处：请把上下文写长一点做到唯一，或加 replace_all:true`), { status: 409 });
  }
  const out = args.replace_all ? src.split(oldText).join(newText) : src.slice(0, first) + newText + src.slice(first + oldText.length);
  await fsp.writeFile(real, out, 'utf8');
  return { text: `已修改 ${real}（替换 ${args.replace_all ? count : 1} 处，${kb(Buffer.byteLength(out))}）` };
}

async function createDirectory(actor, args) {
  const real = await guard(actor, args.path, 'create');
  await fsp.mkdir(real, { recursive: true });
  return { text: `已创建目录（含父目录）：${real}` };
}

/** 跨设备时 rename 会 EXDEV：退回"复制后删源" */
async function copyThenRemove(src, dst) {
  await fsp.cp(src, dst, { recursive: true, force: true });
  await fsp.rm(src, { recursive: true, force: true });
}

async function moveFile(actor, args) {
  const src = await guard(actor, args.source, 'delete');
  const dst = await guard(actor, args.destination, 'create');
  if (fs.existsSync(dst) && !args.overwrite) {
    throw Object.assign(new Error('目标已存在（要覆盖请传 overwrite:true）：' + dst), { status: 409 });
  }
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await fsp.rename(src, dst).catch(async (e) => {
    if (e.code === 'EXDEV') return copyThenRemove(src, dst);
    throw e;
  });
  return { text: `已移动 ${src} → ${dst}` };
}

async function deletePath(actor, args) {
  const real = await guard(actor, args.path, 'delete');
  const st = await fsp.lstat(real).catch(() => null);
  if (!st) throw Object.assign(new Error('不存在：' + real), { status: 404 });
  if (st.isDirectory() && !args.recursive) {
    const n = (await fsp.readdir(real).catch(() => [])).length;
    if (n > 0) throw Object.assign(new Error(`目录非空（${n} 项）：确认要连内容一起删就用 recursive:true`), { status: 409 });
  }
  await fsp.rm(real, { recursive: !!args.recursive, force: false });
  return { text: `已删除${st.isDirectory() ? '目录' : '文件'}：${real}` };
}

/** 命令工具的工作目录：落在白名单内且绑定账号能进入 */
/** 命令的默认工作目录：**当前项目的根目录** → 项目起点 → 可访问范围的第一项 → 家目录。
 *  项目根目录最贴近"我现在在做的这件事"，起点次之（它是"项目都放这儿"的那个目录）。
 *  2026-09-30 起可访问范围默认是整个文件系统，所以不能再用 roots[0]（那会变成 `/`）。 */
function defaultCwd(actor) {
  try {
    // 延迟 require：projects.js → skills.js → tools/fs.js 会成环，调用时再取一次最省事
    const projects = require('../projects');
    const cur = projects.readList(actor.account).current;
    const p = cur ? projects.find(actor.account, cur) : null;
    if (p && p.root && fs.existsSync(p.root)) return p.root;
  } catch { /* 项目读不到就往下回落 */ }
  const start = roots.startFor(actor);
  if (start && fs.existsSync(start)) return start;
  const list = roots.list(actor);
  const fallback = list[0] || (() => { try { return os.homedir(); } catch { return '/'; } })();
  return fallback;
}

async function cwdFor(actor, want) {
  if (!want) {
    const cwd = defaultCwd(actor);
    if (fs.existsSync(cwd)) return cwd;
    throw Object.assign(new Error('工作目录不存在：' + cwd), { status: 404 });
  }
  return guard(actor, want, 'read');
}

module.exports = {
  guard, readFile, listDirectory, directoryTree, searchFiles, fileInfo,
  writeFile, editFile, createDirectory, moveFile, deletePath, cwdFor,
};
