/* 访问级别与命令允许清单：判定「哪些操作要问」（ESM 模块） */
/* 访问级别（permission mode）与命令允许清单 —— "模型动手前要不要先问你"这一层
 *
 *  照主流 Agent 工具的档位设计（不是自创的）：
 *    · Claude Code  permissions.defaultMode = default | acceptEdits | plan | bypassPermissions
 *    · Gemini CLI   approvalMode           = default | auto_edit | yolo
 *    · Codex CLI    approval modes         = suggest | auto-edit | full-auto（另加沙箱）
 *    · Cline / Roo  Auto-Approve 分类开关 + 全局开关
 *  这里收敛成一个参数 agent_access（4 档）：
 *    custom（自定，默认）→ 用各卡片上的开关逐项决定；ask（每次都问）→ 四类操作全问；
 *    auto_edit（自动改文件）→ 写文件不问、命令与删除仍问；full（完全访问）→ 一律不问。
 *
 *  另加一份**命令允许清单** exec_allow：确认框里勾「总是允许」就会记下一条规则（如 `git status`），
 *  之后以它开头的命令直接放行——这是"每次都问"档下唯一能在所有档位生效的豁免层（Claude Code 的
 *  permissions.allow、Cursor 的 allowlist 都是这个位置）。规则只在**单条命令**上提议：带 && / | / ;
 *  / 重定向 / 命令替换的整行不提议也不匹配（前缀规则会覆盖到远超出用户所见的东西），
 *  高风险程序（sudo、rm、dd、解释器、包管理器、ssh/curl 之类）同样不给"总是允许"。
 *
 *  纯逻辑、不碰 DOM：改动闸门逻辑时可以直接在 Node 或浏览器控制台验算（app.js 只负责画界面）。
 *  注意：它只管**前端问不问**。真正的边界是服务端那份危险命令黑名单 + 登录的那个系统账号的 OS 权限，
 *  完全访问档也不会绕过它们。
 */
import { asStringList } from './params.js';    // 清单形状的收敛函数（与参数面板同一份）

/* ============================ 档位 ============================ */

const MODES = [
  { value: 'custom', icon: '🧩', label: '自定（默认）', short: '自定',
    desc: '用各卡片上的开关逐项决定（出厂默认：写文件不问、命令问、删除问、技能改动问）' },
  { value: 'ask', icon: '🙋', label: '每次都问', short: '每次都问',
    desc: '写文件、执行命令、删除、技能改动 —— 四类操作都要你点一次同意' },
  { value: 'auto_edit', icon: '📝', label: '自动改文件', short: '自动改文件',
    desc: '读写与移动文件不再问；执行命令、删除、技能改动仍会问' },
  { value: 'full', icon: '⚡', label: '完全访问', short: '完全访问', danger: true,
    desc: '任何操作都不再询问（含删除与命令）：危险命令黑名单与系统账号权限仍然生效' },
];
const MODE_VALUES = MODES.map(m => m.value);
const meta = (v) => MODES.find(m => m.value === v) || MODES[0];

const modeOf = (params, defaults) => {
  const v = (params && params.agent_access) || (defaults && defaults.agent_access) || 'custom';
  return MODE_VALUES.includes(v) ? v : 'custom';
};
/** 取值：会话里的参数优先，其次出厂默认（与 app.js 的 val2() 同一套语义）。
 *  两边都没有时**按"要问"处理**——拿不准就问，是这个模块唯一说得过去的失败方向。 */
const pick = (params, defaults, key) => {
  if (params && params[key] !== undefined) return !!params[key];
  if (defaults && defaults[key] !== undefined) return !!defaults[key];
  return true;
};

/** 档位 → 四类操作"要不要先问" */
function eff(params, defaults) {
  const mode = modeOf(params, defaults);
  if (mode === 'ask') return { mode, fsAsk: true, delAsk: true, execAsk: true, skillAsk: true };
  if (mode === 'auto_edit') return { mode, fsAsk: false, delAsk: true, execAsk: true, skillAsk: true };
  if (mode === 'full') return { mode, fsAsk: false, delAsk: false, execAsk: false, skillAsk: false };
  return { mode,
    fsAsk: pick(params, defaults, 'plugin_fs_confirm'),
    delAsk: pick(params, defaults, 'plugin_fs_delete_confirm'),
    execAsk: pick(params, defaults, 'plugin_exec_confirm'),
    skillAsk: pick(params, defaults, 'skill_write_confirm') };
}

