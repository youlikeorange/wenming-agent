/* 调用保护与 usage 累计（2026-10-07）：
 *   · thinkloop：思考流尾部重复（循环）检测 + 纯思考超量兜底（纯函数矩阵）；
 *   · usage 累计：一次提问多次模型调用，收尾 stats = 各次注入/输出合计，实时事件同口径；
 *   · 单次调用最高时长：超时中断 → 立即重调（不吃上游重试预算）→ 上限后如实失败；
 *   · 思考循环检测：中断重调 2 次 → 最后一次放开检测让它跑完（防"检测-重调"自环）；
 *   · 被中断尝试的 usage / 正文 / 思考一概不计入（Anthropic 流头就回输入用量，不分会重复计数）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/core/agent.js';
import { thinkLoopHit, thinkOnlyRunaway, THINK_ONLY_CAP } from '../src/core/thinkloop.js';

const call = (id, name, args) => ({ id, name, args });

/** 挂住直到 signal 被中止（或 5 秒保险超时，测试永不真挂死） */
const hangUntil = (signal) => new Promise((resolve) => {
  if (signal && signal.aborted) return resolve();
  const t = setTimeout(resolve, 5000);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});
const abortErr = () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });

/* =====================================================================
 * 一、thinkloop 纯函数
 * ===================================================================== */

test('thinkLoopHit：正常思考不误报', () => {
  const normal = Array.from({ length: 80 }, (_, i) => `第${i}步：检查参数边界条件 ${i}，确认取值范围与默认值是否一致。`).join('');
  assert.equal(thinkLoopHit(normal), '', '编号递增的思考不是循环');
  assert.equal(thinkLoopHit(''), '');
  assert.equal(thinkLoopHit('短'), '');
});

test('thinkLoopHit：短语循环（含中文短周期）要抓到', () => {
  assert.ok(thinkLoopHit('我再想想。'.repeat(120)), '5 字周期连排（按倍数周期 10 命中）');
  assert.ok(thinkLoopHit('我又想岔了，重来。'.repeat(120)), '9 字周期连排');
  assert.ok(thinkLoopHit('wait, let me reconsider this step carefully. '.repeat(60)), '英文长句循环');
  assert.ok(thinkLoopHit('正常的开头，前面是没重复的内容。' + '这句话原地重复了很多遍，是循环输出。'.repeat(40)), '后半段循环（前缀不掺和）');
});

test('thinkLoopHit：只看"连排"——重复但中间隔了别的内容的不算', () => {
  const spread = Array.from({ length: 60 }, (_, i) => `common phrase ${i} appears here; `).join('');
  assert.equal(thinkLoopHit(spread), '', '同一短语散布出现、中间有变化 = 不是循环');
  const tail = '思考到了尾声，最后确认一遍方案是可行的，可以给出回答了。';
  assert.equal(thinkLoopHit(tail.repeat(1) + '别的收尾内容'), '', '不足连排次数');
});

test('thinkOnlyRunaway：整轮只有思考且超量 → 兜底命中', () => {
  assert.equal(thinkOnlyRunaway('x'.repeat(THINK_ONLY_CAP + 1), '', []), true, '纯思考超量');
  assert.equal(thinkOnlyRunaway('x'.repeat(THINK_ONLY_CAP + 1), '有一点正文', []), false, '有正文不算');
  assert.equal(thinkOnlyRunaway('x'.repeat(THINK_ONLY_CAP + 1), '', [call('t', 'a', {})]), false, '有工具调用不算');
  assert.equal(thinkOnlyRunaway('x'.repeat(100), '', []), false, '没超量');
});

/* =====================================================================
 * 二、usage 累计（实时事件与收尾 stats 都是累计口径）
 * ===================================================================== */

