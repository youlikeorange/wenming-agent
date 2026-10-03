/** lib/agent/osaccess.js —— 以「绑定账号」的 POSIX 权限判定能否访问一个路径（纯逻辑 + 只读 stat）
 *
 *  为什么需要它：Agent 的文件工具在站点进程里执行（Node 没有 setuid 式的 fs 切换），
 *  所以"以绑定账号的权限操作文件"这件事必须**自己判定**。它只可能收紧、不可能放宽：
 *    · 目录白名单（roots）决定"能碰哪些路径"；
 *    · 本模块决定"绑定账号对这些路径有没有读/写/遍历权限"。
 *  于是 Agent 的可达范围 = roots ∩ 绑定账号的真实权限位，绝不会超过"站点进程身份 ∩ 绑定账号"。
 *  （命令工具不在这里：它用 su 真正以绑定账号运行，权限由内核判定。）
 *
 *  两条判定路径（同一件事的两种问法，2026-09-30 补第二条）：
 *    ① 绑定账号 == 站点进程账号（method 'same'，最常见）→ **直接问内核**（fs.access）。
 *       内核才是文件操作真正会遇到的判定：ACL、挂载选项、capabilities 全算在内。
 *    ② 绑定账号是另一个账号（method 'su'）→ 没法拿内核问（要换身份才能问），退回
 *       "mode 位 + 属主/属组/其它三段选一"的走查，并带 **ACL 兜底**（getfacl）。
 *
 *  为什么必须有这一层：mode 位看不见 ACL。实测踩到 `/media/leo` 是 `drwxr-x--- root:root`
 *  + ACL `user:leo:r-x` —— 内核允许 leo 进入（`test -x` 通过），但按 other 位判定就是
 *  "缺少 x 位"，于是整块数据盘（项目与文档都在这儿）的文件读写被全拒。
 *
 *  判定规则（mode 位路径）：
 *    · uid 0（root）读/写一律通过；
 *    · 目标属主 == 账号 uid → 取 owner 位；否则目标属组 ∈ 账号组集合 → 取 group 位；否则取 other 位；
 *    · 读文件要 r；写已有文件要 w；目录里新建/改名/删除要 w+x；进入目录（以及每一级祖先）要 x。
 *  ACL 路径（POSIX.1e）：命中命名用户条目 → 该条目；否则所有命中的命名组条目按位或；
 *  两者都没有 → other 位。命名条目要与 mask 相与（other 不受 mask 约束）。
 *
 *  组集合来自 `id -G <user>`（结果缓存 5 分钟；查不到就只按主组判定，方向是**收紧**）。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');

const R = 4, W = 2, X = 1;
const GROUP_TTL_MS = 5 * 60e3;
const ACL_TTL_MS = 60e3;

const groupCache = new Map();       // user -> { groups:Set<number>, exp }
const aclCache = new Map();         // path -> { acl, exp }


/** 账号的组集合（含主组）。查不到返回空集——只按主组判定，宁严不宽。 */
function groupsOf(user) {
  const key = String(user || '');
  const hit = groupCache.get(key);
  if (hit && hit.exp > Date.now()) return Promise.resolve(hit.groups);
  return new Promise((resolve) => {
    execFile('id', ['-G', key], { timeout: 5000 }, (err, stdout) => {
      const groups = new Set();
      if (!err && stdout) {
        for (const t of String(stdout).trim().split(/\s+/)) {
          const n = Number(t);
          if (Number.isFinite(n)) groups.add(n);
        }
      }
      groupCache.set(key, { groups, exp: Date.now() + GROUP_TTL_MS });
      resolve(groups);
    });
  });
}

/** 账号身份：uid/gid 由绑定信息给出，组集合现场查（带缓存） */
async function idsFor(binding) {
  const uid = Number(binding && binding.uid);
  const gid = Number(binding && binding.gid);
  const groups = await groupsOf(binding && binding.osUser);
  groups.add(gid);
  return { uid: Number.isFinite(uid) ? uid : -1, gid: Number.isFinite(gid) ? gid : -1, groups };
}

/** 单个 stat 结果 + 权限位 → 是否通过 */
function permits(stat, mask, ids) {
  if (ids.uid === 0) return true;                       // root：读写不设限（与内核一致）
  const mode = stat.mode;
  let bits;
  if (stat.uid === ids.uid) bits = (mode >> 6) & 7;
  else if (stat.gid === ids.gid || ids.groups.has(stat.gid)) bits = (mode >> 3) & 7;
  else bits = mode & 7;
  return (bits & mask) === mask;
}

/* ============================ ACL 兜底（mode 位看不见的东西） ============================ */

/** getfacl -n 输出 → { users:Map<uid,bits>, groups:Map<gid,bits>, mask, other }；
 *  文件没有 ACL（只有 user::/group::/other::）时返回 null —— 那种情况 mode 位就是全部真相。 */
