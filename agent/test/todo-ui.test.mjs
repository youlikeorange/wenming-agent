/* todo-ui.test.mjs —— 任务清单（右上角浮层）的**客户端一半**回归
 *
 *  数据全在服务端（agent 用 todo_write 写，见 lib/agent/todo.js），客户端只做两件事：
 *  把事件里的 todo 落进状态、把它画成右上角那块浮层（可折叠、带完成时间）。
 *  这两件都是接线，文本断言看不出来对不对，所以这里驱动真模块 + 真渲染。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformSync } from 'esbuild';

/* ui/state/*.js 会 import .jsx（toast 组件）——装上 esbuild 就地转换（与 undo-ui.test.mjs 同一套） */
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('.jsx')) return nextLoad(url, context);
    const code = transformSync(readFileSync(fileURLToPath(url), 'utf8'), {
      loader: 'jsx', format: 'esm', jsx: 'automatic', target: 'esnext', sourcefile: url,
    }).code;
    return { format: 'module', source: code, shortCircuit: true };
  },
});

globalThis.document = { documentElement: { setAttribute: () => {} }, addEventListener: () => {}, visibilityState: 'visible' };
globalThis.window = { matchMedia: () => ({ matches: false }), addEventListener: () => {} };

/* 状态快照在微任务里重建（store.js 的 schedule）——patch 之后要等一拍，组件才读得到新值 */
const tick = () => new Promise((r) => setTimeout(r, 0));

const TODO = {
  sessionId: 's1', createdAt: 1700000000000, updatedAt: 1700000005000,
  items: [
    { text: '查资料', status: 'completed', completedAt: 1700000003000 },
    { text: '写结论', status: 'pending' },
  ],
  total: 2, done: 1,
};

test('★ 浮层渲染：进度、逐项状态、完成时间；折叠后只剩一枚小胶囊', async () => {
  const { patch } = await import('../src/ui/state/store.js');
  const { default: TodoPanel } = await import('../src/ui/features/TodoPanel.jsx');

  /* 没有清单：什么都不画（agent 不写 todo 就没有这块浮层） */
  patch({ todo: { open: true, data: null, sessionId: '', loadedAt: 0 } });
  await tick();
  assert.equal(renderToStaticMarkup(h(TodoPanel)), '', '没有清单时不该出现任何东西');

  /* 展开态 */
  patch({ todo: { open: true, data: TODO, sessionId: 's1', loadedAt: 0 } });
  await tick();
  const html = renderToStaticMarkup(h(TodoPanel));
  assert.ok(html.includes('任务清单'), '标题');
  assert.ok(html.includes('1/2 完成'), '★ 进度（已完成/总数），实际：' + html.slice(0, 300));
  assert.ok(html.includes('查资料') && html.includes('写结论'), '两项都在');
  assert.ok(html.includes('完成于'), '★ 已完成项要显示完成时间');
  assert.ok(html.includes('全部完成后留在这里'), '脚注说清"完成保留"的规则（2026-10-05 起）');

  /* 折叠态：只剩小胶囊（点击展开） */
  patch({ todo: { open: false, data: TODO, sessionId: 's1', loadedAt: 0 } });
  await tick();
  const small = renderToStaticMarkup(h(TodoPanel));
  assert.ok(small.includes('任务 1/2'), '★ 折叠后是一枚带进度的小胶囊，实际：' + small.slice(0, 200));
  assert.ok(!small.includes('查资料'), '折叠时不铺开清单');
});

test('★ 状态接线：事件里的 todo 落进状态；null（显式清空）要把浮层清掉', async () => {
  const { state, patch } = await import('../src/ui/state/store.js');
  const { applyTodo } = await import('../src/ui/state/todo.js');
  state.activeSessId = 's1';
  patch({ todo: { open: true, data: null, sessionId: '', loadedAt: 0 } });
  await tick();

  applyTodo(TODO, 's1');
  assert.deepStrictEqual(state.todo.data.items.map((i) => i.text), ['查资料', '写结论']);
  assert.equal(state.todo.sessionId, 's1');

  /* 别的会话的事件不该显示在当前画面上 */
  patch({ todo: { open: true, data: TODO, sessionId: 's1', loadedAt: 0 } });
  await tick();
  applyTodo({ items: [{ text: '别的会话的', status: 'pending' }], total: 1, done: 0 }, 's2');
  assert.ok(state.todo.data.items.some((i) => i.text === '查资料'), '别的会话的清单不覆盖当前这条');

  /* null = agent 写了空清单（显式清空）→ 浮层收起。全部完成不再清空（2026-10-05 起），
     做完的清单保留显示——那是下面的 SSE 场景。 */
  applyTodo(null, 's1');
  assert.equal(state.todo.data, null, '★ null 是有意义的取值（显式清空）');
});

