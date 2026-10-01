/** lib/agent/tools/exec.js —— 命令行工具（**真正以绑定账号运行**）
 *
 *  与文件工具的区别：这里不是"判定权限"，而是**换身份执行**——
 *  绑定账号就是站点进程用户时直接 `/bin/sh -c`；不同账号时用 su 拉起
 *  （密码只走 stdin 管道，不进命令行、不进环境变量、不进日志）。
 *  于是"这条命令能做到什么"完全由操作系统的权限决定，与在终端里用那个账号敲完全一致。
 *
 *  安全闸门：
 *    · 危险命令命中清单 → 需要人在界面上点「授权执行」（一次性票据，见 lib/agent/grants.js）；
 *    · 环境变量白名单（服务端进程的环境变量绝不外泄给模型跑的命令）；
 *    · 输出/超时/工作目录上限；登出即杀掉以该身份在跑的子进程。
 */
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { auditLog } = require('../../auth');
const { denyHit } = require('../deny');
const { takeGrant } = require('../grants');
const { kb, clampPos } = require('../limits');
const fsTools = require('./fs');
const session = require('../session');

/* ============================ 环境变量白名单 ============================ */

/** 旧实现直接 `Object.assign({}, process.env, …)` —— 服务端进程的环境变量对模型完全可见
 *  （实测 `echo $MY_SECRET_TOKEN` 原样返回），而模型的流量是发往远程服务商的。
 *  这里改成**白名单**：只传真正影响命令行为的那几个。要额外放行用 AGENT_EXEC_ENV_PASS。 */
const ENV_PASS = new Set(['PATH', 'HOME', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ',
  'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'DISPLAY', 'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE',
  'COLUMNS', 'LINES', 'PWD', 'HOSTNAME']);
const ENV_PASS_EXTRA = (process.env.AGENT_EXEC_ENV_PASS || '').split(',').map((s) => s.trim()).filter(Boolean);
/** 名字里像密钥的一律不传，即便被白名单或 AGENT_EXEC_ENV_PASS 点上（防手滑） */
const ENV_SECRET_RE = /(PASS|PWD|SECRET|TOKEN|KEY|CREDENTIAL|AUTH|COOKIE|SESSION|SALT|HASH)/i;

function baseEnv(home) {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (ENV_SECRET_RE.test(k)) continue;                 // 密钥类：任何情况下都不传
    if (!ENV_PASS.has(k) && !ENV_PASS_EXTRA.some((p) => k === p || k.startsWith(p))) continue;
    out[k] = v;
  }
  if (home) out.HOME = home;                             // 以绑定账号的家目录为准
  if (!out.HOME) out.HOME = (() => { try { return os.homedir(); } catch { return '/'; } })();
  if (!out.PATH) out.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  return out;
}

/* ============================ 子进程登记与登出清理 ============================ */

const activeChildren = new Map();          // account -> Set<pid>

function trackChild(account, pid) {
  if (!pid) return;
  let set = activeChildren.get(account);
  if (!set) { set = new Set(); activeChildren.set(account, set); }
  set.add(pid);
}

function untrackChild(account, pid) {
  const set = activeChildren.get(account);
  if (!set || !pid) return;
  set.delete(pid);
  if (!set.size) activeChildren.delete(account);
}

/** 杀掉某个账号下所有在跑的子进程（返回条数）。先按进程组杀，杀不到再退回落单进程。 */
function killChildrenOf(account) {
  const set = activeChildren.get(String(account || ''));
  if (!set || !set.size) return 0;
  let n = 0;
  for (const pid of [...set]) {
    try { process.kill(-pid, 'SIGKILL'); n++; }
    catch { try { process.kill(pid, 'SIGKILL'); n++; } catch { /* 已经退出了 */ } }
  }
  activeChildren.delete(String(account || ''));
  return n;
}

/* 登出（或解绑）立即收回：否则一条 run_command 可以在用户登出之后继续以那个身份跑完——
 * AGENT_EXEC_MAX_SEC 默认 600s，绑的是 root 时就是 root 权限的命令在登出后继续落地。 */
session.onLogout((account) => {
  const n = killChildrenOf(account);
  if (n) auditLog(`agent-exec-kill-on-logout account=${account} n=${n}`);
});

/* ============================ 执行 ============================ */

/** 启动方式：同用户直接跑；身份不同用 su 拉起（密码走 stdin）。
 *  su 无 tty 时从 stdin 读密码（与绑定校验同一姿势），密码只存在于与子进程之间的**内核管道**里，
 *  任何 /proc 取证都看不到；写完即关 stdin，内层命令读 stdin 得到 EOF。 */
