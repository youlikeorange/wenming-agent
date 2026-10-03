/* memory-writeback.test.mjs —— 记忆"整份写回"的纪律（2026-10-03 抖音热点项目被清空事故的回归）
 *
 *  事故：浏览器手里的**项目记忆快照是空的/陈旧的**（取数被跳过、或换了项目没取回来），
 *  而 Memory.onChange 是"一变全写"——任何一次记忆变更（哪怕只写了一条全局记忆）
 *  都会把三类都整份写回，项目记忆那条在服务端是**整份覆盖**（不在集合里的 .md 全删），
 *  于是服务端那份被空列表删光（实测：抖音热点项目的 3 条项目记忆 + 种子条目全没了）。
 *
 *  三条纪律（本文件逐条钉住）：
 *    ① 事件带作用域：写全局只广播 global，不再顺带写项目/会话；
 *    ② 项目条目与项目 id 绑定：换项目不带条目 → 条目清空且**标记为不可写回**；
 *    ③ 取数不再被"有待写"挡住：先落地本地改动，再取服务端那份（否则陈旧快照永远赢）。
 *  外加服务端的兜底：空列表 + 基准对不上 → 409 拒绝（见 test/agent-server-test.js）。
 *
 *  必须"真跑模块"：这三条全是**接线与时序**，源码文本断言看不出接线对不对。
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
globalThis.document = { documentElement: { setAttribute: () => {} }, addEventListener: () => {}, visibilityState: 'visible' };
globalThis.window = { matchMedia: () => ({ matches: false }), addEventListener: () => {} };

const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
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

const PROJECT = { id: 'pa', name: '抖音热点', root: '/w/douyin', memoryDir: '/s/pa/memory' };
const SERVER_ENTRIES = [
  { id: 'p1', title: '跑法', content: 'up.sh' },
  { id: 'p2', title: '产出位置', content: 'output/' },
  { id: 'p3', title: '踩坑', content: 'cookie' },
];

/* ==================== ① core：事件带作用域 + 项目条目与 id 绑定 ==================== */

test('★ 事件带作用域：写全局只广播 global（不再"一变全写"）', async () => {
  const { createMemory } = await import('../src/core/memory.js');
  const M = createMemory();
  const got = [];
  M.onChange((scopes) => got.push(scopes.join('+')));
  M.setProject(PROJECT, []);
  got.length = 0;                                   // 灌项目事实本身会广播一次 project（条目变了）
  M.write({ scope: 'global', title: '偏好', content: '中文' });
  M.write({ scope: 'session', title: '待办', content: '跑单测' });
  M.write({ scope: 'project', title: '跑法', content: 'up.sh' });
  M.update(M.listOf('global')[0].id, { content: '中文交流' }, 'global');
  M.remove(M.listOf('session')[0].id, 'session');
  assert.deepEqual(got, ['global', 'session', 'project', 'global', 'session'],
    '每次变更只广播它自己那一类');
});

test('★ 项目条目与项目 id 绑定：换项目不带条目 → 条目清空、且标记为"不可写回"', async () => {
  const { createMemory } = await import('../src/core/memory.js');
  const M = createMemory();
  M.setProject(PROJECT, SERVER_ENTRIES);
  assert.equal(M.projectLoaded, true, '带条目灌入 = 有权威来源');
  assert.equal(M.projectBaseCount, 3, '基准条数 = 取回时服务端有几条');
  M.setProject({ id: 'pb', name: '别的', root: '/w/b' });     // 换项目，没带条目
  assert.deepEqual(M.listOf('project'), [], '绝不能沿用上一个项目的条目（会被写进新项目的文件夹）');
  assert.equal(M.projectLoaded, false, '没取回来过 = 不许整份写回');
  assert.equal(M.projectBaseCount, 0);
  assert.equal(M.projectListFor, 'pb');
  M.setProject(PROJECT, SERVER_ENTRIES);                      // 同一个项目再来一次、只换事实
  assert.equal(M.listOf('project').length, 3, '同一个项目不给条目 = 保持现有条目');
});

test('load() 只碰全局与会话（项目条目只有 setProject(meta, entries) 一条来路）', async () => {
  const { createMemory } = await import('../src/core/memory.js');
  const M = createMemory();
  M.setProject(PROJECT, SERVER_ENTRIES);
  const got = [];
  M.onChange((scopes) => got.push(scopes.join('+')));
  M.load([{ id: 'g1', title: '偏好', content: 'x' }], []);
  assert.deepEqual(got, ['global'], 'load 不该动项目条目、也不该广播 project');
  assert.equal(M.listOf('project').length, 3);
  assert.equal(M.projectLoaded, true, 'load 不影响项目条目的来源标记');
});

test('清空会话记忆：本来就空就不广播（避免白排一条写请求）', async () => {
  const { createMemory } = await import('../src/core/memory.js');
  const M = createMemory();
  let n = 0;
  M.onChange(() => { n += 1; });
  M.clearSession();
  assert.equal(n, 0);
  M.load([], [{ id: 's1', title: '待办', content: 'x' }]);
  n = 0;
  M.clearSession();
  assert.equal(n, 1, '有内容才广播');
  assert.deepEqual(M.listOf('session'), []);
});

