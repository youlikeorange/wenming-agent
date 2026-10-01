/* protocol-errors.test.mjs —— 上游报错时，界面/会话里能看到**上游自己说的话**
 * （只给一句 "HTTP 401"，用户无从修起：是密钥、额度还是模型名？）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTransport, upstreamChat } from '../src/core/protocol/transport.js';
import { getProtocol } from '../src/core/protocol.js';

const proto = getProtocol('openai');
const cfg = { id: 'p1', type: 'openai', model: 'm', baseUrl: 'https://x/v1' };

async function firstError(res) {
  setTransport({ chat: async () => res, models: async () => new Response('{}') });
  for await (const ev of proto.chat(cfg, [{ role: 'user', content: 'hi' }], {}, {})) {
    if (ev.type === 'error') return ev.message;
  }
  return '(没有 error 事件)';
}

test('★ 401 带上上游的 error.message（不是只有状态码）', async () => {
  const msg = await firstError(new Response(JSON.stringify({ error: { message: 'invalid api key provided', type: 'invalid_request_error' } }),
    { status: 401, headers: { 'content-type': 'application/json' } }));
  assert.equal(msg, 'HTTP 401：invalid api key provided');
});

test('★ 非 JSON 的报错体：原样带上（去掉换行，截断）', async () => {
  const msg = await firstError(new Response('<html><body>502 Bad Gateway from gateway</body></html>', { status: 502 }));
  assert.match(msg, /^HTTP 502：/);
  assert.match(msg, /502 Bad Gateway/);
});

test('★ 报错体是空的：退回状态码（不崩、不空）', async () => {
  const msg = await firstError(new Response('', { status: 429 }));
  assert.equal(msg, 'HTTP 429');
});

test('★ 额度类错误里的 message 也要带出来（用户据此去充值/换 key）', async () => {
  const msg = await firstError(new Response(JSON.stringify({ message: 'quota exceeded: balance is 0' }), { status: 403 }));
  assert.equal(msg, 'HTTP 403：quota exceeded: balance is 0');
});

test('★ upstreamChat 仍走 transport（没把最后一跳改坏）', async () => {
  setTransport({ chat: async () => new Response('ok'), models: async () => new Response('{}') });
  const r = await upstreamChat({ provider: 'p1' }, {}, null, '');
  assert.equal(r.status, 200);
});
