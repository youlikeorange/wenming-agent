/* fixes-2026-10-01.test.mjs —— 第六轮审计修复的回归（core 层，两端共用）
 *
 *  这一轮修的多数是"接线/契约"问题，所以用例也尽量**真跑模块**而不是断言源码文本：
 *    · core/sessions.js   会话规则（标题 / 去重提问 / 客户端历史对账）
 *    · core/{prompts,memory}.js  onChange 必须能退订（不退订 = 跨账号覆盖写）
 *    · core/params.js + policy.js  清单形状收敛（"以后不再问"真的生效）
 *    · core/http.js       2xx 但正文不是 JSON 时必须报错（不能当"服务端数据是空的"）
 *    · core/store.js      pull() 的形状校验
 *    · core/context.js    压缩关掉时的裁剪兜底（只裁请求视图、不动原文）
 *    · core/assemble.js   buildRequestOptions（两端同一份请求参数）
 *    · protocol/anthropic.js + core/agent.js  扩展思考原样回传（含 signature）
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/* ============================ core/sessions.js ============================ */

test('★ 会话规则：标题取第一条用户消息的前 26 字（空白收敛）', async () => {
  const { titleFrom } = await import('../src/core/sessions.js');
  assert.equal(titleFrom([{ role: 'assistant', content: 'x' }, { role: 'user', content: '  你好\n世界  ' }]), '你好 世界');
  assert.equal(titleFrom([]), '', '没有用户消息 → 空串（调用方保留原值）');
  assert.equal(titleFrom([{ role: 'user', content: '' }]), '');
  const long = titleFrom([{ role: 'user', content: '啊'.repeat(50) }]);
  assert.equal([...long].length, 26);
});

test('★ 本轮提问去重：末条与本条提问逐字相同才摘掉（空提问不动）', async () => {
  const { trimTrailingQuestion } = await import('../src/core/sessions.js');
  const h = [{ role: 'user', content: '上一句' }];
  assert.deepEqual(trimTrailingQuestion(h.concat([{ role: 'user', content: '本条' }]), '本条').length, 1);
  assert.deepEqual(trimTrailingQuestion(h, '本条').length, 1, '末条不同：保持原样');
  assert.deepEqual(trimTrailingQuestion(h.concat([{ role: 'user', content: '' }]), '').length, 2, '空提问不去重');
  assert.deepEqual(h.length, 1, '不修改入参');
});

test('★ 历史对账：客户端"落后一轮"时用服务端那份（这是丢一整轮的那个 bug）', async () => {
  const { reconcileHistory } = await import('../src/core/sessions.js');
  const server = [
    { role: 'user', content: '问题1' }, { role: 'assistant', content: '回答1' },
    { role: 'user', content: '问题2' }, { role: 'assistant', content: '回答2' },
  ];
  // 客户端只有前半段（一轮结束后 1.5 秒内切走 / 重拉失败留下的旧快照）
  const client = server.slice(0, 2);
  assert.deepEqual(reconcileHistory(server, client), server, '严格前缀 → 用服务端更完整的那份');

  // 客户端做了本地编辑（内容不同）→ 以客户端为准
  const edited = [{ role: 'user', content: '问题1' }, { role: 'assistant', content: '我改过' }];
  assert.deepEqual(reconcileHistory(server, edited), edited);

  // 客户端更长（本地新增）→ 以客户端为准
  const longer = server.concat([{ role: 'user', content: '问题3' }]);
  assert.deepEqual(reconcileHistory(server, longer), longer);

  // 本地有没落盘的编辑（回撤/删除）→ 即使恰好是前缀，也不能被服务端"变回来"
  assert.deepEqual(reconcileHistory(server, client, { localEdits: true }), client);

  // 客户端没交历史 → 用服务端的
  assert.deepEqual(reconcileHistory(server, null), server);
  assert.deepEqual(reconcileHistory(null, client), client, '服务端没有 → 用客户端的');
});

/* ============================ onChange 可退订 ============================ */

test('★ Memory.onChange 返回退订函数：退订后不再回调（跨账号覆盖写的根）', async () => {
  const { Memory } = await import('../src/core/memory.js');
  let hits = 0;
  const off = Memory.onChange(() => { hits++; });
  Memory.write({ title: '甲', content: 'a' });
  assert.equal(hits, 1, '订阅期间照常回调');
  off();
  Memory.write({ title: '乙', content: 'b' });
  assert.equal(hits, 1, '退订后不再回调');
  off();                       // 幂等：重复退订不报错
  assert.equal(typeof Memory.onChange(() => {}), 'function', 'onChange 的返回值是函数');
});

