/* regression.test.mjs —— 2026-09-30 工业化审计修掉的六条缺陷的回归测试
 *
 *  这六条（C1/C2/C3 + S1/S2/S3）有一个共同点：**既有 119 项测试全绿，缺陷却都在线上**。
 *  原因是同一个——测试注入的是"能用的桩"，或绕开了那个时序：
 *    · C1 压缩：compaction.test.mjs 注入 `Providers: { get: … }`，而生产 host 注入的是 `null`；
 *    · C2 停止：没人测过"响应头到达之后再 abort"这条路径；
 *    · C3 会话记忆：memory-project.test.mjs 只测 core 语义，不覆盖 applyServerData 的实参。
 *  所以下面刻意复刻生产的接线与真实时序，而不是再包一层理想化的依赖。
 *
 *  服务端三条（S1/S2/S3）的回归在 ../test/agent-server-test.js（那里有真实 STATE_DIR 沙箱）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (p) => path.join(here, '..', 'src', p);
const read = (p) => readFileSync(src(p), 'utf8');

/** 去掉注释再断言：否则"旧实现是……"这类说明文字会被当成真的代码命中 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** 造一段 [OI] 风格的 SSE 摘要流（供 fetch 桩使用） */
const sseBody = (text) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] }) + '\n\n'
  + 'data: [DONE]\n\n';

/** 把全局 fetch 换成"直接回一段摘要"的桩；返回还原函数。
 *  客户端的所有上游请求都经服务端代理（/agent/upstream/*），在 Node 里那个相对 URL 无法解析，
 *  所以这里必须在 fetch 层拦下——这也是既有测试的通用做法。 */
function stubFetch(text) {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(sseBody(text), {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  });
  return () => { globalThis.fetch = orig; };
}

/* ==================== C1：压缩必须真的能取到摘要模型 ==================== */

test('C1 契约：host 给 AgentContext 注入的 Providers 不能是 null，且接的是 getProtocol', () => {
  const host = read('ui/state/host.js');
  assert.ok(!/Providers:\s*null/.test(host), 'host 不能再把 Providers 注入成 null（summarize 会解引用它）');
  assert.match(host, /Providers:\s*\{\s*get:\s*getProtocol\s*\}/, 'Providers 应接 core/protocol.js 的 getProtocol');
  // 契约的另一半：context.js 确实按 .get(type) 用它
  assert.match(read('core/context.js'), /Providers\.get\(p\.type\)\.chat\(/, 'context 的调用形状是 .get(type).chat');
});

/* 内容必须真的超过「上下文上限 × COMPACT_AT(0.8)」，否则 compactMessages 在阈值判断处就返回了，
   测不到 summarize —— 这正是我第一版用例的问题（本地类型给了 128000 上限，19 条短文远不够）。
   照既有 compaction.test.mjs 的口径：注入 numCtx（32768），每条 3000 字。 */
const bigText = '事'.repeat(3000);

async function runCompaction(providers) {
  const { AgentContext } = await import('../src/core/context.js');
  const { Prompts } = await import('../src/core/prompts.js');
  const { Agent } = await import('../src/core/agent.js');

  const msgs = [];
  for (let i = 0; i < 19; i++) msgs.push({ role: i % 2 ? 'assistant' : 'user', content: bigText });
  const sess = { msgs, compaction: null };
  const provider = { id: 'p1', type: 'openai', baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'k' };

  AgentContext.init({
    Prompts, Providers: providers, Agent,
    activeProvider: () => provider,
    numCtx: () => 32768,
    buildOptions: () => ({ model: 'm', stream: true }),
    history: () => sess.msgs,
    curSess: () => sess,
    persistSession: () => {},
    addTraceStrip: () => ({}), fillTraceStrip: () => {},
    toast: () => {},
    abortSignal: () => null,
  });
  Prompts.set('compact.prompt', '把下面的对话压缩成摘要');
  const out = await AgentContext.compactMessages(msgs);
  return { out, sess };
}

test('C1 行为：接真实注册表（与修复后的 host 一致）时，压缩能拿到摘要并写回 sess.compaction', async () => {
  const { getProtocol } = await import('../src/core/protocol.js');
  const restore = stubFetch('这是摘要');
  try {
    const { out, sess } = await runCompaction({ get: getProtocol });
    assert.ok(sess.compaction, '压缩必须写出摘要');
    assert.match(sess.compaction.text, /摘要/);
    assert.ok(out.length < 19, '压缩后条数应减少：' + out.length + ' < 19');
  } finally { restore(); }
});

test('C1 反证：Providers 为 null 时压缩必然失败（这就是修复前的生产状态）', async () => {
  const { out, sess } = await runCompaction(null);
  assert.equal(sess.compaction, null, 'Providers=null 时应压缩失败（若这条挂了，说明它不再是必要条件）');
  assert.equal(out.length, 19, '压缩失败就原样返回');
});

/* ==================== C2：点「停止」必须掐断在途的流 ==================== */

/** 起一个"响应头立刻回、body 慢慢吐"的假上游；测 abort 能否真的中断读取 */
async function streamAbortProbe(useGuarded) {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let i = 0;
    const t = setInterval(() => {
      if (i >= 40) { clearInterval(t); res.write('data: [DONE]\n\n'); res.end(); return; }
      res.write('data: {"n":' + i + '}\n\n'); i++;
    }, 100);                                   // 40 × 100ms = 4 秒
    res.on('close', () => clearInterval(t));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + srv.address().port + '/v1/chat/completions';

  /* 2026-10-01 归口：模型流量不再自己 fetch，走 core/http.js 的统一请求层
     （raw=true 拿原始 Response 自己读流，timeoutMs 只守建连/首响应头）。 */
  const { request } = await import('../src/core/http.js');
  const ac = new AbortController();
  const t0 = Date.now();
  setTimeout(() => ac.abort(), 300);           // 300ms 时点「停止」

  let chunks = 0, lastAt = 0;
  try {
    const res = useGuarded
      ? await request(url, { method: 'GET', signal: ac.signal, raw: true, timeoutMs: 20000 })
      : await fetch(url, { signal: ac.signal });
    const reader = res.body.getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
      chunks++; lastAt = Date.now() - t0;
    }
  } catch { /* AbortError / 中断是预期路径 */ }
  const total = Date.now() - t0;
  srv.close();
  return { chunks, lastAt, total };
}

