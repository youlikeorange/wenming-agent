/* parallel-sessions.test.mjs —— **多会话并行**的客户端行为（2026-10-01 用户要求）
 *
 *  要求原文："让子项目 agent 支持并行处理多个会话……处理会话的时候前端可以点击其他会话查看"。
 *  这条链路上最容易悄悄坏掉的是**接线与时序**（服务端能并发、界面却把别的会话当"正在生成"挡住），
 *  所以这些用例真跑模块（与 hosted-run.test.mjs 同一套就地加载器 + fetch 路由桩）：
 *
 *    ① 两条会话同时在跑：各自的内容进各自那条消息，互不串；
 *    ② 生成中切会话：不拦、不丢，切走的会话内容还在继续长（统一个事件口只连一条）；
 *    ③ 生成中新建对话：允许（旧实现被 state.streaming 拦下）；
 *    ④ 归档正在跑的会话：拦住（服务端会把它搬走，而运行还在往里写）；
 *    ⑤ 上游报错：在会话里看得见（msg.error + 重试入口的数据形状）；
 *    ⑥ 子智能体：spawn_agent 那张卡（kind='sub'、subId、过程文本）能长出来。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

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

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/** 两条会话的现场：s1 在跑（liveId m1x），s2 也在跑（liveId m2x）；当前正看 s1 */
async function twoRunning(stub) {
  const { state } = await import('../src/ui/state/store.js');
  const Run = await import('../src/ui/state/run.js');
  const m1 = [{ id: 'u1', role: 'user', content: '问一' }, { id: 'a1', role: 'assistant', content: '', streaming: true, trace: [] }];
  const m2 = [{ id: 'u2', role: 'user', content: '问二' }, { id: 'a2', role: 'assistant', content: '', streaming: true, trace: [] }];
  state.sessions = [{ id: 's1', title: '一', ts: 2, msgs: m1 }, { id: 's2', title: '二', ts: 1, msgs: m2 }];
  state.activeSessId = 's1';
  state.history = m1.slice();
  state.currentProjectId = '';
  const runs = [
    { runId: 'r1', sessionId: 's1', liveId: 'a1', status: 'running', title: '一', startedAt: 2 },
    { runId: 'r2', sessionId: 's2', liveId: 'a2', status: 'running', title: '二', startedAt: 1 },
  ];
  const r = stub({
    '/agent/run/state': () => json({ ok: true, run: runs[0], runs, busy: runs }),
    '/agent/run/hub': () => sse([
      { type: 'hub_snapshot', runs },
      { type: 'replay_start', runId: 'r1', sessionId: 's1', liveId: 'a1', truncated: false, status: 'running' },
      { type: 'replay_start', runId: 'r2', sessionId: 's2', liveId: 'a2', truncated: false, status: 'running' },
      { type: 'content', runId: 'r1', sessionId: 's1', text: '一号回答' },
      { type: 'content', runId: 'r2', sessionId: 's2', text: '二号回答' },
      { type: 'end', runId: 'r2', sessionId: 's2', status: 'done', ms: 7, title: '二（已命名）' },
      { type: 'content', runId: 'r1', sessionId: 's1', text: '，还在继续' },
    ]),
  });
  await Run.reattach('s1');
  await tick(120);
  return { state, Run, m1, m2, calls: r.calls, restore: r.restore };
}

test('★★ 两条会话同时跑：内容各进各的消息，互不串；切到另一条也照样更新', async () => {
  const ctx = await twoRunning(stubRoutes);
  const { state, m1, m2 } = ctx;
  try {
    assert.equal(m1[1].content, '一号回答，还在继续', 's1 的正文进了 s1 的消息');
    assert.equal(m2[1].content, '二号回答', 's2 的正文进了 s2 的消息（没有写到当前会话上）');
    assert.equal((state.runs.s2 || {}).settled, true, 's2 已收尾');
    assert.equal((state.runs.s1 || {}).settled, false, 's1 还在跑');
    assert.equal(state.streaming, true, '当前看的 s1 在生成 → 界面显示生成态');
    assert.equal(state.sessions[0].title, '一', '当前会话标题没被后台那条覆盖');
    assert.equal(state.sessions[1].title, '二（已命名）', '★ 后台会话的标题按它自己的 end 事件更新');
    /* 只连一条事件流：两条会话的事件都从它来（"统一归口"） */
    assert.equal(ctx.calls.filter((c) => c.url.includes('/agent/run/hub')).length, 1, '★ 一条 SSE 看全部会话');
  } finally { ctx.restore(); ctx.Run.reset(); }
});

