/** lib/agent/run-events.js —— 托管运行的**事件流**：记日志、回放、推送
 *
 *  事件是"已经发生的事实"的快照：调用方**先改好 run.live，再 emit**——反过来会让订阅者
 *  （以及回放）收到少一个字段的旧版本（实测：追踪条的 token 就是这么丢的）。
 *
 *  四件事：
 *    emit(run, ev)        记进 run.events（供回放）+ 推给所有挂着的 SSE 订阅者 + 推给账号事件口
 *    applyToLive(run, ev) 流式正文/思考/用量直接累加到 run.live（落盘的就是它，与界面同口径）
 *    attach(run, res)     挂一个"只看这一段运行"的订阅者：先回放，再续播
 *    hubAttach/hubDetach  挂一个"看这个账号所有运行"的订阅者（**统一事件口**）：一次连接
 *                         收全部会话的事件，前端因此不必为每条会话各开一条流
 *
 *  订阅者与运行本体的关系是**松的**：断开只是"少了一个观众"（见 run.js 的文件头）。
 */
const MAX_EVENT_CHARS = Number(process.env.AGENT_RUN_EVENT_CHARS || 8 * 1024 * 1024);
/** 日志的保留上限：超过就丢最老的（**内存有上限**）。
 *  早先只把上限用在"回放时要不要发"，事件数组本身只涨不落——一轮长回答能攒出几十 MB，
 *  而这段时间里它们早已失去用处（客户端要么能回放，要么改读落盘的会话）。 */
const MAX_KEEP_EVENTS = Number(process.env.AGENT_RUN_KEEP_EVENTS || 20000);

const line = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

/* ============================ 统一事件口（hub） ============================ */

/** account → Set<res>：一个账号一条流，流里带着它**所有**在跑/刚跑完的运行的事件。
 *  事件的 runId/sessionId 由 emit 补上——客户端据此把事件写回"那条会话的消息"。 */
const hubs = new Map();

function hubWrite(res, obj) { try { res.write(line(obj)); } catch { /* 断了：close 里会摘掉 */ } }

/** 推给某个账号的事件口（emit 内部调；没有订阅者时什么都不做） */
function hubSend(run, rec) {
  const set = hubs.get(run.account);
  if (!set || !set.size) return;
  const tagged = Object.assign({ runId: run.id, sessionId: run.sessionId }, rec);
  for (const res of set) hubWrite(res, tagged);
}

/** 挂一个账号级订阅者：先给一份**快照**（这个账号现在有哪些在跑），再把每段运行的
 *  已发生事件回放一遍（人刷新/换设备回来 = 画面补齐），之后就是实时续播。 */
function hubAttach(account, res, runs) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });
  res.write(': hub attached\n\n');
  hubWrite(res, { type: 'hub_snapshot', runs: (runs || []).map((r) => view(r)) });
  for (const run of runs || []) replayTo(res, run);
  let set = hubs.get(account);
  if (!set) { set = new Set(); hubs.set(account, set); }
  set.add(res);
  /* 这一条流挂了之后才发生的 end 事件：到这里为止没有 end 的运行会在上面 replay 里补上。
     还没回答的确认也要重发（人回来时才看得到那几个框）。 */
  for (const run of runs || []) {
    for (const c of run.confirms.values()) {
      hubWrite(res, { type: 'confirm', runId: run.id, sessionId: run.sessionId, id: c.id, kind: c.kind, payload: c.payload });
    }
  }
  const drop = () => {
    const s = hubs.get(account);
    if (!s) return;
    s.delete(res);
    if (!s.size) hubs.delete(account);
  };
  res.on('close', drop);
  res.on('error', drop);
  return true;
}

/** 对外的运行摘要（**唯一一份**，run-registry 也从这里 import——原先两边各拼一份同形的，
 *  注释还声称"避免互相 require"，实际 registry 单向依赖本模块，根本无环。2026-10-06 收敛） */
const view = (run) => ({
  runId: run.id, sessionId: run.sessionId, title: run.title, status: run.status,
  startedAt: run.startedAt, liveId: (run.live && run.live.id) || '',
});

