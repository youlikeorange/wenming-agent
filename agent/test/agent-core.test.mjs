/* Agent 内核单测：
 * 不依赖浏览器/网络，用假 stream 验证循环行为。
 * 移植改动：CommonJS + 手写 assert → node:test + node:assert/strict；
 *           被测模块从 IIFE 全局对象改为 ESM `import { Agent } from '../src/core/agent.js'`。
 * 每条断言与中文测试名逐条对应原文件。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/core/agent.js';

/** 造一个假的流式模型：按脚本依次返回（每轮一个元素） */
function fakeStream(script) {
  let i = 0;
  return async function* () {
    const step = script[Math.min(i++, script.length - 1)];
    if (step.think) yield { type: 'thinking', text: step.think };
    if (step.content) yield { type: 'content', text: step.content };
    if (step.calls) yield { type: 'tool_calls', calls: step.calls };
    if (step.stop) yield { type: 'stop', reason: step.stop };
  };
}
const call = (id, name, args) => ({ id, name, args });

test('场景 A：工具两轮 + 最终回答，中途插话被注入', async () => {
  const notices = [], toolMsgs = [];
  const steering = ['用户插话'];
  const out = await Agent.run({
    maxRounds: 6,
    stream: fakeStream([
      { calls: [call('t1', 'web_search', { query: 'x' })] },
      { calls: [call('t2', 'read_file', { path: '/tmp/a' })] },
      { content: '最终回答' },
    ]),
    getSteering: () => steering.splice(0),
    getFollowUps: () => [],
    runTool: async (c) => { toolMsgs.push(c.name); return { ok: true, text: c.name + '结果' }; },
    hooks: { onNotice: (n) => notices.push(n.kind) },
  });
  assert.equal(out.content, '最终回答', '最终回答正确');
  assert.equal(out.rounds, 2, '工具轮次 = 2（实际 ' + out.rounds + '）');
  assert.equal(out.injectedTurns, 1, '插话注入了一轮（实际 ' + out.injectedTurns + '）');
  assert.equal(notices.length, 0, '无多余通知');
});

test('场景 B：轮次到顶后不再消费插话（留给宿主）', async () => {
  const queue = ['插话1', '插话2'];
  let injected = 0;
  const out = await Agent.run({
    maxRounds: 2,
    stream: fakeStream([
      { calls: [call('t1', 'run_command', { command: 'ls' })] },
      { calls: [call('t2', 'run_command', { command: 'ls' })] },
      { calls: [call('t3', 'run_command', { command: 'ls' })] },
      { content: '不该走到这' },
    ]),
    getSteering: () => { const v = queue.shift() || []; if (v.length) injected++; return v; },
    runTool: async () => ({ ok: true, text: 'ok' }),
  });
  assert.equal(out.rounds, 2, '到 maxRounds=2 停（实际 ' + out.rounds + '）');
  assert.equal(injected, 1, '只在轮次未满时消费过一条（消费次数 ' + injected + '）');
  assert.equal(queue.length, 1, '到顶后剩余插话留给宿主（剩 ' + queue.length + ' 条）');
});

test('场景 C：外循环 follow-up（最终回答后再跑一轮）', async () => {
  let rounds2 = 0;
  const out = await Agent.run({
    maxRounds: 6,
    stream: fakeStream([
      { content: '第一次回答' },
      { content: '追问答复' },
    ]),
    getSteering: () => [],
    getFollowUps: () => (rounds2++ === 0 ? ['排队的问题'] : []),
    runTool: async () => ({ ok: true, text: 'ok' }),
  });
  assert.equal(out.content, '第一次回答追问答复', '外循环的追加回答拼进结果（实际：' + out.content + '）');
  assert.equal(rounds2, 2, 'getFollowUps 取空后外循环终止（调用次数 ' + rounds2 + '）');
});

