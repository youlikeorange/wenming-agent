/* protocol/textcalls.js —— 把"写成正文的工具调用"认回来（正文 → 结构化 tool_calls）
 *
 *  为什么需要：不是所有上游都会把工具调用放进 delta.tool_calls。实测过的三种泄漏形态：
 *    ① DeepSeek V4 系列的 DSML 标记（DeepSeek Markup Language）——
 *       规范写法是「小于号 + 全角竖线 ｜ + DSML + 全角竖线 ｜ + tool_calls + 大于号」包住
 *       invoke / parameter 块；上游解析器在长上下文、或模型漏掉起始标记时会把整块**当正文返回**
 *       （vllm-project/vllm#48931、deepseek-ai 模型仓库 discussion #209 记的就是这个）。
 *       还有退化写法：竖线变成两个半角 |，各标签之间也没有换行。
 *    ② 少数实现把工具调用写成 XML（tool_call / function= / parameter=），同样漏进正文。
 *    ③ 一旦漏进正文，Agent 侧看不到 tool_calls → 把整块当"最终回答"收尾退出循环，
 *       用户那边既看到一串标记、又发现模型"没干活"。
 *
 *  本模块是**纯状态机**（不依赖 DOM、不读全局），流式安全：
 *    · 只在看到**完整**的调用块后才产出 tool_calls —— 正文里"提到"这些标记不会被误当调用；
 *    · 标记可能跨 chunk 被切开（分词后很常见），未闭合时把尾巴留在缓冲里继续等；
 *    · 块一直不闭合且已超长（模型在写文件内容中途断了）→ 原样吐回正文，绝不静默吞内容；
 *    · 解析不出调用的块同样原样吐回正文（宁可显示得难看，也不能丢内容）。
 *
 *  产出事件与协议适配器同一套：{ type:'content', text } / { type:'tool_calls', calls, recovered:true }
 */

/* 标签的字符拼装：全部用转义写，源码里不出现任何"标签形态"的字面量——
   这类字面量在编辑/粘贴/工具链里被规范化、被截断过一次，解析器就再也认不出来了。 */
const LT = '\u003c';                                       // 小于号
const GT = '\u003e';                                       // 大于号
const SLASH = '\\s*\\/\\s*';                               // 闭合标签里的斜杠（容忍空白）
const BARS = '(?:\\uff5c|\\|)\\s*(?:\\uff5c|\\|)?';         // 一或两个竖线（全角 ｜ / 半角 |，容忍空白）
/** DSML 标签：小于号 + [斜杠] + 竖线 DSML 竖线 + 名字 + [属性] + 大于号。
 *  属性用**非贪婪**取——属性后面紧跟的就是大于号；贪婪写法在"属性后没有大于号"的
 *  残缺形态下会把参数值一起吞掉（实测踩过）。 */
const dsml = (name, attrs) => LT + '(' + SLASH + ')?\\s*' + BARS + '\\s*DSML\\s*' + BARS + '\\s*'
  + name + '(?![\\w-])' + (attrs ? '(\\s*[^' + GT + ']*?)?\\s*' : '\\s*') + GT;
/** XML 形态的标签（第 ② 种泄漏）：属性可能是空格分隔的 name="…"，也可能是旧写法的 ="值" 简写。
 *  名字后面加个"不是单词字符"的前瞻——否则 `function_calls` 会被当成 `function` 标签吃掉。 */
const xml = (name, attrs) => LT + '(' + SLASH + ')?\\s*' + name + '(?![\\w-])' + (attrs ? '(\\s*[^' + GT + ']*?)?\\s*' : '\\s*') + GT;

const SRC = {
  dsmlWrapper: dsml('tool_calls'),
  dsmlInvoke: dsml('invoke', true),
  dsmlParam: dsml('parameter', true),
  xmlCall: xml('tool_call'),
  xmlCalls: xml('function_calls'),
  xmlFn: xml('function', true),
  xmlParam: xml('parameter', true),
};
const NAME_ATTR = /(?:^|\s)name\s*=\s*"([^"]*)"/;
const STRING_ATTR = /(?:^|\s)string\s*=\s*"([^"]*)"/;
const FN_ATTR = /(?:^|\s)function\s*=\s*"([^"]*)"/;
const PARAM_ATTR = /(?:^|\s)parameter\s*=\s*"([^"]*)"/;
/** 旧写法的 ="值" 简写：标签名本身就是键（`<function="名字">` / `<parameter="键">`） */
const SHORT_ATTR = /^=\s*"([^"]*)"/;

/** 一个块最多等多大（没闭合又超过它 = 模型写到一半断了，原样吐回正文） */
const MAX_BLOCK_CHARS = 4 * 1024 * 1024;
/** 正文模式下最多留多少个字符等标记拼完 */
const MAX_HOLD = 96;

/** 编译一次，重复使用（每次 exec 前重置 lastIndex） */
const RX = {};
for (const [k, src] of Object.entries(SRC)) RX[k] = new RegExp(src, 'g');

