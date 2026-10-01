/* AgentContext（压缩/裁剪）回归：
 *  · compaction-test.js：运行中压缩不丢本轮工具消息、摘要本轮内复用、关掉压缩提示词 = 不压缩；
 *  · audit4-test.js：uncompact 连带清 compactCache、compactNow 防重入/await 后一致性校验。
 * 移植改动：原来的 vm/假 window/垫 DOM → ESM import + AgentContext.init(deps) 注入假依赖；
 *           手写 check() → node:test + node:assert/strict。中文测试名与断言逐条对应原文件。
 * 时间窗控制：原测试靠"等两个微任务"制造 await 窗口；这里改用可手动 release 的 hold，
 *           同样是在摘要生成期间做切会话/删消息，但结果是确定的（不依赖微任务时序）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentContext } from '../src/core/context.js';
import { Prompts } from '../src/core/prompts.js';

/* ---------- 注入宿主依赖（原 compaction-test 的 init 参数，逐项对应） ---------- */
const bigText = '事'.repeat(3000);                  // 3000 CJK ≈ 3000 tok（estTokens 按字计）
const history = [];
for (let i = 0; i < 9; i++) {
  history.push({ role: 'user', content: bigText });
  history.push({ role: 'assistant', content: bigText });
}
history.push({ role: 'user', content: '问题：请查一下并写记忆' });
history.push({ role: 'assistant', content: '', streaming: true });   // live 占位

const state = {
  hist: history,          // 宿主历史（context.js 会原地 shift 裁剪）
  cur: {},                // 当前会话
  numCtx: 32768,
  hold: null,             // 非 null 时摘要调用挂起，制造"await 期间"窗口
  summarizeCalls: 0,
  lastToast: '',
};

AgentContext.init({
  Prompts,
  Providers: { get: () => ({ chat: async function* () { yield { type: 'content', text: '这是摘要。' }; } }) },
  Agent: { complete: async (cfg) => {                 // summarize() 走 Agent.complete → stream
    state.summarizeCalls++;
    if (state.hold) await state.hold;
    let text = '';
    for await (const ev of cfg.stream(cfg.messages, cfg.opts, cfg.signal)) if (ev.type === 'content') text += ev.text;
    return { text: text.trim(), thinking: '' };
  } },
  activeProvider: () => ({ type: 'openai' }),   // 本机模型支持已移除；上限由 numCtx() 注入
  buildOptions: () => ({}),
  history: () => state.hist,
  curSess: () => state.cur,
  persistSession: () => {},
  chatEl: () => ({ querySelector: () => null }),   // 压缩流程仍会取宿主元素挂 trace 条
  addTraceStrip: () => ({}),
  fillTraceStrip: () => {},
  toast: (m) => { state.lastToast = m; },
  getInjectedBlocks: () => ({ blocks: [] }),
  getActiveToolDefs: () => [],
  abortSignal: () => undefined,
  numCtx: () => state.numCtx,
  toApiMsg: (m) => ({ role: m.role, content: m.content }),
});

/* 模拟 agent 上下文：system + history（含 live 占位）+ 第一轮工具调用（未落盘） */
const agentCtxOf = (extra) => [
  { role: 'system', content: 'sys' },
  ...state.hist.map(m => (m.toolCalls && m.toolCalls.length)
    ? { role: 'assistant', content: m.content || '', toolCalls: m.toolCalls }
    : { role: m.role, content: m.content }),
  ...extra,
];
const toolRound = (id, name) => [
  { role: 'assistant', content: '', toolCalls: [{ id, name, args: { query: 'x' } }] },
  { role: 'tool', toolCallId: id, name, content: '工具结果'.repeat(200) },
];

/* =====================================================================
 * 第一部分：compaction-test.js（运行中压缩 / 摘要复用 / 开关语义）
 * ===================================================================== */