function parseAcl(text) {
  const users = new Map();
  const groups = new Map();
  let mask = null, other = null, named = false;
  for (const raw of String(text || '').split('\n')) {
    const m = /^(user|group|mask|other):([^:]*):([rwx-]{3})\s*$/.exec(raw.trim());
    if (!m) continue;
    const bits = (m[3].includes('r') ? R : 0) | (m[3].includes('w') ? W : 0) | (m[3].includes('x') ? X : 0);
    if (m[1] === 'mask') mask = bits;
    else if (m[1] === 'other') other = bits;
    else if (m[2]) { (m[1] === 'user' ? users : groups).set(m[2], bits); named = true; }
  }
  if (!named && mask === null) return null;
  return { users, groups, mask, other };
}

/** 读一个路径的 ACL（带 1 分钟缓存；getfacl 不存在/失败 → null，方向是收紧） */
function aclOf(absPath) {
  const hit = aclCache.get(absPath);
  if (hit && hit.exp > Date.now()) return Promise.resolve(hit.acl);
  return new Promise((resolve) => {
    execFile('getfacl', ['-n', '-p', '--absolute-names', absPath], { timeout: 3000 }, (err, stdout) => {
      const acl = err ? null : parseAcl(stdout);
      if (aclCache.size > 500) aclCache.clear();
      aclCache.set(absPath, { acl, exp: Date.now() + ACL_TTL_MS });
      resolve(acl);
    });
  });
}

/** ACL 给这个账号的位；没有可用条目时返回 other 位 */
function aclBits(acl, ids) {
  if (!acl) return null;
  const mask = acl.mask === null ? 7 : acl.mask;
  let bits = null;
  const named = acl.users.get(String(ids.uid));
  if (named !== undefined) bits = named;
  else {
    for (const [g, v] of acl.groups) {
      const gid = Number(g);
      if (Number.isFinite(gid) && ids.groups.has(gid)) bits = bits === null ? v : (bits | v);
    }
  }
  return bits === null ? acl.other : (bits & mask);
}

/** mode 位判定 + ACL 兜底（只在 mode 位拒绝时才去读 ACL，快路径不受影响） */
async function permitsAt(absPath, stat, mask, ids) {
  if (permits(stat, mask, ids)) return true;
  const bits = aclBits(await aclOf(absPath), ids);
  return bits === null ? false : (bits & mask) === mask;
}

/** 内核判定：同账号档下它就是权威（ACL / 挂载选项 / capabilities 全算在内）。
 *  返回 false 表示"内核拒绝"——具体是哪一级目录、缺哪个位，由 mode 位走查给出人话原因。 */
async function kernelAllows(absPath, mask) {
  let mode = 0;
  if (mask & R) mode |= fs.constants.R_OK;
  if (mask & W) mode |= fs.constants.W_OK;
  if (mask & X) mode |= fs.constants.X_OK;
  if (!mode) return true;
  try { await fsp.access(absPath, mode); return true; } catch { return false; }
}


/** 最近的**已存在**祖先（含自身）。新建/删除要问的是它，不是"父目录"本身——
 *  父目录可能还没建起来（mkdir -p 的常见形态、往还没建的目录里写文件）：
 *  拿不存在的路径去 access() 只会得到 ENOENT，把它读成"内核拒绝"就会把"还没建"误报成
 *  "没权限（ACL 或挂载选项）"（2026-10-03 实测：同一轮 /…/assets/raw 被拒、/…/tools/art 通过，
 *  差别只在父目录存不存在）。 */
async function nearestExisting(absPath) {
  let cur = path.resolve(absPath);
  for (;;) {
    const st = await fsp.stat(cur).catch(() => null);
    if (st) return { path: cur, st };
    const up = path.dirname(cur);
    if (up === cur) return null;                        // 连根都不存在（不可能，但别死循环）
    cur = up;
  }
}

const describe = (need) => ({ read: '读取', write: '写入', delete: '删除', create: '新建', traverse: '进入' }[need] || '访问');

/** 逐级检查祖先目录的 x 位（从根一直到 parent）。返回第一个不放行的目录。 */
async function checkAncestors(absPath, ids) {
  const segs = path.resolve(absPath).split(path.sep).filter(Boolean);
  let cur = path.sep;
  for (let i = 0; i < segs.length; i++) {
    cur = path.join(cur, segs[i]);
    const st = await fsp.stat(cur).catch(() => null);
    if (!st) return null;                               // 不存在的段：交给调用方按"新建"处理
    if (!st.isDirectory()) return null;
    if (!(await permitsAt(cur, st, X, ids))) return { path: cur, need: 'traverse' };
  }
  return null;
}

