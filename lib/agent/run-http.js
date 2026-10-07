/** lib/agent/run-http.js —— 托管运行的 HTTP 端点（/agent/run/*）
 *
 *    POST /agent/run/start    { sessionId, text, providerId?, history?, localEdits? } → { ok, runId }
 *    GET  /agent/run/events   ?id=<runId>   → SSE：回放已发生的事件，然后续播；**断开不影响运行**
 *    GET  /agent/run/hub                    → SSE：本账号**全部**运行的事件（统一口）
 *    GET  /agent/run/state    ?sessionId=   → { ok, run|null, runs:[…], busy:[…] }
 *    GET  /agent/run/subagent ?id=&sub=     → 某个子智能体的完整转录
 *    POST /agent/run/undo  { id, paths? }    → 撤销这一轮的文件改动（缺 paths = 整轮；
 *                                              给了只恢复这几个文件；日志在账号目录里，
 *                                              关掉浏览器回来也能撤；见 lib/agent/undo.js）
 *    POST /agent/run/undo/diff { id, path, entry? } → 一次改动的两侧内容（比对抽屉）
 *    POST /agent/run/stop | steer | confirm
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



/** 撤销/比对两个端点的 catch 共用：把结构化错误里"该给界面看"的字段挑出来
 *  （needUnlock/needBind/needPermission/osUser → 界面据此弹解锁框/绑定入口，
 *  而不是只显示一句报错）。undo 版多带 failed（逐文件的失败明细）。
 *  原先两处 catch 各写一份字段白名单（jscpd，2026-10-06 收敛）。 */
const errorPayload = (e, withFailed) => Object.assign({
  ok: false, error: e.message || '操作失败',
  needUnlock: !!e.needUnlock, needBind: !!e.needBind, needPermission: !!e.needPermission,
  osUser: e.osUser || '',
}, withFailed ? { failed: e.failed } : {});

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

  /* 统一事件口：一条 SSE 收这个账号全部会话的运行事件（前端的唯一订阅点）。
     同样只回本账号那几段——别人的运行不会出现在快照与事件里。 */
  if (tail === '/hub' && req.method === 'GET') {
    if (!run.attachHub(res, account)) return json(res, 401, { ok: false, error: '需要登录' });
    return undefined;                  // SSE
  }

  if (tail === '/state' && req.method === 'GET') {
    const sessionId = url.searchParams.get('sessionId') || '';
    /* busy/runs 只回**本账号**那几段：原先不带过滤，任何登录用户都能从这里拿到别人的
       runId/标题，再去订阅它的事件流（跨账号信息泄露 + 冒名确认）。 */
    const runs = run.busyOf(account);
    return json(res, 200, {
      ok: true,
      run: sessionId ? run.stateOf(account, sessionId) : null,
      runs,
      busy: runs,                      // 兼容旧字段：现在是数组（曾经的"唯一那一段"）
    });
  }

  if (tail === '/subagent' && req.method === 'GET') {
    const t = run.subAgentOf(account, url.searchParams.get('id') || '', url.searchParams.get('sub') || '');
    if (!t) return json(res, 404, { ok: false, error: '没有这个子智能体记录（运行结束后保留 10 分钟，之后看会话里的结论）' });
    return json(res, 200, { ok: true, sub: t });
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
      return json(res, e.status || 500, {
        ok: false, error: e.message || '启动失败',
        busy: run.busyOf(account),       // 界面据此知道"哪几条在跑"
      });
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

  /* 一键撤销：把这一轮的文件改动恢复原状（缺 paths = 整轮；给了 paths 只恢复这几个文件
     ——「比对修改」抽屉与撤销菜单里的"仅恢复这一个"）。日志按账号/会话/运行落在账号目录里，
     见 lib/agent/undo.js。这也是"关掉浏览器回来还能撤"的那条路——它不依赖任何内存态。 */
  if (tail === '/undo') {
    try {
      const out = await run.undoRun(account, actor, String(b.id || ''), String(b.sessionId || ''), {
        paths: Array.isArray(b.paths) ? b.paths.map(String).filter(Boolean) : undefined,
      });
      return json(res, 200, out);
    } catch (e) {
      /* needUnlock / needBind / needPermission 要**带标记**回给界面：与工具那条路同一口径，
         界面据此弹解锁框 / 绑定入口，而不是只显示一句报错（见 ui/state/run.js 的 undoRun）。 */
      return json(res, e.status || 500, errorPayload(e, true));
    }
  }

  /* 比对修改：读一次改动的两侧内容（before = 备份、after = 下一条快照或当前文件）。
     路径必须在这轮的改动日志里（见 undo.js 的 readDiff）——不是通用文件读接口。
     内容是给 diff 渲染用的文本，受 AGENT_UNDO_DIFF_CHARS 截断（二进制/目录只回元信息）。 */
  if (tail === '/undo/diff') {
    try {
      const out = await run.undoDiff(account, actor, String(b.id || ''), String(b.sessionId || ''), {
        path: String(b.path || ''),
        entry: Number.isInteger(b.entry) ? b.entry : undefined,
      });
      return json(res, 200, out);
    } catch (e) {
      return json(res, e.status || 500, errorPayload(e, false));
    }
  }

  return json(res, 404, { ok: false, error: 'unknown agent run endpoint' });
}

module.exports = { handleRun };