/** 把一段运行已经发生的事件推给**任意**订阅者（hub 回放用；标签是 runId/sessionId 而不是裸事件） */
function replayTo(res, run) {
  if (run.status !== 'running' && !run.events.length) return;
  const truncated = !!run.trimmed || run.eventChars > MAX_EVENT_CHARS;
  hubWrite(res, { type: 'replay_start', runId: run.id, sessionId: run.sessionId, liveId: view(run).liveId, truncated, status: run.status });
  if (!truncated) for (const ev of run.events) hubWrite(res, Object.assign({ runId: run.id, sessionId: run.sessionId }, ev));
  hubWrite(res, { type: 'replay_end', runId: run.id, sessionId: run.sessionId, status: run.status });
}

/** 广播一条事件：进日志（供回放）、推给本运行的订阅者、推给账号事件口 */
function emit(run, ev) {
  const rec = Object.assign({ t: Date.now() - run.startedAt }, ev);
  run.events.push(rec);
  run.eventChars += JSON.stringify(rec).length;
  /* 超上限就从最老的开始丢（保留尾部窗口），并记下"已经截断"——
     attach 据此告诉客户端"别指望事件流能补齐，直接读落盘的会话"。 */
  while (run.events.length > MAX_KEEP_EVENTS || run.eventChars > MAX_EVENT_CHARS) {
    const drop = run.events.shift();
    if (!drop) break;
    run.eventChars -= JSON.stringify(drop).length;
    run.trimmed = true;
  }
  const text = line(rec);
  for (const res of run.clients) {
    try { res.write(text); } catch { /* 断了：close 事件里会摘掉 */ }
  }
  hubSend(run, rec);
}

/** 流式正文/思考/用量：直接累加到 run.live（落盘的就是它，与界面口径一致）。
 *  live_reset：调用保护中断重调时清掉本次尝试已流出的半截正文/思考——
 *  重调从零重新生成，不清的话 live 里新旧两份叠加（重复文本）。 */
function applyToLive(run, ev) {
  const live = run.live;
  if (!live) return;
  if (ev.type === 'content') live.content = (live.content || '') + ev.text;
  else if (ev.type === 'thinking') live.thinking = (live.thinking || '') + ev.text;
  else if (ev.type === 'stats') live.stats = ev.raw;
  else if (ev.type === 'live_reset') { live.content = ''; live.thinking = ''; }
}

/** 登记表/记忆被模型改了：给界面一条"数据变了"的提示（面板内容由客户端自己重拉） */
function notifyUi(run) { emit(run, { type: 'data_changed' }); }

/** 挂一个 SSE 订阅者：先回放已发生的事件（人走开再回来 = 画面补齐），再续播 */
function attach(run, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',          // 隧道/反代下也不要缓冲
    Connection: 'keep-alive',
  });
  res.write(': attached\n\n');
  const truncated = !!run.trimmed || run.eventChars > MAX_EVENT_CHARS;
  /* liveId 一起给出去：客户端据此把事件写进**服务端那条**助手消息（多会话并行时
     每条会话各有一条正在生成的消息，靠 id 才能认准是哪一条）。 */
  res.write(line({ type: 'replay_start', truncated, status: run.status, liveId: (run.live && run.live.id) || '' }));
  if (!truncated) for (const ev of run.events) res.write(line(ev));
  res.write(line({ type: 'replay_end', status: run.status }));
  run.clients.add(res);
  // 人回来了：把还没回答的确认重发一遍（不然它会一直等到超时）
  for (const c of run.confirms.values()) {
    res.write(line({ type: 'confirm', id: c.id, kind: c.kind, payload: c.payload }));
  }
  const drop = () => { run.clients.delete(res); };
  res.on('close', drop);
  res.on('error', drop);
  if (run.status !== 'running') { try { res.end(); } catch { /* 已断 */ } }
  return true;
}

module.exports = { emit, applyToLive, notifyUi, attach, hubAttach, view };
