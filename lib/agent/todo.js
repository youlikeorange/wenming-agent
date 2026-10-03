/** lib/agent/todo.js —— 任务清单（agent 自己维护的一份 todo；面板右上角悬浮显示）
 *
 *  规则（产品定的）：
 *    · **同时只有一份**清单（全量覆盖，不并存多份）；
 *    · agent **自行决定**要不要生成——它调 `todo_write` 才有，不调就没有；
 *    · agent 用它**修改**同一份清单（全量覆盖式更新）；
 *    · **全部完成即丢弃**：写进来一项不落全是 completed 时，服务端直接清掉（界面随之消失）。
 *
 *  存储：`STATE_DIR/agent/<账号>/todo/<会话id>.json`（**一条会话一份**）。
 *  为什么按会话而不是按项目：todo 是"这段工作"的清单，会话就是这段工作的边界；
 *  同一个项目下可能同时开着几条会话各干各的，共用一份会互相覆盖。
 *
 *  「完成时间」由服务端记（拿新清单和上一版按 **text** 对齐：新变成 completed 的项打
 *  `completedAt`，原先就完成的沿用旧时间），不信任模型传的时间——模型只给 text 与 status。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { AGENT_ROOT, accountDir } = require('../paths');
const { atomicWriteJson } = require('../state');
const S = require('./sanitize');

/** 上限（数据保留类，刻意不上面板；环境变量可调） */
const MAX_ITEMS = Number(process.env.AGENT_TODO_MAX_ITEMS) || 30;
const MAX_TEXT = Number(process.env.AGENT_TODO_MAX_TEXT) || 300;
/** 每个账号最多保留多少份清单（写新的时候顺手清最旧的；按会话数决定量级，通常远到不了） */
const MAX_FILES = Number(process.env.AGENT_TODO_MAX_FILES) || 200;

/* ============================ 路径 ============================ */

const todoRoot = (account) => {
  const d = accountDir(AGENT_ROOT, account);
  return d ? path.join(d, 'todo') : null;
};
const fileFor = (account, sessionId) => {
  const root = todoRoot(account);
  return root && S.ID_RE.test(String(sessionId || '')) ? path.join(root, `${sessionId}.json`) : null;
};

/* ============================ 读 ============================ */

/** 读一份清单（没有/读不动 → null；坏文件按"没有"处理，不让它挡住主流程） */
function read(account, sessionId) {
  const file = fileFor(account, sessionId);
  if (!file) return null;
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!d || !Array.isArray(d.items) || !d.items.length) return null;
    return {
      version: 1, sessionId: String(d.sessionId || sessionId),
      createdAt: Number(d.createdAt) || 0, updatedAt: Number(d.updatedAt) || 0,
      items: d.items.filter((i) => i && i.text).map((i) => {
        const rec = { text: String(i.text).slice(0, MAX_TEXT), status: i.status === 'completed' ? 'completed' : 'pending' };
        if (rec.status === 'completed' && i.completedAt) rec.completedAt = Number(i.completedAt) || 0;
        return rec;
      }),
    };
  } catch { return null; }
}

/** 交给界面/模型的一份摘要（带计数，省得两边各算一遍） */
function view(todo) {
  if (!todo) return null;
  const done = todo.items.filter((i) => i.status === 'completed').length;
  return {
    sessionId: todo.sessionId, createdAt: todo.createdAt, updatedAt: todo.updatedAt,
    items: todo.items, total: todo.items.length, done,
  };
}

/* ============================ 写（全量覆盖） ============================ */

/** 规整模型给的清单：非空 text、去重（同文只留第一条）、status 只认两档、条数与字数封顶 */
function normalize(items) {
  if (!Array.isArray(items)) {
    throw Object.assign(new Error('items 必须是数组（整份清单，全量覆盖）'), { status: 400 });
  }
  if (items.length > MAX_ITEMS) {
    throw Object.assign(new Error(`清单最多 ${MAX_ITEMS} 项（当前 ${items.length} 项）——别把每一步都拆成一项`), { status: 400 });
  }
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const text = String((it && it.text) || '').trim().slice(0, MAX_TEXT);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push({ text, status: it && it.status === 'completed' ? 'completed' : 'pending' });
  }
  return out;
}

async function save(account, sessionId, todo) {
  const file = fileFor(account, sessionId);
  if (!file) throw Object.assign(new Error('会话 id 不合法'), { status: 400 });
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await atomicWriteJson(file, todo, 2);
  prune(account).catch(() => {});
}