test('★★ 生成中切会话：不拦、内容继续长（旧实现直接 toast 拦住"切换会话"）', async () => {
  const ctx = await twoRunning(stubRoutes);
  const { state } = ctx;
  try {
    const Session = await import('../src/ui/state/session.js');
    Session.selectSession('s2');                    // 正在生成 s1 时切到 s2
    assert.equal(state.activeSessId, 's2', '★ 生成中**可以**切到别的会话（旧实现 guardStreaming 拦住）');
    assert.equal(state.history[1].content, '二号回答', '切过去看到的是那条会话自己的内容');
    assert.equal(state.streaming, false, 's2 已经跑完了 → 这条不在生成态（s1 仍在跑，但那是它的事）');
    Session.selectSession('s1');                    // 再切回来
    assert.equal(state.streaming, true, '★ 切回还在跑的那条：生成态与内容都在（没有因为切走而中断）');
    assert.equal(state.history[1].content, '一号回答，还在继续');
  } finally { ctx.restore(); ctx.Run.reset(); }
});

test('★ 生成中可以新建对话（别的会话在跑不该挡住"开个新话题"）', async () => {
  const ctx = await twoRunning(stubRoutes);
  const { state } = ctx;
  try {
    const Session = await import('../src/ui/state/session.js');
    const before = state.sessions.length;
    Session.newSession();
    assert.equal(state.sessions.length, before + 1, '★ 新建成功（旧实现被 state.streaming 拦下）');
    assert.equal(state.streaming, false, '新会话自己不在生成态');
    assert.equal((state.runs.s1 || {}).settled, false, '另一条会话的运行不受影响，还在跑');
  } finally { ctx.restore(); ctx.Run.reset(); }
});

test('★ 归档正在跑的会话：拦住（服务端会把它搬走，而运行还在往里写）', async () => {
  const ctx = await twoRunning(stubRoutes);
  const { state } = ctx;
  try {
    const Session = await import('../src/ui/state/session.js');
    await Session.archiveSession('s1');
    assert.ok(state.sessions.some((s) => s.id === 's1'), '★ 正在生成的会话不能被归档掉');
    await Session.archiveSession('s2');             // s2 已经跑完：可以归档
    assert.ok(!state.sessions.some((s) => s.id === 's2'), '跑完的那条照常可归档');
  } finally { ctx.restore(); ctx.Run.reset(); }
});

test('★★ 上游出错：错误显示在**那条会话**里（msg.error + 状态），不静默', async () => {
  const { state } = await import('../src/ui/state/store.js');
  const Run = await import('../src/ui/state/run.js');
  const m1 = [{ id: 'u1', role: 'user', content: '问' }, { id: 'a1', role: 'assistant', content: '', streaming: true, trace: [] }];
  state.sessions = [{ id: 's1', title: 'T', ts: 1, msgs: m1 }];
  state.activeSessId = 's1';
  state.history = m1.slice();
  const running = { runId: 'r1', sessionId: 's1', liveId: 'a1', status: 'running' };
  const r = stubRoutes({
    '/agent/run/state': () => json({ ok: true, run: running, runs: [running] }),
    '/agent/run/hub': () => sse([
      { type: 'hub_snapshot', runs: [running] },
      { type: 'replay_start', runId: 'r1', sessionId: 's1', liveId: 'a1', truncated: false, status: 'running' },
      { type: 'error', runId: 'r1', sessionId: 's1', text: 'HTTP 401：api key 无效', source: 'run', kind: 'auth', fatal: true },
      { type: 'end', runId: 'r1', sessionId: 's1', status: 'error', error: 'HTTP 401：api key 无效', errorKind: 'auth', ms: 3 },
    ]),
  });
  try {
    await Run.reattach('s1');
    await tick(80);
    assert.equal(m1[1].error, '请求失败：HTTP 401：api key 无效', '★ 错误挂在那条消息上（界面画错误块 + 重试）');
    assert.equal(state.runs.s1.error, 'HTTP 401：api key 无效', '运行记录里也带着错误（侧栏/诊断用）');
    assert.equal(state.streaming, false, '失败后退出生成态');
    assert.ok(!m1[1].streaming, '不能一直挂在"正在生成"');
  } finally { r.restore(); Run.reset(); }
});

