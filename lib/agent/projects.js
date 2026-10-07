/** lib/agent/projects.js —— 项目：一个根目录 + 一份项目记忆（Markdown 文件夹）
 *
 *  参照主流 agent（ZCode / Claude Code 那一系）的做法：
 *    · **项目 = 用户选定的一个根目录**（"我现在在做的这件事"），会话归属于项目；
 *    · **项目记忆存在用户账号的数据目录里**，一个项目一个文件夹，**真源是 Markdown 文件**
 *      （可以看、可以拷、可以跟别的 agent 互换），而不是塞在某个大 JSON 里：
 *
 *        STATE_DIR/agent/<文档站账号>/projects/<项目id>/
 *            project.json     项目元信息（名字 / 根目录 / 时间）——文件夹自己也能说清它是谁
 *            MEMORY.md        索引（每行一条：- [标题](memory/xxx.md) — 摘要）
 *            memory/*.md      每条记忆一个文件，YAML frontmatter + 正文
 *
 *  为什么不用一个 projects.json 装下所有记忆：项目记忆会随项目长大（几十上百条），
 *  而"文件夹 + 每条一个 .md"既可读、又天然与 ZCode/Claude 的记忆格式互通。
 *  列表本身（有哪些项目、当前是哪个）仍是一份小 JSON：projects.json。
 *
 *  安全口径：项目记忆写在**服务端自己的数据目录**里，因此不受"绑定本机账号"限制；
 *  但"项目根目录"必须是**可访问目录白名单内的真实目录**（走 roots 那套闸门）——
 *  否则模型既看不到也改不了它，选它当项目只会让人困惑。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { AGENT_ROOT, accountDir: accountDirOf } = require('../paths');
const { atomicWriteJson } = require('../state');
const { auditLog } = require('../auth');
const S = require('./sanitize');
const store = require('./store');
const { makeLock } = require('../lock');
const roots = require('./roots');
const { splitFrontmatter } = require('./skills');

/* 标识符规则统一在 lib/ids.js（经 sanitize.js 转出）：本地一律引用，不再各存字面量 */
const { PROJECT_RE: NAME_RE, ENTRY_ID_RE } = S;

const MAX_PROJECTS = 50;
const MAX_MEMORY = 300;
const MAX_MD = 200 * 1024;

/* ============================ 路径 ============================ */

/** 账号 → 账号目录（账号名不合法 → null；校验与拼接同一步，见 lib/paths.js） */
const accountDir = (account) => accountDirOf(AGENT_ROOT, account);
const listFile = (account) => {
  const d = accountDir(account);
  return d ? path.join(d, 'projects.json') : null;
};
/** 项目文件夹（不存在也返回路径，由调用方决定建不建） */
function projectDir(account, id) {
  const d = accountDir(account);
  if (!d || !NAME_RE.test(String(id || ''))) return null;
  return path.join(d, 'projects', String(id));
}
const memoryDir = (account, id) => {
  const p = projectDir(account, id);
  return p ? path.join(p, 'memory') : null;
};

/** 由根目录推出稳定的项目 id：`<目录名>-<路径哈希8位>`（与 ZCode 的项目 slug 同一思路） */
function slugify(s, fallback) {
  const t = String(s || '').trim().toLowerCase()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 40);
  return t || fallback;
}
function idFor(root) {
  const abs = path.resolve(String(root || ''));
  const hash = crypto.createHash('sha1').update(abs).digest('hex').slice(0, 8);
  return slugify(path.basename(abs), 'project').slice(0, 40) + '-' + hash;
}

/* ============================ 项目清单（projects.json） ============================ */

const empty = () => ({ version: 1, current: '', projects: [] });

function readList(account) {
  const file = listFile(account);
  if (!file) return empty();
  /* 原始读取与"损坏先备份再回落"都用 store 的正本（审计：这段逻辑原先在本文件里有一份副本，
     而且那份对"合法但不是对象"的 JSON（比如字面量 null）会抛错当成损坏——正本不会）。 */
  const d = store.readJson(file, null);
  if (!d) return empty();
  const projects = (Array.isArray(d.projects) ? d.projects : []).map(cleanProject).filter(Boolean).slice(0, MAX_PROJECTS);
  const current = projects.some((p) => p.id === d.current) ? String(d.current) : (projects[0] ? projects[0].id : '');
  return { version: 1, current, projects, updatedAt: d.updatedAt };
}