/** 一句话说明当前档位的实际效果（面板与徽章都用它） */
function summary(e) {
  if (!e) return '';
  if (e.mode === 'full') return '任何操作都不再询问';
  const f = (ask, name) => name + (ask ? ' 会问' : ' 不问');
  return [f(e.fsAsk, '写文件'), f(e.execAsk, '命令'), f(e.delAsk, '删除'), f(e.skillAsk, '技能改动')].join(' · ');
}

/* ============================ 命令允许清单 ============================ */

/* 不给"总是允许"的程序：一条前缀规则会覆盖它后面的一切，这些程序后面跟什么都危险。
   （想放开的可以自己在面板里手写规则——那是明示的选择，不是确认框上顺手一勾。） */
const DANGER = new Set([
  // 提权
  'sudo', 'su', 'doas', 'pkexec', 'runuser',
  // 不可逆的磁盘/文件系统操作
  'rm', 'rmdir', 'shred', 'dd', 'mkfs', 'mkswap', 'swapon', 'swapoff', 'fdisk', 'parted', 'sfdisk',
  'wipefs', 'mount', 'umount', 'losetup',
  // 关机 / 服务 / 计划任务
  'shutdown', 'reboot', 'halt', 'poweroff', 'systemctl', 'service', 'init', 'crontab', 'systemd-run',
  // 权限与账号
  'chmod', 'chown', 'chgrp', 'chattr', 'setfacl', 'passwd', 'useradd', 'usermod', 'userdel', 'groupadd',
  // 进程
  'kill', 'pkill', 'killall',
  // 外联（数据出去 / 东西进来）
  'ssh', 'scp', 'sftp', 'curl', 'wget', 'nc', 'ncat', 'netcat', 'socat', 'telnet', 'ftp',
  // 解释器：`-c/-e` 后面是任意代码，前缀规则等于放开一切
  'sh', 'bash', 'zsh', 'dash', 'fish', 'python', 'python2', 'python3', 'node', 'nodejs', 'deno', 'bun',
  'perl', 'ruby', 'php', 'lua', 'osascript', 'powershell',
  // 包管理与构建（会改动环境）
  'apt', 'apt-get', 'dnf', 'yum', 'zypper', 'pacman', 'snap', 'pip', 'pip3', 'gem', 'cargo', 'go',
  'brew', 'npm', 'yarn', 'pnpm', 'npx', 'make',
]);

/* 语义全在选项/参数里的程序：前缀规则盖不住它真正会做什么（`find .` 与 `find . -delete`、
   `sed -n` 与 `sed -i`、`tar xf` 与 `tar cf`），所以一律不提议——要放开就在面板里手写规则。
   包装器程序（env/timeout/watch/nohup/…）同样列在这里：`timeout 5 rm -rf ~` 的语义全在参数里，
   按程序名提议等于把后面跟的任何命令一起放行。 */
/* apt / apt-get / make / systemd-run 已在 DANGER 里，ruleFor 对两张表取并集，这里不重复列。 */
const NO_RULE = new Set(['sed', 'awk', 'find', 'xargs', 'tee', 'truncate', 'mv', 'cp', 'ln', 'install',
  'tar', 'unzip', 'zip', '7z', 'rsync', 'patch', 'sort', 'gcc', 'g++', 'gradle', 'mvn',
  'dpkg', 'rpm',
  'env', 'timeout', 'watch', 'nohup', 'stdbuf', 'setsid', 'script', 'expect', 'unbuffer', 'time',
  'nice', 'ionice', 'taskset', 'numactl', 'chroot', 'unshare', 'nsenter', 'busybox', 'parallel',
  'strace', 'ltrace', 'gdb', 'xdg-open', 'open']);

/* 有"子命令"结构的程序：只放行**读类**子命令（`git log` 可以，光秃秃的 `git` 等于放行 git push /
   reset --hard；`docker ps` 可以，`docker run` 不行）。表里没有的程序一律不提议。 */
const SUBCMD_OK = {
  git: new Set(['log', 'status', 'diff', 'show', 'shortlog', 'describe', 'rev-parse', 'ls-files', 'ls-tree',
    'blame', 'grep', 'cat-file', 'reflog', 'whatchanged', 'diff-tree', 'diff-files', 'name-rev',
    'symbolic-ref', 'for-each-ref', 'count-objects', 'show-ref', 'check-ignore', 'version']),
  docker: new Set(['ps', 'images', 'image', 'inspect', 'logs', 'version', 'info', 'stats', 'top', 'port',
    'diff', 'history', 'df', 'search']),
  podman: new Set(['ps', 'images', 'image', 'inspect', 'logs', 'version', 'info', 'stats', 'top', 'diff',
    'history', 'search']),
  kubectl: new Set(['get', 'describe', 'logs', 'version', 'explain', 'api-resources', 'api-versions', 'top']),
};

