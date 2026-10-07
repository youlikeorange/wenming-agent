/* protocol/sse.js —— SSE / 流式读取的底层工具（只做字节到事件，不认识任何模型厂商）
 *
 *  纯函数 + 生成器，不碰 DOM，可在 Node 下直接单测。
 *
 *  实测踩过的三处（保留修法）：
 *   ① 按"一个 data: 行一个事件"分帧会在两种完全合法的服务器行为下静默丢内容：
 *      把一条 JSON 拆成多个 data: 行（SSE 拼接语义）、用 \r\n 结尾（尾部的 \r 让 JSON.parse 失败）；
 *   ② 上游压根不用空行分隔事件（不合规范但确实存在）→ 退化成按行处理，流式不中断；
 *   ③ 上游没以空行结尾时，缓冲区里剩下的最后一帧常常正是带 stop_reason 的那一帧，必须吐出来。
 *  sseLines（OpenAI 风格）与 sseEvents（Anthropic 风格）共用同一副取帧骨架 sseBlocks()，
 *  三条兜底只写这一份（2026-10-06 审计：原先 sseEvents 没有兜底②，风险见该函数注释）。
 */

/** 空闲看门狗：流式连接长时间没有数据就中断（上游卡死时界面不会永远停在"生成中"） */
const IDLE_TIMEOUT_MS = 120000;

async function readChunk(reader, idleMs = IDLE_TIMEOUT_MS) {
  let timer = null;
  const idle = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`上游 ${Math.round(idleMs / 1000)} 秒没有返回数据，已中断（可点「停止」后重试）`)), idleMs);
  });
  try { return await Promise.race([reader.read(), idle]); }
  finally { if (timer) clearTimeout(timer); }
}

/* 注：这里原有 fetchGuarded()（自己 fetch + 首字节超时 + abort 转发，C2 修的就是它）。
   2026-10-01 取数归口：模型流量也走 core/http.js 的 request()（raw=true 拿原始 Response），
   于是窗口标识头 X-Agent-Client、超时、abort 转发、错误分类只有一份实现——旧实现自己 fetch，
   漏掉了那个头（单窗口互斥在模型流量这条路上失效）。首字节超时随实现搬到
   protocol/transport.js 的 FIRST_BYTE_TIMEOUT_MS（它只对模型流量有意义）。
   本文件从此只做"字节 → SSE 事件"，不认识 http。 */

/** 把缓冲区切出完整的 SSE 事件块（块之间以空行分隔；兼容 \r\n\r\n） */
function takeSseBlocks(buf) {
  const blocks = [];
  const re = /\r?\n\r?\n/;
  let m;
  while ((m = re.exec(buf))) {
    blocks.push(buf.slice(0, m.index));
    buf = buf.slice(m.index + m[0].length);
  }
  return [blocks, buf];
}

/** 从事件块里取 data（SSE 规范：多个 data: 行以 \n 拼接，且只去掉一个前导空格） */
function blockData(block) {
  let data = '';
  for (const raw of String(block).split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.startsWith('data:')) continue;
    data += (data ? '\n' : '') + line.slice(5).replace(/^ /, '');
  }
  return data;
}

/** 两套 SSE 读取**共用**的取帧骨架：把响应流切成"事件块"逐块吐出。
 *  三条实测兜底都在这里：① 空行分帧兼容 \r\n；② 上游不用空行分隔 → 退化按行（流式不中断）；
 *  ③ 流末尾剩下的最后一帧照样吐（常常正是带 stop_reason 的那一帧）。
 *  消费方 return / 抛错时，finally 会 cancel 读端（空闲超时 / 用户停止时尤其重要：不 cancel 连接一直挂着）。 */
async function* sseBlocks(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await readChunk(reader);
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const [blocks, rest] = takeSseBlocks(buf);
      const hadBlock = blocks.length > 0;
      buf = rest;
      for (const block of blocks) yield block;
      if (!hadBlock && buf.includes('\n')) {
        // 兜底②：上游不用空行分隔事件。退化成按行处理，流式不中断。
        const parts = buf.split('\n');
        buf = parts.pop();
        for (const raw of parts) yield raw;
      }
    }
    // 兜底③：收尾——剩下的最后一帧照样吐出来
    if (buf.trim()) yield buf;
  } finally {
    try { reader.cancel().catch(() => {}); } catch { /* 已断开 */ }
  }
}

/** 逐条 data 载荷（OpenAI 风格：每块一个 JSON，[DONE] 结束）
 *  @param {{sawDone?: boolean}} [meta] 结束时回填"这条流见过 `[DONE]` 吗"——
 *         协议适配器据此判断上游是**正常收尾**还是**半路被掐断**（2026-10-03 加）。 */
export async function* sseLines(res, meta) {
  const markDone = () => { if (meta) meta.sawDone = true; };
  for await (const block of sseBlocks(res)) {
    const d = blockData(block);
    if (!d) continue;
    if (d.trim() === '[DONE]') { markDone(); return; }
    yield d;
  }
}

/** 带事件名的 SSE（Anthropic 风格：event: xxx + data: {...}）。
 *  与 sseLines 共用骨架（2026-10-06 审计：旧实现缺兜底②——Anthropic 风格上游若不按空行分帧，
 *  整条流会被攒成一个 data 串、JSON.parse 全失败、整轮事件静默丢）。 */
export async function* sseEvents(res) {
  const parse = (block) => {
    let event = '';
    for (const raw of String(block).split('\n')) {
      const line = raw.replace(/\r$/, '');
      if (line.startsWith('event:')) event = line.slice(6).trim();
    }
    return { event, data: blockData(block) };
  };
  for await (const block of sseBlocks(res)) {
    const ev = parse(block);
    if (ev.data) yield ev;
  }
}

/** 各家对"输出被 token 上限截断"的叫法不同，统一成 'length'（截断保护据此判断） */
export const stopReason = (r) => ((r === 'length' || r === 'max_tokens' || r === 'max_output_tokens') ? 'length' : (r || ''));

/** 解析工具参数。**失败时不静默给 {}**：旧实现把"JSON 没拼完"与"工具本来就不要参数"
 *  混成同一种结果，Agent 侧分辨不出截断，于是照着空参数去执行。挂一个 __badArgs 标记，
 *  截断保护据此识别并回绝；参数内容仍保底是对象。 */
export function safeJson(s) {
  if (!s) return {};
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); }
  catch {
    const raw = String(s);
    return { __badArgs: true, __raw: raw.length > 200 ? raw.slice(0, 200) + '…' : raw };
  }
}