test('★ 子智能体：spawn_agent 那张卡长出来了（过程实时，带 subId 可取完整记录）', async () => {
  const { state } = await import('../src/ui/state/store.js');
  const Run = await import('../src/ui/state/run.js');
  const m1 = [{ id: 'u1', role: 'user', content: '帮我查' }, { id: 'a1', role: 'assistant', content: '', streaming: true, trace: [] }];
  state.sessions = [{ id: 's1', title: 'T', ts: 1, msgs: m1 }];
  state.activeSessId = 's1';
  state.history = m1.slice();
  const running = { runId: 'r1', sessionId: 's1', liveId: 'a1', status: 'running' };
  const r = stubRoutes({
    '/agent/run/state': () => json({ ok: true, run: running, runs: [running] }),
    '/agent/run/hub': () => sse([
      { type: 'hub_snapshot', runs: [running] },
      { type: 'replay_start', runId: 'r1', sessionId: 's1', liveId: 'a1', truncated: false, status: 'running' },
      { type: 'tool_start', runId: 'r1', sessionId: 's1', token: 0, callId: 'tc1', name: 'spawn_agent', label: '子智能体：数测试', args: { task: '数测试' } },
      { type: 'sub_start', runId: 'r1', sessionId: 's1', subId: 'sub-1', callId: 'tc1', label: '数测试', task: '数一下有多少测试', model: 'm1', rounds: 6, tools: ['read_file', 'search_files'] },
      { type: 'sub_tool', runId: 'r1', sessionId: 's1', subId: 'sub-1', callId: 'tc1', label: '找文件：*.test', state: 'running' },
      { type: 'sub_tool', runId: 'r1', sessionId: 's1', subId: 'sub-1', callId: 'tc1', label: '找文件：*.test', state: 'done', ok: true },
      { type: 'sub_delta', runId: 'r1', sessionId: 's1', subId: 'sub-1', callId: 'tc1', text: '一共 170 个。' },
      { type: 'sub_end', runId: 'r1', sessionId: 's1', subId: 'sub-1', callId: 'tc1', ok: true, ms: 800, rounds: 2, tools: 1, text: '一共 170 个。' },
      { type: 'tool_end', runId: 'r1', sessionId: 's1', token: 0, callId: 'tc1', name: 'spawn_agent', label: '子智能体：数测试', ok: true, note: '子智能体完成', result: '子智能体「数测试」已完成（2 轮）。结论：一共 170 个。', ms: 810 },
    ]),
  });
  try {
    await Run.reattach('s1');
    await tick(80);
    const card = (m1[1].trace || []).find((t) => t.kind === 'sub');
    assert.ok(card, '★ 追踪条里要有那张子智能体卡（kind=sub）');
    assert.equal(card.subId, 'sub-1', '带 subId：点「查看记录」按它去取完整转录');
    assert.equal(card.runId, 'r1', '带 runId：转录按 run+sub 寻址');
    assert.match(String(card.result), /一共 170 个/, '过程/结论写在卡片上');
    assert.equal(card.state, 'done', 'tool_end 之后卡片结清（不是一直"进行中"）');
    assert.ok(!(m1[1].trace || []).some((t) => t.name === 'spawn_agent' && t.kind !== 'sub'), '不要同时留一张普通工具卡（同一件事只画一张）');
  } finally { r.restore(); Run.reset(); }
});