/** 在 s 的 [from, …] 里找闭合标签的位置（找不到返回 -1） */
function closeAt(rx, s, from) {
  rx.lastIndex = from;
  let m;
  while ((m = rx.exec(s))) {
    if (m[1]) return m.index;                    // 捕获组 1 命中 = 这是闭合标签
    rx.lastIndex = m.index + 1;                  // 开标签：跳过继续找
  }
  return -1;
}

/** 正文流里的"开标记"：取最先出现的一个 */
const OPENS = [
  { tag: 'dsmlWrapper', rx: () => RX.dsmlWrapper },
  { tag: 'dsmlInvoke', rx: () => RX.dsmlInvoke },
  { tag: 'xmlCall', rx: () => RX.xmlCall },
  { tag: 'xmlCalls', rx: () => RX.xmlCalls },
  { tag: 'xmlFn', rx: () => RX.xmlFn },
];
function firstOpen(s) {
  let best = null;
  for (const o of OPENS) {
    const rx = o.rx();
    rx.lastIndex = 0;
    const m = rx.exec(s);
    if (!m || m[1]) continue;                    // 闭合标签不是开标记
    if (!best || m.index < best.index) best = { tag: o.tag, index: m.index, end: m.index + m[0].length, m };
  }
  return best;
}
/** 开标记 tag → 它该等的闭合标签 */
const CLOSE_OF = {
  dsmlWrapper: () => RX.dsmlWrapper,
  dsmlInvoke: () => RX.dsmlInvoke,
  xmlCall: () => RX.xmlCall,
  xmlCalls: () => RX.xmlCalls,
  xmlFn: () => RX.xmlFn,
};