function cleanProject(p) {
  if (!p || typeof p !== 'object') return null;
  const id = NAME_RE.test(String(p.id || '')) ? String(p.id) : '';
  const root = String(p.root || '').trim().slice(0, 500);
  if (!id || !root.startsWith('/')) return null;
  return {
    id, root,
    name: String(p.name || '').trim().slice(0, 80) || path.basename(root) || id,
    created: S.num(p.created) || Date.now(),
    updated: S.num(p.updated) || S.num(p.created) || Date.now(),
  };
}

/* 按账号串行化：实现只有一处（lib/agent/lock.js）；本模块自己持有一把，
   锁的是本模块读写的那些文件（跨模块共用一把会因"锁里调另一个加锁函数"而死锁，见 lock.js）。 */
const withLock = makeLock();

/** 建目录（0700 权限，已存在则忽略）。写**文件**那条路不走这里——store.writeJson 自己会建父目录；
    这里是"项目记忆文件夹"这类纯建目录的场合（memory/、project.json 同级的那些）。 */
function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* 已存在 */ }
}

/** 写项目清单：目录与 JSON 落盘复用 store 的正本（建目录、updatedAt、原子写都在那边） */
async function writeList(account, data) {
  const file = listFile(account);
  if (!file) throw Object.assign(new Error('账号名不合法'), { status: 400 });
  const out = { version: 1, current: data.current || '', projects: data.projects };
  await store.writeJson(file, out);
  return out;
}

/* ============================ 项目记忆（Markdown 文件） ============================ */

/** frontmatter 值：简单值直写，含特殊字符的用双引号（YAML 双引号串与 JSON 兼容） */
function yamlValue(v) {
  const s = String(v == null ? '' : v);
  if (!s) return "''";
  return /^[^\s#:[\]{}&*!|>'"%@`,][^\n:#]*$/.test(s) ? s : JSON.stringify(s);
}

const fmtIso = (ts) => new Date(Number(ts) || Date.now()).toISOString();

function renderMd(entry, base) {
  const tags = (entry.tags || []).join(', ');
  const head = [
    '---',
    `name: ${yamlValue(base)}`,
    `description: ${yamlValue(entry.title)}`,
    `id: ${yamlValue(entry.id)}`,
    `source: ${entry.source === 'model' ? 'model' : 'user'}`,
    tags ? `tags: ${yamlValue(tags)}` : '',
    `updated: ${fmtIso(entry.updated)}`,
    '---',
    '',
  ].filter((l) => l !== '').join('\n');
  return head + '\n' + String(entry.content || '').replace(/\s+$/, '') + '\n';
}

/** 文件 → 条目。认自家的 frontmatter，也认 ZCode 的 `metadata:` 块（type/source 在里面） */
function parseMd(text, base, stat) {
  const { meta, body } = splitFrontmatter(text);
  const content = body.trim();
  const title = String(meta.description || meta.title || '').trim()
    || content.split(/\r?\n/).map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean)
    || base;
  const metaBlob = String(meta.metadata || '');
  const sourceRaw = String(meta.source || (/source:\s*model/i.test(metaBlob) ? 'model' : ''));
  const ts = Math.round(Number(stat && stat.mtimeMs)) || Date.now();   // mtimeMs 是小数，取整
  const updated = Date.parse(String(meta.updated || '')) || ts;
  return {
    /* 文件名（含 .md）：**MEMORY.md 的索引链接要用它**。条目从磁盘读回来时，
       文件名是唯一可靠的"这条记忆在哪个文件"，id 可能与文件名不同（frontmatter 里的 id）。 */
    file: /^[\w\u4e00-\u9fa5.-]{1,80}\.md$/i.test(String(base)) ? String(base) + '.md' : '',
    id: ENTRY_ID_RE.test(String(meta.id || '')) ? String(meta.id) : base,
    title: title.slice(0, 80),
    content: content.slice(0, MAX_MD),
    tags: String(meta.tags || '').split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean).slice(0, 8),
    ts, updated, source: sourceRaw === 'model' ? 'model' : 'user',
  };
}

