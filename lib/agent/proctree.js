/** lib/agent/proctree.js —— agent 自启进程的归属判定 + kill 族命令的目标解析
 *
 *  解决的问题（2026-10-07）：危险清单把 kill/pkill/killall 一律拦到授权窗（deny.js 的
 *  PROC_PROGS 组），但 agent 自己提交的后台任务（setsid nohup … &）收尾时杀它也要授权，
 *  每次都弹窗。这里给出"目标全是 agent 自启进程"的判定，成立即可免票据放行；
 *  目标里混进任何非 agent 进程（用户的程序、系统服务、本站进程自己）→ 照旧要授权。
 *
 *  归属判定（isAgentOwned）三条证据链，任一成立即可：
 *    1. 祖先链到达站点进程（process.pid）。站点进程启动时标记为 PR_SET_CHILD_SUBREAPER
 *       （proctree-subreaper.c，gcc 现编、缓存 os.tmpdir()，失败自动降级），agent 命令
 *       派生的孤儿（setsid/nohup 的后台任务及其子孙）在父壳退出后归养回站点进程——
 *       祖先链**永远**可查，这是主证据，也覆盖"后台任务再 fork 出来的worker"；
 *    2. 目标曾在站点子树里被采样到（seen，按 starttime 防 PID 复用）——subreaper
 *       不可用时的降级兜底；
 *    3. 目标的进程组/会话号是某条登记过的命令根（没 setsid 的后台任务，父壳退出后组号不变）。
 *  站点进程自己**永远不算** agent 自启（pkill -f server.js 照旧要授权——自保规则保留）。
 *
 *  目标解析（resolveKillTargets）的口径是**保守超集**：解析结果 ⊇ pkill 实际会杀的集合，
 *  于是"解析出的目标全 owned ⇒ pkill 杀的必全 owned"：
 *    · 只认参数完全看得懂的简单形式（pkill 的 -f/-x/-i/-e、kill 的 pid/负 pid/信号、
 *      killall 的进程名；skill/killall5 一律不放）；
 *    · 模式一律按"字面子串"匹配（禁正则元字符）——与 pkill 的 ERE 在无元字符时严格等价，
 *      模式带特殊符号、或带引号空格（token 会拆散还原不准）→ 看不懂 → 不放行；
 *    · 忽略的选项只许是"过滤器"（-u/-g/-P…只会缩小命中集）；会**改变**命中集的
 *      （-v 反转）一律看不懂；
 *    · 子壳 $(…)/反引号（参数展开会先执行别的命令）、多条命令（;|&&）、作业号 %1 → 不放行；
 *    · 目标里只要有一个查不到/已消失 → 不放行（宁可误拦，方向与 deny.js 一致）。
 *    · kill -l / --help 这类"根本不杀东西"的直接放行；pkill 模式零命中反而**不放**——
 *      看不懂它想杀什么，弹窗让用户看一眼。
 *
 *  僵尸清扫：subreaper 收养的孤儿退出后变成站点进程的 <defunct>（libuv 不认识这个 pid，
 *  不会替它 wait），采样器顺带收掉——只收"已是僵尸且不在 libuv 管理清单"的。清单靠
 *  ChildProcess.prototype.spawn 钩子登记（spawn/execFile/exec/fork 全走这里），进程
 *  exit/close 后移除；绝不能抢 libuv 正在管的子进程——抢了 waitpid 会让退出码变 null，
 *  run_command 的成功被误报成失败。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { denyHit, PROC_PROGS } = require('./deny');

const SERVER_PID = process.pid;

/* ============================ /proc 读取（测试可注入） ============================ */

