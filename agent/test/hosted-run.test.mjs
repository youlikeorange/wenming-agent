/* hosted-run.test.mjs —— 托管运行"客户端一半"的行为回归（2026-10-01 用户报的三条）
 *
 *  用户报的现象：
 *    ① 刷新页面后 agent 不再自动运行（服务端其实跑完了、也落盘了，界面停在半截内容上）；
 *    ② 换项目后菜单里的记忆没跟着换（"当前项目"与"当前会话"各说各话）；
 *    ③ 要求：服务器完全脱离前端跑，前端只负责显示——显示的那份必须是**服务端那份**。
 *
 *  为什么这些用例必须"真跑模块"而不是源码文本断言：三条全是**接线与时序**问题，文本看不出
 *  接线对不对（这个项目吃过"119 项测试全绿、线上全坏"的亏，见 regression.test.mjs 头注）。
 *  ui/state/*.js 的依赖链里有 .jsx（toast 组件），Node 默认不认，所以这里先装一个就地加载器，
 *  再把 fetch 换成路由桩，直接驱动真模块。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

/* 最小 DOM 桩：applyAppearance 会写 document.documentElement；core/store.js 与 core/presence.js
   在模块作用域挂 pagehide/visibilitychange（都带 typeof 判断，这里给上就够用）。 */
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

/** 路由桩：按 URL 片段命中；`calls` 记录顺序与请求头（用于断言"先读记忆再写 current"、
 *  "模型流量带窗口标识头"这类约定）。未命中的请求一律回 {ok:true}——避免测试之间因为
 *  别的链路（防抖写盘之类）漏网而炸。 */
function stubRoutes(routes) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, method: (init && init.method) || 'GET', headers: (init && init.headers) || {}, body: init && init.body });
    for (const [frag, make] of Object.entries(routes)) if (u.includes(frag)) return make(u, init);
    return json({ ok: true });
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/* ==================== ① 刷新之后要接上服务端在跑的那一段 ==================== */

test('★ 刷新后续播：落盘快照里 streaming 还是 true，也必须接上服务端在跑的那一段', async () => {
  const { state } = await import('../src/ui/state/store.js');
  const Run = await import('../src/ui/state/run.js');
  state.activeSessId = 's1';
  /* 刷新时从服务端拉到的历史：运行开始时服务端就写了占位（streaming:true），
     所以这条"看起来正在生成"的消息并不代表本地挂着读取连接——旧实现据此直接 return，
     于是永远不订阅、界面停在半截上。 */
  state.history = [
    { role: 'user', content: '在吗' },
    { role: 'assistant', content: '半截内容', thinking: '', trace: [], streaming: true },
  ];
  const r = stubRoutes({
    '/agent/run/state': () => json({ ok: true, run: { runId: 'r1', status: 'running', sessionId: 's1' } }),
    '/agent/run/events': () => sse([
      { type: 'replay_start', truncated: false, status: 'running' },
      { type: 'content', text: '完整回答' },
      { type: 'end', status: 'done', error: '', ms: 1234 },
    ]),
  });
  try {
    const run = await Run.reattach('s1');
    assert.equal(run && run.runId, 'r1', '必须认出服务端还在跑的那一段');
    assert.ok(r.calls.some((c) => c.url.includes('/agent/run/events')), '必须真的订阅事件流（旧实现被 streaming:true 挡在这里）');
    const last = state.history[state.history.length - 1];
    assert.equal(last.content, '完整回答', '回放要覆盖刷新时拉到的半截内容');
    assert.ok(!last.streaming, '收到结束事件后不该再挂着 streaming');
    assert.ok(!last.error, '跑完的那一轮不能被判成"没有跑完"');
    assert.equal(state.streaming, false, '整轮结束后界面退出生成态');
  } finally { r.restore(); }
});

