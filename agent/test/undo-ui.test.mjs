/* undo-ui.test.mjs —— 「改动行数 / 运行时长 / 一键撤销」的**客户端一半**回归
 *
 *  三个功能的数据全在服务端（事件流给行数与撤销摘要，改动日志落在账号目录里），
 *  客户端只做三件事：把事件里的字段写进那条消息、把撤销请求打回去、把它画出来。
 *  这三件都是**接线**，文本断言看不出来对不对（本项目吃过"测试全绿而真机坏"的亏），
 *  所以这里驱动真模块 + 真渲染（react-dom/server），再断最终 HTML 里该有的字。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformSync } from 'esbuild';

/* ui/state/*.js 会 import .jsx（toast 组件）——装上 esbuild 就地转换，测试才能 import 它们 */
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('.jsx')) return nextLoad(url, context);
    const code = transformSync(readFileSync(fileURLToPath(url), 'utf8'), {
      loader: 'jsx', format: 'esm', jsx: 'automatic', target: 'esnext', sourcefile: url,
    }).code;
    return { format: 'module', source: code, shortCircuit: true };
  },
});

globalThis.document = {
  documentElement: { setAttribute: () => {} },
  addEventListener: () => {},
  visibilityState: 'visible',
};
globalThis.window = { matchMedia: () => ({ matches: false }), addEventListener: () => {} };

const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
const sse = (events) => new Response(
  events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''),
  { status: 200, headers: { 'content-type': 'text/event-stream' } },
);
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

function stubRoutes(routes) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, method: (init && init.method) || 'GET', body: init && init.body });
    for (const [frag, make] of Object.entries(routes)) if (u.includes(frag)) return make(u, init);
    return json({ ok: true });
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}
const runState = (run, runs) => json({ ok: true, run: run || null, runs: runs || (run ? [run] : []) });

const UNDO = {
  runId: 'r1', ts: 1700000000000, count: 2, files: ['/tmp/a.md', '/tmp/b.md'],
  more: 0, added: 9, removed: 3, skipped: 0, complete: true, undone: false,
};

test('★ 事件流里的行数/撤销摘要/运行时长都落到那条消息上（卡片与按钮据此渲染）', async () => {
  const { state } = await import('../src/ui/state/store.js');
  const Run = await import('../src/ui/state/run.js');
  state.activeSessId = 's1';
  const live = { id: 'm2', role: 'assistant', content: '', streaming: true, trace: [] };
  state.sessions = [{ id: 's1', title: 'T', ts: 1, msgs: [{ id: 'm1', role: 'user', content: '改文件' }, live] }];
  state.history = state.sessions[0].msgs.slice();
  const running = { runId: 'r1', sessionId: 's1', liveId: 'm2', status: 'running' };
  const r = stubRoutes({
    '/agent/run/state': () => runState(running),
    '/agent/run/hub': () => sse([
      { type: 'hub_snapshot', runs: [running] },
      { type: 'replay_start', runId: 'r1', sessionId: 's1', liveId: 'm2', truncated: false, status: 'running' },
      { type: 'tool_start', runId: 'r1', sessionId: 's1', token: 0, callId: 'c1', name: 'write_file', label: '写文件', args: {} },
      {
        type: 'tool_end', runId: 'r1', sessionId: 's1', token: 0, callId: 'c1', name: 'write_file', label: '写文件',
        state: 'done', ok: true, note: '已覆盖', ms: 12, result: '已覆盖 /tmp/a.md', resultChars: 20,
        lines: { added: 7, removed: 2 },
      },
      { type: 'end', runId: 'r1', sessionId: 's1', status: 'done', error: '', ms: 83000, undo: UNDO },
    ]),
  });
  try {
    await Run.reattach('s1');
    await tick(80);
    const msg = state.history[state.history.length - 1];
    assert.deepEqual(msg.trace[0].lines, { added: 7, removed: 2 }, '★ 工具的行数要进追踪条（否则卡片上永远是空的）');
    assert.equal(msg.wallMs, 83000, '★ 运行时长要落在消息上（刷新后仍显示）');
    assert.equal(msg.undo && msg.undo.count, 2, '★ 撤销摘要要挂在消息上（按钮据此出现）');
    assert.equal(msg.undo.undone, false);
    assert.ok(!msg.streaming, '这一轮已结束');
  } finally { r.restore(); Run.reset(); }
});