/**
 * 写整份清单（agent 的唯一入口）。
 * 全部完成 → **丢弃**（删除文件）并把 `todo: null` 回给调用方；空清单同样视为丢弃。
 * @returns {{todo: object|null, dropped: boolean, total: number, done: number}}
 */
async function write(account, sessionId, items) {
  const list = normalize(items);
  const prev = read(account, sessionId);
  const prevAt = new Map(((prev && prev.items) || []).map((i) => [i.text, i.completedAt || 0]));
  const now = Date.now();
  let done = 0;
  const next = list.map((i) => {
    const rec = { text: i.text, status: i.status };
    if (i.status === 'completed') {
      rec.completedAt = prevAt.get(i.text) || now;   // 原先完成过 → 沿用旧时间；这次刚完成 → 记现在
      done++;
    }
    return rec;
  });
  /* 没有待办项 = 这份清单没有存在意义：显式清空与"全完成"都按丢弃处理 */
  if (!list.length || done === list.length) {
    await drop(account, sessionId);
    return { todo: null, dropped: true, total: list.length, done };
  }
  const todo = {
    version: 1, sessionId: String(sessionId),
    createdAt: (prev && prev.createdAt) || now, updatedAt: now, items: next,
  };
  await save(account, sessionId, todo);
  return { todo: view(todo), dropped: false, total: next.length, done };
}

/** 丢弃（删除文件）：全完成时的自动丢弃、显式清空、会话被彻底删除时都走它 */
async function drop(account, sessionId) {
  const file = fileFor(account, sessionId);
  if (!file) return false;
  const existed = fs.existsSync(file);
  await fsp.rm(file, { force: true }).catch(() => {});
  return existed;
}

/** 账号内清理：只留最近 MAX_FILES 份（按 updatedAt/文件 mtime 排；读不动的也算旧的） */
async function prune(account) {
  const root = todoRoot(account);
  if (!root) return;
  const rows = [];
  for (const e of await fsp.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    const p = path.join(root, e.name);
    const st = await fsp.stat(p).catch(() => null);
    rows.push({ p, ts: st ? st.mtimeMs : 0 });
  }
  if (rows.length <= MAX_FILES) return;
  rows.sort((a, b) => b.ts - a.ts);
  for (const r of rows.slice(MAX_FILES)) await fsp.rm(r.p, { force: true }).catch(() => {});
}

/* ============================ 工具入口 ============================ */

/** 从运行上下文取会话 id：托管运行在 ctx.run 里，HTTP 直调由前端在 body 里带 */
const sessionOf = (ctx) => String((ctx && (ctx.sessionId || (ctx.run && ctx.run.sessionId))) || '');

/**
 * `todo_write` 工具的执行体（注册在 tools/index.js 的 TOOLS 里）。
 * 返回 `{ text, note, todo }`——todo 为 null 表示"已丢弃"，
 * 它会经内核 asResult 与 run-loop 的 tool_end 事件一路传到界面（右上角浮层）。
 */
async function writeTool(actor, args, ctx) {
  const sessionId = sessionOf(ctx);
  if (!sessionId) {
    throw Object.assign(new Error('当前没有会话上下文：任务清单要挂在一条对话上'), { status: 400 });
  }
  const out = await write(actor.account, sessionId, args && args.items);
  if (out.dropped) {
    return {
      ok: true, note: '清单已清空',
      text: out.total ? `清单里 ${out.total} 项全部完成，已丢弃（界面上不再显示）。` : '清单已清空。',
      todo: null,
    };
  }
  const lines = out.todo.items.map((i) => `${i.status === 'completed' ? '[x]' : '[ ]'} ${i.text}`).join('\n');
  return {
    ok: true, note: `清单 ${out.done}/${out.total}`,
    text: `已更新任务清单（${out.done}/${out.total} 完成）：\n${lines}`,
    todo: out.todo,
  };
}

/* ============================ HTTP：GET /agent/todo ============================ */

/** 界面取当前会话的清单（刷新/切会话/换窗口）。只读，账号隔离由调用方保证。 */
async function handleTodo(req, url, res, account) {
  const json = require('../http').json;
  if (req.method !== 'GET') return json(res, 404, { ok: false, error: 'unknown todo endpoint' });
  const sessionId = String(url.searchParams.get('sessionId') || '');
  if (!S.ID_RE.test(sessionId)) return json(res, 400, { ok: false, error: '缺少或非法的 sessionId' });
  return json(res, 200, { ok: true, todo: view(read(account, sessionId)) });
}

module.exports = { read, write, drop, view, writeTool, handleTodo, MAX_ITEMS };