test('场景 1：运行中压缩后，重建的请求保留本轮工具消息', async () => {
  state.hold = null;
  const ctx = agentCtxOf(toolRound('c1', 'memory_search'));
  const view1 = await AgentContext.compactMessages(ctx.slice());
  assert.ok(state.summarizeCalls > 0, '压缩触发（摘要被调用）');
  assert.equal(view1.filter(m => m.toolCalls && m.toolCalls.length).length, 1, 'assistant(toolCalls) 还在请求里');
  assert.ok(view1.some(m => m.role === 'tool' && m.toolCallId === 'c1'), 'tool 结果还在请求里且带 toolCallId');
  assert.ok(!view1.some(m => m.role === 'assistant' && !m.content && !(m.toolCalls && m.toolCalls.length)),
    '无「空正文且无工具调用」的 assistant 残留');
  assert.ok(state.cur.compaction && state.cur.compaction.upTo <= state.hist.length && state.cur.compaction.upTo > 0,
    'compaction 落在会话上（upTo 不超过 history 长度）upTo='
      + (state.cur.compaction && state.cur.compaction.upTo) + '/' + state.hist.length);
});

test('场景 2：同一轮运行里再次 transformContext —— 复用摘要，不再调模型', async () => {
  const before = state.summarizeCalls;
  const ctx = agentCtxOf([...toolRound('c1', 'memory_search'), ...toolRound('c2', 'memory_write')]);
  const view2 = await AgentContext.compactMessages(ctx.slice());
  assert.equal(state.summarizeCalls, before, `没有新的摘要调用（${before} → ${state.summarizeCalls}）`);
  assert.equal(view2.filter(m => m.role === 'tool').length, 2, '两轮工具消息都在请求里');
  assert.equal(view2.filter(m => m.__compaction).length, 1, '摘要消息只插一条');
});

test('场景 3：复用后仍超限 —— 允许重新压缩划界（不卡死在旧切分点）', async () => {
  const before = state.summarizeCalls;
  const huge = toolRound('c3', 'memory_search').map(m => ({ ...m, content: '巨'.repeat(20000) }));
  const ctx = agentCtxOf([...toolRound('c1', 'memory_search'), ...toolRound('c2', 'memory_write'), ...huge]);
  const view3 = await AgentContext.compactMessages(ctx.slice());
  assert.ok(state.summarizeCalls > before, '重新压缩发生（又调了摘要）');
  assert.ok(view3.length < ctx.length - 1 || view3.every(m => m.role !== 'tool' || m.toolCallId !== 'c1'),
    `重建视图不含被覆盖前缀（比完整上下文小）view3 ${view3.length} 条 / ctx ${ctx.length} 条`);
});

test('场景 4：关掉压缩提示词 → compactMessages 原样返回（不调模型、不写摘要）', async () => {
  /* 旧实现里 compactMessages 从不看这个开关，关掉之后压缩照跑（既调模型写摘要、
     又由 app.js 的裁剪分支 shift 掉旧消息，一次关开关得到两种机制叠加）。 */
  Prompts.setEnabled('compact.prompt', false);
  delete state.cur.compaction;
  const callsBefore = state.summarizeCalls;
  const ctx4 = agentCtxOf([...toolRound('c1', 'memory_search')]);
  const view4 = await AgentContext.compactMessages(ctx4.slice());
  assert.equal(AgentContext.autoCompactOn(), false, '判据 autoCompactOn() 为假');
  assert.equal(state.summarizeCalls, callsBefore, `没有新的摘要调用（${callsBefore} → ${state.summarizeCalls}）`);
  assert.equal(view4.length, ctx4.length, `消息原样返回（条数与入参一致）${view4.length}/${ctx4.length}`);
  assert.ok(!state.cur.compaction, '没有写到会话上的摘要');
});

test('场景 4b：把提示词清空（开关仍开着）同样不压缩', async () => {
  Prompts.setEnabled('compact.prompt', true);
  Prompts.set('compact.prompt', '');
  const view4b = await AgentContext.compactMessages(agentCtxOf([]).slice());
  assert.equal(AgentContext.autoCompactOn(), false, '空提示词也算关闭');
  assert.equal(view4b.length, agentCtxOf([]).length, '原样返回');
  Prompts.reset('compact.prompt');
  assert.equal(AgentContext.autoCompactOn(), true, '恢复默认后又开启');
});

/* =====================================================================
 * 第二部分：audit4-test.js（取消压缩 / 防重入 / await 期间一致性）
 * 原文件用 numCtx=9000：4 轮大消息 ≈ 24000 tok ≫ 7200（80% 阈值）。
 * ===================================================================== */

