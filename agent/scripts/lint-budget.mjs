#!/usr/bin/env node
/**
 * scripts/lint-budget.mjs —— eslint warning 的**棘轮**（只减不增）
 *
 *  为什么需要它：这个工程长期挂着 80 条 warning 而 `npm run lint` 依然"通过"。
 *  警告没人看就等于没有 lint —— 真出问题时也淹没在噪声里（审计 2026-09-30：
 *  81 条里 57 条是 complexity，其中 29 条只是 11~14，属于阈值偏严而非代码真有问题）。
 *
 *  棘轮的做法：把当前水位记在 eslint-budget.json 里。
 *    · 新增 warning → 退出码 1（挡住"顺手又加一条"）；
 *    · 减少 → 自动下调预算并提示把它提交（债只会越还越少）；
 *    · error 一律直接失败（error 是硬约束，不参与预算）。
 *
 *  为什么不是"一次全修完"：57 条 complexity 分布在协议解析、Agent 循环、状态编排这些
 *  **高风险**位置，其中 29 条只超阈值 1~4。为它们做大规模拆分，改错一个分支的代价
 *  远高于收益（这个子项目的历史正好证明了这点：一次"重写"漏掉一行 import 就整页白屏）。
 *  正确的顺序是：先让它**不再增长**，再按业务需要逐个还。
 *
 *  跑法：node scripts/lint-budget.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const BUDGET_FILE = path.join(root, 'eslint-budget.json');

let report;
try {
  // eslint 有 warning 时退出码非 0，用 --format json 拿结构化结果（不靠退出码）
  const out = execFileSync('npx', ['eslint', 'src', 'test', 'build.mjs', '--format', 'json'], {
    cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  report = JSON.parse(out);
} catch (e) {
  // 有 error 时 execFileSync 抛错，但 stdout 里仍是完整 JSON
  if (!e.stdout) { console.error('eslint 跑不起来：', e.message); process.exit(1); }
  report = JSON.parse(e.stdout);
}

const counts = { error: 0, warning: 0 };
const byRule = {};
for (const f of report) {
  for (const m of f.messages) {
    if (m.severity === 2) counts.error++;
    else { counts.warning++; byRule[m.ruleId] = (byRule[m.ruleId] || 0) + 1; }
  }
}

if (counts.error > 0) {
  console.error(`\n✗ eslint 有 ${counts.error} 个 error —— error 不参与预算，必须修掉\n`);
  process.exit(1);
}

const prev = fs.existsSync(BUDGET_FILE)
  ? JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'))
  : { maxWarnings: counts.warning };

if (counts.warning > prev.maxWarnings) {
  console.error(`\n✗ eslint warning 从 ${prev.maxWarnings} 涨到 ${counts.warning}（新增 ${counts.warning - prev.maxWarnings} 条）`);
  console.error('  这个工程把 warning 当作"只减不增的债"：新代码不许再添。');
  console.error('  要么修掉，要么在 eslint-budget.json 里显式提高上限并说明理由。');
  console.error('  当前分布：' + Object.entries(byRule).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join('、') + '\n');
  process.exit(1);
}

if (counts.warning < prev.maxWarnings) {
  fs.writeFileSync(BUDGET_FILE, JSON.stringify({ maxWarnings: counts.warning, note: 'eslint warning 的上限；只减不增（见 scripts/lint-budget.mjs）' }, null, 2) + '\n');
  console.log(`\n✓ eslint warning ${counts.warning} 条（比上次少 ${prev.maxWarnings - counts.warning}）—— 预算已自动下调，请把 eslint-budget.json 一起提交\n`);
} else {
  console.log(`\n✓ eslint warning ${counts.warning} 条（预算内，未增长）\n`);
}
