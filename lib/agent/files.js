/** lib/agent/files.js —— **待下载目录**：每个账号一个，放"要交给用户的文件" + 下载链接
 *
 *  为什么要有它：Agent 的产出物（报告、生成的包、导出文件）都在服务端，用户要点"下载"就得有一个
 *  **能取到字节的 HTTP 入口**。这里给每个账号一个目录：
 *      STATE_DIR/agent/<文档站账号>/downloads/
 *  界面上的「📥 待下载」菜单列它、会话里那张文件卡片的链接也指向它（同一个目录、同一个端点）。
 *
 *  三条安全口径（都是"宁可麻烦一点"）：
 *    ① **不拼用户给的路径**：文件名走白名单正则，取文件时再 realpath 复核（挡 `../`、绝对路径、
 *       符号链接逃逸）；目录本身只由账号名拼出来（账号名同样过 ACCOUNT_RE）。
 *    ② **可执行文件不直接给**：发布时打包成 `<名>.zip`（目录里根本不出现裸的可执行文件），
 *       下载时**再兜一道**——手动拷进来的可执行文件照样现场打成 zip 再发。
 *       判据 = **只看后缀名**（exe/bat/deb/apk/…）。不看执行位：NTFS/exFAT 挂载点会把所有文件
 *       报成 0777（数据盘上的普通文档也会被当成可执行文件打成 zip），执行位在这里不可信。
 *    ③ 上限：单文件与目录总量（见 MAX_FILE / MAX_TOTAL），超了明确拒绝并说明，不产半截文件。
 *
 *  端点（都要求登录，走 lib/agent/index.js 的统一前置）：
 *    GET  /agent/files                    列目录（界面菜单与文件卡片都用它）
 *    GET  /agent/files/download?name=…    下载（可执行文件自动改发 zip）
 *    POST /agent/files/delete  { name }   删一个（"待下载"目录会越攒越多，得能清）
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { json, readJson } = require('../http');
const { buildZip } = require('../zip');
/* 存储根与账号名规则走唯一真源：../paths（路径）、../ids（isValidAccount 用的就是它） */
const { AGENT_ROOT, accountDir, validAccount } = require('../paths');
const { auditLog } = require('../auth');

/* 上限：默认单文件 512MB、目录总量 2GB（可用环境变量调）。超了拒绝并说明——
   待下载目录不是网盘，塞大文件应该走别的路（项目目录里的文件本来就能下载）。 */
const MAX_FILE = Number(process.env.AGENT_FILES_MAX_BYTES || 512 * 1024 * 1024);
const MAX_TOTAL = Number(process.env.AGENT_FILES_TOTAL_BYTES || 2 * 1024 * 1024 * 1024);
/** 列表最多回多少条（菜单是给人看的，不是文件管理器） */
const MAX_ENTRIES = 500;

/** 视为"可执行"的扩展名（各操作系统里双击就跑/装的那些）：一律打包，不给裸文件。
 *  比较用小写（`extOf` 已统一小写），所以 .EXE / .Deb 一样能认出来。 */
const EXEC_EXT = new Set([
  /* Windows 与 Windows 脚本宿主 */
  'exe', 'com', 'bat', 'cmd', 'msi', 'msp', 'scr', 'pif', 'cpl', 'lnk',
  'ps1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta',
  /* macOS */
  'app', 'dmg', 'pkg', 'command',
  /* Linux 与发行版安装包 */
  'sh', 'bash', 'zsh', 'run', 'bin', 'deb', 'rpm', 'appimage', 'snap',
  /* Android */
  'apk', 'aab',
  /* 跨平台：JVM 包、freedesktop 桌面项 */
  'jar', 'desktop',
]);
/** 文件名白名单：中英文/数字/常见符号都留，只挡路径分隔符与隐藏文件（含 `..`） */
const NAME_RE = /^[^\x00-\x1f\\/]{1,120}$/;

/** 待下载目录 `<agent>/<账号>/downloads`；账号名不合法 → null（调用方必须处理） */
const dirOf = (account) => {
  const d = accountDir(AGENT_ROOT, account);
  return d ? path.join(d, 'downloads') : null;
};

/** 文件名是否合法（挡 `../`、绝对路径、控制字符、隐藏文件） */
function safeName(input) {
  const n = String(input || '').trim().replace(/[\\/]+/g, '_');
  if (!n || !NAME_RE.test(n)) return '';
  if (n.startsWith('.')) return '';                    // 隐藏文件不给（`.` / `..` / `.env` 一并挡住）
  return n;
}

const extOf = (name) => (path.extname(String(name || '')).slice(1) || '').toLowerCase();

/** 这个文件算不算"可执行"：**只看后缀名**（不看执行位——NTFS/exFAT 挂载点上全是 0777） */
const isExecutable = (name) => EXEC_EXT.has(extOf(name));

