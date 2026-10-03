/** lib/agent/archive.js —— 归档：会话与项目（连会话）搬进"归档文件夹"，随时可以恢复
 *
 *  为什么要有归档：删除是不可逆的，而"这个对话不用了"多数时候只是"先收起来"。
 *  所以界面上（侧栏）原来的删除按钮改成**归档**：搬进用户账号目录下的归档文件夹，
 *  设置 → 存档 里能看到、能恢复、也能在那里**彻底删除**（那一步才是不可逆的）。
 *
 *  存在哪（都是该账号自己的目录，别的账号看不到）：
 *      STATE_DIR/agent/<文档站账号>/archive/
 *          sessions.json      归档的会话（原样 + archivedAt）
 *          projects.json      归档的项目元信息（原样 + archivedAt + memoryCount + sessions 数）
 *          projects/<项目id>/  归档的项目记忆文件夹（整份搬过来，project.json/MEMORY.md/memory/ 都在）
 *
 *  三个必须守住的口径：
 *    · **归档 ≠ 删除**：会话只是从 sessions.json 搬到 archive/sessions.json，一字不改；
 *      项目只是从清单摘掉 + 文件夹搬家，恢复时连它的会话一起回来；
 *    · **搬家用 rename，跨设备才回落 cp+rm**（STATE_DIR 内部一般同盘，rename 是原子的）；
 *    · 归档里的东西**不参与注入**（记忆/会话都不再进上下文）——这正是"收起来"的意思。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { AGENT_ROOT, accountDir } = require('../paths');
const { auditLog } = require('../auth');
const store = require('./store');
const projects = require('./projects');
const S = require('./sanitize');

const MAX_SESSIONS = 500;
const MAX_PROJECTS = 100;

const dirOf = (account) => {
  const d = accountDir(AGENT_ROOT, account);
  return d ? path.join(d, 'archive') : null;
};
const fileOf = (account, name) => {
  const d = dirOf(account);
  return d ? path.join(d, `${name}.json`) : null;
};
const sessionsFile = (account) => fileOf(account, 'sessions');
const projectsFile = (account) => fileOf(account, 'projects');

const emptySessions = () => ({ version: 1, sessions: [] });
const emptyProjects = () => ({ version: 1, projects: [] });

/* ============================ 读写 ============================ */

const readSessions = (account) => {
  const d = store.readJson(sessionsFile(account), emptySessions());
  return { version: 1, sessions: Array.isArray(d.sessions) ? d.sessions : [] };
};
const readProjects = (account) => {
  const d = store.readJson(projectsFile(account), emptyProjects());
  return { version: 1, projects: Array.isArray(d.projects) ? d.projects : [] };
};
const write = (account, file, data) => {
  if (!file) return Promise.reject(Object.assign(new Error('账号名不合法'), { status: 400 }));
  try { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); } catch { /* 已存在 */ }
  return store.writeJson(file, data);
};

/* ============================ 搬家（rename，跨设备回落复制） ============================ */

async function moveDir(from, to) {
  if (!fs.existsSync(from)) return false;
  await fsp.mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
  await fsp.rm(to, { recursive: true, force: true });
  try { await fsp.rename(from, to); }
  catch { await fsp.cp(from, to, { recursive: true }); await fsp.rm(from, { recursive: true, force: true }); }
  return true;
}

/* ============================ 会话 ============================ */

const roundsOf = (s) => (Array.isArray(s.msgs) ? s.msgs.filter((m) => m.role === 'user').length : 0);