test('★ 一键撤销：打到 /agent/run/undo，并把本地那条也标成已撤销（不被整体写回覆盖）', async () => {
  const { state } = await import('../src/ui/state/store.js');
  const Run = await import('../src/ui/state/run.js');
  const msg = { id: 'm2', role: 'assistant', content: '改好了', wallMs: 83000, trace: [], undo: Object.assign({}, UNDO) };
  state.activeSessId = 's1';
  state.sessions = [{ id: 's1', title: 'T', ts: 1, msgs: [{ id: 'm1', role: 'user', content: 'x' }, msg] }];
  state.history = state.sessions[0].msgs.slice();
  let posted = null;
  const r = stubRoutes({
    '/agent/run/undo': (u, init) => {
      posted = JSON.parse(init.body);
      return json({ ok: true, runId: 'r1', undoneAt: 1700000009999, result: { restored: ['/tmp/a.md'], removed: [], failed: [] } });
    },
  });
  try {
    const d = await Run.undoRun('r1');
    assert.deepEqual(posted, { id: 'r1' }, '请求体只需要 runId（日志的定位在服务端完成）');
    assert.equal(d.ok, true);
    assert.equal(msg.undo.undone, true, '★ 本地那条也要标已撤销——否则下一次整体写回会把服务端那份覆盖回去');
    assert.equal(msg.undo.undoneAt, 1700000009999);
  } finally { r.restore(); Run.reset(); }
});

test('★ 没成功就不许说成功：服务端 marked:false（部分失败/被拦）时本地不标已撤销，按钮留着能重试', async () => {
  const { state } = await import('../src/ui/state/store.js');
  const Run = await import('../src/ui/state/run.js');
  const msg = { id: 'm2', role: 'assistant', content: '改好了', wallMs: 83000, trace: [], undo: Object.assign({}, UNDO) };
  state.activeSessId = 's1';
  state.sessions = [{ id: 's1', title: 'T', ts: 1, msgs: [{ id: 'm1', role: 'user', content: 'x' }, msg] }];
  state.history = state.sessions[0].msgs.slice();
  const r = stubRoutes({
    '/agent/run/undo': () => json({
      ok: true, marked: false, partial: true, undoneAt: 0,
      result: { restored: [], removed: [], failed: [{ path: '/tmp/a.md', error: '需要先解锁', needUnlock: true }] },
    }),
  });
  try {
    const d = await Run.undoRun('r1');
    assert.equal(d.partial, true, '服务端说只完成了一部分');
    assert.equal(msg.undo.undone, false, '★ 一个文件都没恢复 → 本地绝不能标"已撤销"（否则用户再也没法重试）');
  } finally { r.restore(); Run.reset(); }
});