test('★ 模型侧的工具清单里有 todo_write；子智能体不给它（清单是主对话的规划工具）', async () => {
  const { createAgentDefs } = await import('../src/core/agent-defs.js');
  const { createPrompts } = await import('../src/core/prompts.js');
  const defs = createAgentDefs();
  const Prompts = createPrompts();
  Prompts.load({});
  defs.init({ Prompts, val2: () => true, me: () => ({ account: 'x' }), bound: () => true, AGENT_API: '/agent' });
  const all = defs.activeToolDefs();
  const names = all.map((d) => d.function.name);
  assert.ok(names.includes('todo_write'), '主对话注册了 todo_write');
  assert.ok(names.includes('spawn_agent'), '（对照：子智能体工具本来就在）');
  const subRw = defs.subagentToolDefsFor(all, true).map((d) => d.function.name);
  assert.ok(!subRw.includes('todo_write'), '★ 子智能体不给它（可写档也不给——两头改同一份清单只会对不上）');
  assert.ok(!subRw.includes('spawn_agent'), '也不给递归');
  const subRo = defs.subagentToolDefsFor(all, false).map((d) => d.function.name);
  assert.ok(!subRo.includes('todo_write'), '只读档同样不给');
});

/** 事件流的桩：与 undo-ui.test.mjs 同一套（一条 SSE 把事件推给 Run.reattach） */
const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
const sse = (events) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
function stubRoutes(routes) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    for (const [frag, make] of Object.entries(routes)) if (u.includes(frag)) return make(u, init);
    return json({ ok: true });
  };
  return { restore: () => { globalThis.fetch = orig; } };
}

test('★★ 事件流：托管运行里 todo_write 的结果经 SSE 推到浮层（整条链：pump → tool_end → applyTodo）', async () => {
  const { state, patch } = await import('../src/ui/state/store.js');
  const Run = await import('../src/ui/state/run.js');
  state.activeSessId = 's1';
  const live = { id: 'm2', role: 'assistant', content: '', streaming: true, trace: [] };
  state.sessions = [{ id: 's1', title: 'T', ts: 1, msgs: [{ id: 'm1', role: 'user', content: '分两步' }, live] }];
  state.history = state.sessions[0].msgs.slice();
  patch({ todo: { open: true, data: null, sessionId: '', loadedAt: 0 } });
  await tick();
  const running = { runId: 'r1', sessionId: 's1', liveId: 'm2', status: 'running' };
  const r = stubRoutes({
    '/agent/run/state': () => json({ ok: true, run: running, runs: [running] }),
    '/agent/run/hub': () => sse([
      { type: 'hub_snapshot', runs: [running] },
      { type: 'replay_start', runId: 'r1', sessionId: 's1', liveId: 'm2', truncated: false, status: 'running' },
      { type: 'tool_start', runId: 'r1', sessionId: 's1', token: 0, callId: 'c1', name: 'todo_write', label: '任务清单：0/2', args: {} },
      {
        type: 'tool_end', runId: 'r1', sessionId: 's1', token: 0, callId: 'c1', name: 'todo_write', label: '任务清单：1/2',
        state: 'done', ok: true, note: '清单 1/2', ms: 3, result: '已更新任务清单（1/2 完成）：…', resultChars: 40,
        todo: { sessionId: 's1', items: [{ text: '查资料', status: 'completed', completedAt: 1700000003000 }, { text: '写结论', status: 'pending' }], total: 2, done: 1 },
      },
      /* 最后一项也做完：清单**保留**（2026-10-05 起）→ 事件里是 2/2 的完成态清单 */
      { type: 'tool_end', runId: 'r1', sessionId: 's1', token: 1, callId: 'c2', name: 'todo_write', label: '任务清单：2/2',
        state: 'done', ok: true, note: '清单 2/2', ms: 2, result: '已更新任务清单（2/2 完成）：…全部完成——清单会保留在界面右上角。', resultChars: 60,
        todo: { sessionId: 's1', items: [{ text: '查资料', status: 'completed', completedAt: 1700000003000 }, { text: '写结论', status: 'completed', completedAt: 1700000006000 }], total: 2, done: 2 } },
      { type: 'end', runId: 'r1', sessionId: 's1', status: 'done', error: '', ms: 1200, undo: null },
    ]),
  });
  try {
    await Run.reattach('s1');
    await tick(80);
    const msg = state.history[state.history.length - 1];
    assert.ok(msg.trace.length >= 2, '两条工具卡都在追踪条上');
    assert.ok(state.todo.data && state.todo.data.done === 2 && state.todo.data.total === 2,
      '★ 最后一条（全完成 → 保留）到达后，浮层显示 2/2 的完成态清单');
  } finally { r.restore(); Run.reset(); }
});