/** 归档一个会话：从 sessions.json 搬到归档区（原样保留，含它的会话记忆与压缩摘要） */
async function archiveSession(account, id) {
  const sid = String(id || '');
  const taken = await store.takeSessions(account, [sid]);
  if (!taken.length) throw Object.assign(new Error('没有这个会话'), { status: 404 });
  const rec = Object.assign({}, taken[0], { archivedAt: Date.now() });
  await store.withLock(account, async () => {
    const cur = readSessions(account);
    cur.sessions = [rec, ...cur.sessions.filter((s) => s.id !== sid)].slice(0, MAX_SESSIONS);
    await write(account, sessionsFile(account), cur);
  });
  auditLog(`agent-archive-session account=${account} id=${sid} title=${String(rec.title || '').slice(0, 60)}`);
  return { id: sid, title: rec.title || '新对话' };
}

/** 把一批会话写进归档区（项目归档时整批搬） */
async function archiveSessions(account, list) {
  if (!list.length) return 0;
  const now = Date.now();
  return store.withLock(account, async () => {
    const cur = readSessions(account);
    const ids = new Set(list.map((s) => s.id));
    const incoming = list.map((s) => Object.assign({}, s, { archivedAt: now }));
    cur.sessions = incoming.concat(cur.sessions.filter((s) => !ids.has(s.id))).slice(0, MAX_SESSIONS);
    await write(account, sessionsFile(account), cur);
    return incoming.length;
  });
}

/** 从归档区取出若干会话（恢复用；取走即从归档清单里删掉） */
async function takeArchivedSessions(account, pred) {
  return store.withLock(account, async () => {
    const cur = readSessions(account);
    const taken = cur.sessions.filter(pred);
    if (taken.length) {
      cur.sessions = cur.sessions.filter((s) => !pred(s));
      await write(account, sessionsFile(account), cur);
    }
    return taken.map((s) => { const c = Object.assign({}, s); delete c.archivedAt; return c; });
  });
}

/* ============================ 项目 ============================ */

/** 归档一个项目：清单摘掉 + 记忆文件夹搬家 + **它下面的会话一起搬**（用户要求"连同里面的会话"） */
async function archiveProject(account, id) {
  const pid = String(id || '');
  const { project, current } = await projects.take(account, pid);      // 只摘清单，文件夹还在原处
  const live = store.readSessions(account).sessions.filter((s) => (s.project || '') === pid);
  const taken = live.length ? await store.takeSessions(account, live.map((s) => s.id)) : [];
  await archiveSessions(account, taken);

  const from = projects.projectDir(account, pid);
  const to = path.join(dirOf(account), 'projects', pid);
  const moved = await moveDir(from, to);

  const rec = Object.assign({}, project, {
    archivedAt: Date.now(), sessions: taken.length,
    memoryCount: (() => { try { return fs.readdirSync(path.join(to, 'memory')).filter((f) => /\.md$/i.test(f)).length; } catch { return 0; } })(),
  });
  await store.withLock(account, async () => {
    const ar = readProjects(account);
    ar.projects = [rec, ...ar.projects.filter((p) => p.id !== pid)].slice(0, MAX_PROJECTS);
    await write(account, projectsFile(account), ar);
  });
  auditLog(`agent-archive-project account=${account} id=${pid} root=${project.root} sessions=${taken.length} moved=${moved}`);
  return { project: rec, current, sessions: taken.length };
}

/** 恢复一个项目：记忆文件夹搬回 + 回清单 + 它的会话一起回来 */
async function restoreProject(account, id) {
  const pid = String(id || '');
  const ar = readProjects(account);
  const rec = ar.projects.find((p) => p.id === pid);
  if (!rec) throw Object.assign(new Error('归档里没有这个项目'), { status: 404 });

  const from = path.join(dirOf(account), 'projects', pid);
  const to = projects.projectDir(account, pid);
  if (fs.existsSync(from) && !fs.existsSync(to)) await moveDir(from, to);

  const prevCurrent = projects.readList(account).current;
  const p = await projects.create(account, { root: rec.root, name: rec.name });   // id 由根目录哈希推出来，同一个根 = 同一个 id
  if (prevCurrent && prevCurrent !== p.id) await projects.setCurrent(account, prevCurrent);

  const sess = await takeArchivedSessions(account, (s) => (s.project || '') === pid);
  if (sess.length) await store.putSessions(account, sess);

  await store.withLock(account, async () => {
    const cur = readProjects(account);
    cur.projects = cur.projects.filter((x) => x.id !== pid);
    await write(account, projectsFile(account), cur);
  });
  auditLog(`agent-restore-project account=${account} id=${pid} sessions=${sess.length}`);
  return { project: p, sessions: sess.length };
}