test('C2 行为：统一请求层的 abort 必须中断 body 读取（原先响应头一到就摘掉监听）', async () => {
  const r = await streamAbortProbe(true);
  assert.ok(r.total < 2000, `点停止后应立刻中断，实际耗时 ${r.total}ms（收到 ${r.chunks} 块）`);
  assert.ok(r.chunks < 20, `不应把 40 块全收完，实际收到 ${r.chunks} 块`);
});

test('C2 对照：同一时序下原生 fetch 同样中断（说明上面测的是 relay，不是 fetch 语义）', async () => {
  const r = await streamAbortProbe(false);
  assert.ok(r.total < 2000, `原生 fetch 也应中断，实际 ${r.total}ms`);
});

test('C2 契约：http.js 不得摘除 abort 转发（relay 一旦摘下，body 阶段就收不到停止信号）', () => {
  const s = stripComments(read('core/http.js'));
  /* 更强的写法：整个文件里都不该出现 removeEventListener('abort', relay)。
     relay 用 { once: true } 注册，触发即自摘；未触发时随 outer 一起回收——
     手动摘除在任何时点都是错的（响应头到达后摘 = 停止失效；catch 里摘也是多余的）。
     这条不变式同时覆盖了"将来有人又把清理写回去"的情况。 */
  assert.ok(!/removeEventListener\('abort', relay\)/.test(s),
    'http.js 里不该再有 removeEventListener(\'abort\', relay)：它会切断停止信号的转发');
  assert.match(s, /addEventListener\('abort', relay, \{ once: true \}\)/, 'relay 仍以 once 注册（触发即自摘）');
});

/* ==================== C3：会话记忆不能刷新即丢 ==================== */

test('C3 契约：applyServerData 必须把当前会话的记忆灌进 core（不是硬编码 []）', () => {
  const s = read('ui/state/session.js');
  assert.ok(!/Memory\.load\(d\.memory \|\| \[\], \[\]/.test(s), '第二个实参（会话记忆）不能是硬编码的 []');
  const call = s.match(/Memory\.load\(([^;]*)\);/);
  assert.ok(call, '找得到 Memory.load 调用');
  assert.match(call[1], /active/, '会话记忆应取自当前会话 active');
});

test('C3 行为：服务端给的会话记忆要能被 core 读回并注入（原先恒为空）', async () => {
  const { Memory } = await import('../src/core/memory.js');
  const { Prompts } = await import('../src/core/prompts.js');
  Memory.init({ Prompts });
  // 复刻 applyServerData 修复后的实参形状
  const active = { id: 's1', msgs: [], memory: [{ id: 'm1', title: '会话结论', content: '记住这个' }] };
  Memory.load([{ id: 'g1', title: '全局', content: 'G' }], active.memory || []);
  assert.equal(Memory.serialize('session').length, 1, '会话记忆必须被加载（原先恒为 0）');
  assert.match(Memory.serialize('session')[0].title, /会话结论/);
  // sessionBlock() 返回的是区块对象（{id,title,text}），注入时取 .text —— 不是字符串
  const blk = Memory.sessionBlock();
  assert.ok(blk && typeof blk === 'object', 'sessionBlock 返回区块对象');
  assert.match(blk.text, /会话结论/, '会话记忆应出现在注入区块的正文里');
});
/* ==================== 第二轮：可维护性修复的回归（C4/C5/C6/C9） ==================== */

test('C4 契约：adoptProject 必须先 setProjectId 再 setProject（否则记忆写到上一个项目）', () => {
  /* 2026-10-01：adoptProject 从 ui/state/projects.js 搬到 ui/state/host.js——
     "切项目"现在有两个入口（设置里选项目、点开别的项目的会话），实现必须只有一份。
     契约本身不变：setProjectId 必须在 setProject 之前（后者 emit → 立刻入队，
     而写入目标 id 是 flush 时才读的）。 */
  const s = read('ui/state/host.js');
  const body = s.slice(s.indexOf('export function adoptProject'));
  const iSet = body.indexOf('Store.setProjectId');
  const iMem = body.indexOf('Memory.setProject');
  assert.ok(iSet > 0 && iMem > 0, '两行都在');
  assert.ok(iSet < iMem, '★ setProjectId 必须在 setProject 之前：后者可能 emit → 立刻按当时的当前项目入队');
  assert.ok(!/function adoptProject/.test(read('ui/state/projects.js')), 'projects.js 不许再留一份自己的 adoptProject（唯一真源在 host.js）');
});

test('C9 行为：没有当前项目时，项目记忆写入器根本不发请求（不再空转 20 次重试）', async () => {
  const { Store } = await import('../src/core/store.js');
  const sent = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => { sent.push(String(url)); return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }); };
  try {
    // 让 Store 认为"已登录"（makeWriter 在未登录时直接跳过，测不到守卫）
    Store.init({ user: () => ({ username: 'u1' }) });
    Store.setProjectId('');                       // 没有当前项目
    Store.queueProjectMemory([{ id: 'm1', title: 'T', content: 'C' }]);
    await Store.flush();
    const memoryWrites = sent.filter((u) => u.includes('/projects/memory'));
    assert.equal(memoryWrites.length, 0, '★ 没有当前项目时不得发项目记忆写请求，实际发了 ' + memoryWrites.length + ' 次');
  } finally { globalThis.fetch = orig; }
});