test('场景 D：截断保护与 notice kind', async () => {
  const notices = [];
  const out = await Agent.run({
    maxRounds: 6,
    stream: fakeStream([
      { calls: [call('t1', 'web_search', {})], stop: 'length' },   // 截断：必填参数没带上
      { content: '重来后的回答' },
    ]),
    getSteering: () => [],
    runTool: async () => { throw new Error('不该执行'); },
    hooks: { onNotice: (n) => notices.push(n) },
    tools: [{ function: { name: 'web_search', parameters: { required: ['query'] } } }],
  });
  assert.ok(notices.some(n => n.kind === 'truncated'), '截断通知 kind=truncated');
  assert.equal(out.content, '重来后的回答', '截断后继续并拿到回答');
});

test('场景 E：重复保护（写类工具同参第二次回绝、失败可重试）', async () => {
  let n = 0, sawDup = false, sawFail = false;
  await Agent.run({
    maxRounds: 6,
    stream: fakeStream([
      { calls: [call('t1', 'write_file', { path: '/a', content: 'x' })] },
      { calls: [call('t2', 'write_file', { path: '/a', content: 'x' })] },
      { calls: [call('t3', 'write_file', { path: '/b', content: 'y' })] },
      { content: '完成' },
    ]),
    getSteering: () => [],
    runTool: async (c) => {
      n++;
      if (c.id === 't2') sawDup = true;
      if (c.id === 't3') sawFail = true;
      return c.id === 't3' ? { ok: false, text: 'boom' } : { ok: true, text: 'done' };
    },
  });
  assert.ok(sawDup, '同参写类第二次仍会执行（回绝在结果里，不是不执行）');
  assert.ok(sawFail, '失败调用不阻止后续');
  assert.equal(n, 3, '三次调用都到达执行层（实际 ' + n + '）');
});

test('场景 F：轮次到顶后外循环（follow-up）也不许续轮', async () => {
  /* 一轮审计只给内循环的 takeSteering 加了轮次闸门，外循环的 getFollowUps 照取不误：
     宿主在生成中持续输入时，模型能被一直调用下去（实测 maxRounds=2 时调了 6 次），
     而 out.rounds 始终显示 2。本场景专门给 getFollowUps 供货——旧测试只给 getSteering，
     所以一直没覆盖到这条路径。 */
  let calls = 0, followTaken = 0;
  const out = await Agent.run({
    maxRounds: 2,
    // 三条命令**参数各不相同**：同参会被重复保护回绝（那是另一条不变量，见场景 E）
    stream: fakeStream([
      { calls: [call('t1', 'run_command', { command: 'ls' })] },
      { calls: [call('t2', 'run_command', { command: 'ls -a' })] },
      { calls: [call('t3', 'run_command', { command: 'ls -l' })] },
      { content: '不该走到这' },
    ]),
    getSteering: () => [],
    getFollowUps: () => { followTaken++; return ['继续追问']; },
    runTool: async () => { calls++; return { ok: true, text: 'ok' }; },
  });
  assert.equal(calls, 2, '工具只执行到 maxRounds 次（实际 ' + calls + '）');
  assert.equal(out.rounds, 2, '轮次计数不被外循环推高（实际 ' + out.rounds + '）');
  assert.equal(followTaken, 0, '轮次到顶后不再取 follow-up（调用次数 ' + followTaken + '）');
  assert.equal(out.content, '', '没有多跑出回答（实际 ' + JSON.stringify(out.content) + '）');
});

test('场景 G：工具执行期间 abort → 返回 stopped 而非抛异常', async () => {
  /* 内核在工具执行中收到 abort 不抛异常，而是 break 出去返回 stopped:true。
     宿主必须读这个字段（app.js 已按此标注"已停止生成"），本场景锁住该契约。 */
  const ac = new AbortController();
  const out = await Agent.run({
    maxRounds: 6,
    signal: ac.signal,
    stream: fakeStream([{ calls: [call('t1', 'run_command', { command: 'sleep 1' })] }, { content: '不该到这' }]),
    getSteering: () => [],
    runTool: async () => { ac.abort(); return { ok: true, text: 'done' }; },
  });
  assert.equal(out.stopped, true, '返回 stopped=true（实际 ' + out.stopped + '）');
  assert.equal(out.rounds, 1, '停在中断的那一轮（实际 ' + out.rounds + '）');
  assert.ok(!out.content, '没有继续产出内容');
});

