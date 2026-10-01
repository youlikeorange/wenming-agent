/* protocol/think.js —— 把正文里的 <think>…</think> 拆到思考通道
 *
 *  为什么需要：不是所有上游都会把思考过程单独放在 reasoning 字段里。实测（qwen3.8 走
 *  OpenAI 兼容端点、未下发思考参数）它会**把 <think> 原文写进 content**，
 *  界面上表现为"思考面板空着、<think> 标签漏在回答气泡里"。
 *  标签跨 chunk 会被正确拼接（保留最多 tag 长度-1 的尾巴）。
 *
 *  纯状态机，无副作用，可单测。
 */
const OPEN = '<think>';
const CLOSE = '</think>';

export function thinkSplitter() {
  let buf = '', inThink = false;
  const step = (final) => {
    const out = [];
    for (;;) {
      if (!inThink) {
        const i = buf.indexOf(OPEN);
        if (i === -1) {
          if (final) { if (buf) out.push({ type: 'content', text: buf }); buf = ''; return out; }
          const keep = Math.min(buf.length, OPEN.length - 1);
          const cut = buf.length - keep;
          if (cut > 0) { out.push({ type: 'content', text: buf.slice(0, cut) }); buf = buf.slice(cut); }
          return out;
        }
        if (i > 0) out.push({ type: 'content', text: buf.slice(0, i) });
        buf = buf.slice(i + OPEN.length);
        inThink = true;
      } else {
        const j = buf.indexOf(CLOSE);
        if (j === -1) {
          if (final) { if (buf) out.push({ type: 'thinking', text: buf }); buf = ''; return out; }
          const keep = Math.min(buf.length, CLOSE.length - 1);
          const cut = buf.length - keep;
          if (cut > 0) { out.push({ type: 'thinking', text: buf.slice(0, cut) }); buf = buf.slice(cut); }
          return out;
        }
        if (j > 0) out.push({ type: 'thinking', text: buf.slice(0, j) });
        buf = buf.slice(j + CLOSE.length);
        inThink = false;
      }
    }
  };
  return { feed: (chunk) => { buf += chunk; return step(false); }, flush: () => step(true) };
}