/** 读一个项目的全部记忆（按文件名排序，稳定的顺序） */
function readMemory(account, id) {
  const dir = memoryDir(account, id);
  if (!dir) return [];
  let files;
  try { files = fs.readdirSync(dir).filter((f) => /\.md$/i.test(f)).sort(); } catch { return []; }
  const out = [];
  for (const f of files.slice(0, MAX_MEMORY)) {
    const full = path.join(dir, f);
    try {
      const st = fs.statSync(full);
      if (!st.isFile() || st.size > MAX_MD) continue;
      out.push(parseMd(fs.readFileSync(full, 'utf8'), f.replace(/\.md$/i, ''), st));
    } catch { /* 单个文件读不到就跳过，别让整份记忆读不出来 */ }
  }
  return out;
}

function renderIndex(project, entries) {
  const head = `# 项目记忆 · ${project.name}\n\n`
    + `项目根目录：\`${project.root}\`\n`
    + `本文件夹由「智能体 Agent」维护：每条记忆一个 Markdown 文件（memory/*.md），本文件是索引。\n\n`;
  if (!entries.length) return head + '（还没有项目记忆）\n';
  return head + entries.map((e) => {
    const hook = e.content.replace(/\s+/g, ' ').slice(0, 90);
    /* 落点是**文件名**：条目来自磁盘时带着 file；来自内存（新建）时按 id 兜底。
       旧实现只用 e.file，而 readMemory 产出的条目没有这个字段 —— 复用已有记忆文件夹
       （重选同一个根目录 / 从存档恢复）时索引会被写成 `memory/undefined`（2026-10-01 实测）。 */
    const file = e.file || `${e.id}.md`;
    return `- [${e.title}](memory/${file}) — ${hook}${e.content.length > 90 ? '…' : ''}`;
  }).join('\n') + '\n';
}

/** 条目 → 文件名（去掉路径花样；重复的加 -2、-3） */
function fileBaseFor(entry, used) {
  let base = slugify(entry.title || entry.id, 'm-' + Math.random().toString(36).slice(2, 8));
  if (!base || !NAME_RE.test(base)) base = 'm-' + Date.now().toString(36);
  let name = base, n = 1;
  while (used.has(name)) name = base + '-' + (++n);
  used.add(name);
  return name;
}

/** 全量重写某个项目的记忆：写新文件、删掉不再存在的、重建 MEMORY.md。
 *  **整段在账号锁内**（借助下面的 locked 版本）：与"托管运行里模型写记忆"并发时，
 *  两边各按旧快照整份覆盖，谁后写谁把对方的改动删掉（2026-10-01 审计）。
 *  注意：调用方若已经持有本模块的锁（create/restore），必须用 writeMemoryLocked，
 *  否则自我等待死锁（见 lib/lock.js 的头注）。
 *  @param {{baseCount?: number}} [opts] baseCount = 客户端"取回这份条目时服务端有几条"，
 *         用于空列表覆盖保护（见 writeMemoryLocked 里的说明）。 */
function writeMemory(account, id, entries, opts) {
  return withLock(account, () => writeMemoryLocked(account, id, entries, opts));
}

