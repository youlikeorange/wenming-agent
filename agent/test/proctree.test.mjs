/* proctree 归属判定与 kill 族免授权（2026-10-07）：
 *   · isAgentOwned：三条证据链（祖先链到站点进程 / 子树采样 seen / 进程组兜底 roots），
 *     站点进程自己永远不算 agent 自启（自保保留）；
 *   · resolveKillTargets / killExempt：目标解析是保守超集——看不懂一律不放行；
 *   · 端到端：测试进程自己当"站点"（SERVER_PID=process.pid），真 spawn setsid 后台任务 →
 *     subreaper 归养 → 通过 exec.runCommand 的真实闸门免票据杀掉。
 * 真实 /proc 用例要求 gcc（编 subreaper 插件）；本仓库环境满足。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const proctree = require('../../lib/agent/proctree.js');
const execTools = require('../../lib/agent/tools/exec.js');
const { denyHit } = require('../../lib/agent/deny.js');

const { killExempt, resolveKillTargets, isAgentOwned, _test } = proctree;
const SERVER_PID = process.pid;

/** 造假 /proc：Map<pid, stat>；ppid 断链的守规矩地指向 1（init） */
function fakeStats(rows) {
  const m = new Map();
  for (const r of rows) m.set(r.pid, {
    pid: r.pid, comm: r.comm, state: r.state || 'S',
    ppid: r.ppid ?? 1, pgid: r.pgid ?? r.pid, sid: r.sid ?? r.pid,
    starttime: r.starttime ?? 100,
  });
  return m;
}

/** 干净的登记表（每条用例独立，防串味） */
function freshRegistries() {
  _test.roots.clear();
  _test.seen.clear();
  _test.setCmdlineReader(null);   // cmdline 读取器也复位（防上一条用例的假数据漏过来）
}

/* =====================================================================
 * 一、归属判定 isAgentOwned（假 /proc）
 * ===================================================================== */

test('isAgentOwned：祖先链到达站点进程 → 属于 agent（含孙子代）', () => {
  freshRegistries();
  const stats = fakeStats([
    { pid: 101, ppid: SERVER_PID, comm: 'sh' },
    { pid: 102, ppid: 101, comm: 'python3' },
    { pid: 103, ppid: 102, comm: 'ffmpeg' },      // 后台任务再 fork 的 worker
    { pid: 201, ppid: 1, comm: 'chrome' },        // 无关进程
  ]);
  assert.equal(isAgentOwned(101, stats), true, '直接子进程');
  assert.equal(isAgentOwned(102, stats), true, '孙进程');
  assert.equal(isAgentOwned(103, stats), true, '曾孙进程');
  assert.equal(isAgentOwned(201, stats), false, '无关进程不属于 agent');
});

test('isAgentOwned：站点进程自己、pid 1、查不到的进程 → 都不算 agent 自启（自保保留）', () => {
  freshRegistries();
  const stats = fakeStats([{ pid: 101, ppid: SERVER_PID, comm: 'sh' }]);
  assert.equal(isAgentOwned(SERVER_PID, stats), false, '站点自己（pkill -f server.js 要授权）');
  assert.equal(isAgentOwned(1, stats), false, 'init');
  assert.equal(isAgentOwned(99999, stats), false, '查不到 → 保守不豁免');
});

test('isAgentOwned：证据 2——曾在站点子树被采样（seen），starttime 防 PID 复用', () => {
  freshRegistries();
  const stats = fakeStats([{ pid: 300, ppid: 1, comm: 'python3', starttime: 777 }]);
  assert.equal(isAgentOwned(300, stats), false, '孤儿且没采样过 → 不豁免');
  _test.seen.set(300, 777);
  assert.equal(isAgentOwned(300, stats), true, '采样过且 starttime 对上 → 豁免');
  _test.seen.set(300, 999);
  assert.equal(isAgentOwned(300, stats), false, 'starttime 对不上（PID 被复用）→ 不豁免');
});