function readStat(pid) {
  let raw;
  try { raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { return null; }
  const open = raw.indexOf('('), close = raw.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const rest = raw.slice(close + 2).split(' ');
  /* stat：1=pid 2=comm 3=state 4=ppid 5=pgrp 6=session … 22=starttime。
     rest 从 state 起（下标 0），故 ppid=rest[1]、pgid=rest[2]、sid=rest[3]、starttime=rest[19]。 */
  if (rest.length < 20) return null;
  return {
    pid: Number(pid),
    comm: raw.slice(open + 1, close),
    state: rest[0],
    ppid: Number(rest[1]) || 0,
    pgid: Number(rest[2]) || 0,
    sid: Number(rest[3]) || 0,
    starttime: Number(rest[19]) || 0,
  };
}

function readCmdlineImpl(pid) {
  try {
    const buf = fs.readFileSync(`/proc/${pid}/cmdline`);
    if (!buf.length) return null;
    return buf.toString('utf8').replace(/\0+/g, ' ').trim();
  } catch { return null; }
}

/** cmdline 读取器：单测注入假 /proc 时可替换 */
let cmdlineReader = readCmdlineImpl;
function readCmdline(pid) { return cmdlineReader(pid); }

function scanAll() {
  const out = new Map();
  let names;
  try { names = fs.readdirSync('/proc'); } catch { return out; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const st = readStat(Number(name));
    if (st) out.set(st.pid, st);
  }
  return out;
}

/* ============================ subreaper 插件（gcc 现编，失败自动降级） ============================ */

let addon = null;
let subreaper = false;

(function loadSubreaperAddon() {
  if (process.env.AGENT_PROC_SUBREAPER === '0') return;
  try {
    const src = fs.readFileSync(path.join(__dirname, 'proctree-subreaper.c'));
    const tag = crypto.createHash('sha1').update(src).digest('hex').slice(0, 12);
    const dir = path.join(os.tmpdir(), 'agent-proctree');
    const soPath = path.join(dir, `subreaper-${tag}.node`);
    if (!fs.existsSync(soPath)) {
      fs.mkdirSync(dir, { recursive: true });
      const cPath = path.join(dir, `subreaper-${tag}.c`);
      fs.writeFileSync(cPath, src);
      /* process.execPath = <node 目录>/bin/node → 头文件在 ../include/node */
      const inc = path.join(path.dirname(process.execPath), '..', 'include', 'node');
      require('child_process').execFileSync('gcc',
        ['-shared', '-fPIC', '-O2', '-I', inc, '-o', soPath, cPath],
        { timeout: 15000, stdio: 'ignore' });
    }
    const mod = { exports: {} };
    process.dlopen(mod, soPath);
    addon = mod.exports;
    subreaper = !!addon.mark();
  } catch (e) {
    console.warn(`  ⚠ subreaper 插件不可用（${e && e.message}）：setsid 型后台任务的归属判定退回采样兜底，相关 kill 仍会要求授权`);
  }
})();

/* ============================ 登记表 ============================ */

/* agent 命令的根进程（/bin/sh -c … 或 su 拉起的那只）：pid → { born, starttime, cmd }。
   进程死了也**不马上删**——没 setsid 的后台任务父壳退出后，组号兜底要靠它；
   超限时按插入序（最旧优先）挤出。 */
const roots = new Map();
/* 曾在站点子树里被采样到的进程：pid → starttime（查的时候再对一次，防 PID 复用） */
const seen = new Map();
/* libuv 正在管理的子进程（prototype.spawn 钩子登记，exit/close/error 后移除） */
const managed = new Set();

const ROOTS_CAP = 2000;
const SEEN_CAP = 4096;

/** exec.js spawn 出命令根进程时登记（归属判定的证据链锚点） */
function noteSpawn(pid, cmd) {
  if (!pid) return;
  const st = readStat(pid);
  roots.set(pid, { born: Date.now(), starttime: st ? st.starttime : 0, cmd: String(cmd || '').slice(0, 160) });
  if (roots.size > ROOTS_CAP) {
    for (const k of roots.keys()) { roots.delete(k); if (roots.size <= ROOTS_CAP) break; }
  }
}

/* 登记所有 child_process 子进程：钩在 ChildProcess.prototype.spawn 上——
   spawn/execFile/exec/fork 全都经由它，且不依赖各模块"解构时机"（早 require 也钩得住）。 */
(function hookChildProcess() {
  try {
    const proto = require('child_process').ChildProcess.prototype;
    if (proto.__proctreeHooked) return;
    const orig = proto.spawn;
    proto.spawn = function (...a) {
      const r = orig.apply(this, a);
      if (this.pid) {
        managed.add(this.pid);
        const drop = () => managed.delete(this.pid);
        this.once('exit', drop);
        this.once('close', drop);
        this.once('error', drop);
      }
      return r;
    };
    proto.__proctreeHooked = true;
  } catch { /* 钩不上：清扫退化为"不跑"，不影响归属判定 */ }
})();

/* ============================ 采样（降级兜底 + 僵尸清扫） ============================ */

function sweepZombies(stats) {
  if (!subreaper || !addon) return;
  for (const [pid, st] of stats) {
    if (st.ppid !== SERVER_PID || st.state !== 'Z' || managed.has(pid)) continue;
    try { addon.reap(pid); } catch { /* 竞态：刚好被 libuv 收走（ECHILD），忽略 */ }
  }
}

/** 全量扫一次 /proc：降级模式把站点子树记进 seen；顺带清扫被收养的僵尸 */
function sample() {
  let stats;
  try { stats = scanAll(); } catch { return; }
  if (!subreaper) {
    const kids = new Map();
    for (const [pid, st] of stats) {
      if (!kids.has(st.ppid)) kids.set(st.ppid, []);
      kids.get(st.ppid).push(pid);
    }
    const queue = [...(kids.get(SERVER_PID) || [])];
    while (queue.length) {
      const pid = queue.pop();
      const st = stats.get(pid);
      if (!st) continue;
      seen.set(pid, st.starttime);
      for (const c of kids.get(pid) || []) queue.push(c);
    }
    if (seen.size > SEEN_CAP) {
      for (const k of seen.keys()) { seen.delete(k); if (seen.size <= SEEN_CAP) break; }
    }
  }
  sweepZombies(stats);
}
const sampler = setInterval(sample, 4000);
if (sampler.unref) sampler.unref();

/* ============================ 归属判定 ============================ */

/** pid 是不是登记过的命令根（活着要 starttime 对得上，防 PID 复用顶名；死了认——组号兜底要用） */
function rootOk(rootPid, all) {
  const root = roots.get(rootPid);
  if (!root) return false;
  const live = all.get(rootPid);
  if (!live) return true;
  return !root.starttime || live.starttime === root.starttime;
}

/** 目标进程是不是 agent 自启的（stats 可注入，供单测造假 /proc） */
function isAgentOwned(pid, stats) {
  pid = Number(pid);
  if (!pid || pid <= 1 || pid === SERVER_PID) return false;    // 站点自己不是"agent 启动的"——自保保留
  const all = stats || scanAll();
  const target = all.get(pid);
  if (!target) return false;                                   // 查不到/已消失 → 不豁免（宁可误拦）
  /* 证据 1：祖先链到达站点进程（subreaper 收养的孤儿 ppid 就是站点进程），或经过登记的命令根 */
  let cur = pid;
  for (let guard = 0; cur > 1 && guard < 64; guard++) {
    const st = all.get(cur);
    if (!st) return false;                                     // 链中途消失 → 查不下去 → 保守
    if (st.ppid === SERVER_PID) return true;
    if (rootOk(cur, all)) return true;
    cur = st.ppid;
  }
  /* 证据 2：曾在站点子树里被采样到（PID 复用用 starttime 排除） */
  if (seen.get(pid) === target.starttime) return true;
  /* 证据 3：进程组/会话号是登记过的命令根（父壳已退出的后台任务，组号不变） */
  if (rootOk(target.pgid, all) || rootOk(target.sid, all)) return true;
  return false;
}

/* ============================ kill 族命令的目标解析 ============================ */

/*  口径（2026-10-07 二版，实测收敛）：agent 清理自己后台任务的真实写法几乎都是
 *  「多段命令 + 引号包住的模式 + 偶尔带正则」——
 *      pkill -f "opencv-python-headless" 2>/dev/null; cd /tmp && setsid nohup … &
 *      kill 21353 21329 2>/dev/null; sleep 3; …; pkill -f "bili_repl[a]ce.py"; echo done
 *  一版只认「单段 + 纯字面」把它们全拒了（用户报"仍然弹窗"）。现在按段判定：
 *    · 多段命令：每段单独过 denyHit——kill 族段必须"目标全 owned"，其余段必须"不在危险清单里"；
 *    · 引号感知 tokenizer：`pkill -f "python train.py"` 的模式是一个 token（含空格）；
 *    · 模式支持正则（POSIX ERE 与 JS 的公共子集：. * + ? ^ $ [] () {} |，一律带 s 标志让 .
 *      也匹配换行）；`\`、`[:`、反引号一类方言差异大的**不放过**；
 *    · shell 侧歧义一律不放过：未加引号的 * ? [ ] 会被 glob、$VAR 会被展开、带 \ 的转义不让看懂；
 *    · 目标集仍是**保守超集**：解析出的集合 ⊇ pkill 实际会杀的集合 ⇒ "全 owned ⇒ 实杀必 owned"。
 *      看不清/零命中/查不到的目标 → 照旧要票。 */

/* 模式允许的字符：字面（含中文与空格）+ 上表的正则元字符。
   不放 \、"、'、`、;、&、<、>、!、%、@、#、~（shell 或 ERE 方言歧义）。 */
const PAT_RE = /^[\w\s\u4e00-\u9fff\u3000-\u303f\uff00-\uffef.,:*+?^$[\](){}|=\/-]+$/;

const SIGNALS = new Set(['HUP', 'INT', 'QUIT', 'ILL', 'TRAP', 'ABRT', 'IOT', 'BUS', 'FPE', 'KILL',
  'USR1', 'SEGV', 'USR2', 'PIPE', 'ALRM', 'TERM', 'STKFLT', 'CHLD', 'CONT', 'STOP', 'TSTP',
  'TTIN', 'TTOU', 'URG', 'XCPU', 'XFSZ', 'VTALRM', 'PROF', 'WINCH', 'IO', 'PWR', 'SYS',
  'RTMIN', 'RTMAX']);
const isSignalTok = (t) => SIGNALS.has(String(t).replace(/^SIG/i, '').toUpperCase());
const baseOf = (t) => String(t).split('/').pop();
/** 重定向 token（`>file`、`2>/dev/null`、`<file`）：它之后的内容不再解析（pkill 不读 stdin，
 *  实际命令里重定向永远排在目标后面；排在前面 = 看不懂 → 保守要票） */
const isRedirect = (t) => /^[<>]|^\d+[<>]/.test(String(t));

/** 按 shell 分隔符切段（保留原文）：; 换行 | || && 与**单个 &**（后台）。
 *  单个 & 要绕开重定向（>& <&）与 &&——`2>/dev/null` 不是分段点。 */
function splitSegments(cmd) {
  return String(cmd).split(/\|\||&&|(?<![<>])&(?!=&)|[;\n|]/).map((x) => x.trim()).filter(Boolean);
}

/** 把一段命令切成"引号感知"的 token：[{ text, safe }]。
 *  safe = shell 会把它**原样**交给程序：未加引号的 * ? [ ] { } ~ 会被 glob/展开、$VAR 会被
 *  展开、反斜杠是转义、引号没闭死、段落里还剩 () 这类 shell 语法字符——一律 safe=false。
 *  引号没闭合整段返回 null（看不懂）。单引号内一切字面；双引号内 $VAR / \ / ` 不建模。 */
function tokenizeSeg(seg) {
  const out = [];
  const s = String(seg);
  let cur = null, q = '';
  const push = () => { if (cur) out.push(cur); cur = null; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q === "'") { if (c === "'") q = ''; else cur.text += c; continue; }
    if (q === '"') {
      if (c === '"') { q = ''; continue; }
      if (c === '\\' || c === '`') { cur.safe = false; continue; }
      if (c === '$' && /[A-Za-z_{(]/.test(s[i + 1] || '')) { cur.safe = false; continue; }
      cur.text += c; continue;
    }
    if (c === ' ' || c === '\t') { push(); continue; }
    if (c === "'" || c === '"') { if (!cur) cur = { text: '', safe: true }; q = c; continue; }
    if (!cur) cur = { text: '', safe: true };
    if (c === '\\' || c === '`') { cur.safe = false; continue; }
    if (c === '$' && /[A-Za-z_{(]/.test(s[i + 1] || '')) { cur.safe = false; continue; }
    if ('*?{}~'.includes(c)) { cur.text += c; cur.safe = false; continue; }     // glob/展开歧义
    if (c === '[') {
      /* 简单字符类（[a] [a-z] [abc]）：glob 展开与正则语义一致——展开成某个具体字符时，
         那串字面必然也被正则匹配（⊆），两种解释都对"超集"性质安全；其余 [ 形式不放。 */
      const m = /^\[[A-Za-z0-9_.-]+\]/.exec(s.slice(i));
      if (m) { cur.text += m[0]; i += m[0].length - 1; continue; }
      cur.text += c; cur.safe = false; continue;
    }
    if ('();|&<>'.includes(c)) { cur.text += c; cur.safe = false; continue; }   // 分段器没切掉的 shell 字符
    cur.text += c;
  }
  if (q) return null;
  push();
  return out;
}

/* pkill [flags] <pattern>：只认 -f/-x/-i/-e、-<信号>、--signal[=v]、--full/--exact/--ignore-case */
function parsePkill(args) {
  const flags = { f: false, x: false, i: false };
  const patToks = [];
  let afterDashDash = false;
  for (let i = 0; i < args.length; i++) {
    const t = args[i].text;
    if (isRedirect(t)) break;                                              // 重定向起（2>/dev/null…），后面不看了
    if (afterDashDash) { patToks.push(args[i]); continue; }
    if (args[i].safe === false) return { bail: true };                     // 选项带 shell 歧义（未引号 glob 等）→ 不看
    if (t === '--') { afterDashDash = true; continue; }
    if (t.startsWith('--')) {
      const name = t.split('=')[0];
      if (name === '--full') flags.f = true;
      else if (name === '--exact') flags.x = true;
      else if (name === '--ignore-case') flags.i = true;
      else if (name === '--echo') { /* 回显，不影响目标 */ }
      else if (name === '--signal') { if (!t.includes('=') && ++i >= args.length) return { bail: true }; }
      else if (name === '--help' || name === '--version') return { none: true };
      else return { bail: true };
      continue;
    }
    if (t.startsWith('-') && t.length > 1) {
      if (/^-\d+$/.test(t)) continue;                            // -9：信号
      if (isSignalTok(t.slice(1))) continue;                     // -TERM
      let ok = true;
      for (const ch of t.slice(1)) {
        if (ch === 'f') flags.f = true;
        else if (ch === 'x') flags.x = true;
        else if (ch === 'i') flags.i = true;
        else if (ch === 'e') { /* 回显 */ }
        else { ok = false; break; }
      }
      if (!ok) return { bail: true };                            // -v 反转/-u 过滤器…一律看不懂
      continue;
    }
    patToks.push(args[i]);
  }
  if (patToks.length !== 1) return { bail: true };               // pkill 恰好一个模式
  const pat = patToks[0].text;
  if (!pat || !PAT_RE.test(pat)) return { bail: true };
  let re;
  try { re = new RegExp(flags.x ? `^(?:${pat})$` : pat, flags.i ? 'si' : 's'); }
  catch { return { bail: true }; }                               // JS 编不过（ERE 方言）→ 不看
  return { matches: [{ re, f: flags.f }] };
}

/* kill [-s v|-n v|--signal[=v]|-l|--help] <pid|-%pgid>…：负 pid 是进程组，-1（全部）绝不放 */
function parseKill(args) {
  const pids = [], groups = [];
  let afterDashDash = false, sawTarget = false;
  for (let i = 0; i < args.length; i++) {
    const t = args[i].text;
    if (isRedirect(t)) break;                                    // 重定向起，后面不看了
    if (!afterDashDash && !sawTarget && t === '--') { afterDashDash = true; continue; }
    if (!afterDashDash && !sawTarget && t.startsWith('-') && t.length > 1) {
      if (/^-\d+$/.test(t) || isSignalTok(t.slice(1))) continue;   // 信号
      if (t === '-s' || t === '-n' || t === '--signal') {
        if (++i >= args.length) return { bail: true };
        continue;                                                // 带值的信号选项，吃掉值
      }
      if (t.startsWith('--signal=')) continue;
      if (t === '-l' || t === '-L' || t === '--help' || t === '--version' || t === '-V') return { none: true };
      return { bail: true };
    }
    if (args[i].safe === false) return { bail: true };            // 目标 token 有 shell 歧义
    if (/^\d+$/.test(t)) { pids.push(Number(t)); sawTarget = true; continue; }
    if (/^-\d+$/.test(t)) {
      const g = Number(t.slice(1));
      if (g === 1) return { bail: true };                        // kill -- -1 = 杀全部进程
      groups.push(g); sawTarget = true; continue;
    }
    return { bail: true };                                       // 作业号 %1、表达式之类
  }
  if (!pids.length && !groups.length) return { bail: true };
  return { pids, groups };
}

/* killall [-<信号>|--signal[=v]] <名>…：按 comm（≤15 字节）精确匹配，其余选项一律看不懂 */
function parseKillall(args) {
  const names = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i].text;
    if (isRedirect(t)) break;
    if (t.startsWith('--')) {
      const name = t.split('=')[0];
      if (name === '--signal') { if (!t.includes('=') && ++i >= args.length) return { bail: true }; continue; }
      if (name === '--help' || name === '--version') return { none: true };
      return { bail: true };
    }
    if (t.startsWith('-') && t.length > 1) {
      if (/^-\d+$/.test(t) || isSignalTok(t.slice(1))) continue;
      return { bail: true };                                     // -i 交互 / -r 正则 / -g 组 / -u 用户…
    }
    if (args[i].safe === false) return { bail: true };
    names.push(t);
  }
  if (!names.length) return { bail: true };
  for (const n of names) {
    if (!/^[A-Za-z0-9_.:=\/+-]{1,15}$/.test(n)) return { bail: true };
  }
  return { matches: names.map((n) => ({ pat: n, x: true, i: false })) };
}

/** 解析一条 kill 族命令要杀的目标；返回 { bail }（看不懂→不放行）/ { none }（不杀东西）/ { targets:[pid] }。
 *  口径是保守超集：targets ⊇ 实际会杀的集合。stats 可注入（单测造假 /proc）。 */
function resolveKillTargets(command, stats) {
  const cmd = String(command == null ? '' : command);
  /* 子壳/反引号一票否决：参数里的命令替换会先于 kill 执行，模式文本看不出来 */
  if (/\$\(|`/.test(cmd)) return { bail: true };
  const segs = splitSegments(cmd);
  if (!segs.length) return { bail: true };
  const all = stats || scanAll();
  const targets = new Set();
  let sawKill = false, sawNone = false;
  for (const seg of segs) {
    const hit = denyHit(seg);
    if (hit == null) continue;                     // 这一段不在危险清单里 → 无害段，放它过去
    if (!PROC_PROGS.has(hit)) return { bail: true };   // 别的危险规则命中（rm/重定向/解释器…）→ 整条要票
    if (hit === 'skill' || hit === 'killall5') return { bail: true };
    const toks = tokenizeSeg(seg);
    if (!toks) return { bail: true };
    const ki = toks.findIndex((t) => PROC_PROGS.has(baseOf(t.text)));
    if (ki < 0) return { bail: true };
    const args = toks.slice(ki + 1);
    const parsed = hit === 'kill' ? parseKill(args) : hit === 'killall' ? parseKillall(args) : parsePkill(args);
    if (parsed.bail) return { bail: true };
    if (parsed.none) { sawNone = true; continue; } // kill -l 之类：这一段不杀东西
    sawKill = true;
    for (const pid of parsed.pids || []) targets.add(pid);
    for (const g of parsed.groups || []) {
      if (g === 0) continue;   /* 组 0 = "自己所在的组"：这条命令 detached 独立成组，组里只有它自己 */
      for (const [pid, st] of all) if (st.pgid === g) targets.add(pid);
    }
    for (const m of parsed.matches || []) {
      for (const [pid, st] of all) {
        const hay = m.f ? readCmdline(pid) : st.comm;
        /* -f 模式下 cmdline 为空/读不到（内核线程、僵尸）：pkill 的干草堆是空的，
           字面/正则模式都不可能命中 → 跳过；comm 模式下 stat 里总有 comm，不会走到这。 */
        if (hay == null) continue;
        const hitIt = m.re ? m.re.test(hay)
          : (m.i ? hay.toLowerCase().includes(m.pat.toLowerCase()) : (m.x ? hay === m.pat : hay.includes(m.pat)));
        if (hitIt) targets.add(pid);
      }
    }
  }
  if (sawKill) return { targets: [...targets] };
  if (sawNone) return { none: true };              // 全是"不杀东西"的段（kill -l）→ 放
  return { bail: true };
}

/** 命中的是 kill 族、且目标全是 agent 自启进程（或不杀任何东西）→ 免票据放行 */
function killExempt(command, stats) {
  try {
    const r = resolveKillTargets(command, stats);
    if (r.bail) return false;
    if (r.none) return true;                                     // kill -l / --help：根本不杀
    if (!r.targets || !r.targets.length) return false;           // 零命中：看不懂它想杀什么 → 弹窗
    for (const pid of r.targets) if (!isAgentOwned(pid, stats)) return false;
    return true;
  } catch { return false; }
}

module.exports = {
  killExempt, resolveKillTargets, isAgentOwned, noteSpawn, sample,
  /* 单测注入口：造假 /proc、直接摆弄登记表 */
  _test: {
    roots, seen, managed, readStat,
    setCmdlineReader: (fn) => { cmdlineReader = fn || readCmdlineImpl; },
    get subreaper() { return subreaper; },
  },
};
