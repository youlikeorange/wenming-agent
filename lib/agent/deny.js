/** lib/agent/deny.js —— 危险命令清单与命中判定（纯函数，无 IO）
 *
 *  这不是安全边界（真正的边界是绑定账号的 OS 权限），它只防"手滑"：命中**不直接拒绝**，
 *  而是要求人在界面上点「授权执行」（一次性票据，见 lib/agent/grants.js）。
 *
 *  匹配规则（保留历次审计修出来的全部细节）：
 *    · shutdown/reboot/init 这类只有**出现在命令位置**（行首或 ; | && 之后）才算命中，
 *      于是 `grep -i reboot /var/log/syslog`、`echo "please reboot later"` 正常放行——
 *      这些恰好是"帮我看下系统日志"时最常跑的只读命令；
 *    · rm -rf /、mkfs、dd of=/dev/* 这些**执行本身**就危险的，仍在任意位置匹配；
 *    · 包装器（sudo/env/timeout/watch/nice…）会被剥掉再取程序名；
 *    · 引号 / 长选项 / 分离短选项 / 解释器 -c 载荷 / 子壳 $(…) 与 `…` 都会过一遍归一副本。
 *  方向永远是保守：宁可误拦（反正人能点授权），不能漏放。
 *
 *  2026-10-02 起加一组**自保规则**（见下方 SELF_PROTECT）：站点就以「绑定账号」的身份
 *  跑在本机，`kill -9 <站点PID>`、`pkill -f server.js`、`rm -rf <站点根>` 这类
 *  "把自己干掉"的命令同样是"手滑"的一大类——授权闸门只由这里命中驱动，
 *  清单不覆盖它们就等于永不弹窗（2026-10-02 自查：13 条全放行）。
 *  边界：进程/服务类规则**只看命令位置**（`grep -i reboot /etc/motd` 仍放行）；
 *  路径类规则绑定"受保护路径 × 破坏性动作"，只保护站点根本身与关键文件，
 *  站点目录里的子路径不保护——在站点里正常干活（清 logs、删构建产物）不该被拦。
 */
const path = require('path');

/** 给规则挂一个可读标签：命中时授权弹窗与设置面板显示标签（没有标签的显示正则原文）。
 *  为什么要有：弹窗文案是「命中了危险操作清单（${hit}）」，没有标签时 hit 是一整串正则。 */
const rule = (re, label) => { re.label = label; return re; };
const textOf = (r) => (r && r.label) || String(r);
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* 递归强删的"目标"：根目录（/ // /* /./ /..）、家目录（~ ~/ $HOME ${HOME}）、
   以及**通配整目录**（`rm -rf *` 在根目录下就是清盘）。
   旧规则只认 `/` 后面跟空白或行尾，于是 `rm -rf /*`、`rm -rf ~`、`rm -rf $HOME`
   全部漏放（2026-09-30 实测 9/17 漏判）；这里把目标形式列全。 */
