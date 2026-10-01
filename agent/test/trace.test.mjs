/* ui/lib/trace.js 单测：追踪条条目的规范化与收尾合并
 *
 *  这两件事原先内联在 session.js 的 send() 里、用中文文案当判据（`note === '插话'` /
 *  `note === '进行中'`），既没法单测也容易在改文案时静默改行为。抽成纯函数后在这里钉住语义。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { traceKind, traceRunning, normalizeTrace, mergeTrace } from '../src/ui/lib/trace.js';

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

test('normalizeTrace：补齐 kind/state 两个字段，不动其它字段', () => {
  const out = normalizeTrace({ label: '读文件：/tmp/a', note: '进行中', ms: 12 });
  assert.equal(out.kind, 'tool');
  assert.equal(out.state, 'running');
  assert.equal(out.label, '读文件：/tmp/a', 'label 原样');
  assert.equal(out.ms, 12);
  assert.equal(normalizeTrace({ kind: 'notice', state: 'done' }).state, 'done');
});

test('mergeTrace：工具条换成内核那份（结果/耗时口径与落盘一致）', () => {
  const live = [{ label: '读文件：/tmp/a', note: '进行中' }];
  const core = [{ name: 'read_file', label: '读文件：/tmp/a', ok: true, note: '完成', result: '正文', ms: 8 }];
  const out = mergeTrace(live, core, []);
  assert.equal(out.length, 1);
  assert.equal(out[0].result, '正文', '用的是内核那条（带结果）');
  assert.equal(out[0].ms, 8);
  assert.equal(out[0].kind, 'tool', '规范化过的条目带 kind');
});

test('★ mergeTrace：提示条留在它出现的位置，不被内核 trace 抹掉', () => {
  const live = [
    { label: '读文件：/tmp/a', note: '进行中' },
    { kind: 'notice', label: '模型把工具调用写成了正文，已自动识别并执行', note: '提示' },
    { label: '命令：ls', note: '进行中' },
  ];
  const core = [
    { name: 'read_file', label: '读文件：/tmp/a', result: 'a' },
    { name: 'run_command', label: '命令：ls', result: 'b' },
  ];
  const out = mergeTrace(live, core, []);
  assert.deepEqual(out.map((t) => t.label), [
    '读文件：/tmp/a',
    '模型把工具调用写成了正文，已自动识别并执行',
    '命令：ls',
  ], '顺序与实时一致，提示条原地保留');
  assert.equal(out[1].kind, 'notice');
});

test('mergeTrace：插话统一由 steering 放在最前面，live 里的重复条目丢掉', () => {
  const live = [
    { kind: 'steer', label: '已插话（下一轮生效）：改成中文', note: '插话' },
    { label: '命令：pwd', note: '进行中' },
  ];
  const core = [{ name: 'run_command', label: '命令：pwd', result: '/tmp' }];
  const steering = [{ kind: 'steer', label: '已插话（下一轮生效）：改成中文', note: '插话' }];
  const out = mergeTrace(live, core, steering);
  assert.deepEqual(out.map((t) => t.kind), ['steer', 'tool']);
  assert.equal(out.filter((t) => t.kind === 'steer').length, 1, '插话只有一条（不重复）');
});

test('mergeTrace：中断收尾（core 为空）时保留实时列表，工具条停在"进行中"', () => {
  const live = [{ label: '命令：sleep 9', note: '进行中' }, { label: '读文件：/tmp/b', note: '进行中' }];
  const out = mergeTrace(live, [], [{ kind: 'steer', label: '已插话（最终回答后生效）：停', note: '插话' }]);
  assert.equal(out.length, 3);
  assert.equal(out[0].kind, 'steer', '插话在最前');
  assert.equal(out[1].state, 'running', '工具条保持进行中（那正是当时的真相）');
});

test('mergeTrace：内核多出来的工具条照样补在末尾（实时列表漏掉的情况）', () => {
  const out = mergeTrace([], [{ name: 'x', label: '工具：x', result: 'r' }], []);
  assert.deepEqual(out.map((t) => t.label), ['工具：x']);
});
