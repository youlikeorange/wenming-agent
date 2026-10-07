/* ui/lib/trace.js 单测：追踪条条目的规范化与收尾合并
 *
 *  这两件事原先内联在 session.js 的 send() 里、用中文文案当判据（`note === '插话'` /
 *  `note === '进行中'`），既没法单测也容易在改文案时静默改行为。抽成纯函数后在这里钉住语义。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { traceKind, traceRunning, summarizeTraces, shortToolName, linesOf } from '../src/ui/lib/trace.js';

test('traceKind：显式 kind 优先；旧数据没有 kind 时按 tool 处理', () => {
  assert.equal(traceKind({ kind: 'notice' }), 'notice');
  assert.equal(traceKind({ kind: 'steer' }), 'steer');
  assert.equal(traceKind({ kind: '乱七八糟' }), 'tool', '不认识的值一律当工具条');
  assert.equal(traceKind({}), 'tool');
  assert.equal(traceKind(null), 'tool');
});

test('★ traceRunning：优先看 state；旧数据（没有 state）按旧文案「进行中」回推', () => {
  assert.equal(traceRunning({ state: 'running' }), true);
  assert.equal(traceRunning({ state: 'done' }), false);
  assert.equal(traceRunning({ note: '进行中' }), true, '旧会话：当时用 note 当状态');
  assert.equal(traceRunning({ note: '完成' }), false);
  assert.equal(traceRunning({}), false);
});

/* ==================== 折叠摘要（features/TraceGroup.jsx 的口径） ==================== */

test('shortToolName：认识的名字给短名；不认识的回退到标签「：」前那段，再回退工具名', () => {
  assert.equal(shortToolName('read_file', '读文件：/tmp/a'), '读文件');
  assert.equal(shortToolName('spawn_agent', '子智能体：查资料'), '子智能体');
  assert.equal(shortToolName('brand_new_tool', '某个新工具：x'), '某个新工具', '没登记过的名字：用标签的前半段');
  assert.equal(shortToolName('brand_new_tool', '一段没有冒号的说明'), '一段没有冒号的说明');
  assert.equal(shortToolName('brand_new_tool', ''), 'brand_new_tool');
  assert.equal(shortToolName('', ''), '工具');
});

test('★ summarizeTraces：计数 / 进行中 / 失败 / 累计耗时 / 改动处数与行数', () => {
  const s = summarizeTraces([
    { name: 'read_file', label: '读文件：/tmp/a', state: 'done', ok: true, ms: 8 },
    { name: 'read_file', label: '读文件：/tmp/b', state: 'running', ok: true, ms: 0 },
    { name: 'run_command', label: '命令：ls', state: 'done', ok: false, ms: 12 },
    { name: 'write_file', label: '写文件：/tmp/c', state: 'done', ok: true, ms: 30, lines: { added: 4, removed: 1 } },
    { name: 'edit_file', label: '改文件：/tmp/d', state: 'done', ok: true, ms: 5, lines: { added: -3, removed: 0 } },
    { kind: 'notice', label: '回答被截断，已自动继续', state: 'done', ok: true },
  ]);
  assert.equal(s.count, 6);
  assert.equal(s.running, 1, '还在跑的那条按 state 数出来');
  assert.equal(s.failed, 1, 'ok === false 就是失败（提示条里的错误也数进来）');
  assert.equal(s.ms, 55, '各步耗时之和（没有 ms / ms=0 的不算）');
  assert.equal(s.changed, 1, '有改动行数的条目数（负数行数当 0，不算改动）');
  assert.equal(s.added, 4);
  assert.equal(s.removed, 1);
});

test('★ summarizeTraces：按短名归类，条数多的在前，同数按首次出现的先后', () => {
  const s = summarizeTraces([
    { name: 'read_file', label: '读文件：/tmp/a', ok: true },
    { name: 'write_file', label: '写文件：/tmp/b', ok: true },
    { name: 'read_file', label: '读文件：/tmp/c', ok: true },
    { name: 'read_file', label: '读文件：/tmp/d', ok: true },
    { kind: 'sub', label: '子智能体：查资料', ok: true },
    { kind: 'steer', label: '已插话（待注入）：改成中文', ok: true },
  ]);
  assert.deepEqual(s.groups, [
    { label: '读文件', count: 3 },
    { label: '写文件', count: 1 },
    { label: '子智能体', count: 1 },
    { label: '插话', count: 1 },
  ], '同一工具的不同路径合成一类；非工具条按类别名归类');
  assert.equal(s.groups.reduce((n, g) => n + g.count, 0), 6, '分类计数之和 = 总条数');
});

test('summarizeTraces：空列表 / 脏数据不炸', () => {
  assert.deepEqual(summarizeTraces([]), { count: 0, running: 0, failed: 0, ms: 0, changed: 0, added: 0, removed: 0, groups: [] });
  assert.equal(summarizeTraces(null).count, 0);
  assert.equal(summarizeTraces([null, undefined, { name: 'read_file', label: '读文件：x' }]).count, 1, '空条目丢掉');
});

test('linesOf：行数口径只有一份（负数/非数字当 0）', () => {
  assert.deepEqual(linesOf({ added: 2, removed: 1 }), { added: 2, removed: 1 });
  assert.deepEqual(linesOf({ added: -5, removed: 'x' }), { added: 0, removed: 0 });
  assert.deepEqual(linesOf(null), { added: 0, removed: 0 });
  assert.deepEqual(linesOf({ added: '3' }), { added: 3, removed: 0 }, '字符串数字照收（落盘回读的形态）');
});

