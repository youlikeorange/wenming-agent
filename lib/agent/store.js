/** lib/agent/store.js —— Agent 的**大对象**存储：会话 / 全局记忆 / 提示词登记表
 *
 *  存在哪：STATE_DIR/agent/<文档站账号>/
 *      sessions.json   会话（含各自的会话记忆与压缩摘要）
 *      memory.json     全局记忆（跨会话）
 *      prompts.json    提示词登记表（覆盖项 + 技能 + 自定义条目）
 *  ——按账号**一个目录**，账号之间互不可见；配置类的小字段在 lib/agent/settings.js
 *  （userdata/<账号>/agent.json）。分开的原因：这些对象可能很大且条数多（单会话上限 32MB、
 *  记忆/技能每条上限 200KB），塞进配置文件的 256KB 配额会直接把用户设置写死。
 *
 *  API Key 与这里无关（只存在 settings 的 providers 里），本文件不接触任何密钥。
 */
const fs = require('fs');
const path = require('path');
const { STATE_DIR } = require('../config');
const { atomicWriteJson } = require('../state');
const { auditLog } = require('../auth');
const { makeLock } = require('../lock');
const S = require('./sanitize');
const { readJson: readReqJson } = require('../http');

const ROOT = path.join(STATE_DIR, 'agent');
/* 标识符规则统一在 sanitize.js（唯一真源）：账号名 / 会话 id / 项目 id 三套，
   原先 store 与 projects 各存一份项目 id 正则，且规则已经不一致（`.hidden` 一个收一个拒）。 */
const { ACCOUNT_RE, PROJECT_RE, ID_RE } = S;

/* 上限（防止单个账号把磁盘写爆；超出时丢最旧的会话并在响应里说明） */
const MAX_SESSIONS = 300;
const MAX_MSGS = 2000;
const MAX_TRACE = 100;
const MAX_SESSION_BYTES = 32 * 1024 * 1024;
const MAX_CONTENT = 2 * 1024 * 1024;
const MAX_MEMORY = 300;
/** store / projects 两条链路的**请求体上限**：必须装得下"整份会话"（单会话配额 MAX_SESSION_BYTES）
 *  与"整份记忆"（MAX_MEMORY 条 × 每条 200KB），再加 JSON 信封余量。
 *  真源只有这一个常量——路由层不许再各写一个数字：审计发现路由层写死 4MB 而这里配额 32MB，
 *  于是超过 4MB 的会话**永远** 413，那个配额成了空头承诺（lib/http.js 的文件头正好警告过这个坑）。 */
const MAX_BODY_BYTES = Math.max(MAX_SESSION_BYTES, MAX_MEMORY * S.MAX_LONG) + 4 * 1024 * 1024;
/** 小请求（绑定、工具、归档、技能安装）的上限 */
const SMALL_BODY_BYTES = 4 * 1024 * 1024;

/** Agent 各路由读 JSON 体的**唯一入口**：按路径选上限，并把 413 与"JSON 坏了"分开回。
 *  为什么要有这个函数：审计发现 /agent/tools/*、/agent/upstream/*、/agent/presence/* 三处
 *  直接调 `readJson(req)`（不传上限），走的是 lib/http.js 的全局默认 8MB，
 *  而路由表 bodyLimitFor 声明的 4MB/32MB 根本没生效——上限成了"写在另一处的注释"。 */
async function readAgentJson(req, pathname) {
  const big = pathname.startsWith('/agent/store') || pathname.startsWith('/agent/projects');
  const max = big ? MAX_BODY_BYTES : SMALL_BODY_BYTES;
  return readReqJson(req, max);        // readReqJson = lib/http 的"读请求体"；本文件的 readJson 是"读文件"
}

/* ============================ 路径与读写 ============================ */

/** 账号 → 数据目录（只接受合法账号名，杜绝 ../ 之类的路径花样） */
function dirOf(account) {
  if (!ACCOUNT_RE.test(String(account || ''))) return null;
  return path.join(ROOT, String(account));
}
const fileOf = (account, name) => {
  const d = dirOf(account);
  return d ? path.join(d, `${name}.json`) : null;
};

/** 按账号串行化（同一账号的并发请求排队，避免读改写互相覆盖） */
/* 按账号串行化：实现只有一处（lib/agent/lock.js）；本模块自己持有一把，
   锁的是本模块读写的那些文件（跨模块共用一把会因"锁里调另一个加锁函数"而死锁，见 lock.js）。 */
const withLock = makeLock();