test('★ 渲染：卡片上有 +N/−M、卡片底部有「本轮用时」与撤销按钮；撤销后换成"已撤销"', async () => {
  const { default: Message } = await import('../src/ui/features/Message.jsx');
  const { default: TraceStrip } = await import('../src/ui/features/TraceStrip.jsx');

  /* ① 一张写文件的工具卡片：+7 / −2 行 */
  const card = renderToStaticMarkup(h(TraceStrip, {
    trace: {
      kind: 'tool', state: 'done', name: 'write_file', label: '写文件', ok: true,
      note: '已覆盖', ms: 12, result: '已覆盖 /tmp/a.md', resultChars: 20, lines: { added: 7, removed: 2 },
    },
  }));
  assert.ok(card.includes('+7'), '卡片上要有 "+7"（写入行数），实际：' + card.slice(0, 300));
  assert.ok(card.includes('−2'), '卡片上要有 "−2"（删除行数）');
  assert.ok(/行/.test(card), '带"行"这个单位，别让人猜是字节还是字符');

  /* ② 没有行数的卡片：不该凭空冒出 +0 */
  const plain = renderToStaticMarkup(h(TraceStrip, { trace: { kind: 'tool', state: 'done', name: 'read_file', label: '读文件', ok: true, result: 'x' } }));
  assert.ok(!plain.includes('+0') && !plain.includes('−0'), '没改文件就不该显示行数');

  /* ③ 一条跑完的消息：时长 + 撤销按钮 */
  const msg = {
    id: 'm2', role: 'assistant', content: '改好了', wallMs: 83000, trace: [],
    undo: Object.assign({}, UNDO),
  };
  const html = renderToStaticMarkup(h(Message, { msg, index: 1, stale: false, isLastRound: true, busy: false }));
  assert.ok(html.includes('本轮用时'), '要有一句人话的运行时长，实际：' + html.slice(0, 400));
  assert.ok(html.includes('1 分 23 秒'), '83000ms 要显示成 1 分 23 秒（不是 83.0s）');
  assert.ok(html.includes('撤销本轮文件改动（2 处）'), '★ 卡片上要有一键撤销按钮，实际：' + html.slice(0, 500));
  assert.ok(html.includes('已覆盖 /tmp/a.md') === false, '详情折叠时不该把结果正文铺在卡片上');

  /* ④ 撤销过的那条：按钮消失，换成"已撤销" */
  const undoneMsg = Object.assign({}, msg, { undo: Object.assign({}, UNDO, { undone: true, undoneAt: Date.now() }) });
  const html2 = renderToStaticMarkup(h(Message, { msg: undoneMsg, index: 1, stale: false, isLastRound: true, busy: false }));
  assert.ok(!html2.includes('撤销本轮文件改动（2 处）'), '撤销过就不该再给按钮（不能撤第二次）');
  assert.ok(html2.includes('已撤销'), '要留下"已撤销"的痕迹（刷新后也知道撤过了）');

  /* ⑤ 没有文件改动的一轮：没有撤销按钮，但时长照常显示 */
  const noUndo = renderToStaticMarkup(h(Message, {
    msg: { id: 'm3', role: 'assistant', content: '只是聊了聊', wallMs: 4200, trace: [] },
    index: 2, stale: false, isLastRound: true, busy: false,
  }));
  assert.ok(noUndo.includes('本轮用时') && noUndo.includes('4.2 秒'));
  assert.ok(!noUndo.includes('撤销本轮文件改动'), '这一轮没改文件，不该出现撤销按钮');

  /* ⑥ 生成中：不显示时长与撤销（它们只有结束时才有值） */
  const streaming = renderToStaticMarkup(h(Message, {
    msg: { id: 'm4', role: 'assistant', content: '写…', streaming: true, trace: [] },
    index: 3, stale: false, isLastRound: true, busy: true,
  }));
  assert.ok(!streaming.includes('本轮用时') && !streaming.includes('撤销本轮文件改动'));
});

/* ==================== 「比对修改」（2026-10-03）：卡片可点 + 撤销菜单 + 进度写回 ==================== */

test('★ 卡片上的 +N/−M 可点（带 undoRef 时）——点开比对抽屉的入口；旧数据不假装能点', async () => {
  const { default: TraceStrip } = await import('../src/ui/features/TraceStrip.jsx');
  const base = {
    kind: 'tool', state: 'done', name: 'edit_file', label: '改文件', ok: true, result: '改好了',
    note: '完成', ms: 9, lines: { added: 1, removed: 1 },
  };
  const withRef = renderToStaticMarkup(h(TraceStrip, {
    trace: Object.assign({}, base, { undoRef: { runId: 'r1', sessionId: 's1', entry: 0, paths: ['/tmp/a.md'] } }),
  }));
  assert.ok(withRef.includes('点击查看前后对比'), '★ 有 undoRef 的卡片要能点开对比（title 里给出提示）');
  assert.match(withRef, /role="button"/, '渲染成可点的元素（span[role=button]，避免嵌套 button）');
  const noRef = renderToStaticMarkup(h(TraceStrip, { trace: base }));
  assert.ok(!noRef.includes('点击查看前后对比'), '没有 undoRef（旧会话/直调）就不假装能点');
  assert.ok(noRef.includes('+1') && noRef.includes('−1'), '行数照常显示');
});