async function writeMemoryLocked(account, id, entries, opts = {}) {
  const dir = projectDir(account, id);
  const mdir = memoryDir(account, id);
  if (!dir || !mdir) throw Object.assign(new Error('项目 id 不合法'), { status: 400 });
  const project = readList(account).projects.find((p) => p.id === id);
  if (!project) throw Object.assign(new Error('没有这个项目'), { status: 404 });

  const clean = [];
  for (const e of Array.isArray(entries) ? entries.slice(0, MAX_MEMORY) : []) {
    if (!e || typeof e !== 'object') continue;
    const title = String(e.title || '').trim().slice(0, 80);
    const content = String(e.content || '').slice(0, MAX_MD);
    if (!title && !content) continue;
    clean.push({
      id: ENTRY_ID_RE.test(String(e.id || '')) ? String(e.id) : 'm-' + Date.now().toString(36),
      title: title || content.slice(0, 24),
      content,
      tags: (Array.isArray(e.tags) ? e.tags : []).slice(0, 8).map((t) => String(t).slice(0, 24)).filter(Boolean),
      ts: S.num(e.ts) || Date.now(),
      updated: S.num(e.updated) || Date.now(),
      source: e.source === 'model' ? 'model' : 'user',
    });
  }

  /* **空列表覆盖保护**（2026-10-03 抖音热点项目被清空事故的防线）：
     整份覆盖的语义是"删掉不在本次集合里的 .md"，所以一份**空的**列表 = 把这个项目的记忆全删。
     合法场景（用户/模型删掉最后一条）带得上基准：baseCount = 取回时的条数 = 服务端现有条数。
     对不上（尤其 baseCount 缺省 = 老客户端/手里根本没取回来过）一律拒绝，把现状回给客户端，
     客户端据此重新取回（自愈）——宁可拒绝一次清空，也不能静默删掉别人写的记忆。 */
  if (!clean.length) {
    const cur = readMemory(account, id);
    const base = Number(opts && opts.baseCount);
    if (cur.length && !(Number.isFinite(base) && base === cur.length)) {
      throw Object.assign(new Error(
        `项目记忆在别处已经变了：服务端现有 ${cur.length} 条，这次要写回 0 条`
        + `（基准 ${Number.isFinite(base) ? base : '未提供'}）——已拒绝这次清空，请重新读取后再改`), {
        status: 409, conflict: true, entries: cur,
      });
    }
  }

  await fsp.mkdir(mdir, { recursive: true, mode: 0o700 });
  const used = new Set();
  const final = [];
  const keep = new Set();
  for (const e of clean) {
    const base = fileBaseFor(e, used);
    const file = base + '.md';
    keep.add(file);
    await fsp.writeFile(path.join(mdir, file), renderMd(e, base), 'utf8');
    final.push(Object.assign({}, e, { file }));
  }
  for (const f of await fsp.readdir(mdir).catch(() => [])) {
    if (!/\.md$/i.test(f) || keep.has(f)) continue;
    /* readMemory 会**跳过**超过 MAX_MD 的 .md（读不动就整条不返回），于是它们必然不在 keep 里：
       旧实现每次都把它们当"不再存在的记忆"删掉 —— 一条静默的数据丢失（2026-10-01 审计）。
       这类文件不归本次重写管，原样留着。 */
    const st = await fsp.stat(path.join(mdir, f)).catch(() => null);
    if (st && st.size > MAX_MD) continue;
    await fsp.rm(path.join(mdir, f), { force: true }).catch(() => {});
  }
  await fsp.writeFile(path.join(dir, 'MEMORY.md'), renderIndex(project, final), 'utf8');
  return final.map((e) => Object.assign({}, e, { file: undefined }));
}

/* ============================ 项目动作 ============================ */

/** 校验并规范化项目根目录：必须是**起点内**真实存在的目录。
 *  起点（roots.startFor）默认 /media/leo/DATA/workspace —— 项目都放在那儿；
 *  注意这与"可访问目录"是两件事：起点只约束项目位置，不限制 agent 能读写哪些目录。 */
function resolveRoot(actor, input) {
  const raw = String(input || '').trim();
  if (!raw) throw Object.assign(new Error('请选择项目根目录'), { status: 400 });
  const { real } = roots.resolveInRoots(actor, raw);      // 绝对路径 / ~ 展开 / realpath 复核
  let st;
  try { st = fs.statSync(real); } catch { throw Object.assign(new Error('目录不存在：' + real), { status: 404 }); }
  if (!st.isDirectory()) throw Object.assign(new Error('不是目录：' + real), { status: 400 });
  const start = roots.startFor(actor);
  if (!roots.insideStart(actor, real)) {
    throw Object.assign(new Error(`项目根目录必须在起点内：${real}\n当前起点：${start}`
      + `\n（要换起点请在设置抽屉 → 项目 → 起点 里改）`), { status: 403, needStart: true });
  }
  return real;
}

const view = (account, p, current) => {
  const dir = projectDir(account, p.id);
  const mdir = memoryDir(account, p.id);
  let count = 0;
  try { count = fs.readdirSync(mdir).filter((f) => /\.md$/i.test(f)).length; } catch { /* 还没建 */ }
  return Object.assign({}, p, { dir, memoryDir: mdir, memoryCount: count, current: !!current });
};

/** 列表（含当前项目指针与各自记忆条数） */
function list(account) {
  const d = readList(account);
  return {
    current: d.current,
    projects: d.projects.map((p) => view(account, p, p.id === d.current)),
  };
}

const find = (account, id) => readList(account).projects.find((p) => p.id === String(id || '')) || null;

