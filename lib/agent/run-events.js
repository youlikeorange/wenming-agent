/** lib/agent/run-events.js —— 托管运行的**事件流**：记日志、回放、推送
 *
 *  事件是"已经发生的事实"的快照：调用方**先改好 run.live，再 emit**——反过来会让订阅者
 *  （以及回放）收到少一个字段的旧版本（实测：追踪条的 token 就是这么丢的）。
 *
 *  三件事：
 *    emit(run, ev)        记进 run.events（供回放）+ 推给所有挂着的 SSE 订阅者
 *    applyToLive(run, ev) 流式正文/思考/用量直接累加到 run.live（落盘的就是它，与界面同口径）
 *    attach(run, res)     挂一个订阅者：先回放，再续播；人回来时把没答的确认重发一遍
 *
 *  订阅者与运行本体的关系是**松的**：断开只是"少了一个观众"（见 run.js 的文件头）。
 */
const MAX_EVENT_CHARS = Number(process.env.AGENT_RUN_EVENT_CHARS || 8 * 1024 * 1024);
/** 日志的保留上限：超过就丢最老的（**内存有上限**）。
 *  早先只把上限用在"回放时要不要发"，事件数组本身只涨不落——一轮长回答能攒出几十 MB，
 *  而这段时间里它们早已失去用处（客户端要么能回放，要么改读落盘的会话）。 */
const MAX_KEEP_EVENTS = Number(process.env.AGENT_RUN_KEEP_EVENTS || 20000);

const line = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

/** 广播一条事件：进日志（供回放）、推给所有订阅者 */
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
}

/** 流式正文/思考/用量：直接累加到 run.live（落盘的就是它，与界面口径一致） */
function applyToLive(run, ev) {
  const live = run.live;
  if (!live) return;
  if (ev.type === 'content') live.content = (live.content || '') + ev.text;
  else if (ev.type === 'thinking') live.thinking = (live.thinking || '') + ev.text;
  else if (ev.type === 'stats') live.stats = ev.raw;
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
  res.write(line({ type: 'replay_start', truncated, status: run.status }));
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

module.exports = { emit, applyToLive, notifyUi, attach, MAX_EVENT_CHARS };
