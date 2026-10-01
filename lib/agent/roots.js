/** lib/agent/roots.js —— 路径范围：**可访问目录**（文件工具能碰哪）+ **项目起点**（项目放哪）
 *
 *  两个概念，别混：
 *    · **可访问目录**（roots）：文件工具与命令的路径范围，符号链接解析后复核。
 *      默认是**整个文件系统 `/`**（2026-09-30 用户要求：agent 要能操作环境、系统盘等
 *      非工作目录的内容）。真正的深度限制来自绑定账号的 POSIX 权限（lib/agent/osaccess.js）
 *      与服务端硬上限（limits）——白名单给范围、权限位给深浅，默认把"范围"放到最大。
 *      想收紧就在面板里填具体目录（可用 AGENT_ROOTS 环境变量覆盖默认值，冒号分隔）。
 *    · **项目起点**（start）：目录选择器从这里开始、**项目根目录必须落在它下面**、
 *      命令的默认 cwd 也优先取它。默认 `/media/leo/DATA/workspace`（AGENT_START 可覆盖）。
 *      它只约束"项目在哪"，不限制 agent 能读写哪些目录。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const settings = require('./settings');

const AGENT_ROOTS_ENV = process.env.AGENT_ROOTS
  ? String(process.env.AGENT_ROOTS).split(path.delimiter).map((p) => path.resolve(p.trim())).filter(Boolean)
  : null;
/** 默认起点（项目都放这儿；不存在时回落绑定账号家目录） */
const DEFAULT_START = path.resolve(process.env.AGENT_START || '/media/leo/DATA/workspace');

/** 出厂默认的可访问范围：**整个文件系统**（限制交给绑定账号权限与服务端硬上限）。
 *  AGENT_ROOTS 一旦设置就以它为准（部署方想收窄时用；单测也靠它把范围锁在临时目录里）。 */
function defaultsFor() {
  return (AGENT_ROOTS_ENV || ['/']).map((p) => path.resolve(p));
}

/** 生效的可访问范围 */
function list(actor) {
  const stored = settings.read(actor.account).tools.roots;
  const raw = stored.length ? stored : defaultsFor();
  return raw.map((p) => path.resolve(String(p))).filter(Boolean);
}

/* ============================ 项目起点 ============================ */

/** 生效的项目起点：面板设置 > 默认值 > 绑定账号家目录（都要求真实存在） */
function startFor(actor) {
  const stored = (actor && actor.account) ? settings.read(actor.account).tools.start : '';
  if (stored && fs.existsSync(stored)) return path.resolve(stored);
  if (fs.existsSync(DEFAULT_START)) return DEFAULT_START;
  const home = (actor && actor.home) || (() => { try { return os.homedir(); } catch { return '/'; } })();
  return path.resolve(home);
}

/** 面板动作：设起点（必须是真实存在的目录） */
async function setStart(account, input) {
  const p = path.resolve(String(input || '').trim());
  if (!String(input || '').trim()) throw Object.assign(new Error('缺少路径'), { status: 400 });
  if (!fs.existsSync(p)) throw Object.assign(new Error('目录不存在：' + p), { status: 404 });
  if (!fs.statSync(p).isDirectory()) throw Object.assign(new Error('不是目录：' + p), { status: 400 });
  await settings.patch(account, (s) => { s.tools.start = p; return s; });
  return p;
}

/** 路径是否落在起点内（realpath 复核，杜绝 ../ 与软链接绕出去） */
function insideStart(actor, target) {
  const start = startFor(actor);
  return inside(resolveReal(target), resolveReal(start));
}

/** 面板动作：add / remove / set / reset / start（前四个改可访问范围，最后一个改项目起点）
 *  @returns {Promise<{roots: string[]}|{start: string}>} **恒为对象**，键随动作而变：
 *     前四个 → { roots }，start → { start }。路由层原样展开进响应体（{ok:true, ...out}），
 *     与前端契约一一对应（settings.js 读 d.roots、projects.js 读 d.start）。
 *     审计发现：这里曾对 start 返回对象、路由层却一律按数组 join → 该动作必然 500。 */