/* ==================== ② 接线：陈旧空快照不再把服务端项目记忆写没 ==================== */

test('★ 回归：手里是空的旧快照 + 全局记忆变化 → 不许发空列表写；取回后写的是真条目', async () => {
  const { Store } = await import('../src/core/store.js');
  const host = await import('../src/ui/state/host.js');
  host.wireCore();
  const session = await import('../src/ui/state/session.js');
  await import('../src/ui/state/projects.js');            // 与真实启动一致：钩子在这里接线
  const { state } = await import('../src/ui/state/store.js');
  const { Memory } = await import('../src/core/memory.js');

  Store.user = { username: 'admin' };
  state.sessions = [{ id: 's1', title: '抖音热点会话', ts: 2, project: 'pa', msgs: [{ role: 'user', content: 'hi' }] }];
  state.projects = [{ id: 'pa', name: '抖音热点', root: '/w/douyin', memoryDir: '/s/pa/memory', memoryCount: 3 }];
  state.activeSessId = 's1';
  state.currentProjectId = 'pa';
  /* 事故现场：浏览器手里的项目快照是**空的**（进项目时服务端还没有条目，之后没再取回来），
     而服务端此刻已经有模型写的 3 条。 */
  Memory.setProject(PROJECT, []);
  Store.setProjectId('pa');

  const r = stubRoutes({
    '/agent/store': () => json({
      ok: true,
      settings: { currentSess: 's1', providers: [], params: {}, theme: {}, ui: {}, tools: {} },
      sessions: state.sessions,
      // 一轮跑完：模型刚写了一条**全局**记忆 → 这次整份重拉里 global 变了
      memory: [{ id: 'g1', title: '偏好', content: '中文交流' }, { id: 'g2', title: '刚写的', content: 'x' }],
      prompts: { overrides: {}, skills: [], extra: [] },
      projects: state.projects, currentProject: 'pa',
    }),
    '/agent/projects/memory': () => json({ ok: true, id: 'pa', entries: SERVER_ENTRIES }),
    '/agent/projects/current': () => json({ ok: true, current: 'pa', entries: [] }),
  });
  try {
    await session.refreshAll();            // 一轮结束后的整份重拉（refreshAllSoon 走的就是它）
    await tick(900);                       // 等 600ms 的防抖写盘落地
    const gets = r.calls.filter((c) => c.method === 'GET' && c.url.includes('/agent/projects/memory'));
    const posts = r.calls.filter((c) => c.method === 'POST' && c.url.includes('/agent/projects/memory'));
    assert.equal(gets.length, 1, '刷新时必须真的把项目记忆取回来（旧实现被"有待写"挡住，一次都不取）');
    assert.deepEqual(Memory.listOf('project').map((e) => e.title), ['跑法', '产出位置', '踩坑'], 'core 里应是服务端那份');
    const empty = posts.filter((p) => /"entries":\[\]/.test(String(p.body)));
    assert.equal(empty.length, 0, '绝不能把空快照整份写回（那会把服务端 3 条项目记忆删光）');
    if (posts.length) assert.match(String(posts[0].body), /"跑法"/, '真要写回就写服务端那份');
  } finally { r.restore(); Store.user = null; }
});

test('★ 项目记忆写请求带 baseCount（服务端空列表保护的基准）', async () => {
  const { Store } = await import('../src/core/store.js');
  Store.user = { username: 'admin' };
  const r = stubRoutes({ '/agent/projects/memory': () => json({ ok: true, entries: [] }) });
  try {
    Store.setProjectId('pa');
    Store.queueProjectMemory([{ id: 'm1', title: 'T', content: 'C' }], 3);
    await tick(800);
    const w = r.calls.find((c) => c.method === 'POST' && c.url.includes('/agent/projects/memory'));
    assert.ok(w, '应当发出一次写请求');
    assert.match(String(w.body), /"baseCount":3/, '基准条数必须随请求带上');
  } finally { r.restore(); Store.user = null; }
});

test('★ 409 冲突：广播 memoryConflict 且**不重试**（重发一百次还是被拒）', async () => {
  const { Store, on } = await import('../src/core/store.js');
  Store.user = { username: 'admin' };
  let conflicts = 0;
  on('memoryConflict', () => { conflicts += 1; });
  const r = stubRoutes({
    '/agent/projects/memory': () => new Response(
      JSON.stringify({ ok: false, conflict: true, error: '项目记忆在别处已经变了' }),
      { status: 409, headers: { 'content-type': 'application/json' } }),
  });
  try {
    Store.setProjectId('pa');
    Store.queueProjectMemory([], 0);
    await tick(900);
    assert.equal(conflicts, 1, '冲突要报给宿主（宿主据此重新取回）');
    const posts = r.calls.filter((c) => c.method === 'POST' && c.url.includes('/agent/projects/memory'));
    assert.equal(posts.length, 1, '409 是永久失败，不该退回重排（旧行为会白跑 20 次）');
  } finally { r.restore(); Store.user = null; }
});