/* ============================ 恢复 / 彻底删除 / 列表 ============================ */

async function restoreSession(account, id) {
  const sid = String(id || '');
  const taken = await takeArchivedSessions(account, (s) => s.id === sid);
  if (!taken.length) throw Object.assign(new Error('归档里没有这个会话'), { status: 404 });
  await store.putSessions(account, taken);
  auditLog(`agent-restore-session account=${account} id=${sid}`);
  return { session: taken[0] };
}

/** 彻底删除（不可逆）：归档区里的会话或项目 */
async function remove(account, kind, id) {
  const target = String(id || '');
  if (kind === 'project') {
    /* id 必须先是**合法项目 id**（与项目清单同一套规则，真源在 sanitize.js），
       再断言它拼出来的路径仍在归档目录内。原先这里直接用 String(id) 拼路径，
       而 path.join 会把 `..` 归一化掉 —— 一个 `{"kind":"project","id":"../../../../x"}`
       就能递归删除归档目录之外的任意路径（实测可删 STATE_DIR、文档根），
       且末尾的 .catch 把失败吞掉、接口照常回 200。
       两道防线：正则挡住非 id 字符；resolve 后必须落在 projects 目录里（防未来规则放宽）。 */
    if (!S.PROJECT_RE.test(target)) throw Object.assign(new Error('项目 id 不合法'), { status: 400 });
    const base = path.resolve(dirOf(account), 'projects');
    const dir = path.resolve(base, target);
    if (dir !== path.join(base, target) || !dir.startsWith(base + path.sep)) {
      throw Object.assign(new Error('项目 id 不合法'), { status: 400 });
    }
    await store.withLock(account, async () => {
      const cur = readProjects(account);
      cur.projects = cur.projects.filter((p) => p.id !== target);
      await write(account, projectsFile(account), cur);
    });
    await fsp.rm(dir, { recursive: true, force: true }).catch((e) => {
      // 目录不存在是正常的（项目可能只剩元信息）；其余错误要说出来，别静默当成功
      if (e && e.code !== 'ENOENT') auditLog(`agent-archive-purge-fail account=${account} id=${target} ${e.code || e.message}`);
    });
    auditLog(`agent-archive-purge account=${account} kind=project id=${target}`);
    return { kind, id: target };
  }
  if (!S.ID_RE.test(target)) throw Object.assign(new Error('会话 id 不合法'), { status: 400 });
  await store.withLock(account, async () => {
    const cur = readSessions(account);
    cur.sessions = cur.sessions.filter((s) => s.id !== target);
    await write(account, sessionsFile(account), cur);
  });
  auditLog(`agent-archive-purge account=${account} kind=session id=${target}`);
  return { kind: 'session', id: target };
}

/** 归档清单（只给摘要：标题/时间/轮数，正文留在文件里等恢复） */
function list(account) {
  const s = readSessions(account).sessions.map((x) => ({
    id: x.id, title: x.title || '新对话', ts: x.ts || 0, archivedAt: x.archivedAt || 0,
    project: x.project || '', rounds: roundsOf(x),
  }));
  const p = readProjects(account).projects.map((x) => ({
    id: x.id, name: x.name, root: x.root, archivedAt: x.archivedAt || 0,
    memoryCount: x.memoryCount || 0, sessions: x.sessions || 0,
  }));
  return { sessions: s, projects: p };
}

module.exports = {
  dirOf, list, archiveSession, archiveProject, restoreSession, restoreProject, remove,
  readSessions, readProjects,
};