test('★ 发送后：提问与助手占位同时进**会话对象**（切走再回来能看到；新建对话据此判断"已有消息"）', async () => {
  const { state, defaultSettings } = await import('../src/ui/state/store.js');
  const Run = await import('../src/ui/state/run.js');
  const Session = await import('../src/ui/state/session.js');
  const host = await import('../src/ui/state/host.js');
  const { Store } = await import('../src/core/store.js');
  host.wireCore();
  Store.user = { username: 'u1' };
  state.info = { loggedIn: true, user: { username: 'u1' } };
  state.settings = Object.assign(defaultSettings(), {
    providers: [{ id: 'p1', name: 'P', type: 'openai', baseUrl: 'https://x/v1', model: 'm' }], activeId: 'p1',
  });
  const sess = { id: 's1', title: '新对话', ts: 1, msgs: [] };
  state.sessions = [sess];
  state.activeSessId = 's1';
  state.currentProjectId = '';
  state.history = [];
  state.streaming = false;
  const r = stubRoutes({
    '/agent/run/start': () => json({ ok: true, runId: 'r5' }),
    '/agent/run/hub': () => sse([{ type: 'hub_snapshot', runs: [{ runId: 'r5', sessionId: 's1', liveId: 'srv-1', status: 'running' }] },
      { type: 'replay_start', runId: 'r5', sessionId: 's1', liveId: 'srv-1', truncated: false, status: 'running' },
      { type: 'content', runId: 'r5', sessionId: 's1', text: '好' }]),
  });
  try {
    await Session.send('你好');
    await tick(80);
    /* 两处必须是同一批对象（会话对象是"切走再切回/下一次发送的 before"那份） */
    assert.equal(sess.msgs.length, 2, '★ 会话对象里也要有这一轮的提问与占位（实际 ' + sess.msgs.length + '）');
    assert.equal(sess.msgs[0].content, '你好');
    assert.equal(sess.msgs[1], state.history[1], '会话对象与 history 共用同一条助手消息对象');
    /* 事件按服务端 liveId 寻址：占位被认领（不会多出一条助手气泡） */
    assert.equal(sess.msgs[1].id, 'srv-1', '本窗口的占位认领了服务端的 liveId');
    assert.equal(state.history.filter((m) => m.role === 'assistant').length, 1, '★ 不能出现两条助手气泡');
    assert.equal(sess.msgs[1].content, '好', '正文写进了那条消息');
    /* 切走再回来：内容还在（旧实现只写 history，切回来这一轮就没了） */
    state.sessions.push({ id: 's2', title: '别处', ts: 2, msgs: [] });
    Session.selectSession('s2');
    Session.selectSession('s1');
    assert.equal(state.history.length, 2, '★ 切走再回来这一轮还在');
    assert.equal(state.history[1].content, '好');
    /* 新建对话：当前会话已经有消息 → 必须真的换一条（旧实现把"新建"变成原地清屏） */
    const n = state.sessions.length;
    Session.newSession();
    assert.equal(state.sessions.length, n + 1, '★ 当前会话有消息时「新建」要真的新建一条');
  } finally {
    r.restore();
    Run.reset();
    Store.user = null;
    state.info = null;
  }
});