/** 读一个 JSON 文件；文件损坏时先留 .bak 再以默认值继续（绝不能直接覆盖，否则原数据无声丢失） */
function readJson(file, fallback) {
  if (!file) return fallback;
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch { return fallback; }
  try {
    const d = JSON.parse(raw);
    return (d && typeof d === 'object') ? d : fallback;
  } catch (e) {
    const bak = file + '.bak-' + Date.now();
    try { fs.copyFileSync(file, bak); } catch { /* 备份失败也继续 */ }
    auditLog(`agent-store-corrupt file=${path.basename(file)} backup=${path.basename(bak)} err=${e.message}`);
    console.error('[agent/store] 数据文件损坏，已备份为', bak);
    return fallback;
  }
}

function writeJson(file, data) {
  if (!file) return Promise.reject(Object.assign(new Error('账号名不合法'), { status: 400 }));
  data.updatedAt = new Date().toISOString();
  try { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); } catch { /* 已存在 */ }
  return atomicWriteJson(file, data, 2);
}

/* ============================ 会话 ============================ */

function sanitizeMsg(m) {
  if (!m || typeof m !== 'object') return null;
  const role = ['user', 'assistant', 'system', 'tool'].includes(m.role) ? m.role : 'user';
  const out = { role, content: S.str(m.content, MAX_CONTENT) };
  /* 消息 id：界面拿它当 React key（下标当 key 会在删除/回撤后错位）。客户端与服务端都会生成，
     这里只做"合法才留"的过滤——它是会话文件里的普通字段，不是标识符。 */
  if (/^[\w-]{1,40}$/.test(String(m.id || ''))) out.id = String(m.id);
  if (m.streaming === true) out.streaming = true;      // 中断标记要保留：重绘时靠它显示"这一轮没跑完"
  /* 失败说明**必须落盘**：模型/上游出错（401、429、断网、上下文超限…）时它挂在消息上，
     界面据此画错误块 + 「重试这一轮」。不存的话刷新一次错误就消失了，
     用户看到的是"这一轮什么都没发生"（2026-10-01：要求"LLM 出问题要能在会话里反映出来"）。 */
  if (m.error) out.error = S.str(m.error, 2000);
  if (typeof m.thinking === 'string' && m.thinking) out.thinking = m.thinking.slice(0, S.MAX_LONG * 5);
  /* Anthropic 扩展思考的两样：signature 与判红块。**必须落盘**——下一轮要把它们原样回传给上游，
     不带就整轮 400（见 core/protocol/anthropic.js 的 toMsg）。丢了白名单里的字段 = 刷新之后必然失败。 */
  if (typeof m.thinkingSig === 'string' && m.thinkingSig) out.thinkingSig = S.str(m.thinkingSig, S.MAX_LONG);
  if (typeof m.redactedThinking === 'string' && m.redactedThinking) out.redactedThinking = S.str(m.redactedThinking, S.MAX_LONG);
  if (m.stats && typeof m.stats === 'object') out.stats = S.plain(m.stats, 3);
  if (Number.isFinite(Number(m.wallMs))) out.wallMs = Number(m.wallMs);
  if (Array.isArray(m.toolCalls) && m.toolCalls.length) {
    out.toolCalls = m.toolCalls.slice(0, 20).map((c) => ({
      id: S.str(c && c.id, 80), name: S.str(c && c.name, 80), args: S.plain(c && c.args, 3) || {},
    }));
  }
  if (Array.isArray(m.trace) && m.trace.length) {
    out.trace = m.trace.slice(0, MAX_TRACE).map((t) => {
      const rec = {
        name: S.str(t && t.name, 80), label: S.str(t && t.label, 300), ok: !!t.ok,
        note: S.str(t && t.note, 200), args: S.plain(t && t.args, 3),
        ms: S.num(t && t.ms), result: S.str(t && t.result, S.MAX_LONG),
      };
      /* 条目的类别与状态是结构化判据（界面不再比中文文案，见 ui/lib/trace.js）：
         白名单内才写，旧数据没有这两个键就不写（界面按老规矩回推一次）。 */
      if (['tool', 'sub', 'notice', 'steer', 'compact'].includes(t && t.kind)) rec.kind = t.kind;
      if (t && t.state === 'running') rec.state = 'running';
      /* 可下载文件清单（deliver_file 那张卡）：**必须落盘**——刷新后卡片与下载链接还在，
         否则"传给用户的文件"只在当轮看得见。字段与 files.js 的列表同形。 */
      if (Array.isArray(t && t.files) && t.files.length) {
        rec.files = t.files.slice(0, 20).map((f) => ({
          name: S.str(f && f.name, 200), size: S.num(f && f.size),
          exec: !!(f && f.exec), packaged: !!(f && f.packaged), source: S.str(f && f.source, 500),
        })).filter((f) => f.name);
      }
      return rec;
    });
  }
  if (m.injected && typeof m.injected === 'object') {
    out.injected = { summary: S.str(m.injected.summary, 500), text: S.str(m.injected.text, S.MAX_LONG) };
  }
  return out;
}