const bigCtx = () => {
  const msgs = [{ role: 'system', content: '系统' }];
  for (let i = 0; i < 4; i++) {
    msgs.push({ role: 'user', content: bigText });
    msgs.push({ role: 'assistant', content: bigText });
  }
  return msgs;                               // ≈ 24000 tok ≫ 7200
};
const fillHistory = (pairs) => {
  state.hist = [];
  for (let i = 0; i < pairs; i++) {
    state.hist.push({ role: 'user', content: bigText }, { role: 'assistant', content: bigText });
  }
};

test('场景 A：取消压缩后，运行中下一轮 transformContext 不得复用已取消的摘要', async () => {
  state.numCtx = 9000;
  state.hist = [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }];
  state.cur = { id: 's1', msgs: [], compaction: null };
  state.summarizeCalls = 0;
  state.hold = null;
  const ctx = bigCtx();
  const view1 = await AgentContext.compactMessages(ctx.slice());        // 首次压缩：写 sess.compaction + compactCache
  assert.ok(view1.length < ctx.length, `首次压缩生效（视图比原上下文小）${view1.length}/${ctx.length}`);
  assert.ok(!!(state.cur.compaction && state.cur.compaction.text), 'sess.compaction 已写入');

  AgentContext.uncompact();                                             // 用户点「取消压缩」
  assert.ok(!state.cur.compaction, '取消后 compaction 为空');
  state.summarizeCalls = 0;
  let threw = null;
  try { await AgentContext.compactMessages(ctx.slice()); }              // 旧代码在这里 compactHeader(undefined) TypeError
  catch (e) { threw = e; }
  assert.ok(!threw, '取消后下一轮压缩不抛 TypeError' + (threw ? '：' + threw.message : ''));
  assert.equal(state.summarizeCalls, 1, `走了重新压缩（复用分支没有拿旧摘要）summarize 调用 ${state.summarizeCalls} 次`);
  assert.ok(!!(state.cur.compaction && state.cur.compaction.text), '重新压缩后 compaction 重新写入');
});

test('场景 B：手动压缩的防重入与 finally 复位', async () => {
  state.numCtx = 9000;
  state.summarizeCalls = 0;
  fillHistory(8);
  state.cur = { id: 's1', msgs: [], compaction: null };
  let release;
  state.hold = new Promise((r) => { release = r; });
  const r1 = AgentContext.compactNow();                                 // 真压缩（异步进行中）
  await Promise.resolve(); await Promise.resolve();
  state.lastToast = '';
  await AgentContext.compactNow();                                      // 并发的第二个调用
  assert.ok(state.lastToast.includes('正在压缩'), `并发手动压缩被拦（toast 提示压缩中）${state.lastToast}`);
  release();
  await r1;
  state.hold = null;
  state.lastToast = '';
  await AgentContext.compactNow();                                      // r1 完成后再调：不得再提示"压缩中"
  assert.ok(!state.lastToast.includes('正在压缩'), `压缩完成后 compacting 复位（finally）${state.lastToast}`);
  assert.ok(state.summarizeCalls >= 2, `复位后这次真的发起压缩了（summarize 共 ${state.summarizeCalls} 次）`);
});

test('场景 C：await 期间换会话——摘要不写错地方', async () => {
  const sessA = { id: 'A', msgs: [], compaction: null };
  const sessB = { id: 'B', msgs: [], compaction: null };
  state.cur = sessA; fillHistory(8);
  let release;
  state.hold = new Promise((r) => { release = r; });
  const pending = AgentContext.compactNow();                            // 对 A 发起手动压缩
  state.cur = sessB;                                                    // await 期间切到 B
  release();
  await pending;
  state.hold = null;
  assert.ok(!sessA.compaction, '切会话后旧会话没被写入摘要' + (sessA.compaction ? sessA.compaction.text : ''));
});

test('场景 D：await 期间删消息——坐标不写回', async () => {
  state.cur = { id: 'D', msgs: [], compaction: null };
  fillHistory(8);
  const len0 = state.hist.length;
  let release;
  state.hold = new Promise((r) => { release = r; });
  const pending = AgentContext.compactNow();
  state.hist.splice(0, 4);                                              // await 期间删掉两轮
  release();
  await pending;
  state.hold = null;
  assert.ok(!state.cur.compaction,
    '历史变了就不写摘要坐标' + (state.cur.compaction ? `upTo=${state.cur.compaction.upTo}` : ''));
  assert.equal(state.hist.length, len0 - 4, '历史确实被删过（前提成立）');
});