const RM_TARGET = String.raw`(?:\/+\*?|\/+\.{1,2}|\/*~\/?|\$\{?HOME\}?|\*)`;
const DANGEROUS_AT_ANY_POS = [
  // rm -rf <根/家目录/通配>：选项可分散（-r -f）或长短混用，归一后都能命中
  rule(new RegExp(String.raw`\brm\s+(?:-{1,2}[a-zA-Z][\w-]*\s+)*-[a-zA-Z]*r[a-zA-Z]*f?[a-zA-Z]*\s+${RM_TARGET}(?:\s|$|[;|&])`),
    '递归强删根目录/家目录（rm -rf / ~ *）'),
  rule(/\bdd\b[^\n]*\bof=\/dev\//, '往块设备写数据（dd of=/dev/…）'),
  rule(/>\s*\/dev\/(sd|nvme|hd|vd|mmcblk)/, '重定向写入块设备'),
  rule(/:\s*\(\s*\)\s*\{.*\}\s*;\s*:/, 'fork 炸弹'),
  rule(/\bchmod\s+(-[a-zA-Z]+\s+)*777\s+\/+(\s|$)/, '把根目录权限改成 777（chmod 777 /）'),
  rule(/\bchown\s+(-[a-zA-Z]+\s+)*[^\s]+\s+\/+(\s|$)/, '改根目录属主（chown … /）'),
  // find … -delete：只拦**根目录/家目录**为起点的（`find . -delete`、`find ./build -delete` 是正常清理）
  rule(new RegExp(String.raw`\bfind\s+(?:\/+\*?(?=\s|$)|\/*~\/?(?=\s|$)|\$\{?HOME\}?(?=\s|$))[^\n]*\s-delete\b`),
    'find -delete 根目录/家目录'),
  rule(/\|\s*(?:sudo\s+|doas\s+)?(?:sh|bash|dash|ash|zsh|ksh)\s*(?:$|[;|&])/, '管道喂给 shell 执行（| sh）'),
];
/* 只有"被当成命令来跑"才危险的：不看整行里有没有这个词，而是看**每一段命令的第一个词** */
const KILL_PROGS = new Set(['shutdown', 'reboot', 'halt', 'poweroff', 'telinit', 'kexec', 'mkswap', 'swapoff']);
const ACCT_PROGS = new Set(['passwd', 'chpasswd', 'userdel', 'groupdel', 'visudo', 'vipw']);
const SYSCTL_SUB = new Set(['reboot', 'poweroff', 'halt', 'suspend', 'hibernate', 'kexec', 'emergency', 'rescue']);
/* 自保三组（2026-10-02）：站点/宿主就在本机，这些命令等于"把自己带走"。
   · PROC_PROGS：进程控制程序，出现在命令位置即命中（kill -9 <站点PID>、pkill -f server.js、
     killall node、kill -9 -1、pkill -u leo……精细方案（只认目标 PID/命令行）有漏洞——
     `kill -s TERM $(cat .server.pid)`、`kill -- -1` 都能绕，所以按程序名保守拦）。
   · LOGINCTL_SUB / SYSCTL_BAD：会话与服务级杀伤子命令（`loginctl terminate-user leo` 会把
     该账号所有进程一起带走；`systemctl --user stop x` 停的可能是代理/隧道）。
     systemctl 的子命令要跳过选项再取（`--user`、`-H host`），见 firstNonOpt。 */
const PROC_PROGS = new Set(['kill', 'pkill', 'killall', 'killall5', 'skill']);
const LOGINCTL_SUB = new Set(['terminate-user', 'kill-user', 'terminate-session', 'kill-session']);
const SYSCTL_BAD = new Set(['stop', 'restart', 'kill', 'try-restart', 'reload-or-restart', 'isolate',
  'halt', 'poweroff', 'reboot', 'kexec', 'suspend', 'hibernate', 'hybrid-sleep', 'emergency', 'rescue']);
/** 只做"转发"的包装器：真正的命令在它后面（`sudo reboot` 的危险在 reboot）。
 *  timeout/watch/flock/chrt/strace… 同样是转发（`timeout 5 reboot` 就是重启）。
 *  busybox 是多合一二进制（`busybox reboot`、`busybox rm -rf /`），同样只转发。 */
const WRAPPERS = new Set(['sudo', 'doas', 'pkexec', 'env', 'nohup', 'setsid', 'nice', 'ionice',
  'taskset', 'stdbuf', 'time', 'timeout', 'watch', 'flock', 'chrt', 'unbuffer', 'script',
  'expect', 'strace', 'ltrace', 'busybox',
  'command', 'exec', 'builtin', 'eval', 'xargs', 'parallel']);
/** 这些包装器的选项会吃掉下一个词（-u root / -s KILL / -n 5 之类） */
const WRAP_OPTS_WITH_VALUE = new Set(['-u', '-g', '-p', '-C', '-U', '-r', '-t', '-s', '-n', '--user', '--group']);

/* ============================ 自保：站点自身（SELF_PROTECT） ============================ */

/** 站点根：从本文件位置推（lib/agent/ → 上两级）。换部署目录自动跟随，不硬编码路径。 */
const SITE_ROOT = path.resolve(__dirname, '..', '..');
/** 关键文件（相对站点根）：入口、PID 文件、页面唯一加载的构建产物（public/llm-chat/vendor/agent.js）。
 *  相对路径与绝对路径都拦——命令的默认 cwd 就是项目根，相对形式很常见。 */
const PROTECT_FILES = ['server.js', '.server.pid', 'public/llm-chat/vendor/agent.js'];
/** 额外受保护路径：AGENT_PROTECT 用 path.delimiter 分隔（Linux 下是冒号），相对路径按站点根解析。
 *  例：AGENT_PROTECT='/srv/data:/home/leo/.local/share/wenming-web'（状态目录可这样加进来）。 */
const PROTECT_ROOTS = [SITE_ROOT].concat(
  String(process.env.AGENT_PROTECT || '').split(path.delimiter)
    .map((s) => s.trim()).filter(Boolean)
    .map((p) => path.resolve(SITE_ROOT, p)));

/** 目标 token 的右边界：空白 / 命令分隔符 / 闭引号闭括号 / 行尾 */
const TOK_END = String.raw`(?=[\s;|&)'"\]}]|$)`;
/** 受保护路径的匹配形式：可带引号，尾部允许 / 或 *（`<根>/*` 是清盘；`<根>/logs` 不算——
 *  在站点目录里清日志/删构建产物是正常干活，不该被拦）。 */
const pathTok = (p) => `['"]?${escRe(p)}[\\/*]*['"]?`;
const fileTok = (f) => `['"]?(?:${escRe(f)}|${escRe(path.join(SITE_ROOT, f))})[\\/*]*['"]?`;

/** 路径类自保规则：破坏性动作 × 受保护目标。写文件的动作覆盖 rm/shred/truncate/mv、重定向、
 *  cp/tee/dd（把受保护文件当**写入目标**）；删目录的动作另加 find -delete。 */
const SELF_PROTECT = [];
for (const p of PROTECT_ROOTS) {
  const tok = pathTok(p);
  SELF_PROTECT.push(
    rule(new RegExp(String.raw`\b(?:rm|shred|truncate)\b[^\n;|&]*?\s${tok}${TOK_END}`), '受保护路径：删除/截断'),
    rule(new RegExp(String.raw`\bmv\b[^\n;|&]*?\s${tok}${TOK_END}`), '受保护路径：搬走或覆盖'),
    rule(new RegExp(String.raw`>>?\s*${tok}${TOK_END}`), '受保护路径：重定向写入'),
    rule(new RegExp(String.raw`\bfind\s+${tok}${TOK_END}[^\n]*\s-delete\b`), '受保护路径：find -delete'));
}
for (const f of PROTECT_FILES) {
  const tok = fileTok(f);
  SELF_PROTECT.push(
    rule(new RegExp(String.raw`\b(?:rm|shred|truncate|mv)\b[^\n;|&]*?\s${tok}${TOK_END}`), '受保护文件：删除/移动/截断'),
    rule(new RegExp(String.raw`>>?\s*${tok}${TOK_END}`), '受保护文件：重定向覆盖'),
    rule(new RegExp(String.raw`\bcp\b(?:\s+[^\s;|&]+)*\s+${tok}\s*(?=[;|&)<>\n]|$)`), '受保护文件：被 cp 覆盖'),
    rule(new RegExp(String.raw`\btee\b(?:\s+-{1,2}[\w-]+)*\s+${tok}${TOK_END}`), '受保护文件：被 tee 覆盖'),
    rule(new RegExp(String.raw`\bdd\b[^\n;|&]*?\bof=${tok}${TOK_END}`), '受保护文件：被 dd 覆盖'));
}

/** 用户追加的危险命令正则（AGENT_EXEC_DENY，`||` 分隔）。
 *  逐条 try/catch：写错的表达式只跳过并告警，**不能**让 new RegExp 在 require 期抛出
 *  ——那会让整个站点起不来（改环境变量需要停站，等于自锁）。 */
const EXEC_DENY = DANGEROUS_AT_ANY_POS.concat(SELF_PROTECT).concat(
  (process.env.AGENT_EXEC_DENY || '').split('||').map((s) => s.trim()).filter(Boolean).map((s) => {
    try { return new RegExp(s); } catch (e) {
      console.warn(`  ⚠ AGENT_EXEC_DENY 里的正则无效，已跳过: ${s}（${e.message}）`);
      return null;
    }
  }).filter(Boolean));

const baseCmd = (p) => String(p || '').split('/').pop();

/** 包装器后面跟的**时长**（`timeout 5 reboot` 的 5、`timeout 2.5h reboot`）——那是时长，不是命令 */
const DURATION_RE = /^\d+(?:\.\d+)?[smhd]?$/i;

const isDangerProg = (base) => KILL_PROGS.has(base) || ACCT_PROGS.has(base) || PROC_PROGS.has(base)
  || base.startsWith('mkfs') || base === 'init' || base === 'telinit'
  || base === 'systemctl' || base === 'loginctl';

/** 按 shell 分隔符切行，并对每一段剥掉 `VAR=x` 前缀与包装器，取出"真正在跑的程序 + 它的参数"。
 *  启发式，不追求完整的 shell 解析——目的是判断某个词是命令还是参数。 */
function commandSegments(cmd) {
  const out = [];
  for (let seg of String(cmd == null ? '' : cmd).split(/[\n;]|\|\||&&|\|/)) {
    seg = seg.trim().replace(/^[({]*\s*/, '');
    if (!seg) continue;
    const toks = seg.split(/\s+/);
    let i = 0;
    const skipAssigns = () => { while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++; };
    skipAssigns();                                                              // VAR=val cmd
    // 剥包装器：先跳程序名，再跳它自己的选项（含带值的选项），直到看见真正的程序。
    while (i < toks.length && (WRAPPERS.has(baseCmd(toks[i])) || DURATION_RE.test(toks[i]))) {
      i++;
      while (i < toks.length && toks[i].startsWith('-')) {
        const opt = toks[i].split('=')[0];
        /* "这个选项带值"只是启发式，方向必须**保守**：`-u root` 的值该跳，
           但 `sudo -n reboot` 的 -n 根本不带值、`time -p reboot` 的 -p 也不带——
           照跳就会把真正的程序名当成值吃掉，这一段解析成空，危险闸门整条失守。 */
        const nxt = baseCmd(toks[i + 1] || '');
        const takesValue = WRAP_OPTS_WITH_VALUE.has(opt) && !toks[i].includes('=')
          && nxt && !WRAPPERS.has(nxt) && !isDangerProg(nxt);
        i += takesValue ? 2 : 1;
      }
      skipAssigns();
    }
    if (i >= toks.length) continue;
    out.push({ prog: baseCmd(toks[i]), args: toks.slice(i + 1) });
  }
  return out;
}

/** 跳过选项取"子命令"：`systemctl --user stop x` 的子命令是 stop（`-H host` 这类带值选项
 *  由后面的兜底扫描覆盖，取不到正确子命令时不会漏——见 segmentsHit）。 */
const firstNonOpt = (args) => args.find((a) => a && !a.startsWith('-')) || '';

/** 命令位置上的危险程序名 → 命中项；否则 null */
function segmentsHit(cmd) {
  for (const { prog, args } of commandSegments(cmd)) {
    if (!prog) continue;
    if (KILL_PROGS.has(prog) || ACCT_PROGS.has(prog)) return prog;      // reboot / passwd / userdel…
    if (PROC_PROGS.has(prog)) return prog;                               // kill / pkill / killall / skill
    if (prog.startsWith('mkfs')) return prog;                            // mkfs / mkfs.ext4 …
    if ((prog === 'init' || prog === 'telinit') && (args[0] === '0' || args[0] === '6')) return `${prog} ${args[0]}`;
    if (prog === 'loginctl') {
      const sub = firstNonOpt(args);
      if (LOGINCTL_SUB.has(sub)) return `loginctl ${sub}`;
    }
    if (prog === 'systemctl') {
      const sub = firstNonOpt(args);
      if (SYSCTL_SUB.has(sub)) return `systemctl ${sub}`;                // 开机/关机那一组（口径不变）
      const bad = SYSCTL_BAD.has(sub) ? sub : args.find((a) => SYSCTL_BAD.has(a));
      if (bad) return `systemctl ${bad}`;                                // stop/restart/kill…（含 --user / -H host 形式）
    }
  }
  return null;
}

/* ---- 归一：引号 / 长选项 / 分离短选项会破掉上面的锚 ----
 *  实测放行过 `rm -rf "/"`、`rm --recursive --force /`、`dd of="/dev/sda"`——
 *  只在**归一副本**上做检查，真实执行的命令原样不动。 */
const LONG_OPT_MAP = { '--recursive': '-r', '--force': '-f' };

/** 引号对启发式解析只在这个副本上做：剥掉后"参数文本"与命令词的边界会丢
 *  （`echo "rm -rf / 很危险"` 会误命中），属保守方向的误伤，接受。 */
function normalizeForDeny(raw) {
  let s = String(raw == null ? '' : raw).replace(/['"]/g, '');
  /* $IFS / ${IFS} 是 shell 的字段分隔符（默认含空格）：`rm$IFS-rf$IFS/` 在 shell 里
     就是 `rm -rf /`，但任何按空白切词的匹配都看不见它（2026-09-30 实测放行）。
     归一副本里换成一个空格，让后面的规则按"它实际会怎么被解释"来判断。 */
  s = s.replace(/\$\{IFS\}|\$IFS/g, ' ');
  for (const [lo, so] of Object.entries(LONG_OPT_MAP)) s = s.split(lo).join(so);
  // 分离短选项收拢：`-r -f` → `-rf`（迭代到收敛；只影响检查副本）
  let prev;
  do {
    prev = s;
    s = s.replace(/(^|[\s;|&])(-[a-z]+)\s+-([a-z]+)(?=[\s/]|$)/gi, '$1$2$3');
  } while (s !== prev);
  return s;
}

/** shell 类解释器：-c/--command 的载荷本身又是一条 shell 命令 → 递归整查 */
const SHELL_PROGS = new Set(['sh', 'bash', 'dash', 'ash', 'zsh', 'ksh', 'su']);
/** 代码类解释器：-c/-e/-r 的载荷是**程序代码**，shell 的"命令位置"概念不存在 →
 *  载荷里出现危险词（词边界）就拦（`python3 -c "…os.system('reboot')"` 实测曾放行）。 */
const CODE_PROGS = new Set(['python', 'python3', 'perl', 'node', 'ruby', 'php', 'lua', 'awk']);

/** 取 token 流里载荷选项（-c/-e/-r/-S/--command）后面的整段；遇到位置参数（脚本名）就停。
 *  注意**不能**用 commandSegments：载荷里的 `;` 会被 shell 分隔符切走。
 *  shell=true 时额外认组合单字母选项里的 c（`bash -lc "…"` = -l -c，login shell 很常见；
 *  不认的话 `bash -lc "kill 1"` 整条绕过——2026-10-02 补）。 */
function payloadFromTokens(toks, start, shell) {
  for (let j = start + 1; j < toks.length; j++) {
    const t = toks[j];
    if (t === '-c' || t === '-e' || t === '-r' || t === '-S' || t === '--command') return toks.slice(j + 1).join(' ');
    if (shell && /^-[A-Za-z]{2,}$/.test(t) && t.includes('c')) return toks.slice(j + 1).join(' ');
    if (t.startsWith('--command=')) return t.slice('--command='.length);
    if (t.startsWith('-')) continue;        // 其它选项继续找
    break;                                  // 位置参数：载荷选项不在这一段
  }
  return null;
}

/** `su` 的 -c 载荷：位置参数（要切换的用户名）可以出现在 -c **之前**
 *  （`su - leo -c "kill 18319"`）——`payloadFromTokens` 在第一个位置参数处停下的规则
 *  对 sh/bash 正确（`bash 脚本.sh -c x` 的 -c 是脚本的参数），对 su 会整条漏掉。 */
function suPayloadFromTokens(toks, start) {
  for (let j = start + 1; j < toks.length; j++) {
    const t = toks[j];
    if (t === '-c' || t === '--command') return toks.slice(j + 1).join(' ');
    if (t.startsWith('--command=')) return t.slice('--command='.length);
  }
  return null;
}

/** 解释器载荷检查：在**整行**的 token 流里找解释器与其 -c 载荷 */
function interpreterHit(line) {
  const toks = line.split(/\s+/);
  for (let i = 0; i < toks.length; i++) {
    const base = toks[i].split('/').pop();
    const isShell = SHELL_PROGS.has(base), isCode = CODE_PROGS.has(base);
    if (!isShell && !isCode) continue;
    const payload = base === 'su' ? suPayloadFromTokens(toks, i) : payloadFromTokens(toks, i, isShell);
    if (!payload || !payload.trim()) continue;
    if (isShell) {
      const sub = denyHit(payload, 1);
      if (sub) return sub;
    } else {
      const hit = codePayloadHit(payload);
      if (hit) return hit;
    }
  }
  return null;
}

/** 代码载荷里的"任意位置危险词"：kill/account 程序名（词边界）+ mkfs + 块设备写 */
function codePayloadHit(payload) {
  if (/\b(shutdown|reboot|halt|poweroff|telinit|kexec|mkswap|swapoff|passwd|chpasswd|userdel|groupdel|visudo|vipw)\b/.test(payload)) return '解释器载荷含危险命令词';
  /* 杀进程/会话/服务：os.kill / process.kill / subprocess 的 kill 都落在这几个词上；
     SIGKILL/SIGTERM 同理——载荷里出现信号名基本只有"要杀点什么"一种意思。 */
  if (/\b(kill|pkill|killall|killall5|loginctl)\b/.test(payload)
    || /\bSIGKILL\b|\bSIGTERM\b/.test(payload)) return '解释器载荷含进程/会话控制词';
  if (/\bmkfs/.test(payload)) return '解释器载荷含 mkfs';
  if (/\brm\s+(-{1,2}[^\s]+\s+)*-{1,2}[^\s]*r[^\s]*\s+\/+(\s|$)/.test(payload)) return '解释器载荷含 rm -r /';
  if (/\bdd\b[^\n]*\bof=\/dev\//.test(payload) || />\s*\/dev\/(sd|nvme|hd|vd|mmcblk)/.test(payload)) return '解释器载荷写块设备';
  return null;
}

/** 命中危险清单 → 命中的规则文本（有标签用标签，否则正则原文）；否则 null */
function denyHit(command, depth) {
  const raw = String(command == null ? '' : command);
  const any = EXEC_DENY.find((re) => re.test(raw));
  if (any) return textOf(any);
  const hit = segmentsHit(raw);
  if (hit) return hit;
  // 归一副本：引号/长选项/分离短选项不再遮住危险结构（只朝"多拦"方向变化）
  if ((depth || 0) < 3) {
    const norm = normalizeForDeny(raw);
    if (norm !== raw) {
      const nHit = EXEC_DENY.find((re) => re.test(norm)) || segmentsHit(norm);
      if (nHit) return textOf(nHit);
    }
    const sub = interpreterHit(norm);
    if (sub) return sub;
    // 子壳内容（单层 + 一层嵌套）：内容只会比原命令短，递归必然终止
    const re = /\$\(([^()]*)\)|`([^`]*)`/g;
    let m, guard = 0;
    while ((m = re.exec(norm)) && guard++ < 20) {
      const inner = (m[1] || m[2] || '').trim();
      if (!inner) continue;
      const s = denyHit(inner, (depth || 0) + 1);
      if (s) return s;
    }
  }
  return null;
}

/** 面板上展示的清单（只读展示用；命中不等于拒绝，是"要人点授权"）。
 *  PROC_PROGS 组带一句例外说明（2026-10-07）：杀 **agent 自己启动的进程** 免票据——
 *  规则真源是 lib/agent/proctree.js 的 killExempt，这里只是把口径如实写到面板上。 */
const denyList = () => EXEC_DENY.map((re) => textOf(re))
  .concat([...KILL_PROGS, ...ACCT_PROGS].map((p) => `(以命令身份执行) ${p}`))
  .concat([...PROC_PROGS].map((p) => `(以命令身份执行) ${p} —— 杀 agent 自己启动的进程免授权`))
  .concat([...new Set([...SYSCTL_SUB, ...SYSCTL_BAD])].map((s) => `systemctl ${s}`))
  .concat([...LOGINCTL_SUB].map((s) => `loginctl ${s}`));

module.exports = {
  denyHit, denyList, commandSegments, EXEC_DENY,
  KILL_PROGS, ACCT_PROGS, SYSCTL_SUB, SYSCTL_BAD, PROC_PROGS, LOGINCTL_SUB, WRAPPERS,
  SITE_ROOT, PROTECT_ROOTS, PROTECT_FILES, SELF_PROTECT,
};
