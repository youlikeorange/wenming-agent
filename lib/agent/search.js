/** lib/agent/search.js —— 服务端联网搜索（AnySearch CLI，Key 不下发前端）
 *
 *  POST /agent/search { query, max_results } → { ok, markdown }
 *  为什么放服务端：① 浏览器侧 CSP 是 connect-src 'self'，直连不了独立的搜索代理；
 *  ② 搜索 API Key 必须留在服务端；③ 未登录不给用（搜索消耗服务端配额）。
 */
const { execFile } = require('child_process');
const { json } = require('../http');
const { makeGate } = require('./limits');

const ANYSEARCH_CLI = process.env.ANYSEARCH_CLI || '/home/leo/.agents/skills/anysearch/scripts/anysearch_cli.py';
const ANYSEARCH_PYTHON = process.env.ANYSEARCH_PYTHON || 'python3';
const SEARCH_TIMEOUT_MS = Number(process.env.SEARCH_TIMEOUT_MS || 60000);
const MAX_SEARCH_OUTPUT = 4 * 1024 * 1024;
const MAX_BODY = 64 * 1024;
/* 并发 / 频率闸门：搜索每次都要拉起一个 python 进程（最长 60 秒），
   不限并发的话一个登录用户就能把站点拖死（2026-10-01 审计）。 */
const gate = makeGate({
  maxConcurrent: Number(process.env.SEARCH_MAX_CONCURRENT || 4),
  perMinute: Number(process.env.SEARCH_PER_MINUTE || 30),
});

/** 真正执行搜索（服务端托管运行也用它，避免第二份实现）。
 *  返回 { ok, markdown } 或 { ok:false, error }——HTTP 处理器与进程内调用共用同一个结果形状。
 *  @param {string} [account] 限频键（按账号计数）；不传则按 'anon' 计（托管运行总会传） */
function runSearch(query, n, account) {
  const q = String(query || '').trim();
  if (!q) return Promise.resolve({ ok: false, error: 'query 不能为空' });
  const max = Math.max(1, Math.min(10, Number(n) || 5));
  return gate.run(String(account || 'anon'), () => new Promise((resolve) => {
    execFile(ANYSEARCH_PYTHON, [ANYSEARCH_CLI, 'search', q, '--max_results', String(max)],
      { timeout: SEARCH_TIMEOUT_MS, maxBuffer: MAX_SEARCH_OUTPUT, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || err.message || '').trim().slice(0, 300);
          return resolve({ ok: false, error: err.killed ? '搜索超时' : ('搜索失败: ' + detail) });
        }
        return resolve({ ok: true, markdown: stdout });
      });
  })).then((r) => {
    /* 闸门拒了（超出频率 / 排队过长）：形状与"搜索失败"一致，调用方不用多认一种返回 */
    if (r && r.ok === false && r.reason) {
      return { ok: false, error: r.reason === 'rate' ? '搜索太频繁了，请稍后再试' : '搜索排队已满，请稍后再试' };
    }
    return r;
  });
}

function handleSearch(req, res, account) {
  /* 与 lib/http.js 的 readBody 同一条铁律：先收 Buffer 再整体解码。
     `raw += chunk` 会按 chunk 各自 toString('utf8')，搜索词里的中文若正好跨 chunk 边界
     就变成 U+FFFD，搜出来的是另一个词。上限同理按字节算。 */
  const chunks = [];
  let size = 0;
  let tooBig = false;
  const reply = (code, obj) => { if (!res.writableEnded && !res.destroyed) json(res, code, obj); };
  req.on('data', (c) => {
    const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
    chunks.push(buf);
    size += buf.length;
    if (size > MAX_BODY && !tooBig) {
      tooBig = true;
      // 必须**当场**回 413：req.destroy() 之后 'end' 不会再来，等它等于永远不回包
      reply(413, { ok: false, error: '请求体过大' });
      req.destroy();
    }
  });
  req.on('error', () => { /* 客户端中断，无需响应 */ });
  req.on('end', () => {
    if (tooBig) return;
    const raw = Buffer.concat(chunks).toString('utf8');
    let body;
    try { body = JSON.parse(raw || '{}'); } catch { return reply(400, { ok: false, error: 'invalid json' }); }
    if (!String(body.query || '').trim()) return reply(400, { ok: false, error: 'query 不能为空' });
    runSearch(body.query, body.max_results, account).then((r) => reply(r.ok ? 200 : 502, r));
  });
}

module.exports = { handleSearch, runSearch, ANYSEARCH_CLI, gate };