/** 建项目：落 projects.json + 建项目记忆文件夹（已存在同根目录的项目时直接复用） */
async function create(account, { root, name } = {}) {
  const abs = path.resolve(String(root || ''));
  const id = idFor(abs);
  return withLock(account, async () => {
    const d = readList(account);
    let p = d.projects.find((x) => x.id === id || x.root === abs);
    if (!p) {
      if (d.projects.length >= MAX_PROJECTS) {
        throw Object.assign(new Error(`项目数已达上限（${MAX_PROJECTS}），先删掉不用的`), { status: 400 });
      }
      p = { id, root: abs, name: String(name || '').trim().slice(0, 80) || path.basename(abs) || id, created: Date.now(), updated: Date.now() };
      d.projects.push(p);
    } else if (String(name || '').trim()) {
      p.name = String(name).trim().slice(0, 80);
    }
    p.updated = Date.now();
    d.current = p.id;
    await writeList(account, d);
    const dir = projectDir(account, p.id);
    await fsp.mkdir(memoryDir(account, p.id), { recursive: true, mode: 0o700 });
    ensureDir(dir);
    await atomicWriteJson(path.join(dir, 'project.json'), Object.assign({}, p, { version: 1 }), 2);
    /* 种子记忆：**项目根目录的位置本身就是第一条项目记忆**（模型据此知道"这个项目在哪"，
       用户也能一眼看到这份记忆记的是哪个目录）。只在首次建立时写，之后随用户改。 */
    const seeded = readMemory(account, p.id);
    if (!seeded.length) {
      await writeMemoryLocked(account, p.id, [{
        id: '项目根目录', title: '项目根目录', content: `项目根 = ${p.root}`,
        tags: [], ts: Date.now(), updated: Date.now(), source: 'user',
      }]);
    } else {
      await fsp.writeFile(path.join(dir, 'MEMORY.md'), renderIndex(p, seeded), 'utf8');
    }
    auditLog(`agent-project-create account=${account} id=${p.id} root=${p.root}`);
    return view(account, p, true);
  });
}

/** 改名（只动显示名，根目录与 id 不变） */
async function rename(account, id, name) {
  const nm = String(name || '').trim().slice(0, 80);
  if (!nm) throw Object.assign(new Error('名字不能为空'), { status: 400 });
  return withLock(account, async () => {
    const d = readList(account);
    const p = d.projects.find((x) => x.id === String(id || ''));
    if (!p) throw Object.assign(new Error('没有这个项目'), { status: 404 });
    p.name = nm; p.updated = Date.now();
    await writeList(account, d);
    return view(account, p, d.current === p.id);
  });
}

/** 设当前项目（'' = 不归属任何项目） */
async function setCurrent(account, id) {
  return withLock(account, async () => {
    const d = readList(account);
    const want = String(id || '');
    if (want && !d.projects.some((p) => p.id === want)) throw Object.assign(new Error('没有这个项目'), { status: 404 });
    d.current = want;
    await writeList(account, d);
    return { current: d.current };
  });
}

/** 从清单里摘掉（**不动记忆文件夹**）：归档用。真正连文件夹一起删是 remove() 的事。 */
async function take(account, id) {
  return withLock(account, async () => {
    const d = readList(account);
    const p = d.projects.find((x) => x.id === String(id || ''));
    if (!p) throw Object.assign(new Error('没有这个项目'), { status: 404 });
    d.projects = d.projects.filter((x) => x.id !== p.id);
    if (d.current === p.id) d.current = d.projects[0] ? d.projects[0].id : '';
    await writeList(account, d);
    return { project: p, current: d.current };
  });
}

/** 删项目：连项目记忆文件夹一起删（会话不受影响，只是不再归属项目） */
async function remove(account, id) {
  return withLock(account, async () => {
    const d = readList(account);
    const p = d.projects.find((x) => x.id === String(id || ''));
    if (!p) throw Object.assign(new Error('没有这个项目'), { status: 404 });
    d.projects = d.projects.filter((x) => x.id !== p.id);
    if (d.current === p.id) d.current = d.projects[0] ? d.projects[0].id : '';
    await writeList(account, d);
    const dir = projectDir(account, p.id);
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    auditLog(`agent-project-delete account=${account} id=${p.id} root=${p.root}`);
    return { current: d.current, projects: d.projects.length };
  });
}

/* ============================ 目录浏览（选择项目根目录用） ============================ */