/** 参数值解码：string="true" 原样（只去掉转义引号那种 JSON 字符串壳）；否则试 JSON，失败保底字符串 */
function decodeValue(raw, isString) {
  let v = String(raw == null ? '' : raw);
  v = v.replace(/^\s*\n/, '').replace(/\s+$/, '');
  if (isString) {
    if (/^"[\s\S]*"$/.test(v)) { try { v = JSON.parse(v); } catch { /* 保留原文 */ } }
    return v;
  }
  const t = v.trim();
  if (!t) return '';
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === 'true' || t === 'false') return t === 'true';
  if (t === 'null') return null;
  if (/^[[{]/.test(t)) { try { return JSON.parse(t); } catch { /* 保底字符串 */ } }
  return v;
}

/** 把 { name, arguments } 归一成内部调用对象 */
let seq = 0;
function makeCall(name, args) {
  const nm = String(name || '').trim();
  if (!nm) return null;
  let a = args;
  // 有的实现把参数整体包成 {"arguments": {…}} / {"input": {…}}
  if (a && typeof a === 'object' && !Array.isArray(a)) {
    const keys = Object.keys(a);
    const inner = a.arguments !== undefined ? a.arguments : a.input;
    if (keys.length === 1 && inner && typeof inner === 'object' && !Array.isArray(inner)) a = inner;
  }
  return { id: 'text_' + (++seq) + '_' + Date.now().toString(36), name: nm, args: (a && typeof a === 'object') ? a : {} };
}

/** 参数段（invoke/function 的 body）→ 参数对象 */
function parseParams(body) {
  const args = {};
  let found = false;
  const pRe = new RegExp('(?:' + RX.dsmlParam.source + ')|(?:' + RX.xmlParam.source + ')', 'g');
  let pm;
  while ((pm = pRe.exec(body))) {
    if (pm[1] || pm[3]) continue;                         // 闭合标签（两条分支的斜杠各占一个组）
    const attrs = pm[2] != null ? pm[2] : (pm[4] || '');  // 两条分支的属性各占一个组
    const key = (NAME_ATTR.exec(attrs) || PARAM_ATTR.exec(attrs) || SHORT_ATTR.exec(String(attrs).trim()) || [])[1];
    const from = pm.index + pm[0].length;
    // 参数体：到下一个 parameter 标签（开或闭）为止；退化写法（没有闭合标签）也能切对
    pRe.lastIndex = from;
    const nx = pRe.exec(body);
    const stop = nx ? nx.index : body.length;
    pRe.lastIndex = from;
    if (!key) continue;
    found = true;
    const isStr = /true/i.test((STRING_ATTR.exec(attrs) || [])[1] || '');
    args[key] = decodeValue(body.slice(from, stop), isStr);
  }
  return found ? args : null;
}

/** DSML 形态：块里可能并排多个 invoke */
function parseDsmlBlock(block) {
  const calls = [];
  RX.dsmlInvoke.lastIndex = 0;
  let m;
  while ((m = RX.dsmlInvoke.exec(block))) {
    if (m[1]) continue;
    const from = m.index + m[0].length;
    const close = closeAt(RX.dsmlInvoke, block, from);
    const stop = close === -1 ? block.length : close;
    const name = (NAME_ATTR.exec(m[2] || '') || [])[1];
    const args = parseParams(block.slice(from, stop));
    const c = makeCall(name, args === null && /^\s*[[{]/.test(block.slice(from, stop)) ? jsonOrEmpty(block.slice(from, stop)) : (args || {}));
    if (c) calls.push(c);
    RX.dsmlInvoke.lastIndex = stop;
  }
  return calls;
}

/** 块里没有 parameter 时，body 本身可能就是一段 JSON。
 *  注意**不要**和 sse.js 导出的 safeJson 混用：那个把解析失败标成 `__badArgs`（给内核看"参数被截断"），
 *  这里只想要"解析不出来就当空参数"。同上层的两个 safeJson 同名不同义过（审计），故改名。 */
function jsonOrEmpty(text) { try { return JSON.parse(text.trim()); } catch { return {}; } }

/** XML 形态：tool_call 里可能是 JSON，也可能是 function= / parameter= 结构 */
function parseXmlBlock(block) {
  const calls = [];
  // ① 包裹里直接是一段 JSON
  const stripped = block
    .replace(new RegExp(LT + '\\/?\\s*(tool_call|function_calls)\\s*' + GT, 'g'), '')
    .trim();
  if (/^[[{]/.test(stripped)) {
    try {
      const o = JSON.parse(stripped);
      for (const it of (Array.isArray(o) ? o : [o])) {
        const fn = (it && (it.function || it)) || {};
        let args = fn.arguments !== undefined ? fn.arguments : fn.args;
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
        const c = makeCall(fn.name, args);
        if (c) calls.push(c);
      }
      if (calls.length) return calls;
    } catch { /* 不是 JSON，走结构解析 */ }
  }
  // ② function="name" 里若干 parameter="k"
  RX.xmlFn.lastIndex = 0;
  let m;
  while ((m = RX.xmlFn.exec(block))) {
    if (m[1]) continue;
    const from = m.index + m[0].length;
    const close = closeAt(RX.xmlFn, block, from);
    const stop = close === -1 ? block.length : close;
    const name = (FN_ATTR.exec(m[2] || '') || SHORT_ATTR.exec(String(m[2] || '').trim()) || [])[1];
    const c = makeCall(name, parseParams(block.slice(from, stop)) || {});
    if (c) calls.push(c);
    RX.xmlFn.lastIndex = stop;
  }
  return calls;
}

/** 块 → 调用数组（认不出返回空数组，调用方原样当正文） */
export function parseCallBlock(block) {
  try {
    const calls = parseDsmlBlock(block);
    if (calls.length) return calls;
    return parseXmlBlock(block);
  } catch { return []; }
}

/**
 * 流式拆分器：feed(chunk) → 事件数组；flush() → 收尾事件。
 * 事件：{type:'content',text} | {type:'tool_calls',calls,recovered:true}
 */
export function textCallSplitter() {
  let buf = '';
  let open = null;              // 正在等的闭合标签（开标记的 tag 名）

  const step = (final) => {
    const out = [];
    for (;;) {
      if (!open) {
        const hit = firstOpen(buf);
        if (!hit) {
          if (final) { if (buf) out.push({ type: 'content', text: buf }); buf = ''; return out; }
          /* 标记可能被切在 chunk 中间：把最后一个小于号之后的尾巴留住继续等
             （留得住的长度有上限——那个小于号要是普通正文，下次 feed 就吐出来了）。 */
          const i = buf.lastIndexOf(LT);
          const cut = (i !== -1 && buf.length - i <= MAX_HOLD) ? i : buf.length;
          if (cut > 0) { out.push({ type: 'content', text: buf.slice(0, cut) }); buf = buf.slice(cut); }
          return out;
        }
        if (hit.index > 0) out.push({ type: 'content', text: buf.slice(0, hit.index) });
        buf = buf.slice(hit.index);
        open = hit.tag;
        continue;
      }
      const close = closeAt(CLOSE_OF[open](), buf, 0);
      if (close === -1) {
        if (final || buf.length > MAX_BLOCK_CHARS) {      // 没闭合：原样吐回正文，绝不吞内容
          out.push({ type: 'content', text: buf });
          buf = ''; open = null;
          return out;
        }
        return out;                                        // 继续等
      }
      /* 闭合标签按"块的种类"取：外层包裹开的等自己的闭合标签，孤儿 invoke 等 invoke 的。
         两者混用时（invoke 的闭合在外层闭合之前）不会截断错——各自只认自己的那个。 */
      const rx = CLOSE_OF[open]();
      rx.lastIndex = close;
      const cm = rx.exec(buf);
      const end = cm ? cm.index + cm[0].length : buf.length;
      const block = buf.slice(0, end);
      buf = buf.slice(end);
      open = null;
      const calls = parseCallBlock(block);
      if (calls.length) out.push({ type: 'tool_calls', calls, recovered: true });
      else out.push({ type: 'content', text: block });     // 认不出 → 原样显示
    }
  };

  return {
    feed: (chunk) => { buf += String(chunk == null ? '' : chunk); return step(false); },
    flush: () => step(true),
  };
}