/* 只读程序：直接按程序名放行（`cat` 放行后读任何文件都不再问；它们改不了东西） */
const READ_ONLY = new Set(['ls', 'll', 'dir', 'vdir', 'cat', 'bat', 'head', 'tail', 'wc', 'nl', 'grep', 'rg',
  'ag', 'du', 'df', 'free', 'uname', 'whoami', 'id', 'pwd', 'echo', 'printf', 'date', 'which', 'type', 'file',
  'stat', 'readlink', 'realpath', 'basename', 'dirname', 'tree', 'lsblk', 'lscpu', 'nvidia-smi', 'ps', 'uptime',
  'hostname', 'jq', 'cut', 'paste', 'tr', 'uniq', 'diff', 'cmp', 'md5sum', 'sha256sum', 'less', 'more', 'column',
  'lsof', 'ss', 'netstat']);   // dpkg / rpm 在 NO_RULE 里，ruleFor 先看那张表，列在这里也走不到

const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, 120);
const normalizeRule = (s) => norm(String(s == null ? '' : s).replace(/\*+$/, ''));
const baseName = (p) => String(p || '').split('/').pop();

/**
 * 为这条命令提议一条允许规则（如 `git status -sb` → `git status`，`cat a.txt` → `cat`）。
 * @returns 规则字符串；空串 = 不给这个选项（含串联/重定向/换行，或高风险程序）
 */
function ruleFor(cmd) {
  const raw = String(cmd == null ? '' : cmd);
  if (!raw.trim() || /[\n\r]/.test(raw)) return '';                     // 多行 = 多条命令
  if (/[;&|`<>()]|\$\(|\$\{/.test(raw)) return '';                      // 串联、管道、重定向、命令替换、括号子壳
  const s = norm(raw);
  if (!s) return '';
  const toks = s.split(' ');
  if (toks[0].includes('=')) return '';                                 // VAR=x cmd：真正跑的不是它
  const prog = baseName(toks[0]);
  if (DANGER.has(prog) || NO_RULE.has(prog)) return '';
  const sub = /^[A-Za-z][\w:.-]*$/.test(toks[1] || '') ? toks[1] : '';  // 子命令（不是选项、不是路径）
  const okSub = SUBCMD_OK[prog];
  if (okSub) return okSub.has(sub) ? toks[0] + ' ' + sub : '';          // git log ✓ / git push ✗
  if (READ_ONLY.has(prog)) return toks[0];                             // 只读程序：按程序名放行
  return sub ? toks[0] + ' ' + sub : toks[0];
}

/** 命中允许清单则返回命中的规则，否则 null。按词边界前缀匹配（`git s` 不匹配 `git status`）。
 *  **含串联/管道/重定向/命令替换的整行一律不匹配**：规则只在"单条命令"上提议（见 ruleFor），
 *  匹配也必须守同一条边界——否则给 `git log` 记的规则会放行 `git log && rm -rf ~`，
 *  `cat` 的规则会放行 `cat x > /etc/...`（前缀匹配完全盖不住后面的东西）。 */
function matchRule(cmd, rules) {
  const raw = String(cmd == null ? '' : cmd);
  if (!raw.trim() || /[\n\r]/.test(raw)) return null;
  if (/[;&|`<>()]|\$\(|\$\{/.test(raw)) return null;
  const s = norm(raw);
  /* 清单形状容忍字符串（换行/逗号分隔）：读取端只认数组会把盘上的旧数据判成"没有清单"，
     用户勾过的"以后不再问"就静默失效（2026-10-01 实测）。收敛函数与参数面板共用一份。 */
  for (const r of asStringList(rules)) {
    const rule = normalizeRule(r);
    if (!rule) continue;
    if (s === rule || (s.startsWith(rule) && s.charAt(rule.length) === ' ')) return rule;
  }
  return null;
}

/** 加一条规则（去重、归一化、上限 100 条） */
function addRule(rules, rule) {
  const out = (Array.isArray(rules) ? rules : []).map(normalizeRule).filter(Boolean);
  const r = normalizeRule(rule);
  if (r && !out.includes(r)) out.push(r);
  return out.slice(-100);
}
const removeRule = (rules, rule) => {
  const r = normalizeRule(rule);
  return (Array.isArray(rules) ? rules : []).filter(x => normalizeRule(x) !== r);
};

export const AgentPolicy = { MODES, meta, modeOf, eff, summary, ruleFor, matchRule, addRule, removeRule, normalizeRule };