/** mode 位走查（含 ACL 兜底）—— 'su' 档的唯一判定，也是 'same' 档内核拒绝时的人话解释 */
async function checkByBits(target, need, ids, isThere) {
  const dir = path.dirname(target);

  // 每一级祖先都要能进入（x）。这一步必须在"目标不存在就放行"之前：
  // 目录没有 x 位时连 stat 都做不了（isThere 会是 false），若先短路就变成"放行"——
  // 一个没有被约束的读取会被底层 EACCES 挡下，但错误信息会误导成"文件不存在"。
  const anc = await checkAncestors(dir, ids);
  if (anc) return { ok: false, reason: `绑定账号对目录 ${anc.path} 没有进入权限（缺少 x 位）`, path: anc.path };

  // 目标不存在：read 放行（交给工具报"文件不存在"，比报"没权限"准确）
  if (!isThere && need === 'read') return { ok: true };

  // 新建 / 删除 / 改名发生在父目录上：需要父目录的 w+x
  if (need === 'create' || need === 'delete') {
    const parent = await fsp.stat(dir).catch(() => null);
    if (parent && !(await permitsAt(dir, parent, W | X, ids))) {
      return { ok: false, reason: `绑定账号对目录 ${dir} 没有写权限（新建/删除/改名需要 w+x）`, path: dir };
    }
    if (need === 'create') return { ok: true };
  }
  if (!isThere) return { ok: true };

  const st = await fsp.stat(target).catch(() => null);   // 跟着软链接看真实目标（与打开文件的行为一致）
  if (!st) return { ok: false, reason: '目标无法解析（软链接悬空？）', path: target };
  // 目录自身也要能进入（列目录需要 r+x，在其中写入要 w+x）
  const mask = st.isDirectory() ? (need === 'read' ? R | X : W | X) : (need === 'read' ? R : need === 'write' ? W : 0);
  if (mask && !(await permitsAt(target, st, mask, ids))) {
    return {
      ok: false, path: target,
      reason: `绑定账号对${st.isDirectory() ? '目录' : '文件'} ${target} 没有${describe(need)}权限`
        + `（模式 ${(st.mode & 0o777).toString(8)}，属主 uid=${st.uid} gid=${st.gid}）`,
    };
  }
  return { ok: true };
}

/**
 * 判定 access(path, need) 是否被绑定账号允许。
 *   need: 'read' | 'write' | 'delete' | 'create'
 *   exists: 目标是否已存在（调用方一般知道；不知道就传 null 由本函数 stat）
 *   opts.sameAccount: 绑定账号 == 站点进程账号（绑定信息里的 method === 'same'）→ 直接问内核
 *  返回 { ok } 或 { ok:false, reason, path }
 *
 *  约定：目标不存在时——read 放行（交给工具报"文件不存在"，比报"没权限"准确）、
 *  write 升级为 create（覆盖一个还不存在的文件 = 在父目录新建）。
 */
async function check(absPath, need, ids, exists, opts = {}) {
  const target = path.resolve(absPath);
  const dir = path.dirname(target);
  let isThere = exists;
  if (isThere === undefined || isThere === null) {
    isThere = !!(await fsp.lstat(target).catch(() => null));
  }
  if (!isThere && need === 'write') need = 'create';

  if (opts.sameAccount) {
    /* 同账号档：**内核才是权威**（ACL、挂载选项、capabilities 全算在内），自己推 mode 位会漏掉
       ACL —— /media/leo 就是"mode 位说不行、内核说行"的实例，误判会让整块数据盘读写全废。
       内核放行 = 放行；内核拒绝 = 拒绝，但改用 mode 位走查给出精确原因（哪一级目录、缺哪个位）。 */
    const mask = need === 'read' ? (isThere ? R : 0) : (need === 'write' ? W : 0);
    let okByKernel;
    if (need === 'create' || need === 'delete') {
      /* 新建/删除发生在父目录上，但父目录本身可能还不存在（见 nearestExisting）：
         问**最近一个存在的祖先**（它可写就允许一路建下去，与 mkdir -p 的语义一致）。
         以前直接问父目录，父目录不存在时 access() 报 ENOENT → 被判成"内核拒绝"，
         而同一函数的 mode 位走查对同一种情形判"放行"——两边自相矛盾（2026-10-03 修）。 */
      const anc = await nearestExisting(dir);
      okByKernel = anc ? await kernelAllows(anc.path, W | X) : false;
    } else {
      okByKernel = (!isThere && need === 'read') ? true : await kernelAllows(target, mask);
    }
    if (okByKernel) return { ok: true };
    const why = await checkByBits(target, need, ids, isThere);
    if (!why.ok) return why;
    return { ok: false, path: target,
      reason: `绑定账号对 ${target} 没有${describe(need)}权限（内核判定为拒绝：ACL 或挂载选项）` };
  }

  return checkByBits(target, need, ids, isThere);
}

module.exports = {
  check, checkByBits, permits, permitsAt, aclOf, aclBits, parseAcl, kernelAllows, idsFor, groupsOf, R, W, X,
  clearAclCache: () => aclCache.clear(),     // 权限刚被改过时要能立刻重判（测试与"改完权限再试"都用它）
};