/** 与 agent-core.test.mjs 同款假流：按脚本逐轮返回 */
function fakeStream(script) {
  let i = 0;
  return async function* () {
    const step = script[Math.min(i++, script.length - 1)];
    if (step.think) yield { type: 'thinking', text: step.think };
    if (step.content) yield { type: 'content', text: step.content };
    if (step.calls) yield { type: 'tool_calls', calls: step.calls };
    if (step.stop) yield { type: 'stop', reason: step.stop };
    if (step.stats) yield { type: 'stats', raw: step.stats };
  };
}

test('usage 累计：三轮调用的注入/输出合计进收尾 stats，实时事件同口径', async () => {
  const statEvents = [];
  const out = await Agent.run({
    maxRounds: 6,
    stream: fakeStream([
      { calls: [call('t1', 'web_search', { query: 'x' })], stats: { prompt_eval_count: 100, eval_count: 20 } },
      { calls: [call('t2', 'read_file', { path: '/a' })], stats: { prompt_eval_count: 150, eval_count: 30 } },
      { content: '最终回答', stats: { prompt_eval_count: 200, eval_count: 50 } },
    ]),
    getSteering: () => [], getFollowUps: () => [],
    runTool: async () => ({ ok: true, text: 'ok' }),
    hooks: { onStats: (raw) => statEvents.push(raw) },
  });
  assert.equal(out.stats.prompt_eval_count, 450, '收尾 = 三次注入合计（100+150+200）');
  assert.equal(out.stats.eval_count, 100, '收尾 = 三次生成合计（20+30+50）');
  assert.equal(statEvents.length, 3, '每次调用结束发一条');
  assert.equal(statEvents[1].prompt_eval_count, 250, '实时事件 = 累计到此（100+150）');
  assert.equal(statEvents[2].eval_count, 100, '实时事件最后一条 = 全部合计');
});

test('usage 累计：用户停止那次的 usage 也计入（token 已经消耗了）', async () => {
  let attempts = 0;
  const stream = async function* (msgs, opts, signal) {
    attempts++;
    if (attempts === 1) {
      yield { type: 'content', text: '第一段' };
      yield { type: 'stats', raw: { prompt_eval_count: 80, eval_count: 12 } };
      yield { type: 'tool_calls', calls: [call('t1', 'run_command', { command: 'ls' })] };
      return;
    }
    yield { type: 'stats', raw: { prompt_eval_count: 90, eval_count: 5 } };
    yield { type: 'content', text: '第二轮的前半' };
    await hangUntil(signal);           // 用户在这里点停止
    throw abortErr();
  };
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 60);    // 第二轮挂着的时候停
  const out = await Agent.run({
    maxRounds: 4, stream, signal: ac.signal,
    getSteering: () => [], getFollowUps: () => [],
    runTool: async () => ({ ok: true, text: 'ok' }),
  });
  assert.equal(out.stopped, true, '按用户停止收尾');
  assert.equal(out.stats && out.stats.prompt_eval_count, 170, '两轮注入都计入（80+90）');
});

/* =====================================================================
 * 三、单次调用最高时长
 * ===================================================================== */

test('调用保护：单次超时中断 → 立即重调，半截内容与 usage 都不计入', async () => {
  const notices = [];
  let attempts = 0;
  const stream = async function* (msgs, opts, signal) {
    attempts++;
    if (attempts === 1) {
      yield { type: 'content', text: '卡住的前半句' };
      yield { type: 'stats', raw: { prompt_eval_count: 999, eval_count: 1 } };
      await hangUntil(signal);
      throw abortErr();
    }
    yield { type: 'stats', raw: { prompt_eval_count: 100, eval_count: 10 } };
    yield { type: 'content', text: '回答完成' };
    yield { type: 'stop', reason: 'stop' };
  };
  const out = await Agent.run({
    maxRounds: 3, callTimeoutSec: 0.05, stream,
    getSteering: () => [], getFollowUps: () => [],
    runTool: async () => ({ ok: true, text: 'ok' }),
    hooks: { onNotice: (n) => notices.push(n) },
  });
  assert.equal(out.content, '回答完成', '被中断尝试的半截正文不累计');
  assert.equal(out.stats.prompt_eval_count, 100, '被中断尝试的 usage 不计入（Anthropic 流头回用量，不分会重复计）');
  assert.equal(out.rounds, 0, '重调不算轮次（轮次只数工具轮，最终回答轮不记）');
  assert.equal(notices.filter((n) => n.kind === 'call_timeout').length, 1, '中断有提示');
});

