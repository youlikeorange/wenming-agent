/* ui/lib/diff.js —— 行级差异（「比对修改」抽屉的渲染依据；纯函数、零依赖、可 Node 单测）
 *
 *  为什么自己写而不用现成库：整个 agent 前端只有 React + radix 这一层依赖，
 *  一个 diff 视图不值得再拉一个包；而且这里的输入形态很窄——两侧**全文文本**
 *  （服务端已经按 AGENT_UNDO_DIFF_CHARS 截断），不是流式或超大文件。
 *
 *  做法（unified diff 的最小实现）：
 *    ① 掐掉公共前后缀（绝大多数改动都集中在文件中间）；
 *    ② 中间段做 LCS（动态规划 + Int32Array）；两个方向的行数乘积超过阈值时
 *       **退化成"整段删 + 整段加"**——宁可粗略也不把几万行的文件卡死（limited=true 如实标出）；
 *    ③ 按 context 参数保留每个改动周围各 N 行，其余折叠成一条 `gap`（"… 省略 N 行"）。
 *
 *  rows 的形状（组件只认这四种 type）：
 *    { type:'ctx', text, a, b }  两边都有的行（a/b = 1 起的行号）
 *    { type:'del', text, a }     只在这一侧（旧文件）
 *    { type:'add', text, b }     只在新文件
 *    { type:'gap', count, a, b } 被折叠的未变区（a/b = 折叠区起始行号）
 *
 *  每个步骤各是一个小函数（公共前后缀 / LCS 表 / 回溯 / 铺行 / 折叠）：
 *  这是按 lint 的复杂度棘轮拆的，也正好对应"哪一步出错就改哪一步"的排查路径。
 */

/** LCS 的规模上限（行数乘积）：超过就退化成"整段删+整段加"。
 *  400 万格 ≈ 2000×2000 行，Int32Array 16MB——比"页面卡住 3 秒"划算得多。 */
const LCS_CELLS_MAX = 4_000_000;

/** 文本 → 行数组。`'a\nb\n'` 是 2 行（末尾换行不是"多一行空的"），`'a\n\n'` 是 2 行（含一个空行）。 */
function toLines(s) {
  const t = String(s == null ? '' : s);
  if (!t) return [];
  const arr = t.split('\n');
  if (arr[arr.length - 1] === '') arr.pop();
  return arr;
}

/** 公共前缀/后缀的行数（掐掉两头，中间段通常只剩改动附近那几行） */
function commonEdges(A, B) {
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  return { pre, suf };
}

/** LCS 长度表（dp[i][j] = 从 i/j 起的公共子序列长度，一维 Int32Array 存放） */
function lcsTable(am, bm) {
  const n = am.length, m = bm.length, w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = am[i] === bm[j]
        ? dp[(i + 1) * w + j + 1] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  return { dp, w };
}

/** 沿长度表回溯出一条对齐序列：[{type:'ctx'|'del'|'add', ai?, bj?}] */
function backtrack(am, bm, dp, w) {
  const out = [];
  let i = 0, j = 0;
  while (i < am.length && j < bm.length) {
    if (am[i] === bm[j]) { out.push({ type: 'ctx', ai: i, bj: j }); i++; j++; continue; }
    if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { out.push({ type: 'del', ai: i }); i++; continue; }
    out.push({ type: 'add', bj: j }); j++;
  }
  while (i < am.length) { out.push({ type: 'del', ai: i }); i++; }
  while (j < bm.length) { out.push({ type: 'add', bj: j }); j++; }
  return out;
}

/** 中间段的行对齐；规模过大返回 null（调用方退化处理） */
function align(am, bm) {
  if (!am.length || !bm.length || am.length * bm.length > LCS_CELLS_MAX) return null;
  const { dp, w } = lcsTable(am, bm);
  return backtrack(am, bm, dp, w);
}

/** 对齐项 → 带行号的 diff 行（a/b 是各自侧 1 起的行号，pre 是公共前缀长度） */
function midRow(p, am, bm, pre) {
  if (p.type === 'ctx') return { type: 'ctx', text: am[p.ai], a: pre + p.ai + 1, b: pre + p.bj + 1 };
  if (p.type === 'del') return { type: 'del', text: am[p.ai], a: pre + p.ai + 1 };
  return { type: 'add', text: bm[p.bj], b: pre + p.bj + 1 };
}

/** 铺 rows：前缀 ctx + 中间段（LCS 或退化）+ 后缀 ctx */
function buildRows(A, B, pre, suf) {
  const am = A.slice(pre, A.length - suf);
  const bm = B.slice(pre, B.length - suf);
  const pairs = align(am, bm);
  const limited = !pairs && !!(am.length && bm.length);
  const mid = pairs || [
    ...am.map((_, i) => ({ type: 'del', ai: i })),
    ...bm.map((_, j) => ({ type: 'add', bj: j })),
  ];
  const rows = [];
  for (let k = 0; k < pre; k++) rows.push({ type: 'ctx', text: A[k], a: k + 1, b: k + 1 });
  for (const p of mid) rows.push(midRow(p, am, bm, pre));
  for (let k = 0; k < suf; k++) {
    const ai = A.length - suf + k, bj = B.length - suf + k;
    rows.push({ type: 'ctx', text: A[ai], a: ai + 1, b: bj + 1 });
  }
  return { rows, limited };
}

/** 折叠：每个改动周围保留 ctx 行，其余未变区合成一条 gap（ctx=Infinity 时全展开） */
function foldRows(rows, ctx) {
  if (ctx === Infinity) return rows;
  const keep = new Uint8Array(rows.length);
  rows.forEach((r, i) => {
    if (r.type === 'ctx') return;
    const lo = Math.max(0, i - ctx), hi = Math.min(rows.length - 1, i + ctx);
    for (let k = lo; k <= hi; k++) keep[k] = 1;
  });
  const out = [];
  let gap = null;
  rows.forEach((r, i) => {
    if (keep[i]) {
      if (gap) { out.push(gap); gap = null; }
      out.push(r);
      return;
    }
    if (!gap) gap = { type: 'gap', count: 0, a: r.a || 0, b: r.b || 0 };
    gap.count++;
  });
  if (gap) out.push(gap);
  return out;
}

function tally(rows) {
  let added = 0, removed = 0;
  for (const r of rows) {
    if (r.type === 'add') added++;
    else if (r.type === 'del') removed++;
  }
  return { added, removed };
}

/**
 * 两侧文本 → diff 行。`opts.context` 是每个改动周围保留的上下文行数（默认 3；给 Infinity 就全展开）。
 * @returns {{rows:Array, added:number, removed:number, limited:boolean, unchanged:boolean}}
 *          limited=true 表示中间段太大、退化成整段替换（差异方向仍然真实，只是不逐行对齐）。
 */
export function diffLines(before, after, opts = {}) {
  const raw = opts.context;
  const ctx = raw === Infinity ? Infinity : (Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 3);
  const A = toLines(before);
  const B = toLines(after);
  const { pre, suf } = commonEdges(A, B);
  const { rows, limited } = buildRows(A, B, pre, suf);
  const { added, removed } = tally(rows);
  /* 无改动：原样返回（不折叠）——界面此时显示"两侧一致"，不会逐行渲染；
     折叠它反而会得到一个"整篇都是一个 gap"的怪结果。 */
  if (!added && !removed) return { rows, added: 0, removed: 0, limited, unchanged: true };
  return { rows: foldRows(rows, ctx), added, removed, limited, unchanged: false };
}
