#!/usr/bin/env node
/** scripts/gen-inventory.mjs —— 生成《函数与数据清单》（docs/INVENTORY.md）的**函数部分**
 *
 *  用法：cd agent && node scripts/gen-inventory.mjs   （输出到 stdout，由文档引用或重定向）
 *
 *  提取口径（故意保守，宁缺勿滥）：
 *    · `function name(` / `export async function name(` —— 顶层与闭包内声明；
 *    · `const name = (...) =>` / `= async (...) =>` / `= () =>` / `= function` —— 箭头/函数表达式赋值；
 *    · 不抓对象字面量方法、类方法、内联回调（`forEach((x) => …)` 这类）——
 *      那些跟着宿主函数走，单列反而把清单打散。
 *  "作用"取函数定义前**最近的注释块**的最后一行（本项目注释密度高，大多能取到一句话）。
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOTS = ['src', '../lib/agent'];
const HERE = new URL('.', import.meta.url).pathname;   // agent/scripts/
const BASE = new URL('..', import.meta.url).pathname;  // agent/

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (/\.(js|jsx|mjs)$/.test(e) && !e.endsWith('.test.mjs')) out.push(p);
  }
  return out;
}

const FUNC_RE = /^(?:export )?(?:default )?(?:async )?function \w+\s*[(<]|^export const \w+ = (?:async )?(?:\([^)]*\)|\w+) =>|^const \w+ = (?:async )?\(|^export const \w+ = function|^  function \w+\s*[(]|^    function \w+\s*[(]/;
const NAME_RE = /(?:function |const )(async )?(\w+)/;

const files = ROOTS.flatMap((r) => walk(join(BASE, r))).sort();
const modules = new Map();   // 相对路径 → [{name, line, exported, doc}]
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const rel = relative(BASE, file);
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!FUNC_RE.test(line)) continue;
    const m = line.match(NAME_RE);
    if (!m) continue;
    const name = m[2];
    if (['if', 'for', 'while', 'switch', 'catch', 'return'].includes(name)) continue;
    // 向上找最近的注释块（连续的 //、*、/* 行），取它的最后一行非空文本当"作用"
    let doc = '';
    for (let k = i - 1; k >= 0 && k >= i - 30; k--) {
      const t = lines[k].trim();
      if (!t) { if (doc) break; continue; }
      if (/^(\/\/|\*|\/\*)/.test(t)) {
        const text = t.replace(/^[/*]+\s?/, '').replace(/\*\/$/, '').trim();
        if (text) doc = text;          // 不断覆盖 → 循环结束时是注释块的**最后一行**
        continue;
      }
      break;                            // 撞到代码：注释块结束
    }
    doc = doc.replace(/=+/g, '').replace(/^[-—·\d]+[.、)］]*\s*/, '').trim().slice(0, 120);
    items.push({ name, line: i + 1, exported: /^(export|  return )/.test(line) || /export/.test(line), doc });
  }
  if (items.length) modules.set(rel, items);
}

/** 文件路径 → 清单里的分组（顺序即输出顺序） */
const GROUPS = [
  ['src/core/', '### 共享 core（agent/src/core，零框架、两端同一份）'],
  ['src/ui/state/', '### UI 状态层（agent/src/ui/state，React 之外的"动作层"）'],
  ['src/ui/lib/', '### UI 纯函数库（agent/src/ui/lib）'],
  ['src/ui/features/', '### UI 组件（agent/src/ui/features）'],
  ['src/ui/components/', '### UI 基础件（agent/src/ui/components，shadcn 风）'],
  ['src/ui/', '### UI 顶层（agent/src/ui：App 入口等）'],
  ['lib/agent/run', '### 服务端 · 托管运行 run* 家族（lib/agent）'],
  ['lib/agent/tools/', '### 服务端 · 工具实现（lib/agent/tools）'],
  ['lib/agent/', '### 服务端 · 其余（lib/agent）'],
];
const groupOf = (rel) => GROUPS.find(([pre]) => rel.startsWith(pre) || rel.slice(3).startsWith(pre.replace('../', '')));
const grouped = new Map();
for (const [rel, items] of modules) {
  const g = groupOf(rel) || GROUPS[GROUPS.length - 1];
  if (!grouped.has(g[1])) grouped.set(g[1], []);
  grouped.get(g[1]).push([rel, items]);
}

let out = '';
for (const [title, files2] of grouped) {
  const n = files2.reduce((a, [, items]) => a + items.length, 0);
  out += `\n${title}——${files2.length} 个文件 / ${n} 个函数\n`;
  for (const [rel, items] of files2) {
    out += `\n#### \`${rel.replace('../', '')}\`（${items.length} 个）\n\n`;
    out += '| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |\n|---|---|---|---|\n';
    for (const it of items) {
      out += `| \`${it.name}\` | ${rel.replace('../', '')}:${it.line} | ${it.exported ? '✓' : ''} | ${it.doc.replace(/\|/g, '∣')} |\n`;
    }
  }
}

/** 回写 docs/INVENTORY.md 的标记区（没有标记就只打印到 stdout） */
const DOC = join(BASE, 'docs/INVENTORY.md');
const START = '<!-- GEN:FUNCTIONS START（本区由 scripts/gen-inventory.mjs 生成，勿手改） -->';
const END = '<!-- GEN:FUNCTIONS END -->';
try {
  const doc = readFileSync(DOC, 'utf8');
  const i = doc.indexOf(START), j = doc.indexOf(END);
  if (i >= 0 && j > i) {
    writeFileSync(DOC, doc.slice(0, i + START.length) + '\n' + out + doc.slice(j));
    console.error(`已回写 ${DOC}（${modules.size} 个文件、${[...modules.values()].reduce((n, v) => n + v.length, 0)} 个函数）`);
    process.exit(0);
  }
} catch { /* 文档不存在：只打印 */ }
process.stdout.write(out);
console.error(`共 ${modules.size} 个文件、${[...modules.values()].reduce((n, v) => n + v.length, 0)} 个函数（未找到标记区，输出到 stdout）`);