test('isAgentOwned：证据 3——进程组/会话是登记过的命令根（父壳已退出的后台任务）', () => {
  freshRegistries();
  /* 命令根 500 已退出（stats 里没有它），它的组还在跑：没 setsid 的后台任务组号不变 */
  _test.roots.set(500, { born: Date.now(), starttime: 55, cmd: 'sh -c train' });
  const orphan = fakeStats([{ pid: 501, ppid: 1, comm: 'python3', pgid: 500, starttime: 66 }]);
  assert.equal(isAgentOwned(501, orphan), true, '组长已退出，组号兜底 → 豁免');

  /* 组长活着：starttime 对得上才认（防 PID 复用出的新组长顶名） */
  const liveLeader = fakeStats([
    { pid: 500, ppid: SERVER_PID, comm: 'sh', starttime: 55 },
    { pid: 501, ppid: 500, comm: 'python3', pgid: 500 },
  ]);
  assert.equal(isAgentOwned(501, liveLeader), true, '活组长 + starttime 对上');
  const reused = fakeStats([
    { pid: 500, ppid: 1, comm: 'sshd', starttime: 99999 },   // pid 500 已被复用成别的进程
    { pid: 501, ppid: 1, comm: 'python3', pgid: 500 },
  ]);
  assert.equal(isAgentOwned(501, reused), false, '组长被复用（starttime 不对）→ 不豁免');
});

/* =====================================================================
 * 二、目标解析与免授权判定（假 /proc + 假 cmdline）
 * ===================================================================== */

const OWNED_CMDLINE = 'python3 train.py --epochs 3';
const SCENE = () => fakeStats([
  { pid: SERVER_PID, comm: 'node', starttime: 1 },               // 站点自己
  { pid: 101, ppid: SERVER_PID, comm: 'sh', starttime: 2 },
  { pid: 102, ppid: 101, comm: 'python3', pgid: 102, starttime: 3 },
  { pid: 201, ppid: 1, comm: 'firefox', starttime: 4 },          // 用户的浏览器
  { pid: 202, ppid: 1, comm: 'python3', starttime: 5 },          // 别人跑的 python
]);

test('killExempt：杀 agent 自启的后台任务 → 免票据（pkill -f / pkill 名字 / kill pid）', () => {
  freshRegistries();
  const stats = SCENE();
  _test.setCmdlineReader((pid) => (pid === 102 ? OWNED_CMDLINE
    : pid === SERVER_PID ? 'node server.js' : pid === 201 ? 'firefox' : null));
  assert.equal(killExempt('pkill -f train.py', stats), true, 'pkill -f 模式匹配自启任务');
  assert.equal(killExempt('pkill python3', stats), false, '按名字杀：站点外还有别的 python3 → 目标超集不干净');
  assert.equal(killExempt('kill -9 102', stats), true, '按 pid 杀自启任务');
  assert.equal(killExempt('kill 102', stats), true, '默认信号（TERM）同样免');
  assert.equal(killExempt('sudo pkill -f train.py', stats), true, '包装器剥掉后照常判定');
});

test('killExempt：目标里混进任何非 agent 进程 → 照旧要授权（含站点自己）', () => {
  freshRegistries();
  const stats = SCENE();
  _test.setCmdlineReader((pid) => (pid === 102 ? OWNED_CMDLINE
    : pid === SERVER_PID ? 'node server.js' : pid === 201 ? 'firefox' : null));
  assert.equal(killExempt('pkill -f server.js', stats), false, '命中站点自己 → 要授权（自保）');
  assert.equal(killExempt('pkill firefox', stats), false, '用户的浏览器 → 要授权');
  assert.equal(killExempt('kill -9 1', stats), false, 'init → 要授权');
  assert.equal(killExempt('kill -9 201', stats), false, '无关进程的 pid → 要授权');
  assert.equal(killExempt('kill -- -1', stats), false, '组 -1（全部进程）→ 看不懂级危险 → 要授权');
});

test('killExempt：看不懂的形式一律不放行（保守方向）', () => {
  freshRegistries();
  const stats = SCENE();
  _test.setCmdlineReader((pid) => (pid === 102 ? OWNED_CMDLINE : null));
  assert.equal(killExempt('pkill -v train.py', stats), false, '-v 反转命中集 → 不放');
  assert.equal(killExempt('pkill -f "$(reboot)"', stats), false, '子壳一票否决');
  assert.equal(killExempt('pkill -f x; rm -rf /', stats), false, '多段里混进别的危险命令 → 整条不放');
  assert.equal(killExempt('pkill -f x; reboot', stats), false, '多段里混进 reboot → 不放');
  assert.equal(killExempt('pkill -f nothingmatchesxyz', stats), false, '零命中：看不懂想杀什么 → 弹窗');
  assert.equal(killExempt('pkill -f train.py extra', stats), false, '两个模式 → 不放');
  assert.equal(killExempt('pkill -f "a b"', stats), false, '引号空格模式没命中任何目标 → 零命中 → 弹窗');
  assert.equal(killExempt('pkill -f "train.py$"', stats), false, '锚在行尾但命令行长于它 → 零命中');
  _test.setCmdlineReader(() => null);
  assert.equal(killExempt('pkill -f train.py', stats), false, 'cmdline 全读不到 → 零命中 → 弹窗');
  assert.equal(killExempt('skill -t pts/1', stats), false, 'skill 参数花样多 → 不放');
  assert.equal(killExempt('killall5 -9', stats), false, 'killall5 → 不放');
  assert.equal(killExempt('kill %1', stats), false, '作业号 → 不放');
  assert.equal(killExempt('kill 99999', stats), false, '已消失的 pid → 不放（宁可误拦）');
});

