/* ui/lib/diff.js 单测：「比对修改」抽屉的行级差异（纯函数）
 *
 *  这个算法决定用户看到的"之前 / 之后"对不对：行号、增删方向、折叠边界。
 *  组件层（FileDiffSheet）只是把这些行画出来，所以语义全部钉在这里。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { diffLines } from '../src/ui/lib/diff.js';

const types = (r) => r.rows.map((x) => x.type).join(' ');
const texts = (r) => r.rows.map((x) => (x.type === 'gap' ? `…${x.count}` : x.text));

test('无变化：全部 ctx，added/removed 都是 0', () => {
  const r = diffLines('a\nb\nc\n', 'a\nb\nc\n');
  assert.equal(types(r), 'ctx ctx ctx');
  assert.equal(r.added, 0);
  assert.equal(r.removed, 0);
  assert.equal(r.unchanged, true);
  assert.deepEqual(r.rows[1], { type: 'ctx', text: 'b', a: 2, b: 2 });
});

test('改一行：中间是 del+add，两侧 ctx 行号各自连续', () => {
  const r = diffLines('a\nb\nc\n', 'a\nB\nc\n');
  assert.equal(types(r), 'ctx del add ctx');
  assert.deepEqual(r.rows[1], { type: 'del', text: 'b', a: 2 });
  assert.deepEqual(r.rows[2], { type: 'add', text: 'B', b: 2 });
  assert.equal(r.added, 1);
  assert.equal(r.removed, 1);
});

test('纯新增（追加两行）：只出 add，行号接在旧文件末尾', () => {
  const r = diffLines('a\n', 'a\nb\nc\n');
  assert.equal(types(r), 'ctx add add');
  assert.deepEqual(r.rows[1], { type: 'add', text: 'b', b: 2 });
  assert.equal(r.added, 2);
  assert.equal(r.removed, 0);
});

test('纯删除：只出 del', () => {
  const r = diffLines('a\nb\nc\n', 'a\nc\n');
  assert.equal(types(r), 'ctx del ctx');
  assert.equal(r.removed, 1);
  assert.deepEqual(r.rows[2], { type: 'ctx', text: 'c', a: 3, b: 2 });
});

test('空文件 → 有内容（全 add）；有内容 → 空文件（全 del）', () => {
  const up = diffLines('', 'x\ny\n');
  assert.equal(types(up), 'add add');
  assert.equal(up.added, 2);
  const down = diffLines('x\ny\n', '');
  assert.equal(types(down), 'del del');
  assert.equal(down.removed, 2);
});

test('★ 尾随换行的语义：`a\\n` 是 1 行、`a` 也是 1 行（不产生幽灵空行）', () => {
  assert.equal(diffLines('a\n', 'a').unchanged, true);
  assert.equal(diffLines('a\n\n', 'a\n').removed, 1, '`a\\n\\n` 比 `a\\n` 多一个空行');
});

test('插入一行：旧行号不错位（a/b 是各自侧的行号）', () => {
  const r = diffLines('1\n2\n3\n', '1\nX\n2\n3\n');
  assert.deepEqual(texts(r), ['1', 'X', '2', '3']);
  assert.deepEqual(r.rows[1], { type: 'add', text: 'X', b: 2 });
  assert.deepEqual(r.rows[2], { type: 'ctx', text: '2', a: 2, b: 3 });
  assert.deepEqual(r.rows[3], { type: 'ctx', text: '3', a: 3, b: 4 });
});

test('★ 折叠：隔得远的未变区合成 gap，改动周围各留 3 行', () => {
  const before = Array.from({ length: 30 }, (_, i) => `L${i + 1}`).join('\n');
  const after = before.replace('L15', 'CHANGED');
  const r = diffLines(before, after);
  assert.equal(r.added, 1);
  assert.equal(r.removed, 1);
  const gaps = r.rows.filter((x) => x.type === 'gap');
  assert.equal(gaps.length, 2, '改动前面和后面各一个 gap');
  assert.deepEqual(gaps[0], { type: 'gap', count: 11, a: 1, b: 1 }, '前 11 行（1..11）折叠，12..14 是上下文');
  assert.equal(r.rows[0].type, 'gap');
  /* 保留的就是改动前后各 3 行 + 那一对 del/add */
  assert.deepEqual(texts(r).slice(1, 8), ['L12', 'L13', 'L14', 'L15', 'CHANGED', 'L16', 'L17']);
});

test('context: Infinity 全展开，不出现 gap', () => {
  const before = Array.from({ length: 20 }, (_, i) => `L${i + 1}`).join('\n');
  const r = diffLines(before, `${before}\nNEW`, { context: Infinity });
  assert.equal(r.rows.some((x) => x.type === 'gap'), false);
  assert.equal(r.rows.length, 21);
});

test('★ 移动行：按 del+add 呈现（不做移动检测——宁可多显示也不显示错）', () => {
  const r = diffLines('a\nb\nc\n', 'b\nc\na\n');
  assert.equal(r.added, 1);
  assert.equal(r.removed, 1);
  const del = r.rows.find((x) => x.type === 'del');
  const add = r.rows.find((x) => x.type === 'add');
  assert.equal(del.text, 'a');
  assert.equal(add.text, 'a');
});

test('★ 大文件退化：超过 LCS 规模上限时整段删+整段加，方向与计数仍然真实', () => {
  const A = Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n');
  const B = Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n');
  const r = diffLines(A, B);
  assert.equal(r.limited, true);
  assert.equal(r.added, 3000);
  assert.equal(r.removed, 3000);
  assert.ok(r.rows.some((x) => x.type === 'del'));
  assert.ok(r.rows.some((x) => x.type === 'add'));
});

test('相同前缀/后缀很长时仍然只标出中间的真实改动（LCS 只跑中间段）', () => {
  const head = Array.from({ length: 500 }, (_, i) => `h${i}`).join('\n');
  const tail = Array.from({ length: 500 }, (_, i) => `t${i}`).join('\n');
  const r = diffLines(`${head}\nmid\n${tail}`, `${head}\nMID\n${tail}`);
  assert.equal(r.added, 1);
  assert.equal(r.removed, 1);
  assert.equal(r.limited, false);
});
