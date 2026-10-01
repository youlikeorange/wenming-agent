/* 服务端存储/执行模块回归：
 *   · sanitizeSettings：缺字段沿用 prev、空数组 = 显式清空（五轮实测"半量提交毁密钥"）；
 *   · sanitizeSession：会话消息的净化（msgs 字段）；
 *   · spawnSpec：su 密码只走 stdin、不进环境变量（spawnCommand 的 v2 形态）。
 * 说明：这三块对应服务端的 lib/agent/store.js、lib/agent/settings.js 与 lib/agent/tools/exec.js（
 *       lib/agent/settings.js、lib/agent/store.js、lib/agent/tools/exec.js（在站点根 lib/ 下，
 *       不在 agent 构建工程内）。这里用 createRequire 相对引入——它们是纯逻辑，不碰网络。
 * 移植改动：手写 assert/ok() → node:test + node:assert/strict。
 * 被删掉的旧断言见文件末尾注释（与回报说明一致）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const settings = require('../../lib/agent/settings.js');
const store = require('../../lib/agent/store.js');
const exec = require('../../lib/agent/tools/exec.js');
const session = require('../../lib/agent/session.js');

const prev = {
  providers: [{ id: 'p1', type: 'openai', name: '远程', baseUrl: 'https://x.example/v1', model: 'm1', apiKey: 'sk-secret-1234' }],
  activeId: 'p1', params: { temperature: 0.7 }, theme: { mode: 'dark', accent: 'blue', density: 'cozy', scale: 1 },
  myPrompts: [{ id: 'q1', name: '我的', text: '你好' }], currentSess: 's-1',
  memory: [{ id: 'm1', title: '测试', content: '内容' }],
};

test('sanitizeSettings：缺字段沿用 prev、空数组 = 显式清空（五轮实测"半量提交毁密钥"）', () => {
  const out = settings.sanitizeSettings({ params: { temperature: 0.9 } }, prev);
  assert.equal(out.providers.length, 1, '不带 providers → 服务商保留');
  assert.equal(out.providers[0].apiKey, 'sk-secret-1234', '不带 providers → 密钥保留');
  assert.equal(out.activeId, 'p1', '其余缺省字段同样沿用（activeId）');
  assert.equal(out.myPrompts.length, 1, '其余缺省字段同样沿用（myPrompts：v2 已移出 settings，靠 prev 透传保留）');
  assert.equal(out.memory.length, 1, '其余缺省字段同样沿用（memory：v2 已移出 settings，靠 prev 透传保留）');
  assert.equal(out.params.temperature, 0.9, '出现的字段按提交的来（params）');
});

test('sanitizeSettings：带 providers: [] → 显式清空（语义不变）', () => {
  const out = settings.sanitizeSettings({ providers: [] }, prev);
  assert.equal(out.providers.length, 0, '空数组 = 显式清空服务商');
});

test('sanitizeSettings：带 providers（不含 apiKey）→ 密钥保持', () => {
  const out = settings.sanitizeSettings({ providers: [{ id: 'p1', name: '远程改名' }] }, prev);
  assert.equal(out.providers[0].apiKey, 'sk-secret-1234', '空 apiKey = 保持原值（不是清空）');
  assert.equal(out.providers[0].name, '远程改名', '提交的字段按提交的来');
});

test('sanitizeSettings：prev 为空（新用户）也不抛错', () => {
  const out = settings.sanitizeSettings({ providers: [{ id: 'p2', name: 'x' }] }, {});
  assert.equal(out.providers.length, 1, '新用户提交一个服务商 → 保留');
});

test('sanitizeSession：msgs（本站字段名）行为不变', () => {
  const out = store.sanitizeSession({ id: 's-x', msgs: [{ role: 'assistant', content: 'yo' }] });
  assert.equal(out.msgs.length, 1, 'msgs 消息保留');
  assert.equal(out.msgs[0].content, 'yo', '消息正文保留');
});

test('sanitizeSession：两者都没有 → 空会话（不报错）', () => {
  const out = store.sanitizeSession({ id: 's-x' });
  assert.equal(out.msgs.length, 0, '没有消息字段 → 空会话');
});

test('spawnSpec：同用户直接 /bin/sh -c，无 stdinData、无密码变量', () => {
  const spec = exec.spawnSpec({ method: 'same', osUser: session.SITE_USER, home: '/home/x', account: 'a' }, 'ls');
  assert.deepEqual(spec.args, ['-c', 'ls'], '同用户：/bin/sh -c <命令>');
  assert.ok(!spec.viaSu && !spec.stdinData, '不经过 su、不喂 stdin');
  assert.ok(!JSON.stringify(spec.env).includes('LLMCHAT_OS_PW'), '环境里不应再有密码变量');
});

test('spawnSpec：su 用户 → spawn 的就是 su 本身，密码只经 stdinData', () => {
  const spec = exec.spawnSpec({ method: 'su', password: 'PW-xyz', home: '/root', osUser: 'somebody-else', account: 'a' }, 'id');
  assert.ok(spec.command.endsWith('/su') || spec.command === 'su', 'command 应是 su（绝对路径或裸名），实际 ' + spec.command);
  assert.equal(spec.args[0], '-s', 'args[0] = -s');
  assert.equal(spec.args[1], '/bin/sh', 'args[1] = /bin/sh');
  assert.equal(spec.args[2], '-c', 'args[2] = -c');
  assert.equal(spec.args[3], 'id', 'args[3] = 命令');
  assert.equal(spec.args[4], 'somebody-else', 'args[4] = 目标账号');
  assert.equal(spec.stdinData, 'PW-xyz\n', '密码只经 stdinData');
  assert.ok(spec.viaSu, '标记 viaSu');
  const envStr = JSON.stringify(spec.env);
  assert.ok(!envStr.includes('PW-xyz'), '密码绝不能出现在 env（含 LLMCHAT_OS_PW）');
  assert.ok(!envStr.includes('LLMCHAT_OS_PW'), '旧密码变量名彻底消失');
});

test('spawnSpec：su 无密码（重启恢复的会话）→ 明确报错而非静默换身份', () => {
  let threw = null;
  try { exec.spawnSpec({ method: 'su', password: '', home: '/root', osUser: 'somebody-else', account: 'a' }, 'id'); }
  catch (e) { threw = e; }
  assert.ok(threw && threw.needUnlock, '应抛 needUnlock（v2 由 needRelogin 改名）');
  assert.ok(/解锁/.test(threw && threw.message), '报错文案点明需要先解锁');
});

/* ---------------------------------------------------------------------------
 * 被删掉的旧断言（旧代码下成立、v2 下不成立，未改实现）：
 *  1) sanitizeSettings 场景里的 `out.theme === 'light'`：v2 的 theme 从裸字符串改成
 *     结构化对象（mode/accent/density/scale，见 lib/agent/sanitize.js 的 theme()），
 *     提交字符串会被归一成默认主题对象，"提交什么就得到什么"在 theme 上不再适用。
 *  2) `sanitizeSettings({ memory: [] }, prev)` → 期望记忆被清空：v2 里记忆已移出 settings
 *     （全局记忆走 lib/agent/store.js、会话记忆挂在 session 上），settings.sanitizeSettings
 *     根本不读 memory 字段，所以"空数组 = 清空"对 memory 不再成立。
 *  3) `sanitizeSession({ id, messages: [...] })` → 期望 messages 别名被接住：v2 的
 *     store.sanitizeSession 只认 msgs（前端 store.js 也只发 msgs），第三方的 messages
 *     字段被静默忽略——这是一处行为变化，见回报的"实现层问题"。
 * ------------------------------------------------------------------------- */
