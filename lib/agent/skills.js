/** lib/agent/skills.js —— 从 Markdown「安装」技能（吃 SKILL.md 那套热门结构）
 *
 *  为什么要有它：技能原先只能由模型用 skill_write 一条条手写、或用户在界面里敲。
 *  而主流 agent（Claude Code / agentskills.io 那一系）的技能都是磁盘上的 Markdown：
 *
 *      <技能目录>/<技能名>/SKILL.md
 *      ---
 *      name: rvc-voice-conversion
 *      description: RVC 变声环境、音色模型与使用。触发词：RVC、变声。
 *      ---
 *      # RVC 变声
 *      （正文……）
 *
 *  本模块把这种文件读进来 → 拆出 frontmatter（name/description，可选 auto）与正文 →
 *  写进**该账号的**提示词登记表（STATE_DIR/agent/<账号>/prompts.json 的 skills[]）。
 *  于是"安装技能"= 把目录指过来即可，模型也能用 skill_import 工具自己装。
 *
 *  三处必须守住的口径：
 *    · **路径要走 fs 工具那套闸门**（roots 白名单 + 绑定账号权限）：借 fsTools.guard，
 *      不许因为"是技能目录"就绕过可访问目录的限制；
 *    · **frontmatter 用 YAML 的一个子集**（单行键值、引号、| 与 > 块、缩进续行）——SKILL.md
 *      里真实出现过的就这几种；解析不了的一律当正文，绝不吞内容；
 *    · **不覆盖同名的内置技能**（联网搜索那种是源码里的条目，不是本账号的 skills[]）。
 */
const path = require('path');
const fsp = require('fs/promises');
const fsTools = require('./tools/fs');
const store = require('./store');

const MAX_FILES = 20;              // 一次最多装几个技能（目录扫一层，防手滑指到根目录）
const MAX_BYTES = 512 * 1024;      // 单个 MD 的上限（技能正文本来就是给人看的）
const NAME_MAX = 60;
const DESC_MAX = 300;

/* ============================ frontmatter 解析 ============================ */

const unquote = (v) => {
  const s = String(v).trim();
  if (s.length > 1 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
};

/** YAML 子集：`key: value` / `key: "value"` / `key: |` 块 / `key: >` 折叠块 / 缩进续行 */
function parseYamlSubset(lines) {
  const meta = {};
  let key = null, mode = null, buf = [];
  const flush = () => {
    if (key) meta[key] = mode === '|' ? buf.join('\n') : buf.join(' ').trim();
    key = null; mode = null; buf = [];
  };
  for (const raw of lines) {
    const line = String(raw).replace(/\s+$/, '');
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const m = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (m) {
      flush();
      const k = m[1].toLowerCase();
      const v = m[2].trim();
      if (v === '|' || v === '|-') { key = k; mode = '|'; }
      else if (v === '>' || v === '>-') { key = k; mode = '>'; }
      else if (v) meta[k] = unquote(v);
      else { key = k; mode = 'plain'; }               // 值在后续缩进行里
      continue;
    }
    if (key) buf.push(mode === '|' ? line.replace(/^\s{2}/, '') : line.trim());
  }
  flush();
  return meta;
}

/** 拆 frontmatter 与正文。**没有收尾的 `---` 就当没有 frontmatter**（宁可不解析，也不吞正文） */
function splitFrontmatter(text) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  if (!/^---[ \t]*\r?\n/.test(src)) return { meta: {}, body: src };
  const lines = src.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^---[ \t]*$/.test(lines[i])) { end = i; break; }
  }
  if (end < 0) return { meta: {}, body: src };
  return { meta: parseYamlSubset(lines.slice(1, end)), body: lines.slice(end + 1).join('\n') };
}

/** 一段 Markdown → 一条技能记录。description 缺省时取正文第一句（非标题、非代码围栏） */
function parseSkillMd(text, fallbackName) {
  const { meta, body } = splitFrontmatter(text);
  const name = String(meta.name || fallbackName || '').trim().slice(0, NAME_MAX);
  let description = String(meta.description || '').trim();
  if (!description) {
    const first = body.split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#') && !l.startsWith('```') && !l.startsWith('---') && !l.startsWith('>'));
    description = first || '';
  }
  const autoRaw = meta.auto === undefined ? '' : String(meta.auto).trim();
  return {
    name,
    description: description.slice(0, DESC_MAX),
    text: body.trim(),
    // frontmatter 里写了 auto 就听它的（false/no/off/0 = 常驻注入），没写则交给调用方的默认
    auto: autoRaw ? !/^(false|no|off|0)$/i.test(autoRaw) : undefined,
    extraKeys: Object.keys(meta).filter((k) => !['name', 'description', 'auto'].includes(k)),
  };
}

/* ============================ 扫描与导入 ============================ */

/** 收出待导入的 Markdown：
 *  · path 是 .md 文件 → 就它一个；
 *  · path 是目录 → 扫一层：`<dir>/<技能名>/SKILL.md`（主流布局）与 `<dir>/*.md`。 */