test('killExempt：真实工作流形态——多段命令、引号空格、正则子集、重定向、后台 &（2026-10-07 二版）', () => {
  freshRegistries();
  const stats = SCENE();
  _test.setCmdlineReader((pid) => (pid === 102 ? OWNED_CMDLINE
    : pid === 201 ? 'python3 train.py --epochs 9' : null));   // 外人也在跑 train.py
  /* agent 清理后台任务的真实写法（取证自会话记录）：清理 + 续跑混在一条里 */
  assert.equal(killExempt('pkill -f "python3 train.py" 2>/dev/null; cd /tmp && setsid nohup uv pip install x > /tmp/l.log 2>&1 < /dev/null & echo 已提交', stats), false,
    '模式同时命中自启与外人 → 仍然要票');
  _test.setCmdlineReader((pid) => (pid === 102 ? OWNED_CMDLINE : null));
  assert.equal(killExempt('pkill -f "python3 train.py" 2>/dev/null; cd /tmp && setsid nohup uv pip install x > /tmp/l.log 2>&1 < /dev/null & echo 已提交', stats), true,
    '多段 + 引号空格 + 重定向 + 后台 &：其余段无害 → 免票');
  assert.equal(killExempt('kill 102 2>/dev/null; sleep 3; pkill -f "train.py" 2>/dev/null; echo done', stats), true,
    'kill pid + sleep + pkill + echo 的多段真实形态');
  assert.equal(killExempt('cd /tmp; pkill -f train.py; sleep 1; echo 已清理', stats), true,
    'cd/pkill/sleep/echo 真实形态');
  assert.equal(killExempt('pkill -f "train.[p]y"', stats), true, '引号内正则字符类（自排除惯用写法）');
  assert.equal(killExempt('pkill -f train.[p]y', stats), true, '未加引号的简单字符类：glob 与正则语义一致 → 可判定');
  assert.equal(killExempt('pkill -f "train.py --epochs 3$"', stats), true, '行尾锚 $：与命令行末一致 → 命中自启目标');
  assert.equal(killExempt('pkill -f "train$"', stats), false, '$VAR 会被 shell 展开 → 看不懂');
  assert.equal(killExempt('pkill -f train*', stats), false, '未加引号的 * 会被 glob → 看不懂');
  assert.equal(killExempt('pkill -f "bili_repl[!a]ce"', stats), false, 'glob 的 [!a] 与正则的 [!a] 语义不同 → 不放');
});

test('killExempt：不杀任何东西的直接放行（kill -l / --help），负 pid 组成员全 owned 也放', () => {
  freshRegistries();
  const stats = fakeStats([
    { pid: SERVER_PID, comm: 'node' },
    { pid: 101, ppid: SERVER_PID, comm: 'sh' },
    { pid: 102, ppid: 101, comm: 'python3', pgid: 102 },
  ]);
  assert.equal(killExempt('kill -l', stats), true, '列信号表，不杀东西');
  assert.equal(killExempt('pkill --help', stats), true, '帮助，不杀东西');
  assert.equal(killExempt('kill -- -102', stats), true, '杀自启任务的进程组（组内全是 agent 的）');
  const mixed = fakeStats([
    { pid: SERVER_PID, comm: 'node' },
    { pid: 102, ppid: SERVER_PID, comm: 'python3', pgid: 102 },
    { pid: 301, ppid: 1, comm: 'firefox', pgid: 102 },   // 组里混进外人的进程
  ]);
  assert.equal(killExempt('kill -- -102', mixed), false, '组里混进非 agent 进程 → 要授权');
});