async function apply(action, body, actor) {
  if (action === 'start') return { start: await setStart(actor.account, body && body.path) };
  const cur = list(actor);
  let next = cur.slice();
  if (action === 'add') {
    const p = path.resolve(String((body && body.path) || '').trim());
    if (!String((body && body.path) || '').trim()) throw Object.assign(new Error('缺少 path'), { status: 400 });
    if (!fs.existsSync(p)) throw Object.assign(new Error('目录不存在：' + p), { status: 404 });
    if (!fs.statSync(p).isDirectory()) throw Object.assign(new Error('不是目录：' + p), { status: 400 });
    if (!next.includes(p)) next.push(p);
  } else if (action === 'remove') {
    const p = path.resolve(String((body && body.path) || '').trim());
    next = next.filter((x) => x !== p);
    if (!next.length) throw Object.assign(new Error('至少要保留一个可访问目录'), { status: 400 });
  } else if (action === 'set') {
    next = (Array.isArray(body && body.roots) ? body.roots : []).map((p) => path.resolve(String(p).trim())).filter(Boolean);
    if (!next.length) throw Object.assign(new Error('至少要保留一个可访问目录'), { status: 400 });
  } else if (action === 'reset') {
    next = defaultsFor();
  } else {
    throw Object.assign(new Error('unknown action'), { status: 400 });
  }
  await settings.setRoots(actor.account, next);
  return { roots: next };
}

/* ============================ 路径沙箱 ============================ */

const WRITE_FORBIDDEN = ['/proc', '/sys', '/dev', '/run'];

/** 把可能不存在的路径解析成"最接近的真实路径 + 剩余段"，避免用 ../ 或软链接绕出白名单 */
function resolveReal(p) {
  const abs = path.resolve(p);
  let cur = abs, tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;                 // 到根了还不存在：按字面返回
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

const inside = (child, root) => child === root || child.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/** 解析并校验一个路径：必须落在该身份的可访问目录内。
 *  `~` 按**绑定账号**的家目录展开（旧实现用服务端进程的 os.homedir()，绑 root 时
 *  ~/x 会静默指向 /home/<站点用户>/x —— 一个"看起来对、实际错"的路径比报错更难查）。 */
function resolveInRoots(actor, input, opts) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) throw Object.assign(new Error('缺少 path 参数'), { status: 400 });
  if (raw.includes('\0')) throw Object.assign(new Error('路径不合法'), { status: 400 });
  const roots = list(actor);
  const home = (actor && actor.home) || (() => { try { return require('os').homedir(); } catch { return '/'; } })();
  const expanded = raw === '~' ? home
    : raw.startsWith('~/') ? path.join(home, raw.slice(2))
    : raw;
  const abs = path.resolve(expanded);                 // 相对路径按站点进程的 cwd 解析
  const real = resolveReal(abs);
  const ok = roots.find((r) => inside(real, resolveReal(r)));
  if (!ok) {
    throw Object.assign(new Error(`路径不在可访问目录内：${real}\n允许的目录：${roots.join('、')}`
      + `\n（要放开请在设置抽屉 → 权限与工具 → 可访问目录 里添加）`), { status: 403, needRoots: true });
  }
  if (opts && opts.write) {
    const bad = WRITE_FORBIDDEN.find((d) => inside(real, d));
    if (bad) throw Object.assign(new Error(`拒绝写入系统目录：${real}`), { status: 403 });
  }
  return { abs, real, roots };
}

module.exports = {
  list, defaultsFor, apply, resolveInRoots, resolveReal, inside, WRITE_FORBIDDEN,
  DEFAULT_START, startFor, setStart, insideStart,
};