test('★ Prompts.onChange 同样可退订（托管运行每轮注册一次依赖它）', async () => {
  const { Prompts } = await import('../src/core/prompts.js');
  let hits = 0;
  const off = Prompts.onChange(() => { hits++; });
  Prompts.setEnabled('compact.prompt', false);
  assert.equal(hits, 1);
  off();
  Prompts.setEnabled('compact.prompt', true);
  assert.equal(hits, 1, '退订后不再回调');
});

/* ============================ 清单形状（exec_allow） ============================ */

test('★ asStringList：数组/换行串/逗号串三种形状都收敛成数组', async () => {
  const { asStringList, normalizeValue, TOOL_FIELDS } = await import('../src/core/params.js');
  assert.deepEqual(asStringList(['git status', ' git log ']), ['git status', 'git log']);
  assert.deepEqual(asStringList('git status\ngit log'), ['git status', 'git log'], '换行串（旧实现写进盘的那种）');
  assert.deepEqual(asStringList('a,b'), ['a', 'b']);
  assert.deepEqual(asStringList(''), []);
  assert.deepEqual(asStringList(null), []);
  assert.deepEqual(asStringList(undefined), []);
  assert.deepEqual(normalizeValue(TOOL_FIELDS.exec_allow, 'a\nb'), [], 'kind:list 的规范形状是数组（写入端用它）');
});

test('★ matchRule：盘上是换行串时也必须命中（"以后不再问"原先永不生效）', async () => {
  const { AgentPolicy } = await import('../src/core/policy.js');
  assert.equal(AgentPolicy.matchRule('git status', 'git status\ngit log'), 'git status', '字符串清单要能命中');
  assert.equal(AgentPolicy.matchRule('git status', ['git status']), 'git status');
  assert.equal(AgentPolicy.matchRule('git status --short', ['git status']), 'git status', '前缀 + 词边界');
  assert.equal(AgentPolicy.matchRule('git statusx', ['git status']), null, '词边界：不匹配更长的词');
  assert.equal(AgentPolicy.matchRule('git log && rm -rf ~', ['git log']), null, '带串联的整行一律不豁免');
  assert.equal(AgentPolicy.matchRule('git log', []), null);
});

/* ============================ core/http.js ============================ */

test('★ 2xx 但不是 JSON → 必须报错（不能当成"服务端数据是空的"）', async () => {
  const http = await import('../src/core/http.js');
  const orig = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('<html>代理兜底页</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    await assert.rejects(() => http.request('/agent/store'), (e) => {
      assert.match(String(e.message), /不是 JSON/);
      assert.equal(e.network, true);
      return true;
    });
    globalThis.fetch = async () => new Response('{"ok":true,"sessions":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
    const d = await http.request('/agent/store');
    assert.deepEqual(d, { ok: true, sessions: [] }, '正常 JSON 照常返回');
    globalThis.fetch = async () => new Response('{"ok":false,"error":"需要登录"}', { status: 401, headers: { 'content-type': 'application/json' } });
    await assert.rejects(() => http.request('/agent/store'), (e) => e.status === 401);
  } finally { globalThis.fetch = orig; }
});

test('★ pull() 的形状校验：缺字段/空对象的响应一律当"没拉到"', async () => {
  const { Store } = await import('../src/core/store.js');
  const orig = globalThis.fetch;
  const reply = (obj) => { globalThis.fetch = async () => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } }); };
  try {
    Store.user = { username: 'u1' };
    reply({});                                    // 合法 JSON 但不是 store 快照
    assert.equal(await Store.pull(), null, '空对象不算数据（旧实现会拿它清空界面与记忆）');
    reply({ ok: true, settings: {}, sessions: [] });   // 缺 projects/memory/prompts
    assert.equal(await Store.pull(), null);
    reply({ ok: true, settings: {}, memory: [], prompts: {}, projects: [], sessions: [], meta: {} });
    assert.ok(await Store.pull(), '形状齐全才采信');
    reply({ ok: true, memory: [], prompts: {}, projects: [] });   // light：没有 sessions 也算合法
    assert.ok(await Store.pullLight(), 'light 拉取不带会话');
    reply({ ok: true, memory: [], projects: [] });
    assert.equal(await Store.pullLight(), null, 'light 也必须带 prompts');
  } finally {
    globalThis.fetch = orig;
    Store.user = null;
  }
});