test('调用保护：连续超时到上限 → 如实报错（不睡 30 秒走上游重试）', async () => {
  const t0 = Date.now();
  const stream = async function* (msgs, opts, signal) {
    yield { type: 'content', text: 'x' };
    await hangUntil(signal);
    throw abortErr();
  };
  await assert.rejects(
    () => Agent.run({
      maxRounds: 2, callTimeoutSec: 0.05, stream,
      getSteering: () => [], getFollowUps: () => [],
      runTool: async () => ({ ok: true, text: 'ok' }),
    }),
    /超过最高时长/,
  );
  assert.ok(Date.now() - t0 < 3000, `失败要快（实际 ${Date.now() - t0}ms），不能掉进 30 秒上游重试`);
});

test('调用保护：用户主动停止不被超时逻辑吞掉', async () => {
  const stream = async function* (msgs, opts, signal) {
    yield { type: 'content', text: '用户能看到的前半句' };
    await hangUntil(signal);
    throw abortErr();
  };
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 40);
  const out = await Agent.run({
    maxRounds: 2, callTimeoutSec: 0.02, stream, signal: ac.signal,
    getSteering: () => [], getFollowUps: () => [],
    runTool: async () => ({ ok: true, text: 'ok' }),
  });
  assert.equal(out.stopped, true, '超时与用户停止同时在场时，按"用户停止"收尾');
  assert.ok(out.content.includes('用户能看到的前半句'), '已生成的部分一个字不丢');
});

/* =====================================================================
 * 四、思考循环检测（内核级）
 * ===================================================================== */

test('思考循环：检出即中断重调，最后一次放开检测让模型说完', async () => {
  const notices = [];
  let attempts = 0;
  const unit = '我又想岔了，重来。';      // 9 字
  const stream = async function* (msgs, opts, signal) {
    attempts++;
    if (attempts <= 2) {
      for (let i = 0; i < 400; i++) {
        yield { type: 'thinking', text: unit };
        if (signal && signal.aborted) throw abortErr();
        await new Promise((r) => setTimeout(r, 0));
      }
      return;                             // 没被中断的话就是一轮空回答（守卫会另案处理）
    }
    yield { type: 'content', text: '想清楚了，这是回答' };
    yield { type: 'stop', reason: 'stop' };
  };
  const out = await Agent.run({
    maxRounds: 3, stream,
    getSteering: () => [], getFollowUps: () => [],
    runTool: async () => ({ ok: true, text: 'ok' }),
    hooks: { onNotice: (n) => notices.push(n) },
  });
  assert.equal(attempts, 3, '中断重调 2 次 + 放开检测的最后一次');
  assert.equal(notices.filter((n) => n.kind === 'think_loop').length, 2, '每次中断都有提示');
  assert.equal(out.content, '想清楚了，这是回答', '最终能给出回答');
  assert.equal(out.rounds, 0, '轮次只数工具轮');
});

test('思考循环：正常思考完全不受影响', async () => {
  const out = await Agent.run({
    maxRounds: 3,
    stream: fakeStream([
      { think: Array.from({ length: 40 }, (_, i) => `第${i}步推演：假设 A 成立则检查 B；否则回退到 C 重新评估。`).join(''), content: '回答' },
    ]),
    getSteering: () => [], getFollowUps: () => [],
    runTool: async () => ({ ok: true, text: 'ok' }),
  });
  assert.equal(out.content, '回答', '正常一轮直接过');
});
