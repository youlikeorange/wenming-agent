#!/usr/bin/env node
/** tools/deps-check.mjs —— 「下载即可运行」的守卫：仓库里缺文件就别发布
 *
 *  为什么要有（2026-10-03 真实事故）：站点新增了宿主公共件 `lib/paths.js` 与 `lib/ids.js`，
 *  但 `tools/paths.conf` 的 `@sync-only` 清单没跟着加。同步看起来一切正常（git 也提交推送了），
 *  下载者却 `Cannot find module './paths'` —— 仓库里那一版**起不来**。
 *  静态检查抓不到这类问题，跑一遍才知道；所以同步/回滚后各跑一次。
 *
 *  做法：从入口 `standalone.js` 出发，顺着相对路径的 require / import 递归，
 *  报告解析不到的文件（只查相对依赖；npm 包靠 `npm install`，不在这里管）。
 *
 *  用法：node tools/deps-check.mjs    退出码 0 = 闭包完整；1 = 缺文件（已列出）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* 入口：独立运行入口，以及界面/测试真正会加载的相对依赖起点。
   agent/src 里带 JSX 的模块由构建工具处理，这里只检查相对路径存在性，不解析 JSX 语义。 */
const ENTRIES = ['standalone.js', 'lib/agent/index.js', 'agent/src/core/agent.js', 'agent/src/ui/main.jsx'];

const RESOLVE_EXT = ['', '.js', '.mjs', '.cjs', '.jsx', '.json', '/index.js', '/index.mjs'];

/** 相对说明符 → 仓库里的真实文件；找不到返回 null。**
 *  只当「同名前缀的候选一个都不存在」时才返回 null——存在但扩展名不匹配也算找到。 */
function resolveRel(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const ext of RESOLVE_EXT) {
    const p = base + ext;
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return null;
}

/** 抓出一份源码里所有相对依赖（require / import / export … from / 动态 import）。 */
function specsOf(src) {
  const out = new Set();
  const patterns = [
    /require\(\s*['"](\.[^'"]+)['"]\s*\)/g,
    /\bfrom\s+['"](\.[^'"]+)['"]/g,
    /\bimport\(\s*['"](\.[^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src))) out.add(m[1]);
  }
  return [...out];
}

const seen = new Set();
const missing = [];
const unresolved = [];

function walk(file) {
  if (seen.has(file)) return;
  seen.add(file);
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const spec of specsOf(src)) {
    const target = resolveRel(file, spec);
    if (!target) {
      /* 构建期才存在的路径（如 CSS、资源、打包别名）不算缺文件：只报「像源码却没落地」的。
         判据：说明符以 ./ 或 ../ 开头且不是纯资源后缀。 */
      if (!/\.(css|svg|png|jpg|jpeg|gif|webp|woff2?|ttf)$/i.test(spec)) {
        unresolved.push(`${spec}  ← ${path.relative(ROOT, file)}`);
      }
      continue;
    }
    walk(target);
  }
}

for (const e of ENTRIES) {
  const p = path.join(ROOT, e);
  if (!fs.existsSync(p)) missing.push(`${e}（入口不存在）`);
  else walk(p);
}

/* 站点里存在、但仓库里被 @never 排除的审计文档不算缺失（它们本就不该在仓库里）。 */
const neverRe = /(^|\/)(AUDIT[^/]*\.md|BUGFIX[^/]*\.md)$/;

if (missing.length) {
  console.error('❌ 入口缺失：\n  ' + missing.join('\n  '));
}
if (unresolved.length) {
  console.error('❌ 以下相对依赖在仓库里找不到（同步清单 tools/paths.conf 可能漏了新文件）：');
  for (const u of unresolved.filter((u) => !neverRe.test(u))) console.error('  ' + u);
}
if (missing.length || unresolved.filter((u) => !neverRe.test(u)).length) {
  console.error(`\n检查了 ${seen.size} 个文件。修法：把缺的文件加进 tools/paths.conf 的 @sync-only 或子项目目录，再跑一次 tools/sync.sh。`);
  process.exit(1);
}
console.log(`✅ 入口依赖闭包完整（检查了 ${seen.size} 个文件）`);