/* ============================ core/context.js 裁剪兜底 ============================ */

test('★ 压缩关掉时：只裁**这一轮请求视图**，会话原文一条不动', async () => {
  const { AgentContext } = await import('../src/core/context.js');
  const toasts = [];
  const history = [];
  for (let i = 0; i < 40; i++) {
    history.push({ role: 'user', content: '问题' + i + '：' + '字'.repeat(200) });
    history.push({ role: 'assistant', content: '回答' + i + '：' + '字'.repeat(200) });
  }
  const before = history.length;
  AgentContext.init({
    Prompts: { enabled: () => false, text: () => '' },       // 压缩关掉 → 走裁剪
    numCtx: () => 4000,                                     // 上限很小，必然触发
    history: () => history,
    curSess: () => ({ id: 's1' }),
    getInjectedBlocks: () => ({ blocks: [] }),
    addTraceStrip: () => null,
    fillTraceStrip: () => {},
    toast: (t) => toasts.push(t),
  });
  const msgs = [{ role: 'system', content: '系统' }].concat(history);
  const out = await AgentContext.transformMessages(msgs);
  assert.ok(out.length < msgs.length, '请求视图被裁短了（实际 ' + out.length + ' / ' + msgs.length + '）');
  assert.equal(out[0].role, 'system', 'system 永远留着');
  assert.equal(out[1].role, 'user', '裁完要对齐到 user 边界（否则 tool 结果会与它的 assistant 拆开 → 上游 400）');
  assert.equal(history.length, before, '★ 会话原文一条不动（旧实现是原地 shift，不可逆）');
  assert.ok(toasts.some((t) => /只带最近/.test(t)), '要有提示条告诉用户"原文还在"');
});

test('压缩开着时 transformMessages 走压缩（不会误走裁剪）', async () => {
  const { AgentContext } = await import('../src/core/context.js');
  AgentContext.init({
    Prompts: { enabled: () => true, text: () => '把对话压成摘要' },
    numCtx: () => 100000,                                   // 上限大：不触发任何一层
    history: () => [],
    curSess: () => ({ id: 's1' }),
    getInjectedBlocks: () => ({ blocks: [] }),
    toast: () => {},
  });
  const msgs = [{ role: 'system', content: '系统' }, { role: 'user', content: '你好' }];
  const out = await AgentContext.transformMessages(msgs);
  assert.deepEqual(out, msgs, '没到阈值：原样返回');
});

/* ============================ assemble / 请求参数 ============================ */

test('★ buildRequestOptions：两端同一份（参数表 + 工具 + extraBody + 模型兜底）', async () => {
  const { Assemble } = await import('../src/core/assemble.js');
  const defs = [{ function: { name: 'read_file' } }];
  const o = Assemble.buildRequestOptions({ params: { temperature: 0.5 }, defs, model: 'm1', extraBody: '{"a":1}' });
  assert.equal(o.temperature, 0.5);
  assert.equal(o.tools, defs);
  assert.equal(o.__extraBody, '{"a":1}');
  assert.equal(o.model, 'm1');
  const o2 = Assemble.buildRequestOptions({ params: {}, defs: [] });
  assert.equal('tools' in o2, false, '没有工具就不带 tools 字段');
});

test('★ 组装不会再追加一遍本轮提问（服务端只传 history）', async () => {
  const { buildMessages } = await import('../src/core/assemble.js');
  const env = {
    history: [
      { role: 'user', content: '问题' }, { role: 'assistant', content: '回答' },
      { role: 'user', content: '现在这个问题' },            // 服务端 push 进来的
      { role: 'assistant', content: '', streaming: true },  // 占位（空正文会被滤掉）
    ],
    params: { mem_inject: 'off', tool_mem_on: false, plugin_fs_on: false, plugin_exec_on: false },
    Prompts: { systemBlocks: () => [], skillIndexBlock: () => null, enabled: () => false, text: () => '' },
    Memory: { fullBlock: () => null, indexBlock: () => null, projectBlock: () => null, sessionBlock: () => null },
    AgentDefs: { activeToolDefs: () => [], pluginsAllowed: () => false, pluginGateNote: () => null },
    AgentPolicy: { eff: () => ({ mode: 'custom' }) }, AgentContext: { compactHeader: () => '' }, TOOL_DEFAULTS: {},
  };
  const msgs = buildMessages(env);                          // 托管运行就是这么调的（不再传 req.text）
  assert.equal(msgs.filter((m) => m.content === '现在这个问题').length, 1, '同一个问题只能出现一次');
});