async function collectMarkdown(actor, target) {
  const real = await fsTools.guard(actor, target, 'read');
  const st = await fsp.stat(real).catch(() => null);
  if (!st) throw Object.assign(new Error('不存在：' + real), { status: 404 });

  if (st.isFile()) return [{ file: real, name: path.basename(real).replace(/\.md$/i, '') }];

  const out = [];
  const entries = await fsp.readdir(real, { withFileTypes: true });
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= MAX_FILES) break;
    if (e.name.startsWith('.')) continue;
    if (e.isFile() && /\.md$/i.test(e.name)) {
      out.push({ file: path.join(real, e.name), name: e.name.replace(/\.md$/i, '') });
      continue;
    }
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    let dir = path.join(real, e.name);
    /* 软链接的技能目录要跟着走（实测：~/.zcode/skills/anysearch 就是一个指向
       ~/.agents/skills/anysearch 的软链接，不跟的话整份技能被静默跳过）。
       跟之前先过一遍 fs 闸门：目标必须仍在可访问目录内、且绑定账号有权限。 */
    if (e.isSymbolicLink()) {
      const isDir = await fsp.stat(dir).then((s) => s.isDirectory()).catch(() => false);
      if (!isDir) continue;
      dir = await fsTools.guard(actor, dir, 'read').catch(() => '');
      if (!dir) continue;
    }
    // 主流布局：每个技能一个目录，里面是 SKILL.md（大小写都认）
    for (const cand of ['SKILL.md', 'skill.md', 'Skill.md']) {
      const f = path.join(dir, cand);
      const ok = await fsp.stat(f).then((s) => s.isFile()).catch(() => false);
      if (ok) { out.push({ file: f, name: e.name }); break; }
    }
  }
  return out;
}

/** 读 + 解析（不做任何写入）——dryRun 预览与正式导入共用这一份结果 */
async function planImport(actor, { path: target, auto } = {}) {
  if (!String(target || '').trim()) {
    throw Object.assign(new Error('要给出技能文件或目录的路径（.md 文件，或装着 SKILL.md 的目录）'), { status: 400 });
  }
  const files = await collectMarkdown(actor, target);
  if (!files.length) {
    throw Object.assign(new Error('这个目录里没有找到技能 Markdown（认 `<目录>/<技能名>/SKILL.md` 与 `<目录>/*.md`）'), { status: 404 });
  }
  const items = [];
  const errors = [];
  for (const f of files) {
    const st = await fsp.stat(f.file).catch(() => null);
    if (!st || !st.isFile()) { errors.push(`${f.file}：读不到`); continue; }
    if (st.size > MAX_BYTES) { errors.push(`${f.file}：超过 ${Math.round(MAX_BYTES / 1024)}KB，没读`); continue; }
    const raw = await fsp.readFile(f.file, 'utf8').catch(() => '');
    const parsed = parseSkillMd(raw, f.name);
    if (!parsed.name) { errors.push(`${f.file}：拿不到技能名`); continue; }
    if (!parsed.text) { errors.push(`${f.file}：正文是空的`); continue; }
    items.push(Object.assign(parsed, { file: f.file, auto: parsed.auto === undefined ? auto !== false : parsed.auto }));
  }
  return { path: path.resolve(String(target)), items, errors };
}

/** 把 plan 的结果写进该账号的提示词登记表。同名技能 = 改写（与 skill_write 同口径）。
 *  读-改-写**在 store 的账号锁内**完成（store.updatePrompts）：旧写法分两步、中间没有锁，
 *  与"托管运行里模型写技能"并发时两边各按旧快照整份覆盖，后写的把先写的抹掉（2026-10-01 审计）。 */
async function applyImport(account, items) {
  const done = [];
  await store.updatePrompts(account, (reg) => {
    const skills = Array.isArray(reg.skills) ? reg.skills.slice() : [];
    const byName = new Map(skills.map((s) => [String(s.name || '').toLowerCase(), s]));
    for (const it of items) {
      const hit = byName.get(it.name.toLowerCase());
      if (hit) {
        hit.name = it.name;
        hit.description = it.description;
        hit.text = it.text;
        hit.auto = it.auto !== false;
        hit.enabled = true;
        done.push({ name: it.name, action: '改写' });
      } else {
        const rec = {
          id: 'sk-' + Math.random().toString(36).slice(2, 8),
          name: it.name, description: it.description, text: it.text,
          enabled: true, auto: it.auto !== false,
        };
        skills.push(rec);
        byName.set(rec.name.toLowerCase(), rec);
        done.push({ name: it.name, action: '新建' });
      }
    }
    return Object.assign({}, reg, { skills });
  });
  return done;
}

module.exports = { parseSkillMd, splitFrontmatter, parseYamlSubset, collectMarkdown, planImport, applyImport, MAX_FILES, MAX_BYTES };