test('场景 G2：读流读到一半 abort（上游被掐断）→ 同样返回 stopped，已生成的内容保留', async () => {
  /* 2026-10-01 用户报的「点停止没反应」在内核这一侧的一半：宿主 abort 之后，上游连接被掐断，
     读流处会抛 AbortError（服务端是 run-upstream 的 AbortError，浏览器是 ApiError(aborted)）。
     旧实现让这个异常直接冒出去，宿主只能按"请求失败"收尾——用户点了停止，却看到红色错误块。
     现在与"两轮之间发现 abort"同一条出口：返回 stopped + 已生成内容。 */
  const ac = new AbortController();
  async function* cutMidStream() {
    yield { type: 'content', text: '前半段' };
    ac.abort();
    throw Object.assign(new Error('已停止'), { name: 'AbortError', aborted: true });
  }
  const out = await Agent.run({
    maxRounds: 6,
    signal: ac.signal,
    stream: () => cutMidStream(),
    getSteering: () => [],
    runTool: async () => ({ ok: true, text: '不该执行' }),
  });
  assert.equal(out.stopped, true, '返回 stopped=true（实际 ' + out.stopped + '）');
  assert.equal(out.content, '前半段', '中断前生成的内容一个字都不丢（实际 ' + JSON.stringify(out.content) + '）');
  assert.equal(out.rounds, 0, '停在中断的那一轮（实际 ' + out.rounds + '）');
});

test('场景 G3：不是中断的流错误照旧抛出去（别把真错误都吞成"已停止"）', async () => {
  /* 上一条的反面：上游 500 / 网络故障没有 abort 信号，必须原样抛出——
     否则真故障会被伪装成"用户停止"，错误在界面上再也看不见。 */
  async function* boom() {
    yield { type: 'content', text: '半句' };
    throw new Error('上游 500：boom');
  }
  await assert.rejects(
    () => Agent.run({ maxRounds: 2, stream: () => boom(), getSteering: () => [] }),
    /上游 500：boom/,
    '非中断错误必须抛出',
  );
});

test('场景 H：只有思考、没有正文 → 算空回答，重试前追加提醒并拿到正文', async () => {
  /* 2026-09-22 用户报的"发出信息不调用 LLM"真身：模型思考完就停，正文一个字没写。
     旧判据（!roundContent && !roundThinking && !calls）把它当"回答完成"存下来，
     会话里留下一个空气泡。现在必须重试；第二次重试前追加提醒（texts.noContent）。 */
  const notices = [];
  const sentNudge = [];
  const history = [{ role: 'user', content: '问题' }];        // 宿主的历史（提醒不该写进这里）
  const script = fakeStream([{ think: '我先想一想……' }, { content: '正文来了' }]);
  const out = await Agent.run({
    maxRounds: 6,
    messages: history,
    stream: (msgs) => {
      sentNudge.push(msgs.some((m) => m.content === '请直接给出正文'));
      return script();
    },
    getSteering: () => [],
    runTool: async () => ({ ok: true, text: 'ok' }),
    texts: { noContent: '请直接给出正文' },
    hooks: { onNotice: (n) => notices.push(n.kind) },
  });
  assert.equal(out.content, '正文来了', '重试后拿到正文（实际 ' + JSON.stringify(out.content) + '）');
  assert.equal(notices.filter(k => k === 'empty_retry').length, 1, '只重试了一次');
  assert.deepEqual(sentNudge, [false, true], '第二次请求才带上提醒（实际 ' + JSON.stringify(sentNudge) + '）');
  assert.equal(history.length, 1, '提醒只进本轮工作上下文，没写进宿主历史（实际 ' + history.length + ' 条）');
});