test('★ 运行结束 / 模型改过数据：通知宿主持服务端那份重拉（界面显示服务端的数据）', async () => {
  const host = await import('../src/ui/state/host.js');
  const { state } = await import('../src/ui/state/store.js');
  const Run = await import('../src/ui/state/run.js');
  const seen = [];
  host.hooks.onRunDataChanged = () => seen.push('data');
  host.hooks.onRunEnded = (sid) => seen.push('end:' + sid);
  state.activeSessId = 's1';
  state.history = [{ role: 'user', content: 'x' }, { role: 'assistant', content: '', streaming: true }];
  const r = stubRoutes({
    '/agent/run/state': () => json({ ok: true, run: { runId: 'r2', status: 'running', sessionId: 's1' } }),
    '/agent/run/events': () => sse([
      { type: 'data_changed' },
      { type: 'content', text: 'ok' },
      { type: 'end', status: 'done', error: '', ms: 10 },
    ]),
  });
  try {
    await Run.reattach('s1');
    await tick(60);                     // 钩子是动态 import 之后调的
    assert.deepEqual(seen, ['data', 'end:s1'], '模型改数据与整轮结束都要通知宿主（旧实现把 data_changed 直接丢掉）');
  } finally {
    r.restore();
    host.hooks.onRunDataChanged = null; host.hooks.onRunEnded = null;
  }
});

test('★ 回来时这一轮已经跑完：先重拉服务端那份，再判定占位（不能把跑完的标成被打断）', async () => {
  const host = await import('../src/ui/state/host.js');
  const { state } = await import('../src/ui/state/store.js');
  const Run = await import('../src/ui/state/run.js');
  state.activeSessId = 's1';
  state.history = [{ role: 'user', content: 'x' }, { role: 'assistant', content: '半截', streaming: true, trace: [] }];
  let asked = '';
  host.hooks.onPullLatest = async (sid) => {
    asked = sid;
    state.history = [{ role: 'user', content: 'x' }, { role: 'assistant', content: '完整回答', wallMs: 9000, trace: [] }];
    return true;
  };
  const r = stubRoutes({ '/agent/run/state': () => json({ ok: true, run: null, busy: null }) });
  try {
    const out = await Run.reattach('s1');
    assert.equal(out, null, '没有在跑的运行');
    assert.equal(asked, 's1', '必须先向服务端确认落盘状态（旧实现直接按本地占位判"被打断"）');
    const last = state.history[state.history.length - 1];
    assert.equal(last.content, '完整回答');
    assert.ok(!last.error, '跑完的那一轮不能被标成"没有跑完"');
  } finally {
    r.restore();
    host.hooks.onPullLatest = null;
  }
});

test('★ 端到端：真接入 host 钩子后，刷新回来发现已跑完 → 界面显示服务端落盘的完整回答', async () => {
  const { Store } = await import('../src/core/store.js');
  await import('../src/ui/state/session.js');           // 导入即接线（hooks.onPullLatest → refreshAll）
  const { state } = await import('../src/ui/state/store.js');
  const Run = await import('../src/ui/state/run.js');
  Store.user = { username: 'admin' };
  state.activeSessId = 's1';
  state.history = [{ role: 'user', content: '问题' }, { role: 'assistant', content: '半截', streaming: true, trace: [] }];
  const r = stubRoutes({
    '/agent/run/state': () => json({ ok: true, run: null }),
    '/agent/store': () => json({
      ok: true,
      settings: { currentSess: 's1', providers: [], params: {}, theme: {}, ui: {}, tools: {} },
      sessions: [{
        id: 's1', title: '问题', ts: 2, project: '', msgs: [
          { role: 'user', content: '问题' },
          { role: 'assistant', content: '服务端落盘的完整回答', wallMs: 9000 },
        ],
      }],
      memory: [], prompts: { overrides: {}, skills: [], extra: [] },
      projects: [], currentProject: '',   // 项目记忆不在全量 store 里（唯一路径见 ②）
    }),
  });
  try {
    await Run.reattach('s1');
    const last = state.history[state.history.length - 1];
    assert.equal(last.content, '服务端落盘的完整回答', '显示的必须是服务端落盘的那份');
    assert.ok(!last.streaming && !last.error, '既不该停在生成中，也不该被判成被打断');
  } finally {
    r.restore();
    Store.user = null;                                  // 别让后面的用例带着身份去发写请求
  }
});

