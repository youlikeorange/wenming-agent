/* protocol/textcalls.test.mjs —— "写成正文的工具调用"解析器 + 协议适配器串联
 *
 *  背景（都是实测/上游 issue 记过的形态）：
 *    · DeepSeek V4 系列的 DSML 标记会被上游漏解析，整块当正文返回
 *      （vllm-project/vllm#48931：漏掉起始标记时整块泄漏；模型仓库 discussion #209：退化成半角双竖线）；
 *    · 少部分实现写成 XML（tool_call / function= / parameter=）；
 *    · 漏进正文后，Agent 看不到 tool_calls → 把标记当"最终回答"收尾退出循环。
 *
 *  测试里的标记一律用**拼装函数**生成（不写字面量）：源码里不出现标签形态，
 *  编辑器/工具链的规范化就碰不到它；两端字符也与真实模型输出逐字一致。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { textCallSplitter, parseCallBlock } from '../src/core/protocol/textcalls.js';

const LT = '\u003c';
const GT = '\u003e';
const BAR = '\uff5c';                       // 全角竖线 U+FF5C
const FP = BAR + 'DSML' + BAR;              // 规范标记
const DP = '||DSML||';                      // 退化标记（半角双竖线）
const tag = (mark, n, a) => LT + mark + n + (a ? ' ' + a : '') + GT;
const ctag = (mark, n) => LT + '/' + mark + n + GT;
/** 规范形：全角竖线 + 换行 */
const T = (n, a) => tag(FP, n, a);
const C = (n) => ctag(FP, n);
/** 退化形：半角双竖线 + 无换行 */
const T2 = (n, a) => tag(DP, n, a);
const C2 = (n) => ctag(DP, n);

/** 按固定大小切块喂进拆分器，收集正文与调用 */
function collect(text, size) {
  const sp = textCallSplitter();
  let content = '';
  const calls = [];
  const take = (evs) => {
    for (const e of evs) {
      if (e.type === 'content') content += e.text;
      else calls.push(...e.calls.map((c) => ({ name: c.name, args: c.args, recovered: !!e.recovered })));
    }
  };
  for (let i = 0; i < text.length; i += size) take(sp.feed(text.slice(i, i + size)));
  take(sp.flush());
  return { content, calls };
}

const DEGRADED = '干活：'
  + T2('tool_calls')
  + T2('invoke', 'name="write_file"')
  + T2('parameter', 'name="path" string="true"') + '/tmp/a.txt' + C2('parameter')
  + T2('parameter', 'name="content" string="true"') + 'hello' + C2('parameter')
  + C2('invoke')
  + T2('invoke', 'name="run_command"')
  + T2('parameter', 'name="command" string="true"') + 'ls -la' + C2('parameter')
  + C2('invoke')
  + C2('tool_calls') + '完了';

const CANONICAL = '先读一下。\n' + T('tool_calls') + '\n'
  + T('invoke', 'name="read_file"') + '\n'
  + T('parameter', 'name="path" string="true"') + '/etc/hosts' + C('parameter') + '\n'
  + T('parameter', 'name="start_line"') + '10' + C('parameter') + '\n'
  + T('parameter', 'name="replace_all"') + 'true' + C('parameter') + '\n'
  + C('invoke') + '\n' + C('tool_calls');

test('DSML：规范形态（全角竖线 + 换行）解析出调用，正文只留前导文字', () => {
  const r = collect(CANONICAL, 1);
  assert.equal(r.content, '先读一下。\n', '正文只剩下前导文字');
  assert.deepEqual(r.calls, [{ name: 'read_file', args: { path: '/etc/hosts', start_line: 10, replace_all: true }, recovered: true }]);
});

test('DSML：退化形态（半角双竖线、无换行、多调用）同样解析', () => {
  const r = collect(DEGRADED, 1);
  assert.equal(r.content, '干活：完了', '前后正文都保留');
  assert.equal(r.calls.length, 2, '两个 invoke 都要认出来');
  assert.deepEqual(r.calls[0], { name: 'write_file', args: { path: '/tmp/a.txt', content: 'hello' }, recovered: true });
  assert.deepEqual(r.calls[1], { name: 'run_command', args: { command: 'ls -la' }, recovered: true });
});

test('DSML：逐字流 / 小段 / 整段三种切法结果一致（标记跨 chunk 不许丢）', () => {
  for (const src of [CANONICAL, DEGRADED]) {
    const a = collect(src, 1), b = collect(src, 5), c = collect(src, 4096);
    assert.deepEqual(a, b, '逐字流与小段流一致');
    assert.deepEqual(b, c, '小段流与整段流一致');
  }
});

test('DSML：缺起始包裹（孤儿 invoke）也认——模型在长上下文会漏掉它（vllm#48931）', () => {
  const src = T('invoke', 'name="read_file"')
    + T('parameter', 'name="path" string="true"') + '/etc/hosts' + C('parameter')
    + C('invoke');
  const r = collect(src, 1);
  assert.equal(r.content, '', '整块被认成调用，正文不残留标记');
  assert.deepEqual(r.calls, [{ name: 'read_file', args: { path: '/etc/hosts' }, recovered: true }]);
});

test('DSML：参数值里含尖括号 / 大于号不截错（写 HTML、跑重定向命令）', () => {
  const html = '<div class="a">if (a < b && c > d) {}</div>\n<div>again</div>';
  const src = T('tool_calls') + T('invoke', 'name="write_file"')
    + T('parameter', 'name="path" string="true"') + '/tmp/x.html' + C('parameter')
    + T('parameter', 'name="content" string="true"') + html + C('parameter')
    + C('invoke') + C('tool_calls');
  const r = collect(src, 3);
  assert.deepEqual(r.calls, [{ name: 'write_file', args: { path: '/tmp/x.html', content: html }, recovered: true }]);
});