test('★★ 运行在"统一口已经连着"之后才开始：事件也只会落进**一条**助手消息（不能每个事件冒一条气泡）', async () => {
  const { state, defaultSettings } = await import('../src/ui/state/store.js');
  const Run = await import('../src/ui/state/run.js');
  const host = await import('../src/ui/state/host.js');
  const { Store } = await import('../src/core/store.js');
  host.wireCore();
  Store.user = { username: 'u1' };
  state.info = { loggedIn: true, user: { username: 'u1' } };
  state.settings = Object.assign(defaultSettings(), {
    providers: [{ id: 'p1', name: 'P', type: 'openai', baseUrl: 'https://x/v1', model: 'm' }], activeId: 'p1',
  });
  const sess = { id: 's1', title: '新对话', ts: 1, msgs: [] };
  state.sessions = [sess];
  state.activeSessId = 's1';
  state.currentProjectId = '';
  state.history = [];
  state.streaming = false;
  let hubCalls = 0;
  const r = stubRoutes({
    '/agent/run/start': () => json({ ok: true, runId: 'r1' }),
    /* 第一条连接：空快照（连上时还没有运行）——这正是"先连上、后开跑"的形态 */
    '/agent/run/hub': () => {
      hubCalls++;
      if (hubCalls > 1) return sse([{ type: 'hub_snapshot', runs: [] }]);
      return sse([
        { type: 'hub_snapshot', runs: [] },
        /* 新运行开始：服务端宣告 run_started（带 liveId），随后才是内容分片 */
        { type: 'run_started', runId: 'r1', sessionId: 's1', liveId: 'srv-live' },
        { type: 'content', runId: 'r1', sessionId: 's1', text: '第一段' },
        { type: 'thinking', runId: 'r1', sessionId: 's1', text: '想' },
        { type: 'content', runId: 'r1', sessionId: 's1', text: '第二段' },
      ]);
    },
  });
  try {
    await Run.ensureHub();
    await tick(40);
    /* 直接驱动托管运行那一层（没有 session.js 的占位）：事件先到也不该冒多条消息 */
    await Run.startRun({ sessionId: 's1', text: '你好', providerId: 'p1', before: [] });
    await tick(120);
    const assistants = state.history.filter((m) => m.role === 'assistant');
    assert.equal(assistants.length, 1, '★ 只能有一条助手消息（旧实现每个事件现造一条，实际 ' + assistants.length + '）');
    assert.equal(assistants[0].content, '第一段第二段', '分片都落在同一条上');
    assert.equal(assistants[0].thinking, '想');
    assert.equal(assistants[0].id, 'srv-live', '★ 认领服务端的 liveId（刷新/换窗口后还能对上）');
  } finally { r.restore(); Run.reset(); Store.user = null; state.info = null; }
});

test('★★ 事件比 POST 响应先到（run_started 早于 /start 返回）：也只留**一条**助手消息', async () => {
  const { state, defaultSettings } = await import('../src/ui/state/store.js');
  const Run = await import('../src/ui/state/run.js');
  const Session = await import('../src/ui/state/session.js');
  const host = await import('../src/ui/state/host.js');
  const { Store } = await import('../src/core/store.js');
  host.wireCore();
  Store.user = { username: 'u1' };
  state.info = { loggedIn: true, user: { username: 'u1' } };
  state.settings = Object.assign(defaultSettings(), {
    providers: [{ id: 'p1', name: 'P', type: 'openai', baseUrl: 'https://x/v1', model: 'm' }], activeId: 'p1',
  });
  const sess = { id: 's1', title: '新对话', ts: 1, msgs: [] };
  state.sessions = [sess];
  state.activeSessId = 's1';
  state.currentProjectId = '';
  state.history = [];
  state.streaming = false;
  const r = stubRoutes({
    /* POST 故意慢一拍：先让统一口把 run_started + 分片吐出来（服务端就是这个顺序） */
    '/agent/run/start': async () => { await tick(120); return json({ ok: true, runId: 'r1' }); },
    '/agent/run/hub': () => sse([
      { type: 'hub_snapshot', runs: [] },
      { type: 'run_started', runId: 'r1', sessionId: 's1', liveId: 'srv-1' },
      { type: 'content', runId: 'r1', sessionId: 's1', text: '第一段' },
    ]),
  });
  try {
    await Run.ensureHub();
    await tick(40);
    await Session.send('你好');
    await tick(200);
    const assistants = state.history.filter((m) => m.role === 'assistant');
    assert.equal(assistants.length, 1, '★ 只能有一条助手消息（实际 ' + assistants.length + '：占位与 liveId 消息并存就是两个气泡）');
    assert.equal(assistants[0].id, 'srv-1', '正文落在服务端那条消息上');
    assert.equal(assistants[0].content, '第一段');
    assert.equal(state.streaming, true, '生成态照常');
    /* 登记表里也得是"合并过"的那一条记录 */
    assert.equal((state.runs.s1 || {}).runId, 'r1', 'runId 拿到响应后补上');
  } finally { r.restore(); Run.reset(); Store.user = null; state.info = null; }
});

