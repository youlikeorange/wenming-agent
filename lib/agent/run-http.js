/** lib/agent/run-http.js —— 托管运行的 HTTP 端点（/agent/run/*）
 *
 *    POST /agent/run/start    { sessionId, text, providerId?, history? } → { ok, runId }
 *    GET  /agent/run/events   ?id=<runId>   → SSE：回放已发生的事件，然后续播；**断开不影响运行**
 *    GET  /agent/run/state    ?sessionId=   → { ok, run|null, busy|null }
 *    POST /agent/run/stop     { id }
 *    POST /agent/run/confirm  { id, confirmId, ok, remember, grant }
 *
 *  这些端点与其它 /agent/* 一样要求登录、并在单窗口互斥之内（见 index.js 的 guard）——
 *  但**运行本体不受窗口影响**：一旦 start 成功，循环就在服务端跑，浏览器关掉、断网、
 *  换窗口都只是"少了一个观众"，不会中断。
 */
const { json, readJson } = require('../http');
const { MAX_BODY_BYTES } = require('./store');
const run = require('./run');

async function body(req) {
  try { return await readJson(req, MAX_BODY_BYTES); } catch { return null; }
}

async function handleRun(req, url, res, account, actor) {
  const tail = url.pathname.slice('/agent/run'.length);

  if (tail === '/events' && req.method === 'GET') {
    const id = url.searchParams.get('id') || '';
    /* attach 内部按 account 取 run：别人的运行一律当作"不存在"（404），
       既不确认它存在、也不回放它的内容（2026-10-01 审计的 P0）。 */
    if (!run.attach(id, res, account)) {
      return json(res, 404, { ok: false, error: '运行不存在或已结束（刷新页面看落盘的结果）' });
    }
    return undefined;                  // SSE：响应由 attach 接管
  }

  if (tail === '/state' && req.method === 'GET') {
    const sessionId = url.searchParams.get('sessionId') || '';
    /* busy 只回**本账号**那一段：原先不带过滤，任何登录用户都能从这里拿到别人的
       runId/标题，再去订阅它的事件流（跨账号信息泄露 + 冒名确认）。 */
    return json(res, 200, { ok: true, run: sessionId ? run.stateOf(account, sessionId) : null, busy: run.busyOf(account) });
  }

  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' });
  const b = await body(req);
  if (b === null) return json(res, 400, { ok: false, error: 'invalid json' });

  if (tail === '/start') {
    try {
      const out = await run.startRun({
        account, actor,
        sessionId: String(b.sessionId || ''),
        text: String(b.text || ''),
        providerId: b.providerId ? String(b.providerId) : '',
        history: Array.isArray(b.history) ? b.history : undefined,
        localEdits: !!b.localEdits,        // 本地还有没落盘的编辑 → 历史以客户端那份为准
      });
      return json(res, 200, { ok: true, ...out });
    } catch (e) {
      return json(res, e.status || 500, { ok: false, error: e.message || '启动失败', busy: !!run.busy() });
    }
  }

  if (tail === '/stop') {
    const ok = run.stopRun(account, String(b.id || ''));
    return json(res, ok ? 200 : 404, { ok, error: ok ? '' : '运行不存在' });
  }

  if (tail === '/steer') {
    const ok = run.steer(account, String(b.id || ''), b.text);
    return json(res, ok ? 200 : 409, { ok, error: ok ? '' : '这一轮已经结束了（话没送出去）' });
  }

  if (tail === '/confirm') {
    const ok = run.answerConfirm(String(b.id || ''), String(b.confirmId || ''), b.ok, b.remember, b.grant, account);
    return json(res, ok ? 200 : 409, { ok, error: ok ? '' : '这个确认已经结算过了' });
  }

  return json(res, 404, { ok: false, error: 'unknown agent run endpoint' });
}

module.exports = { handleRun };