test('★ 读取断线：界面保持生成态并自动重连（这一轮还在服务端跑，不能闪"被打断"）', async () => {
  const { state } = await import('../src/ui/state/store.js');
  const Run = await import('../src/ui/state/run.js');
  state.activeSessId = 's1';
  state.history = [{ role: 'user', content: 'x' }, { role: 'assistant', content: '', streaming: true, trace: [] }];
  let stateCalls = 0;
  let eventsCalls = 0;
  const r = stubRoutes({
    '/agent/run/state': () => { stateCalls++; return json({ ok: true, run: { runId: 'r3', status: 'running', sessionId: 's1' } }); },
    '/agent/run/events': () => {
      eventsCalls++;
      if (eventsCalls === 1) {
        // 第一条连接：吐一个分片后直接断（隧道抖动 / 后台标签被节流的现实形态）
        const enc = new TextEncoder();
        return new Response(new ReadableStream({
          start(c) { c.enqueue(enc.encode('data: {"type":"content","text":"前半"}\n\n')); c.error(new Error('socket 断了')); },
        }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      /* 重连按**服务端的真实形态**回：先 replay_start，再把这一轮已发生的事件整份回放
         （所以第一条连接丢掉的那个分片不影响正确性——回放里什么都有）。 */
      return sse([
        { type: 'replay_start', truncated: false, status: 'running' },
        { type: 'content', text: '前半后半' },
        { type: 'end', status: 'done', error: '', ms: 5 },
      ]);
    },
  });
  try {
    await Run.reattach('s1');
    assert.equal(state.streaming, true, '断线后界面保持生成态（旧行为会先删掉占位、看着像被打断）');
    assert.ok(state.history[state.history.length - 1].streaming, '占位不能提前摘掉');
    await tick(3200);                                    // 内置的自动重连延迟是 2.5s
    assert.ok(stateCalls >= 2, '必须自动重连一次（再问服务端这一轮还在不在）');
    assert.equal(state.history[state.history.length - 1].content, '前半后半', '重连后按回放补齐内容');
    assert.equal(state.streaming, false, '结束事件之后退出生成态');
  } finally { r.restore(); }
});

/* ==================== ② 取数归口（2026-10-01 用户要求） ==================== */

test('★ 模型流量走统一请求层：带窗口标识头（单窗口互斥才拦得住），错误分类也统一', async () => {
  const { upstreamModels, upstreamChat } = await import('../src/core/protocol/transport.js');
  const { CLIENT_HEADER, AUTH_HEADER } = await import('../src/core/endpoints.js');
  const http = await import('../src/core/http.js');
  const r = stubRoutes({
    '/agent/upstream/models': () => json({ data: [{ id: 'm1' }] }),
    '/agent/upstream/chat': () => new Response('', { status: 401, headers: { 'content-type': 'application/json', [AUTH_HEADER]: 'need-login' } }),
  });
  try {
    const models = await upstreamModels({ provider: 'p1' });
    assert.deepEqual(models, { data: [{ id: 'm1' }] }, '模型清单原样回上游 JSON');
    const call = r.calls[0];
    assert.ok(call.headers[CLIENT_HEADER], `模型流量必须带 ${CLIENT_HEADER}（旧实现自己 fetch，漏了它 → 被顶掉的窗口照样能烧 token）`);
    assert.equal(call.headers['Content-Type'], 'application/json', 'JSON 体与 Content-Type 由统一层补');

    // 401 + X-Agent-Auth: need-login → 统一分类成"要登录"，而不是一个裸 HTTP 401
    const err = await upstreamChat({ provider: 'p1' }, { messages: [] }, null, 's1').then(() => null, (e) => e);
    assert.ok(err, 'chat 401 必须抛错');
    assert.equal(err.needLogin, true, 'needLogin 分类来自统一请求层');
    assert.ok(err instanceof http.ApiError, '抛的是统一错误类型');
  } finally { r.restore(); }
});

test('★ 接线：projects.js 导入即接线 hooks.onSessionChange（会话→项目对齐与项目记忆取数都靠它）', async () => {
  const host = await import('../src/ui/state/host.js');
  if (typeof host.hooks.onSessionChange !== 'function') await import('../src/ui/state/projects.js');
  assert.equal(typeof host.hooks.onSessionChange, 'function',
    '没接线的话"当前项目不跟会话换、项目记忆一次都不取"——而且是静默的（真实启动由 Sidebar 加载 projects.js 接线）');
});

test('★ 项目记忆只有一条取数路径：全量 store 不带它，条目一律 GET /agent/projects/memory', async () => {
  const { Store } = await import('../src/core/store.js');
  await import('../src/ui/state/projects.js');            // 与真实启动一致：钩子在这里接线
  const session = await import('../src/ui/state/session.js');
  const { state } = await import('../src/ui/state/store.js');
  const { Memory } = await import('../src/core/memory.js');
  Store.user = { username: 'admin' };
  state.sessions = [{ id: 's1', title: 'x', ts: 2, project: 'pb', msgs: [] }];
  state.projects = [{ id: 'pb', name: 'B', root: '/tmp/b', memoryDir: '/tmp/b/mem', memoryCount: 1 }];
  state.activeSessId = 's1';
  const r = stubRoutes({
    '/agent/store': () => json({
      ok: true,
      settings: { currentSess: 's1', providers: [], params: {}, theme: {}, ui: {}, tools: {} },
      sessions: [{ id: 's1', title: 'x', ts: 2, project: 'pb', msgs: [] }],
      memory: [], prompts: { overrides: {}, skills: [], extra: [] },
      projects: state.projects, currentProject: 'pb',
      projectMemory: [{ id: '不该被用', title: '全量 store 里塞的旧副本', content: 'stale' }],   // 故意塞一份：客户端必须无视它
    }),
    '/agent/projects/memory': () => json({ ok: true, id: 'pb', entries: [{ id: 'mb', title: '服务端那份', content: 'fresh' }] }),
  });
  try {
    await session.refreshAll();
    const memCalls = r.calls.filter((c) => c.url.includes('/agent/projects/memory'));
    assert.equal(memCalls.length, 1, '整份重拉后应恰好取一次项目记忆');
    assert.deepEqual(Memory.listOf('project').map((e) => e.title), ['服务端那份'], '显示的必须是 /agent/projects/memory 那份，而不是全量 store 里的副本');
  } finally {
    r.restore();
    Store.user = null;
  }
});

test('★ 契约：客户端不再读 d.projectMemory（条目一律经 /agent/projects/memory 取回）', () => {
  const fs = readFileSync(new URL('../src/ui/state/session.js', import.meta.url), 'utf8');
  assert.ok(!/projectMemory/.test(fs), 'session.js 里不该再出现 projectMemory：全量 store 已经不带它，留一处读法就会再长出第二条取数路径');
  const st = readFileSync(new URL('../src/core/store.js', import.meta.url), 'utf8');
  assert.match(st, /queueProjectMemory = \(entries\) => projectWriter\.queue\(\{ id: currentProjectId, entries \}\)/, '写项目记忆时目标 id 必须与条目一起入队（不能在 flush 时读当前项目）');
});

test('★ 项目记忆的写请求：目标项目在**入队那一刻**定死（切项目不会把 A 的记忆写进 B）', async () => {
  const { Store } = await import('../src/core/store.js');
  Store.user = { username: 'admin' };
  const r = stubRoutes({ '/agent/projects/memory': () => json({ ok: true, entries: [] }) });
  try {
    Store.setProjectId('pa');
    Store.queueProjectMemory([{ id: 'ma', title: 'A 的记忆', content: 'a' }]);
    Store.setProjectId('pb');                      // 防抖窗口内切了项目
    await tick(800);                               // 等 600ms 的防抖落地
    const w = r.calls.find((c) => c.method === 'POST' && c.url.includes('/agent/projects/memory'));
    assert.ok(w, '应当发出一次写请求');
    assert.match(String(w.body || ''), /"id":"pa"/, '必须写回 pa（入队时的项目），而不是切过去的 pb');
  } finally {
    r.restore();
    Store.user = null;
  }
});

/* ==================== ③ 切会话 = 切当前项目 ==================== */

test('★ 新建会话要把"当前会话指针"写进服务端配置（否则整份重拉会把画面切回上一条对话）', async () => {
  const { Store } = await import('../src/core/store.js');
  await import('../src/ui/state/projects.js');
  const session = await import('../src/ui/state/session.js');
  const { state } = await import('../src/ui/state/store.js');
  Store.user = { username: 'admin' };
  state.settings = {
    currentSess: 's-old', providers: [{ id: 'p1', type: 'openai', model: 'm' }], activeId: 'p1',
    params: {}, paramsByModel: {}, theme: {}, ui: {}, tools: {},
  };
  state.sessions = [{ id: 's-old', title: '旧的', ts: 1, project: 'pb', msgs: [{ role: 'user', content: 'x' }] }];
  state.projects = [{ id: 'pb', name: 'B', root: '/tmp/b', memoryDir: '/tmp/b/mem' }];
  state.activeSessId = 's-old';
  state.currentProjectId = 'pb';
  const r = stubRoutes({ '/agent/store/settings': () => json({ ok: true, settings: {} }) });
  try {
    session.newSession();                                  // 切项目后建"新对话"走的正是这条
    const freshId = state.activeSessId;
    assert.notEqual(freshId, 's-old', '新建必须真的换一条会话');
    await tick(800);                                       // 设置是 500ms 防抖
    const w = r.calls.find((c) => c.url.includes('/agent/store/settings'));
    assert.ok(w, '必须把当前会话指针写上去（旧实现只有 selectSession 写，新建不写）');
    assert.match(String(w.body || ''), new RegExp(`"currentSess":"${freshId}"`), '写的是**新**会话的 id');
  } finally {
    r.restore();
    Store.user = null;
  }
});

test('★ 整份重拉时保持"用户正在看的会话"（服务端指针还没写过来也不能跳走）', async () => {
  const { Store } = await import('../src/core/store.js');
  await import('../src/ui/state/projects.js');
  const session = await import('../src/ui/state/session.js');
  const { state } = await import('../src/ui/state/store.js');
  Store.user = { username: 'admin' };
  state.sessions = [
    { id: 's-old', title: '旧的', ts: 1, project: 'pb', msgs: [] },
    { id: 's-new', title: '新的', ts: 2, project: 'pb', msgs: [{ role: 'user', content: 'hi' }] },
  ];
  state.projects = [{ id: 'pb', name: 'B', root: '/tmp/b', memoryDir: '/tmp/b/mem' }];
  state.activeSessId = 's-new';
  state.currentProjectId = 'pb';
  const r = stubRoutes({
    '/agent/store': () => json({
      ok: true,
      // 服务端指针还停在旧会话（新建会话的指针写入还在路上）
      settings: { currentSess: 's-old', providers: [], params: {}, theme: {}, ui: {}, tools: {} },
      sessions: state.sessions, memory: [], prompts: { overrides: {}, skills: [], extra: [] },
      projects: state.projects, currentProject: 'pb',
    }),
    '/agent/projects/memory': () => json({ ok: true, id: 'pb', entries: [] }),
  });
  try {
    await session.refreshAll({ onlyIfSession: 's-new' });
    assert.equal(state.activeSessId, 's-new', '重拉不能把用户正在看的会话换掉');
  } finally {
    r.restore();
    Store.user = null;
  }
});

/** 造两个项目、两条会话（各归一个项目），并把"当前"设在 A 上 */
async function setupProjects() {
  const { state } = await import('../src/ui/state/store.js');
  const { Memory } = await import('../src/core/memory.js');
  state.sessions = [
    { id: 'sa', title: 'A 项目里的对话', ts: 2, project: 'pa', msgs: [{ role: 'user', content: 'x' }] },
    { id: 'sb', title: 'B 项目里的对话', ts: 1, project: 'pb', msgs: [] },
  ];
  state.projects = [
    { id: 'pa', name: 'A', root: '/tmp/a', memoryDir: '/tmp/a/mem', memoryCount: 1 },
    { id: 'pb', name: 'B', root: '/tmp/b', memoryDir: '/tmp/b/mem', memoryCount: 1 },
  ];
  state.currentProjectId = 'pa';
  state.activeSessId = 'sa';
  Memory.setProject({ id: 'pa', name: 'A', root: '/tmp/a', memoryDir: '/tmp/a/mem' },
    [{ id: 'ma', title: 'A 的记忆', content: 'a' }]);
  return { state, Memory };
}

const PROJECT_ROUTES = {
  '/agent/projects/memory': () => json({ ok: true, id: 'pb', entries: [{ id: 'mb', title: 'B 的记忆', content: 'b' }] }),
  '/agent/projects/current': () => json({ ok: true, current: 'pb', entries: [] }),
};

test('★ 切到别的项目的会话：当前项目跟着换，项目记忆换成服务端那份', async () => {
  const projects = await import('../src/ui/state/projects.js');   // 导入即接线 hooks.onSessionChange
  const { state, Memory } = await setupProjects();
  const r = stubRoutes(PROJECT_ROUTES);
  try {
    /* 与 selectSession 的顺序一致：先切会话，再对齐项目（对齐里会校验"期间有没有又切走"） */
    state.activeSessId = 'sb';
    const ok = await projects.followSessionProject(state.sessions[1]);
    assert.equal(ok, true);
    assert.equal(state.currentProjectId, 'pb', '当前项目必须跟着会话切到 B');
    assert.equal(Memory.projectMeta.id, 'pb', 'core 里的项目事实也要换');
    assert.deepEqual(Memory.listOf('project').map((e) => e.title), ['B 的记忆'], '项目记忆是服务端返回的 B 那份');
    const urls = r.calls.map((c) => c.url);
    assert.ok(urls[0].includes('/agent/projects/memory'), '顺序：先读这个项目的记忆（读不到就不换）');
    assert.ok(urls[1].includes('/agent/projects/current'), '再写服务端 current，两边保持一致');
  } finally { r.restore(); }
});

test('对齐期间用户又切走了：这次的结果直接丢弃（不能把项目改成"已经不在看"的那个）', async () => {
  const projects = await import('../src/ui/state/projects.js');
  const { state } = await setupProjects();
  const r = stubRoutes(PROJECT_ROUTES);
  try {
    state.activeSessId = 'sb';
    const inflight = projects.followSessionProject(state.sessions[1]);
    state.activeSessId = 'sa';                     // 用户手快：又点回 A 项目的会话了
    await inflight;
    assert.equal(state.currentProjectId, 'pa', '结果作废，仍停在 A');
  } finally { r.restore(); }
});

test('★ 点开别的项目的会话（selectSession）→ 自动对齐当前项目（不是只换对话）', async () => {
  await import('../src/ui/state/projects.js');
  const session = await import('../src/ui/state/session.js');
  const { state } = await setupProjects();
  const r = stubRoutes(PROJECT_ROUTES);
  try {
    session.selectSession('sb');                     // 同步动作，内部排一次对齐
    await tick(40);
    assert.equal(state.activeSessId, 'sb', '会话已经切过去');
    assert.equal(state.currentProjectId, 'pb', '当前项目必须跟着这条会话走（旧实现不动它）');
  } finally { r.restore(); }
});

test('读不到新项目的记忆时不换项目（宁可停在旧项目，也不显示一个空的"新项目"）', async () => {
  const projects = await import('../src/ui/state/projects.js');
  const { state, Memory } = await setupProjects();
  const r = stubRoutes({
    '/agent/projects/memory': () => new Response('{"ok":false,"error":"boom"}', { status: 500, headers: { 'content-type': 'application/json' } }),
  });
  try {
    const ok = await projects.followSessionProject(state.sessions[1]);
    assert.equal(ok, false);
    assert.equal(state.currentProjectId, 'pa', '读不到就保持原样');
    assert.deepEqual(Memory.listOf('project').map((e) => e.title), ['A 的记忆'], 'core 里也还是 A 那份');
  } finally { r.restore(); }
});

test('「设置 → 记忆」打开时把当前项目的记忆从服务端重拉一份', async () => {
  const { Store } = await import('../src/core/store.js');
  const projects = await import('../src/ui/state/projects.js');
  const { state, Memory } = await setupProjects();
  state.currentProjectId = 'pb';
  Store.user = { username: 'admin' };                 // 面板只在登录态下刷新（数据按账号存服务端）
  const r = stubRoutes({
    '/agent/projects/memory': () => json({ ok: true, id: 'pb', entries: [{ id: 'mb2', title: '模型刚写的记忆', content: 'x' }] }),
  });
  try {
    const entries = await projects.refreshCurrentMemory();
    assert.deepEqual(entries.map((e) => e.title), ['模型刚写的记忆']);
    assert.deepEqual(Memory.listOf('project').map((e) => e.title), ['模型刚写的记忆'], '面板读的就是 core 这份，必须已被换成服务端的');
  } finally {
    r.restore();
    Store.user = null;
  }
});

/* ==================== 第六轮（2026-10-01）修复的回归 ==================== */

test('★ 一轮结束：结果要写回会话对象并排队落盘（不能只等 1.5 秒后的整份重拉）', async () => {
  const { state } = await import('../src/ui/state/store.js');
  const Run = await import('../src/ui/state/run.js');
  await import('../src/ui/state/session.js');          // 注册宿主钩子（onRunEnded → persistSession）
  const { Store } = await import('../src/core/store.js');
  Store.user = { username: 'u1' };
  const sess = { id: 's1', title: '新对话', ts: Date.now(), msgs: [{ role: 'user', content: '上一句' }] };
  state.sessions = [sess];
  state.activeSessId = 's1';
  state.currentProjectId = '';
  state.history = [
    { id: 'm1', role: 'user', content: '上一句' },
    { id: 'm2', role: 'user', content: '新问题' },
    { id: 'm3', role: 'assistant', content: '', streaming: true, trace: [] },
  ];
  const r = stubRoutes({
    '/agent/run/state': () => json({ ok: true, run: { runId: 'r9', status: 'running', sessionId: 's1' } }),
    '/agent/run/events': () => sse([
      { type: 'replay_start', truncated: false, status: 'running' },
      { type: 'content', text: '这是回答' },
      { type: 'end', status: 'done', ms: 12 },
    ]),
  });
  try {
    await Run.reattach('s1');
    await tick(60);
    assert.equal(state.history[2].content, '这是回答', '界面拿到了正文');
    assert.equal(state.streaming, false, '生成态结清');
    /* 关键：**会话对象**（下次切回来/再发消息时用的那份）必须也有这一轮。
       旧实现只写 state.history：1.5 秒内切走会话 → 重拉被跳过 → 会话对象还是运行前的快照，
       切回来再发一条就会把服务端刚跑完的一轮覆盖掉（实测的数据丢失）。 */
    assert.ok(sess.msgs.some((m) => m.content === '这是回答'), '★ 会话对象里也要有这一轮的正文');
    assert.equal(sess.title, '上一句', '标题照旧由第一条用户消息决定');
    await tick(600);                                     // 等会话落盘的防抖（400ms）
    assert.ok(r.calls.some((c) => c.url.includes('/agent/store/sessions') && String(c.body).includes('这是回答')),
      '★ 会话要排队写回服务端（切走也不会丢）');
  } finally {
    r.restore();
    Run.reset();
    Store.user = null;
  }
});

test('★ 插话成功才返回 true（Composer 只在 true 时清空草稿）', async () => {
  const { state } = await import('../src/ui/state/store.js');
  const Run = await import('../src/ui/state/run.js');
  const Session = await import('../src/ui/state/session.js');
  const { Store } = await import('../src/core/store.js');
  Store.user = { username: 'u1' };
  state.sessions = [{ id: 's1', title: 'T', msgs: [] }];
  state.activeSessId = 's1';
  state.currentProjectId = '';
  state.history = [{ id: 'u', role: 'user', content: 'q' }, { id: 'live', role: 'assistant', content: '', streaming: true, trace: [] }];
  let steerStatus = 409;                                 // 服务端说"这一轮已经结束了"
  const r = stubRoutes({
    '/agent/run/state': () => json({ ok: true, run: { runId: 'r1', status: 'running', sessionId: 's1' } }),
    '/agent/run/events': () => sse([{ type: 'replay_start', truncated: false, status: 'running' }, { type: 'content', text: '片段' }]),
    '/agent/run/steer': () => new Response(
      JSON.stringify(steerStatus === 200 ? { ok: true } : { ok: false, error: '这一轮已经结束了（话没送出去）' }),
      { status: steerStatus, headers: { 'content-type': 'application/json' } }),
  });
  try {
    await Run.reattach('s1');
    await tick(60);
    assert.equal(await Session.steer('喂'), false, '★ 服务端拒绝 → false（草稿不能被清掉）');
    steerStatus = 200;
    assert.equal(await Session.steer('喂'), true, '送出去了 → true');
    assert.equal(await Session.steer('   '), false, '空文本不发');
  } finally {
    r.restore();
    Run.reset();
    Store.user = null;
  }
});

test('★ 发送时给消息分配稳定 id（界面 key 用它，回撤/删除后不再错位）', async () => {
  const { state, defaultSettings } = await import('../src/ui/state/store.js');
  const Run = await import('../src/ui/state/run.js');
  const Session = await import('../src/ui/state/session.js');
  const host = await import('../src/ui/state/host.js');
  const { Store } = await import('../src/core/store.js');
  host.wireCore();                    // send() 要组装注入预览（core 的登记表得先接上）
  Store.user = { username: 'u1' };
  state.info = { loggedIn: true, user: { username: 'u1' } };
  state.settings = Object.assign(defaultSettings(), {
    providers: [{ id: 'p1', name: 'P', type: 'openai', baseUrl: 'https://x/v1', model: 'm' }], activeId: 'p1',
  });
  state.sessions = [];
  state.activeSessId = null;
  state.currentProjectId = '';
  state.history = [];
  state.streaming = false;
  const r = stubRoutes({
    '/agent/run/start': () => json({ ok: true, runId: 'r5' }),
    '/agent/run/events': () => sse([{ type: 'replay_start', truncated: false, status: 'running' }, { type: 'content', text: '好' }]),
  });
  try {
    await Session.send('你好');
    await tick(60);
    const h = state.history;
    assert.equal(h.length, 2, '用户消息 + 助手占位（实际 ' + h.length + '）');
    assert.ok(h[0].id, '用户消息带 id');
    assert.ok(h[1].id, '助手占位带 id');
    assert.notEqual(h[0].id, h[1].id, 'id 各不相同');
  } finally {
    r.restore();
    Run.reset();
    Store.user = null;
    state.info = null;
  }
});

test('★ 登出后（settings=null）设置动作不再抛 TypeError', async () => {
  const { state } = await import('../src/ui/state/store.js');
  const S = await import('../src/ui/state/settings.js');
  state.settings = null;
  S.setUi('group', 'time');                  // 侧栏"按时间分组"走的就是它
  assert.ok(state.settings && state.settings.ui.group === 'time', '动作把配置建出来（旧实现：Cannot read properties of null）');
  S.setTheme({ accent: 'green' });
  assert.equal(state.settings.theme.accent, 'green', '外观动作同样可用');
});

test('★ 收尾时把服务端交回的压缩摘要写进会话对象（写回不能抹掉它）', async () => {
  const { state } = await import('../src/ui/state/store.js');
  const Run = await import('../src/ui/state/run.js');
  await import('../src/ui/state/session.js');
  const { Store } = await import('../src/core/store.js');
  Store.user = { username: 'u1' };
  const sess = { id: 's1', title: 'T', ts: Date.now(), msgs: [], compaction: undefined };
  state.sessions = [sess];
  state.activeSessId = 's1';
  state.currentProjectId = '';
  state.history = [
    { id: 'u1', role: 'user', content: '问' },
    { id: 'a1', role: 'assistant', content: '', streaming: true, trace: [] },
  ];
  const r = stubRoutes({
    '/agent/run/state': () => json({ ok: true, run: { runId: 'rc', status: 'running', sessionId: 's1' } }),
    '/agent/run/events': () => sse([
      { type: 'replay_start', truncated: false, status: 'running' },
      { type: 'content', text: '答' },
      { type: 'end', status: 'done', ms: 5, compaction: { upTo: 2, count: 2, text: '摘要正文', ts: 1 } },
    ]),
  });
  try {
    await Run.reattach('s1');
    await tick(80);
    assert.equal(sess.compaction && sess.compaction.text, '摘要正文', '★ 会话对象拿到了服务端的摘要');
  } finally {
    r.restore();
    Run.reset();
    Store.user = null;
  }
});