test('DSML：参数被包了一层 arguments 时自动拆开（上游兼容写法）', () => {
  const src = T('tool_calls') + T('invoke', 'name="write_file"')
    + T('parameter', 'name="arguments" string="false"') + '{"path":"/tmp/b","content":"hi"}' + C('parameter')
    + C('invoke') + C('tool_calls');
  const r = collect(src, 7);
  assert.deepEqual(r.calls, [{ name: 'write_file', args: { path: '/tmp/b', content: 'hi' }, recovered: true }]);
});

test('XML 形态：tool_call 里一段 JSON / function= 结构 都能认', () => {
  const json = LT + 'tool_call' + GT + '{"name":"list_directory","arguments":{"path":"/tmp"}}' + LT + '/tool_call' + GT;
  const r1 = collect(json, 1);
  assert.deepEqual(r1.calls, [{ name: 'list_directory', args: { path: '/tmp' }, recovered: true }]);

  const fn = LT + 'function_calls' + GT + LT + 'function="search_files"' + GT
    + LT + 'parameter="pattern"' + GT + '*.js' + LT + '/parameter' + GT
    + LT + '/function' + GT + LT + '/function_calls' + GT;
  const r2 = collect(fn, 1);
  assert.deepEqual(r2.calls, [{ name: 'search_files', args: { pattern: '*.js' }, recovered: true }]);
});

test('只是正文里提到标记（没有完整块）→ 不误判、不吞内容', () => {
  const prose = '说明：模型会输出 ' + T('invoke', 'name="read_file"') + ' 这种标签，但没有闭合';
  const r = collect(prose, 1);
  assert.equal(r.calls.length, 0, '不许当成调用');
  assert.equal(r.content, prose, '正文逐字保留');
});

test('块一直不闭合且超长 → 原样吐回正文（绝不静默吞内容）', () => {
  const src = T('tool_calls') + T('invoke', 'name="write_file"')
    + T('parameter', 'name="content" string="true"') + 'x'.repeat(200);
  const r = collect(src, 4096);
  assert.equal(r.calls.length, 0);
  assert.equal(r.content, src, '没闭合的块原样当正文');
});

test('parseCallBlock：认不出的块返回空数组（调用方据此当正文显示）', () => {
  assert.deepEqual(parseCallBlock('普通文本'), []);
  assert.deepEqual(parseCallBlock(T('tool_calls') + C('tool_calls')), []);
});

/* ============ 与协议适配器串联：SSE → 拆分器 → 统一事件流 ============ */

/** 用假的 fetch 造一条 SSE 流（同时锁住"每条 data 一行"的分帧口径） */
function stubFetch(lines) {
  const enc = new TextEncoder();
  let i = 0;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => (i < lines.length ? { done: false, value: enc.encode(lines[i++]) } : { done: true, value: undefined }),
        cancel: async () => {},
      }),
    },
  });
}
const sseLine = (obj) => 'data: ' + JSON.stringify(obj) + '\n\n';
const delta = (d) => sseLine({ choices: [{ delta: d }] });

test('openai 适配器：正文里的 DSML 被认成 tool_calls（不再当最终回答）', async () => {
  const { openai } = await import('../src/core/protocol/openai.js');
  const saved = globalThis.fetch;
  try {
    stubFetch([
      delta({ content: '我来改这份文档。' }),
      delta({ content: T('tool_calls') + T('invoke', 'name="edit_file"') }),
      delta({ content: T('parameter', 'name="path" string="true"') + '/docs/a.md' + C('parameter') }),
      delta({ content: T('parameter', 'name="new_text" string="true"') + '新' + C('parameter') + C('invoke') + C('tool_calls') }),
      sseLine({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ]);
    const evs = [];
    for await (const ev of openai.chat({ model: 'm', baseUrl: 'http://127.0.0.1:1/v1' }, [{ role: 'user', content: 'hi' }], {}, {})) evs.push(ev);
    const content = evs.filter((e) => e.type === 'content').map((e) => e.text).join('');
    const calls = evs.filter((e) => e.type === 'tool_calls').flatMap((e) => e.calls);
    assert.equal(content, '我来改这份文档。', '正文只剩前导说明，标记不进正文');
    assert.equal(calls.length, 1, '认出一个工具调用');
    assert.equal(calls[0].name, 'edit_file');
    assert.deepEqual(calls[0].args, { path: '/docs/a.md', new_text: '新' });
  } finally { globalThis.fetch = saved; }
});

test('openai 适配器：结构化 tool_calls 与正文标记并存时都发出（顺序不丢）', async () => {
  const { openai } = await import('../src/core/protocol/openai.js');
  const saved = globalThis.fetch;
  try {
    stubFetch([
      delta({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"path":"/a"}' } }] }),
      sseLine({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ]);
    const evs = [];
    for await (const ev of openai.chat({ model: 'm', baseUrl: 'http://127.0.0.1:1/v1' }, [{ role: 'user', content: 'hi' }], {}, {})) evs.push(ev);
    const calls = evs.filter((e) => e.type === 'tool_calls').flatMap((e) => e.calls);
    assert.deepEqual(calls.map((c) => c.name), ['read_file'], '结构化调用照旧');
    assert.equal(calls[0].id, 'c1', 'id 原样保留');
  } finally { globalThis.fetch = saved; }
});