test('resolveKillTargets：命中集是保守超集（过滤器忽略后仍 ⊇ pkill 的目标）', () => {
  freshRegistries();
  const stats = fakeStats([
    { pid: SERVER_PID, comm: 'node' },
    { pid: 102, ppid: SERVER_PID, comm: 'python3' },
    { pid: 103, ppid: 1, comm: 'PYTHON3' },
  ]);
  _test.setCmdlineReader(() => null);
  const r = resolveKillTargets('pkill -i python3', stats);
  assert.deepEqual([...r.targets].sort((a, b) => a - b), [102, 103],
    '-i 大小写不敏感：两个 python3 都算命中；忽略的 -u/-g 等过滤器只会缩小 pkill 的命中集');
});

/* =====================================================================
 * 三、真实 /proc 端到端：本测试进程当"站点"，真 spawn → 真归养 → 真免票据杀掉
 * ===================================================================== */

const MARKER = '30.20261007';   // 唯一标记：真机里几乎不可能撞上的 sleep 时长

test('端到端：setsid 后台任务被 subreaper 归养 → 祖先链可查 → 免票据杀掉 → 僵尸被清扫', async (t) => {
  if (!_test.subreaper) return t.skip('subreaper 插件不可用（无 gcc？），降级路径由单测覆盖');
  freshRegistries();
  const fsMod = require('fs');
  const { spawn } = require('child_process');

  /* 1) 模拟 agent 提交后台任务：父壳秒退，sleep 成为孤儿 */
  const launcher = spawn('/bin/sh', ['-c', `setsid sleep ${MARKER} < /dev/null > /dev/null 2>&1 &`],
    { detached: true, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 500));

  /* 2) 归养：孤儿的 ppid 应当是本进程（站点），祖先链由此永远可查 */
  const stats = (() => {
    const m = new Map();
    for (const name of fsMod.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      const st = _test.readStat(Number(name));
      if (st) m.set(st.pid, st);
    }
    return m;
  })();
  const orphan = [...stats.values()].find((st) => st.comm === 'sleep' && st.ppid === SERVER_PID);
  assert.ok(orphan, 'setsid 孤儿被归养回站点进程（ppid = 站点 pid）');

  /* 3) 免授权判定成立，且 denyHit 确实命中（证明这条走的是"豁免"而不是"没拦"） */
  assert.ok(denyHit('kill -9 ' + orphan.pid), 'kill 命中危险清单（PROC_PROGS）');
  assert.equal(killExempt('kill -9 ' + orphan.pid), true, '目标是 agent 自启进程 → 免票据');
  assert.equal(killExempt('pkill -f ' + MARKER), true, 'pkill -f 按唯一标记同样判为自启目标');

  /* 4) 走 exec.runCommand 的真实闸门：不携带票据也要放行（旧逻辑这里必 403 needGrant） */
  const actor = { account: 't-proctree', osUser: process.env.USER || 'leo', method: 'same',
    needUnlock: false, bound: true, home: '/tmp' };
  const limits = { timeoutSec: 10, outputBytes: 65536 };
  const r = await execTools.runCommand(actor, { command: 'kill -9 ' + orphan.pid, cwd: '/tmp' }, limits, '');
  assert.equal(r.ok, true, `免票据执行成功：${r.text && r.text.slice(0, 120)}`);

  /* 5) 孤儿被 SIGKILL 后变成本进程的僵尸 → 采样器收掉，不常驻进程表 */
  await new Promise((wake) => setTimeout(wake, 300));
  const zBefore = _test.readStat(orphan.pid);
  assert.ok(zBefore === null || zBefore.state === 'Z', '后台任务已退出（SIGKILL 生效）');
  proctree.sample();
  await new Promise((wake) => setTimeout(wake, 100));
  const zAfter = _test.readStat(orphan.pid);
  assert.equal(zAfter, null, `僵尸已被清扫（readStat=${JSON.stringify(zAfter)}）`);

  /* 兜底清理 */
  try { process.kill(orphan.pid, 'SIGKILL'); } catch { /* 已经死了 */ }
  void launcher;
});

test('对照：杀非 agent 进程仍要求票据（exec 闸门 403 needGrant 不回归）', async () => {
  freshRegistries();
  const actor = { account: 't-proctree', osUser: process.env.USER || 'leo', method: 'same',
    needUnlock: false, bound: true, home: '/tmp' };
  const limits = { timeoutSec: 10, outputBytes: 65536 };
  /* init 永远不是 agent 自启的：kill -9 1 必须走授权窗 */
  await assert.rejects(
    () => execTools.runCommand(actor, { command: 'kill -9 1', cwd: '/tmp' }, limits, ''),
    (e) => e.needGrant === true, '无票据杀 init → 403 needGrant');
});