function sanitizeSession(s) {
  if (!s || typeof s !== 'object') return null;
  const id = ID_RE.test(String(s.id || '')) ? String(s.id) : '';
  if (!id) return null;
  // msgs 是本站自己的字段名；顺带认 messages（第三方脚本/未来功能的常见叫法）——
  // 旧实现会静默丢掉它还不报错（实测：发 messages 进来消息数 0）。
  const rawMsgs = Array.isArray(s.msgs) ? s.msgs : (Array.isArray(s.messages) ? s.messages : []);
  const msgs = [];
  for (const m of rawMsgs.slice(-MAX_MSGS)) {
    const clean = sanitizeMsg(m);
    if (clean) msgs.push(clean);
  }
  const out = {
    id, title: S.str(s.title, 80) || '新对话', ts: S.num(s.ts) || Date.now(),
    provider: ID_RE.test(String(s.provider || '')) ? String(s.provider) : '',
    msgs,
  };
  // 归属的项目（项目 id = lib/agent/projects.js 的 slug）：侧栏按项目分组、项目记忆跟着项目走
  const project = String(s.project || '');
  if (PROJECT_RE.test(project)) out.project = project;
  // 会话记忆：只在这一个对话里有效，随会话删除
  if (Array.isArray(s.memory) && s.memory.length) out.memory = S.memory(s.memory, 200);
  // 上下文压缩摘要：原文仍在 msgs 里，摘要只是"发出去的那份"
  const cp = s.compaction;
  if (cp && typeof cp === 'object' && typeof cp.text === 'string' && cp.text.trim()) {
    out.compaction = {
      upTo: Math.max(0, Math.min(MAX_MSGS, Math.floor(S.num(cp.upTo) || 0))),
      count: Math.max(0, Math.floor(S.num(cp.count) || 0)),
      text: cp.text.slice(0, S.MAX_LONG),
      ts: S.num(cp.ts) || Date.now(),
    };
  }
  return out;
}

const emptySessions = () => ({ version: 1, sessions: [] });

function readSessions(account) {
  const d = readJson(fileOf(account, 'sessions'), emptySessions());
  return { version: 1, sessions: Array.isArray(d.sessions) ? d.sessions : [], updatedAt: d.updatedAt };
}

/** 超出总容量时丢最旧的会话（保留刚写入的那个），返回被丢弃条数。
 *
 *  **别在循环里反复 stringify 整个库**：旧实现每次丢一条都要 `JSON.stringify(st)` 重算大小，
 *  一次请求最多能带 64MB（MAX_BODY_BYTES），压回 32MB 要丢几百条 → 几百次全库序列化。
 *  实测基准：31MB 的库单次 stringify ≈ 139ms，丢 40 条 ≈ 5.6 秒**同步** CPU——
 *  期间所有账号的请求与 SSE 全部停摆，等于一个人就能把全站按死（2026-10-01 审计）。
 *  现在：整库只算一次，之后按"每条自己的字节数"增量扣减。 */
function enforceQuota(st, keepId) {
  let dropped = 0;
  if (st.sessions.length > MAX_SESSIONS) {
    const keep = new Set([keepId].filter(Boolean));
    st.sessions.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const out = [];
    for (const s of st.sessions) {
      if (out.length < MAX_SESSIONS || keep.has(s.id)) out.push(s); else dropped++;
    }
    st.sessions = out;
  }
  let bytes = Buffer.byteLength(JSON.stringify(st));          // 整库只算这一次
  if (bytes <= MAX_SESSION_BYTES) return dropped;
  /* 按 ts 从老到新丢（跳过刚写入的那条），每丢一条就减掉它自己的字节数（+1 是数组分隔符） */
  const order = st.sessions
    .map((s, i) => ({ s, i, ts: s.ts || 0 }))
    .filter((x) => x.s.id !== keepId)
    .sort((a, b) => a.ts - b.ts);
  const out = new Set();
  let remaining = st.sessions.length;
  for (const x of order) {
    if (bytes <= MAX_SESSION_BYTES || remaining <= 1) break;   // 至少留一条（与旧行为一致）
    if (out.has(x.i)) continue;
    bytes -= Buffer.byteLength(JSON.stringify(x.s)) + 1;
    out.add(x.i);
    remaining--;
    dropped++;
  }
  if (out.size) st.sessions = st.sessions.filter((_, i) => !out.has(i));
  return dropped;
}