test('★★ 事件先到 + 占位被认领：那条消息不能被"清理多余占位"顺手删掉', async () => {
  const { state, defaultSettings } = await import('../src/ui/state/store.js');
  const Run = await import('../src/ui/state/run.js');
  const Session = await import('../src/ui/state/session.js');
  const host = await import('../src/ui/state/host.js');
  const { Store } = await import('../src/core/store.js');
  host.wireCore();
  Store.user = { username: 'u1' };
  state.info = { loggedIn: true, user: { username: 'u1' } };
  state.settings = Object.assign(defaultSettings(), {
    providers: [{ id: 'p1', name: 'P', type: 'openai', baseUrl: 'https://x/v1', model: 'm' }], activeId: 'p1',
  });
  const sess = { id: 's1', title: '新对话', ts: 1, msgs: [] };
  state.sessions = [sess];
  state.activeSessId = 's1';
  state.currentProjectId = '';
  state.history = [];
  state.streaming = false;
  const r = stubRoutes({
    /* POST 慢：run_started 与分片先到，且会把占位认领成服务端的 liveId；
       随后 POST 才返回——收尾时**不能**把这条已认领的消息当成"多余占位"删掉 */
    '/agent/run/start': async () => { await tick(150); return json({ ok: true, runId: 'r1' }); },
    '/agent/run/hub': () => sse([
      { type: 'hub_snapshot', runs: [] },
      { type: 'run_started', runId: 'r1', sessionId: 's1', liveId: 'srv-9' },
      { type: 'content', runId: 'r1', sessionId: 's1', text: '正文来了' },
    ]),
  });
  try {
    await Run.ensureHub();
    await tick(40);
    await Session.send('你好');
    await tick(260);
    const assistants = state.history.filter((m) => m.role === 'assistant');
    assert.equal(assistants.length, 1, '★ 那一条必须还在（实际 ' + assistants.length + '）');
    assert.equal(assistants[0].id, 'srv-9');
    assert.equal(assistants[0].content, '正文来了', '★ 正文不能被"清理占位"带走');
    assert.equal(sess.msgs.filter((m) => m.role === 'assistant').length, 1, '会话对象里同样只留一条');
  } finally { r.restore(); Run.reset(); Store.user = null; state.info = null; }
});

test('★ 刷新回来：服务端说"这条会话没有在跑的运行"→ 被中断那轮的占位要退出生成态（内容保留）', async () => {
  const { state } = await import('../src/ui/state/store.js');
  const Run = await import('../src/ui/state/run.js');
  const host = await import('../src/ui/state/host.js');
  const { Store } = await import('../src/core/store.js');
  Store.user = { username: 'u1' };
  /* 站点重启后：服务端落盘的那份里，在途那轮还带着 streaming:true（它没机会清） */
  const half = { id: 'a1', role: 'assistant', content: '半截内容', streaming: true, trace: [] };
  const sess = { id: 's1', title: 'T', ts: 1, msgs: [{ id: 'u1', role: 'user', content: '问' }, half] };
  state.sessions = [sess];
  state.activeSessId = 's1';
  state.history = sess.msgs.slice();
  state.currentProjectId = '';
  host.hooks.onPullLatest = async () => true;      // 拉取成功（服务端那份照样是 streaming:true）
  const r = stubRoutes({ '/agent/run/state': () => json({ ok: true, run: null, runs: [] }) });
  try {
    await Run.reattach('s1');
    const last = state.history[state.history.length - 1];
    assert.equal(last.streaming, undefined, '★ 必须退出生成态（否则永远挂着"正在思考…"）');
    assert.equal(last.content, '半截内容', '已经生成的内容一个字都不能丢');
    assert.equal(state.streaming, false);
  } finally {
    r.restore();
    host.hooks.onPullLatest = null;
    Store.user = null;
    Run.reset();
  }
});

test('★ 待下载：下载链接的形状（浏览器直连服务端，name 要编码）', async () => {
  const D = await import('../src/ui/state/downloads.js');   // 导入即接线（也顺带挡住坏 import）
  const url = D.downloadUrl('报告 说明.md');
  assert.match(url, /^\/agent\/files\/download\?name=/);
  assert.equal(decodeURIComponent(url.split('name=')[1]), '报告 说明.md', '中文与空格要编码后传');
  const { state } = await import('../src/ui/state/store.js');
  assert.ok(state.downloads && Array.isArray(state.downloads.entries), '状态里有待下载这个切片（菜单计数读它）');
});