function spawnSpec(actor, command) {
  /* 未解锁一律不放行 —— **两种绑定都要**。'same' 档也要求解锁后，这条判断必须放在
     method 分支**之前**：放在 su 分支里的话，一条存量 same 绑定（旧规则建立的、免解锁）
     仍会以站点进程身份直接把命令跑掉（实测 tester 能以 leo 身份执行任意命令）。 */
  if (actor.needUnlock) {
    throw Object.assign(new Error(`需要先解锁：以 ${actor.osUser} 的身份执行命令需要在本次会话里输入一次该账号的密码`
      + '（密码只在内存里保存，从不落盘）。'), { status: 403, needUnlock: true, osUser: actor.osUser });
  }
  const env = baseEnv(actor.home);
  if (actor.method === 'same') {
    return { command: '/bin/sh', args: ['-c', command], env, viaSu: false };
  }
  if (!actor.password) {
    // 绝不能悄悄用站点进程的身份去跑一条本应以绑定账号执行的命令——那会让"我以 X 执行"的
    // 认知与实际权限完全对不上（比报错危险得多）。
    throw Object.assign(new Error(`需要先解锁：以 ${actor.osUser} 的身份执行命令需要在本次会话里输入一次该账号的密码`
      + '（密码只在内存里保存，从不落盘）。'), { status: 403, needUnlock: true, osUser: actor.osUser });
  }
  return { command: session.SU_BIN, args: ['-s', '/bin/sh', '-c', command, actor.osUser],
    env, viaSu: true, stdinData: String(actor.password) + '\n' };
}

function runOnce(actor, command, cwd, timeoutMs, maxOut) {
  return new Promise((resolve, reject) => {
    let spec;
    try { spec = spawnSpec(actor, command); }
    catch (e) { return reject(e); }
    let child;
    try {
      // su 路径的 stdin 是管道（要喂密码）；同用户路径保持 /dev/null（命令不读输入）
      child = spawn(spec.command, spec.args, { cwd, env: spec.env, detached: true,
        stdio: spec.viaSu ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: -1, out: '', err: '无法启动命令：' + e.message, timedOut: false });
    }
    trackChild(actor.account, child.pid);
    if (spec.stdinData) {
      child.stdin.on('error', () => { /* su 密码错时管道会提前关闭 */ });
      child.stdin.write(spec.stdinData);
      child.stdin.end();
    }
    let out = '', err = '', truncated = false, timedOut = false;
    const push = (which, b) => {
      const s = b.toString('utf8');
      if (which === 'out') { if (out.length < maxOut) out += s; else truncated = true; }
      else { if (err.length < maxOut) err += s; else truncated = true; }
    };
    child.stdout.on('data', (b) => push('out', b));
    child.stderr.on('data', (b) => push('err', b));
    const killer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(killer); untrackChild(actor.account, child.pid); resolve({ code: -1, out, err: err + '\n' + e.message, timedOut }); });
    child.on('close', (code) => { clearTimeout(killer); untrackChild(actor.account, child.pid); resolve({ code, out, err, truncated, timedOut }); });
  });
}

async function runCommand(actor, args, limits, grant) {
  const command = String(args.command || '').trim();
  if (!command) throw Object.assign(new Error('缺少 command'), { status: 400 });
  // 危险命令：不直接拒绝——需要一张与命令全文绑定的一次性授权票据（人在界面点过「授权执行」）
  const hit = denyHit(command);
  if (hit && !takeGrant(grant, command)) {
    throw Object.assign(new Error(`这条命令命中危险操作清单（${hit}），需要用户在界面上点击「授权执行」后才会运行。`
      + '授权窗口已弹出；若用户拒绝了授权，请换更安全的做法，不要原样重试。'),
      { status: 403, needGrant: true, hit });
  }
  // 默认超时取面板设置（limits 已由 effLimits 收敛），模型显式传 timeout_sec 只能更小或合理地大，
  // 一律不得超过服务端硬上限。用 clampPos：0/负数视为"没传"，走默认值。
  const sec = clampPos(args.timeout_sec, 1, limits.timeoutSec, Math.min(60, limits.timeoutSec));
  const maxOut = Math.min(limits.outputBytes, clampPos(Number(args.max_kb) * 1024, 1024, limits.outputBytes, 32 * 1024));
  const cwd = await fsTools.cwdFor(actor, args.cwd);

  const t0 = Date.now();
  const r = await runOnce(actor, command, cwd, sec * 1000, maxOut);
  const ms = Date.now() - t0;
  const head = `$ ${command}\n（cwd ${cwd} · 身份 ${actor.osUser} · ${ms}ms · 退出码 ${r.code}${r.timedOut ? ' · 超时已终止' : ''}）`;
  const body = [
    r.out ? '--- stdout ---\n' + r.out : '',
    r.err ? '--- stderr ---\n' + r.err : '',
    !r.out && !r.err ? '(无输出)' : '',
    r.truncated ? `\n…（输出超过 ${kb(maxOut)} 已截断）` : '',
  ].filter(Boolean).join('\n');
  return { ok: !r.timedOut && r.code === 0, note: r.timedOut ? '超时' : r.code === 0 ? '完成' : `退出码 ${r.code}`, text: head + '\n' + body };
}

module.exports = { runCommand, spawnSpec, killChildrenOf, baseEnv, ENV_PASS, activeChildren };