/* ============================ Anthropic 扩展思考 ============================ */

test('★ toMsg：带工具调用的 assistant 轮要原样回传 thinking + signature', async () => {
  const { toMsg } = await import('../src/core/protocol/anthropic.js');
  const m = {
    role: 'assistant', content: '我来读一下', thinking: '先看看文件', thinkingSig: 'sig-abc',
    toolCalls: [{ id: 't1', name: 'read_file', args: { path: '/tmp/a' } }],
  };
  const out = toMsg(m);
  assert.equal(out.content[0].type, 'thinking', 'thinking 必须是第一个块');
  assert.equal(out.content[0].thinking, '先看看文件');
  assert.equal(out.content[0].signature, 'sig-abc', 'signature 缺了上游会 400');
  assert.equal(out.content[1].type, 'text');
  assert.equal(out.content[2].type, 'tool_use');

  const noSig = toMsg({ role: 'assistant', content: '', thinking: '思考', toolCalls: [{ id: 't', name: 'x', args: {} }] });
  assert.equal(noSig.content.some((b) => b.type === 'thinking'), false, '没有签名就别构造这个块（伪造只会换一种 400）');

  const red = toMsg({ role: 'assistant', content: '', redactedThinking: 'enc', toolCalls: [{ id: 't', name: 'x', args: {} }] });
  assert.equal(red.content[0].type, 'redacted_thinking');
  assert.equal(red.content[0].data, 'enc');
});

test('★ anthropic.chat 的流式事件里要带出 signature_delta（否则无从回传）', async () => {
  const { anthropic } = await import('../src/core/protocol/anthropic.js');
  const orig = globalThis.fetch;
  const sse = [
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '想看' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-1' } }],
    ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'read_file' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"/tmp/a"}' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 1 }],
    ['message_stop', { type: 'message_stop' }],
  ].map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
  try {
    globalThis.fetch = async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const evs = [];
    for await (const ev of anthropic.chat({ id: 'p1', type: 'anthropic', model: 'm', baseUrl: 'https://api.anthropic.com/v1' },
      [{ role: 'user', content: '读个文件' }], { reasoning: 'low', maxTokens: 8192 })) evs.push(ev);
    assert.deepEqual(evs.find((e) => e.type === 'thinking_sig'), { type: 'thinking_sig', text: 'sig-1' });
    assert.ok(evs.find((e) => e.type === 'thinking'), 'thinking 事件照旧');
    const calls = evs.find((e) => e.type === 'tool_calls');
    assert.equal(calls.calls[0].name, 'read_file');
  } finally { globalThis.fetch = orig; }
});

test('★ Agent 循环把 signature 挂到带工具调用的 assistant 消息上（下一轮才带得回去）', async () => {
  const { Agent } = await import('../src/core/agent.js');
  const sent = [];
  let round = 0;
  const out = await Agent.run({
    maxRounds: 4,
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: '读文件' }],
    opts: {},
    stream: async function* (msgs) {
      sent.push(msgs);
      round++;
      if (round === 1) {
        yield { type: 'thinking', text: '想一下' };
        yield { type: 'thinking_sig', text: 'sig-xyz' };
        yield { type: 'tool_calls', calls: [{ id: 't1', name: 'read_file', args: { path: '/tmp/a' } }] };
      } else {
        yield { type: 'content', text: '读完了' };
      }
    },
    runTool: async () => ({ ok: true, text: '内容' }),
  });
  assert.equal(out.content, '读完了');
  const second = sent[1];
  const asst = second.find((m) => m.role === 'assistant' && m.toolCalls && m.toolCalls.length);
  assert.ok(asst, '第二轮请求里要有那条 assistant(tool_use)');
  assert.equal(asst.thinking, '想一下');
  assert.equal(asst.thinkingSig, 'sig-xyz', '★ signature 必须挂在消息上（Anthropic 要求原样回传）');
  assert.ok(second.find((m) => m.role === 'tool' && m.content === '内容'), '工具结果照旧');
});