async function ensureDir(account) {
  const dir = dirOf(account);
  if (!dir) throw Object.assign(new Error('账号名不合法'), { status: 400 });
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** 目录里没有同名时用原名，重名就加 ` (2)`、` (3)`…（在扩展名前） */
async function uniqueName(dir, name) {
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  for (let i = 1; i < 200; i++) {
    const tryName = i === 1 ? name : `${base} (${i})${ext}`;
    try { await fsp.access(path.join(dir, tryName)); } catch { return tryName; }
  }
  return `${base}-${Date.now()}${ext}`;
}

/** 目录总量（含子目录——正常不会有，但手工拷进来的要算上） */
async function totalBytes(dir) {
  let sum = 0;
  let list = [];
  try { list = await fsp.readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of list) {
    if (!e.isFile()) continue;
    try { sum += (await fsp.stat(path.join(dir, e.name))).size; } catch { /* 读不到就不算 */ }
  }
  return sum;
}

/* ============================ 列表 / 下载 / 删除 ============================ */

/** 待下载目录的内容（界面菜单与文件卡片用）。按时间倒序（最新放的在最上面）。 */
async function list(account) {
  if (!validAccount(account)) return { dir: '', entries: [] };
  const dir = await ensureDir(account);
  let raw = [];
  try { raw = await fsp.readdir(dir, { withFileTypes: true }); } catch { raw = []; }
  const entries = [];
  for (const e of raw) {
    if (!e.isFile()) continue;
    const full = path.join(dir, e.name);
    let st;
    try { st = await fsp.stat(full); } catch { continue; }
    const exec = isExecutable(e.name);
    entries.push({
      name: e.name,
      size: st.size,
      mtime: Math.round(st.mtimeMs),
      exec,
      /* 已经打包过的（.zip）原样给；裸的可执行文件列表里就标出来（下载时会被打包） */
      packaged: extOf(e.name) === 'zip' ? true : undefined,
      downloadName: exec ? `${e.name}.zip` : e.name,
    });
    if (entries.length >= MAX_ENTRIES) break;
  }
  entries.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  return { dir, entries, maxFileBytes: MAX_FILE, maxTotalBytes: MAX_TOTAL };
}

/** 取一个文件（**只在待下载目录里**取；realpath 复核，符号链接指向外面也不行） */
async function resolveFile(account, name) {
  const clean = safeName(name);
  if (!clean) return null;
  const dir = dirOf(account);
  if (!dir) return null;
  const full = path.join(dir, clean);
  let real;
  try { real = await fsp.realpath(full); } catch { return null; }
  let realDir;
  try { realDir = await fsp.realpath(dir); } catch { return null; }
  /* 解析后的文件必须**正好躺在这个目录里**：符号链接指向别处（哪怕同名）一律拒绝 */
  if (path.dirname(real) !== realDir) return null;
  const st = await fsp.stat(real).catch(() => null);
  if (!st || !st.isFile()) return null;
  return { name: path.basename(real), file: real, st };
}

/** 下载要发的那份：**可执行文件一律改发 zip**（现打现发，原始文件不动） */
async function downloadOf(account, name) {
  const hit = await resolveFile(account, name);
  if (!hit) return null;
  const { file, st } = hit;
  if (!isExecutable(hit.name)) {
    return { file, downloadName: hit.name, size: st.size, packaged: false, mtime: st.mtime };
  }
  const data = await fsp.readFile(file);
  const zip = buildZip([{ name: hit.name, data, mtime: st.mtime }]);
  return { buffer: zip, downloadName: `${hit.name}.zip`, size: zip.length, packaged: true, mtime: st.mtime };
}

async function remove(account, name) {
  const hit = await resolveFile(account, name);
  if (!hit) throw Object.assign(new Error('文件不存在（或名字不合法）'), { status: 404 });
  await fsp.unlink(hit.file);
  auditLog(`agent-file-delete account=${account} name=${hit.name}`);
  return { name: hit.name };
}

/* ============================ 放文件进目录 ============================ */

/** 从 Buffer 放一个文件（内部用：发布时打包、测试） */
async function saveBuffer(account, name, buf, opts = {}) {
  const clean = safeName(name);
  if (!clean) throw Object.assign(new Error('文件名不合法'), { status: 400 });
  if (buf.length > MAX_FILE) {
    throw Object.assign(new Error(`文件太大（${Math.round(buf.length / 1048576)}MB），上限 ${Math.round(MAX_FILE / 1048576)}MB`), { status: 413 });
  }
  const dir = await ensureDir(account);
  if (await totalBytes(dir) + buf.length > MAX_TOTAL) {
    throw Object.assign(new Error('待下载目录已满（可以先在菜单里删掉不再需要的文件）'), { status: 413 });
  }
  const finalName = await uniqueName(dir, clean);
  const target = path.join(dir, finalName);
  await fsp.writeFile(target, buf, { mode: 0o600 });
  if (opts.mtime) { try { await fsp.utimes(target, opts.mtime, opts.mtime); } catch { /* 无所谓 */ } }
  return { name: finalName, size: buf.length, packaged: extOf(finalName) === 'zip' };
}

/**
 * 把一个**已经存在于磁盘上**的文件放进待下载目录（工具 deliver_file 的唯一落点）。
 * @param {string} account 文档站账号
 * @param {string} src 源文件（**已经过 roots + 权限闸门**，见 tools/deliver.js）
 * @param {{name?:string}} opts name = 换个名字（默认用源文件名）
 * @returns {Promise<{name:string, size:number, packaged:boolean, exec:boolean}>}
 *          packaged = 这次是不是打成了 zip（可执行文件必然为 true）
 */
async function publish(account, src, opts = {}) {
  const st = await fsp.stat(src);
  if (st.isDirectory()) {
    throw Object.assign(new Error('这是目录：先把目录打包成 .zip 再传（例如 run_command 里 zip -r），或逐个传文件'), { status: 400 });
  }
  const srcName = path.basename(src);
  const want = safeName(opts.name || srcName);
  if (!want) {
    throw Object.assign(new Error('文件名不合法（以 . 开头的隐藏文件不直接给下载）：用 name 参数指定一个名字再传'), { status: 400 });
  }
  const exec = isExecutable(want);
  if (st.size > MAX_FILE) {
    throw Object.assign(new Error(`文件太大（${Math.round(st.size / 1048576)}MB），上限 ${Math.round(MAX_FILE / 1048576)}MB`), { status: 413 });
  }
  const data = await fsp.readFile(src);
  /* 可执行文件：**打包后再放**（目录里不出现裸的可执行文件）。名字保留原名，外面套一层 zip。 */
  if (exec) {
    const zipName = extOf(want) === 'zip' ? want : `${want}.zip`;
    const buf = buildZip([{ name: want, data, mtime: st.mtime }]);
    const saved = await saveBuffer(account, zipName, buf, { mtime: st.mtime });
    return { name: saved.name, size: saved.size, packaged: true, exec: true, sourceBytes: st.size };
  }
  const saved = await saveBuffer(account, want, data, { mtime: st.mtime });
  return { name: saved.name, size: saved.size, packaged: saved.packaged, exec: false, sourceBytes: st.size };
}

/* ============================ HTTP 端点 ============================ */

const MIME = {
  txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8', json: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8', html: 'text/html; charset=utf-8', pdf: 'application/pdf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm',
  zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar',
};
const mimeOf = (name) => MIME[extOf(name)] || 'application/octet-stream';

/** RFC 5987：中文/空格文件名必须这么写，否则各浏览器各乱码 */
const contentDisposition = (name) =>
  `attachment; filename="${String(name).replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'")}"; filename*=UTF-8''${encodeURIComponent(name)}`;

async function handleFiles(req, url, res, account) {
  const tail = url.pathname.slice('/agent/files'.length) || '/';

  if (req.method === 'GET' && (tail === '/' || tail === '')) {
    const out = await list(account);
    return json(res, 200, Object.assign({ ok: true }, out));
  }

  if (req.method === 'GET' && tail === '/download') {
    const name = url.searchParams.get('name') || '';
    let d = null;
    try { d = await downloadOf(account, name); } catch { d = null; }
    if (!d) return json(res, 404, { ok: false, error: '文件不存在（或已删除）' });
    res.writeHead(200, {
      'Content-Type': d.packaged ? 'application/zip' : mimeOf(d.downloadName),
      'Content-Disposition': contentDisposition(d.downloadName),
      'Content-Length': String(d.size),
      'Cache-Control': 'no-store',
      /* 可执行文件被换成了 zip：让调用方（脚本/测试）也看得见 */
      'X-Agent-Packaged': d.packaged ? '1' : '0',
    });
    if (d.buffer) { res.end(d.buffer); return undefined; }
    await new Promise((resolve) => {
      const rs = fs.createReadStream(d.file);
      rs.on('error', () => { try { res.destroy(); } catch { /* 已断 */ } resolve(); });
      rs.on('end', resolve);
      rs.pipe(res);
    });
    return undefined;
  }

  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' });
  let b = null;
  try { b = await readJson(req, 64 * 1024); } catch { b = null; }
  if (b === null) return json(res, 400, { ok: false, error: 'invalid json' });

  if (tail === '/delete') {
    try {
      const r = await remove(account, b.name);
      return json(res, 200, { ok: true, ...r });
    } catch (e) {
      return json(res, e.status || 500, { ok: false, error: e.message });
    }
  }

  return json(res, 404, { ok: false, error: 'unknown files endpoint' });
}

module.exports = {
  dirOf, list, publish, saveBuffer, remove, resolveFile, downloadOf,
  isExecutable, safeName, handleFiles,
  MAX_FILE, MAX_TOTAL, MAX_ENTRIES, EXEC_EXT,
};