/** 列一层子目录：给"选项目根目录"的选择器用。
 *  path 为空 = 从**起点**开始；一路只能在起点内往下走（到起点时 parent 为 null，不能再往上）。
 *  **要求已绑定**：这个动作是以**站点进程**的身份 readdir（不像文件工具那样过 osaccess 的权限判定），
 *  未绑定时等于让任何登录用户按名字枚举整块文件系统（审计 S8 实测：未绑定也能列出目录内容）。 */
async function browse(actor, input) {
  if (!actor.bound) {
    throw Object.assign(new Error('还没有绑定本机账号：目录浏览要以绑定账号的权限执行。'
      + '请在设置抽屉 → 本机账号 里绑定一个本机账号。'), { status: 403, needBind: true });
  }
  const start = roots.startFor(actor);
  const raw = String(input || '').trim();
  const real = raw ? roots.resolveInRoots(actor, raw).real : roots.resolveReal(start);
  if (!roots.insideStart(actor, real)) {
    throw Object.assign(new Error(`不能离开起点：${real}\n当前起点：${start}`), { status: 403, needStart: true });
  }
  const dirents = await fsp.readdir(real, { withFileTypes: true }).catch((e) => {
    throw Object.assign(new Error(`读目录失败：${real}${e.code === 'EACCES' ? '（权限不足）' : ''}`), { status: e.code === 'ENOENT' ? 404 : 403 });
  });
  const entries = [];
  for (const e of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.')) continue;                      // 隐藏目录不进选择器（.git/node_modules 之类）
    if (e.name === 'node_modules') continue;
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const p = path.join(real, e.name);
    const isDir = await fsp.stat(p).then((s) => s.isDirectory()).catch(() => false);
    if (isDir) entries.push({ name: e.name, path: p });
  }
  const atStart = real === roots.resolveReal(start);
  return { path: real, parent: atStart ? null : path.dirname(real), start, entries, atStart };
}

/** 在起点内建一个空目录（选择器的「新建文件夹」用）。
 *  与 browse 同一道闸：要求已绑定（以**站点进程**身份建目录，未绑定等于任何登录用户
 *  都能在文件系统里建目录，审计 S8 同款问题）、可访问目录白名单内、起点内。
 *  name 只取一段 basename：禁路径分隔符与点开头（browse 会隐藏 . 开头的目录，
 *  建了在选择器里就是隐形的）。已存在 → 409（交给人改名字，不静默复用同名目录）。 */
async function mkdir(actor, input) {
  if (!actor.bound) {
    throw Object.assign(new Error('还没有绑定本机账号：新建目录要以绑定账号的身份执行。'
      + '请在设置抽屉 → 本机账号 里绑定一个本机账号。'), { status: 403, needBind: true });
  }
  const name = String((input && input.name) || '').trim();
  if (!name) throw Object.assign(new Error('请填写目录名'), { status: 400 });
  if (/[/\\\0]/.test(name) || name.startsWith('.')) {
    throw Object.assign(new Error('目录名不能含路径分隔符、不能以点开头'), { status: 400 });
  }
  const parentRaw = String((input && input.parent) || '').trim();
  const parent = parentRaw
    ? roots.resolveInRoots(actor, parentRaw).real
    : roots.resolveReal(roots.startFor(actor));                 // 空 = 在起点根下建
  if (!roots.insideStart(actor, parent)) {
    throw Object.assign(new Error(`不能离开起点：${parent}\n当前起点：${roots.startFor(actor)}`),
      { status: 403, needStart: true });
  }
  const target = path.join(parent, name);
  if (!roots.insideStart(actor, target)) {
    throw Object.assign(new Error('目录名不合法'), { status: 400 });
  }
  await fsp.mkdir(target).catch((e) => {
    if (e.code === 'EEXIST') throw Object.assign(new Error('这里已有同名目录：' + target), { status: 409 });
    if (e.code === 'ENOENT') throw Object.assign(new Error('上级目录不存在：' + parent), { status: 404 });
    if (e.code === 'EACCES') throw Object.assign(new Error(`权限不足：${parent}`), { status: 403 });
    throw Object.assign(new Error(`建目录失败：${e.message}`), { status: 500 });
  });
  auditLog(`agent-project-mkdir actor=${actor.account || '?'} path=${target}`);
  return { path: target };
}

module.exports = {
  accountDir, projectDir, memoryDir, idFor, slugify,
  readList, list, find, create, rename, setCurrent, take, remove,
  readMemory, writeMemory, resolveRoot, browse, mkdir,
  MAX_PROJECTS, MAX_MEMORY,
};