test('★ 撤销菜单的纯函数：文件清单（动作/行数/已恢复）与"还剩几处"——新旧两种摘要都认', async () => {
  const { filesOf, pendingOf } = await import('../src/ui/features/UndoMenu.jsx');
  const fresh = {
    runId: 'r1', count: 3, undone: false, pendingCount: 2, undoneCount: 1,
    fileList: [
      { path: '/tmp/a.md', action: 'modify', added: 3, removed: 1, undone: false },
      { path: '/tmp/b.md', action: 'create', added: 5, removed: 0, undone: true },
      { path: '/tmp/c.md', action: 'delete', added: 0, removed: 4, undone: false },
    ],
  };
  assert.equal(pendingOf(fresh), 2, '还剩 2 处可恢复');
  assert.equal(filesOf(fresh).length, 3);
  assert.equal(filesOf(fresh)[1].undone, true, '第二个文件已恢复（菜单里显示「✓ 已恢复」）');
  assert.equal(filesOf(fresh)[2].action, 'delete', '动作随行给出（菜单显示"删除"徽标）');
  const legacy = { runId: 'r2', count: 2, files: ['/tmp/x.md', '/tmp/y.md'], undone: false };
  assert.equal(pendingOf(legacy), 2, '旧摘要没有 pendingCount：按"还没撤过"算');
  assert.deepEqual(filesOf(legacy).map((f) => f.path), ['/tmp/x.md', '/tmp/y.md']);
  assert.deepEqual(filesOf(legacy)[0], { path: '/tmp/x.md', action: 'modify', added: 0, removed: 0, undone: false },
    '旧数据不编行数（0 就是不显示）');
  assert.equal(pendingOf(Object.assign({}, legacy, { undone: true })), 0, '旧摘要撤过之后没有可撤的了');
});

test('★ 逐文件撤销的进度写回本地那条消息（applyUndoSummary）——按钮与菜单立刻跟上，不用刷新', async () => {
  const { state } = await import('../src/ui/state/store.js');
  const Run = await import('../src/ui/state/run.js');
  const msg = { id: 'm2', role: 'assistant', content: 'x', wallMs: 1, trace: [], undo: Object.assign({}, UNDO) };
  state.sessions = [{ id: 's1', title: 'T', ts: 1, msgs: [msg] }];
  state.history = [msg];
  Run.applyUndoSummary({
    runId: 'r1', undone: false, undoneCount: 1, pendingCount: 1,
    fileList: [
      { path: '/tmp/a.md', action: 'modify', added: 1, removed: 1, undone: true },
      { path: '/tmp/b.md', action: 'create', added: 2, removed: 0, undone: false },
    ],
    lastFailed: 0,
  });
  assert.equal(msg.undo.undone, false, '只恢复了一个：整轮还不算已撤销（按钮留着）');
  assert.equal(msg.undo.pendingCount, 1);
  assert.equal(msg.undo.fileList[0].undone, true, '★ 菜单里那行要立刻变「已恢复」');
  Run.applyUndoSummary({ runId: 'r1', undone: true, undoneCount: 2, pendingCount: 0, fileList: [], lastFailed: 0 });
  assert.equal(msg.undo.undone, true, '全部恢复后收尾条换成"已撤销"');
});

test('★ 比对抽屉的差异渲染：两侧文本 → 逐行差异（行号/±/统计），"之后"来源说清楚', async () => {
  const { DiffBody } = await import('../src/ui/features/FileDiffSheet.jsx');
  const data = {
    path: '/tmp/a.md', scope: 'entry', action: 'modify', changes: 1, undone: false,
    lines: { added: 1, removed: 1 },
    before: { exists: true, source: 'journal', text: 'A\nB\nC\n' },
    after: { exists: true, source: 'disk', text: 'A\nB2\nC\nD\n' },
  };
  const html = renderToStaticMarkup(h(DiffBody, { data, loading: false, error: '' }));
  assert.ok(html.includes('+2') && html.includes('−1'), '统计要按实际行数（+2 −1），实际：' + html.slice(0, 300));
  assert.ok(html.includes('B2') && html.includes('D'), '新增/改动的行要出现在差异里');
  assert.ok(html.includes('当前文件'), '★ 之后来自磁盘时要写明（"之后 = 当前文件"）');
  /* 二进制/目录/没备份：不画差异，给一句人话 */
  const bin = renderToStaticMarkup(h(DiffBody, {
    data: Object.assign({}, data, { before: { exists: true, source: 'journal', binary: true }, after: data.after }),
    loading: false, error: '',
  }));
  assert.ok(bin.includes('二进制文件'), '二进制要说清不展示差异');
  const missing = renderToStaticMarkup(h(DiffBody, {
    data: Object.assign({}, data, { before: { exists: false, source: 'journal' } }),
    loading: false, error: '',
  }));
  assert.ok(missing.includes('这一轮新建的'), '新建的文件要说清"之前不存在"');
});