/** 新增/覆盖单个会话（按 id 合并）。
 *  实现直接复用 putSessions：两条路径原先是各写一遍同样的"按 id 合并 + 配额 + 落盘"，
 *  改一处忘一处就会让单条与批量写入的语义分叉（审计）。 */
async function putSession(account, session) {
  const s = sanitizeSession(session);
  if (!s) throw Object.assign(new Error('会话数据不合法'), { status: 400 });
  const r = await putSessions(account, [s]);
  return { id: s.id, sessions: r.sessions, dropped: r.dropped };
}

/** 一次写入多个会话（客户端首屏批量上传/迁移用），返回条数与丢弃数 */
async function putSessions(account, list) {
  const incoming = (Array.isArray(list) ? list : []).map(sanitizeSession).filter(Boolean);
  return withLock(account, async () => {
    const st = readSessions(account);
    const byId = new Map(st.sessions.map((s) => [s.id, s]));
    let n = 0;
    for (const s of incoming) { byId.set(s.id, s); n++; }
    st.sessions = [...byId.values()];
    const dropped = enforceQuota(st, incoming.length ? incoming[incoming.length - 1].id : '');
    await writeJson(fileOf(account, 'sessions'), st);
    return { saved: n, sessions: st.sessions.length, dropped };
  });
}

/** 取走若干会话（**归档**用）：从 sessions.json 摘掉并原样返回，调用方负责存进归档区。
 *  与 deleteSession 的区别：这个不"销毁"，只是搬家。 */
async function takeSessions(account, ids) {
  const want = new Set((Array.isArray(ids) ? ids : [ids]).map(String));
  return withLock(account, async () => {
    const st = readSessions(account);
    const taken = st.sessions.filter((s) => want.has(s.id));
    if (taken.length) {
      st.sessions = st.sessions.filter((s) => !want.has(s.id));
      await writeJson(fileOf(account, 'sessions'), st);
    }
    return taken;
  });
}

async function deleteSession(account, id) {
  if (!ID_RE.test(String(id || ''))) throw Object.assign(new Error('会话 id 不合法'), { status: 400 });
  return withLock(account, async () => {
    const st = readSessions(account);
    st.sessions = st.sessions.filter((x) => x.id !== id);
    await writeJson(fileOf(account, 'sessions'), st);
    return { sessions: st.sessions.length };
  });
}

/* ============================ 全局记忆 ============================ */

const emptyMemory = () => ({ version: 1, entries: [] });

function readMemory(account) {
  const d = readJson(fileOf(account, 'memory'), emptyMemory());
  return { version: 1, entries: Array.isArray(d.entries) ? d.entries : [], updatedAt: d.updatedAt };
}

async function putMemory(account, entries) {
  const clean = S.memory(entries, MAX_MEMORY);
  await withLock(account, () => writeJson(fileOf(account, 'memory'), { version: 1, entries: clean }));
  return { entries: clean };
}

/* ============================ 提示词登记表 ============================ */

const emptyPrompts = () => ({ version: 1, overrides: {}, skills: [], extra: [] });

function readPrompts(account) {
  const d = readJson(fileOf(account, 'prompts'), emptyPrompts());
  const clean = S.prompts(d);
  clean.version = 1;
  clean.updatedAt = d.updatedAt;
  return clean;
}

async function putPrompts(account, p) {
  const clean = S.prompts(p);
  await withLock(account, () => writeJson(fileOf(account, 'prompts'), clean));
  return clean;
}

/** 读-改-写**在锁内**完成（技能安装用）。
 *  旧写法是 `applyImport` 自己 readPrompts → 改 → putPrompts，两步之间没有锁：
 *  与"托管运行里模型写技能"并发时，两边各自基于旧快照整份覆盖，谁后写谁把对方的改动抹掉
 *  （2026-10-01 审计）。改完的回调与 settings.patch 同形状：拿到当前值、返回新的。 */
async function updatePrompts(account, fn) {
  return withLock(account, async () => {
    const cur = readPrompts(account);
    const next = S.prompts((await fn(cur)) || cur);
    await writeJson(fileOf(account, 'prompts'), next);
    return next;
  });
}

module.exports = {
  ROOT, dirOf,
  readSessions, putSession, putSessions, takeSessions, deleteSession,
  readMemory, putMemory,
  readPrompts, putPrompts, updatePrompts,
  readJson, writeJson, withLock, sanitizeSession,
  readAgentJson, SMALL_BODY_BYTES,
  MAX_SESSIONS, MAX_SESSION_BYTES, MAX_MEMORY, MAX_BODY_BYTES,
};