test('场景 I：一直不给正文 → 报错，绝不静默返回空回答', async () => {
  let attempts = 0;
  let err = '';
  try {
    await Agent.run({
      maxRounds: 6,
      stream: async function* () { attempts++; yield { type: 'thinking', text: '想' }; yield { type: 'stop', reason: 'stop' }; },
      getSteering: () => [],
      runTool: async () => ({ ok: true, text: 'ok' }),
      texts: { noContent: '请直接给出正文' },
    });
  } catch (e) { err = e.message; }
  assert.equal(attempts, 3, '一共尝试 3 次（首轮 + 2 次重试，实际 ' + attempts + '）');
  assert.ok(/没有给出回答正文/.test(err), '报错点明"没有给出回答正文"（实际：' + err.slice(0, 40) + '）');
});

/* ---- 2026-09-30：正文型工具调用（DSML / XML）与截断提示 ---- */

test('场景 J：正文里认回来的工具调用照常执行，并给出一条提示', async () => {
  /* 有的上游把工具调用写进正文（DSML 标记 / XML），协议层会认回来并标 recovered:true。
     内核要照常执行（旧实现把它当"最终回答"，循环直接收尾），并通知宿主让用户知道。 */
  const notices = [], ran = [];
  /* 自己写流：fakeStream 不转发 recovered 标记，而本场景要的正是它 */
  let step = 0;
  const out = await Agent.run({
    maxRounds: 4,
    stream: async function* () {
      if (step++ === 0) {
        yield { type: 'content', text: '我来改。' };
        yield { type: 'tool_calls', calls: [{ id: 'text_1', name: 'edit_file', args: { path: '/a.md' } }], recovered: true };
      } else yield { type: 'content', text: '改好了' };
    },
    getSteering: () => [],
    runTool: async (c) => { ran.push(c.name); return { ok: true, text: 'ok' }; },
    texts: { textCalls: '已自动识别正文里的工具调用' },
    hooks: { onNotice: (n) => notices.push(n) },
  });
  assert.deepEqual(ran, ['edit_file'], '正文里认回的调用要真的执行');
  assert.equal(out.content, '我来改。改好了', '前导文字 + 最终回答都在');
  assert.deepEqual(notices.map((n) => n.kind), ['text_tool_calls'], '提示一次（kind 结构化）');
  assert.equal(notices[0].text, '已自动识别正文里的工具调用', '文案取自注入的登记表');
});

test('场景 K：只有正文但撞到输出上限 → 提示"回答被截断"，不静默当完整回答', async () => {
  const notices = [];
  const out = await Agent.run({
    maxRounds: 4,
    stream: fakeStream([{ content: '前半段……', stop: 'length' }]),
    getSteering: () => [],
    runTool: async () => ({ ok: true, text: 'ok' }),
    texts: { truncatedAnswer: '这轮被截断了' },
    hooks: { onNotice: (n) => notices.push(n) },
  });
  assert.equal(out.content, '前半段……', '已生成的内容保留');
  assert.deepEqual(notices.map((n) => n.kind), ['truncated_answer'], '打一条截断提示');
});

test('场景 L：trace 里的长参数值被截断（写大文件不再把几 MB 内容存进会话）', async () => {
  const big = 'x'.repeat(50000);
  const out = await Agent.run({
    maxRounds: 4,
    stream: fakeStream([
      { calls: [{ id: 't1', name: 'write_file', args: { path: '/tmp/big.txt', content: big } }] },
      { content: '写好了' },
    ]),
    getSteering: () => [],
    runTool: async () => ({ ok: true, text: 'ok' }),
  });
  const t = out.trace[0];
  assert.equal(t.args.path, '/tmp/big.txt', '短字段照原样（界面标题靠它）');
  assert.ok(t.args.content.length < 2100, '长字段被截断（实际 ' + t.args.content.length + ' 字）');
  assert.ok(/已截断/.test(t.args.content), '截断处有说明');
  assert.equal(Agent.shrinkArgs({ a: 'y'.repeat(10) }).a.length, 10, '短值不动');
});