test('C6 契约：确认框的 remember 必须有消费点（exec_allow / skill_write_confirm）', () => {
  const tr = read('core/tool-runner.js');
  assert.match(tr, /r\.remember/, 'tool-runner 必须读确认框返回的 remember');
  assert.match(tr, /onExecAllow\(rule\)/, '勾选后应写进命令允许清单');
  assert.match(tr, /onSkillRemember\(\)/, '勾选后应关掉技能确认开关');
  // 读侧用的是既有通路，不该新造一套
  assert.match(tr, /matchRule\(args\.command, C\.val2\('exec_allow'\)\)/, '允许清单的真源是参数 exec_allow');
  assert.ok(!/tools\.execAllow/.test(tr), '不该再造一套 settings.tools.execAllow');
  const st = read('ui/state/settings.js');
  assert.match(st, /hooks\.onExecAllow\s*=/, '落点要接在 settings.js（只有它持有 setParam）');
  assert.match(st, /setParam\('exec_allow'/, '写的是 exec_allow 参数');
});

test('C6 行为：技能确认开关在"完全访问"档下不再打断（skillAsk 有消费点）', () => {
  const tr = read('core/tool-runner.js');
  // skill_write 走共同的 confirmSkillGate 闸门（2026-10-06 收敛：write/delete/import 三处同构），
  // 闸门内部必须包在 skillAsk() 判断里——删掉这道判断 = "完全访问"档重新被打断。
  const i = tr.indexOf('async function confirmSkillGate');
  assert.ok(i > 0, 'confirmSkillGate 闸门存在');
  const seg = tr.slice(i, i + 700);
  assert.match(seg, /if \(skillAsk\(\)\)/, '★ 技能写入的确认要受 skillAsk 控制（原先无条件弹窗）');
  const j = tr.indexOf("name === 'skill_write'");
  const seg2 = tr.slice(j, j + 700);
  assert.match(seg2, /confirmSkillGate\(/, '★ skill_write 必须经共同闸门（不许绕开自己弹窗）');
});

test('C5 行为：Anthropic 开思考时 max_tokens 必须大于 budget_tokens（否则整轮 400）', async () => {
  const { buildBody } = await import('../src/core/protocol/anthropic.js');
  const cfg = { model: 'claude-sonnet-4-5' };
  const msgs = [{ role: 'user', content: 'hi' }];
  for (const reasoning of ['low', 'medium', 'high']) {
    for (const maxTokens of [undefined, 2000, 4096, 8000]) {
      const b = buildBody(cfg, msgs, Object.assign({ reasoning }, maxTokens ? { maxTokens } : {}));
      if (b.thinking) {
        assert.ok(b.max_tokens > b.thinking.budget_tokens,
          `max_tokens(${b.max_tokens}) 必须 > budget(${b.thinking.budget_tokens})（reasoning=${reasoning}, maxTokens=${maxTokens}）`);
      }
    }
  }
  // 默认参数（maxTokens 未设 → 4096）下开思考也必须合法
  const d = buildBody(cfg, msgs, { reasoning: 'high' });
  assert.ok(d.thinking && d.max_tokens > d.thinking.budget_tokens, '默认参数下开 high 也要合法（原先 4096 > 16384 必然 400）');
});
