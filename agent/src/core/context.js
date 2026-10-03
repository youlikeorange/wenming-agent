/* 上下文管理：token 估算、用量、自动压缩与裁剪兜底（ESM 模块） */
/* AgentContext —— 上下文管理层：用量估算 + 压缩（Pi 的 compaction）+ 自动裁剪
 *
 *  标准 agent 都要回答一个问题："历史越滚越长，窗口装不下怎么办？"这里的答案有两层：
 *    ① 压缩（首选）：接近上限时，用提示词登记表里的 compact.prompt 让模型把较早的对话
 *       压成摘要，摘要代替原文进入请求（原文仍留在会话里，可展开查看、也可直接编辑摘要）。
 *    ② 裁剪（兜底）：压缩提示词被关掉时，从最老的对话开始成对丢弃（不产摘要）。
 *  用量环（ctxMeter）与详情弹层原先也在这里，移植时删除（见下）。
 *
 *  纯宿主依赖全部走 init 注入，实例自身不持有其它全局状态：
 *  init({ Prompts, Providers, Agent, activeProvider, buildOptions, history, curSess,
 *         persistSession, addTraceStrip, fillTraceStrip, toast,
 *         getInjectedBlocks, getActiveToolDefs, abortSignal, numCtx, toApiMsg, val2 })
 *  其中 history 是"取当前会话消息"的函数（本模块**只读**它：裁剪只作用于这一轮的请求视图，
 *  不再原地 shift —— 见下面 trimForRequest 的注释）；
 *  numCtx 与 toApiMsg 原文件头漏记，但宿主 init 一直在传（移植时补记）。
 *
 *  移植改动：删除了哪些界面渲染函数，由 agent/src/ui 的 React 组件接管；纯计算函数
 *  （estTokens/ctxLimit/ctxUsage/autoCompactOn/compactMessages/compactNow/uncompact/
 *  invalidateCompaction/compactHeader 与四个阈值常量）一枚不动。
 *  2026-10-01：`trimHistoryIfNeeded`/`trimNotice` 换成 `trimForRequest` + `transformMessages`
 *  （只裁请求视图、不动原文、真正接进 Agent 的 transformContext）；界面上的 st.trimNotice
 *  提示条随之移除——提示改走 toast → 事件流（两端同一条路）。
 *  具体删掉的是：updateCtxMeter、updateCtxMeterSoon、renderCompactNotice、renderCtxPop、
 *  toggleCtxPop，连同只服务于它们的模块内状态 popOpen / meterTimer / fmtK，以及全部
 *  宿主 DOM 查询（原 $ 注入项）；init 也不再收 $。被删函数在压缩流程里的调用点（compactMessages /
 *  compactNow / uncompact / invalidateCompaction 内的 renderCompactNotice()、
 *  updateCtxMeter()）一并移除——要在压缩后重绘界面，由 React 侧在拿到返回值后自己做。
 *
 *  **依赖与缓存（trimSent / compacting / compactCache）都在 createAgentContext() 的闭包里**：
 *  一份实例 = 一轮运行的上下文管理，于是多段运行可以并行（原先 `compacting` 是进程级重入锁、
 *  `compactCache` 只按会话对象寻址，两段并发运行会互相阻塞/复用对方的摘要，
 *  见 lib/agent/run-registry.js）。`export const AgentContext` 是给界面/单测用的默认实例。
 */

/** 造一份独立的上下文管理实例
 *  @returns 与旧模块级 AgentContext 同形 */
/* eslint-disable-next-line max-lines-per-function, max-statements -- 工厂函数装的是**整个模块体的实例**（内部结构一格没动，只是从模块级单例改成按需现造）：拆开反而让"一份实例的全部代码"散掉，见文件头的说明。 */
export function createAgentContext() {
  /** 依赖注入：宿主只需给"它知道而 core 不知道"的东西。 */
  let Prompts = null, Providers = null, Agent = null;
  let activeProvider = () => null;
  let buildOptions = () => ({});
  let history = () => [];
  let curSess = () => null;
  let persistSession = () => {};
  let addTraceStrip = () => null;
  let fillTraceStrip = () => {};
  let toast = () => {};
  let getInjectedBlocks = () => ({ blocks: [] });
  let getActiveToolDefs = () => [];
  let abortSignal = () => undefined;
  let numCtx = () => 0;
  let toApiMsg = (m) => m;
  /** 参数读取（宿主注入 core/params 的取值口径 val2Of）：可选依赖，没接时用下面的出厂默认。
   *  只用来读「结果与记录」里的内设上限（record_compact_chars），不参与协议与请求体。 */
  let val2 = () => undefined;

  /** 压缩时"单条消息最多取多少字"（面板 record_compact_chars，默认 4000） */
  const COMPACT_MSG_CHARS = 4000;
  const compactCap = () => {
    const n = Number(val2('record_compact_chars'));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : COMPACT_MSG_CHARS;
  };

  /* 注：原实现还注入一个 chatEl()（"消息区在哪"的 DOM 句柄）并把它透传给 addTraceStrip 的第一个参数。
     React 宿主不需要它（追踪条挂在消息对象上），宿主一直传 () => null —— 审计时删掉这个空转的注入项，
     addTraceStrip(label) 现在只收标签。 */
  function init(deps) {
    const d = deps || {};
    if (d.Prompts !== undefined) Prompts = d.Prompts;
    if (d.Providers !== undefined) Providers = d.Providers;
    if (d.Agent !== undefined) Agent = d.Agent;
    if (d.activeProvider !== undefined) activeProvider = d.activeProvider;
    if (d.buildOptions !== undefined) buildOptions = d.buildOptions;
    if (d.history !== undefined) history = d.history;
    if (d.curSess !== undefined) curSess = d.curSess;
    if (d.persistSession !== undefined) persistSession = d.persistSession;
    if (d.addTraceStrip !== undefined) addTraceStrip = d.addTraceStrip;
    if (d.fillTraceStrip !== undefined) fillTraceStrip = d.fillTraceStrip;
    if (d.toast !== undefined) toast = d.toast;
    if (d.getInjectedBlocks !== undefined) getInjectedBlocks = d.getInjectedBlocks;
    if (d.getActiveToolDefs !== undefined) getActiveToolDefs = d.getActiveToolDefs;
    if (d.abortSignal !== undefined) abortSignal = d.abortSignal;
    if (d.numCtx !== undefined) numCtx = d.numCtx;
    if (d.toApiMsg !== undefined) toApiMsg = d.toApiMsg;
    if (d.val2 !== undefined) val2 = d.val2;
  }

  /* ======================= 用量估算 ======================= */

  /** 估算 token 数：中文按字计，其他按 ~3.6 字符/token（无需 tokenizer，足够指导决策） */
  function estTokens(text) {
    if (!text) return 0;
    let cjk = 0, other = 0;
    for (const ch of String(text)) {
      const c = ch.codePointAt(0);
      if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3000 && c <= 0x303f) || (c >= 0xff00 && c <= 0xffef)
        || (c >= 0x3040 && c <= 0x30ff) || (c >= 0xac00 && c <= 0xd7af)) cjk++;
      else other++;
    }
    return Math.ceil(cjk + other / 3.6);
  }

  /** 上下文上限：优先用宿主注入的 numCtx()（服务商配置里的 ctxLimit），否则按远程 API 的常见量级（128K）。
   *  注：原先有一条"本机模型（ollama）读 num_ctx"的分支，随本机模型支持一并移除。 */
  function ctxLimit() {
    const n = typeof numCtx === 'function' ? Number(numCtx()) : 0;
    if (n > 0) return n;
    return 128000;   // 远程 API 多为 128K 级别
  }

  const msgTokens = (m) => estTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''));
  const tokensOf = (msgs) => msgs.reduce((n, m) => n + msgTokens(m), 0);

  const compactHeader = (cp) => Prompts.text('compact.header').replace(/\{n\}/g, String(cp.count || 0));

  /** 计算当前占用（系统提示词 + 工具说明 + 工具 schema + 历史 + 当前输入）
   *  已压缩的会话按「摘要 + 未压缩部分」计——用量环显示的才是真正发出去的量。 */
  function ctxUsage(draftInput = '') {
    const { blocks } = getInjectedBlocks();
    let sysTok = blocks.reduce((n, b) => n + estTokens(b.text), 0);
    const defs = getActiveToolDefs();
    if (defs.length) sysTok += Math.ceil(JSON.stringify(defs).length / 3.6);  // schema 随请求发出，同样占上下文
    const hist = history();
    const cp = curSess() && curSess().compaction;
    const from = cp && cp.text ? Math.min(cp.upTo || 0, hist.length) : 0;
    let h = 0;
    if (from > 0) h += estTokens(cp.text) + estTokens(compactHeader(cp));
    hist.slice(from).forEach(m => {
      h += estTokens(m.content) + 4;               // 每条消息的角色/分隔符开销
      if (m.thinking) h += estTokens(m.thinking);  // 部分 API 会把思考一并计入
    });
    const draft = estTokens(draftInput);
    return { sysTok, hist: h, draft, total: sysTok + h + draft, limit: ctxLimit() };
  }

  /* ======================= 自动裁剪（压缩提示词被关掉时的兜底） ======================= */
  const CTX_TRIM_AT = 0.85;     // 达到上限 85% 时开始裁剪
  const CTX_KEEP_TAIL = 0.55;   // 裁剪后保留最近 55% 的消息

  /** 把"这一轮要发出去的消息"裁到安全线以内。**只裁请求视图，不动会话原文**：
   *  原文仍留在会话里（界面上能看、能复制），只是这一轮不带它。
   *  为什么不做成"从 history 里原地 shift"（旧实现）：① 那件事**发生在消息已经发出去之后**——
   *  等 history 被裁时这一轮的请求早超限失败了，"兜底"根本没兜住（2026-10-01 审计：该函数
   *  全仓零调用，而文件头与注释一直承诺"关掉压缩就用它"）；② 静默删掉用户的会话原文不可逆，
   *  而"这轮少带点历史"随时可恢复。
   *  裁剪必须**对齐到 user 边界**：从中间截断会把 tool 结果与它的 assistant(tool_calls) 拆开，
   *  上游直接 400。 */
  function trimForRequest(messages) {
    const limit = ctxLimit();
    if (tokensOf(messages) <= limit * CTX_TRIM_AT) return { messages, trimmed: 0 };
    const head = (messages[0] && messages[0].role === 'system') ? [messages[0]] : [];
    const body = head.length ? messages.slice(1) : messages.slice();
    const target = limit * CTX_KEEP_TAIL;
    let used = 0, from = body.length;
    while (from > 0) {
      const t = msgTokens(body[from - 1]) + 4;
      if (used + t > target) break;
      used += t; from--;
    }
    while (from < body.length && body[from].role !== 'user') from++;    // 对齐到 user 边界
    if (from <= 0 || from >= body.length) return { messages, trimmed: 0 };
    return { messages: head.concat(body.slice(from)), trimmed: from };
  }

  /* 裁剪提示只发一次（按会话 + 已裁条数去重）：不然每一轮都会弹一句一模一样的提示 */
  let trimSent = { sess: null, from: 0 };
  function notifyTrim(trimmed, after) {
    const sess = curSess();
    if (trimSent.sess === sess && trimSent.from >= trimmed) return;
    trimSent = { sess, from: trimmed };
    /* 与服务端托管运行的提示条同一条路：toast → 事件流 → 界面上的提示条。
       文案明确"原文还在"，避免用户以为内容被删了。 */
    toast(`⚖ 上下文接近上限：这一轮只带最近 ${after} 条消息（较早的 ${trimmed} 条被忽略，原文仍在会话里）`);
  }

  /** Agent 的 transformContext（**唯一入口**）：压缩开着走摘要，关掉走上面的裁剪兜底。
   *  两者互斥——压缩阈值 0.8 < 裁剪阈值 0.85，压缩开着时永远先到 0.8。 */
  async function transformMessages(messages) {
    if (autoCompactOn()) return compactMessages(messages);
    const r = trimForRequest(messages);
    if (!r.trimmed) return messages;
    notifyTrim(r.trimmed, r.messages.length);
    return r.messages;
  }

  /* ======================= 压缩（Pi 的 compaction） ======================= */
  const COMPACT_AT = 0.8;        // 用量超过上限的 80% 触发
  const COMPACT_KEEP = 0.45;     // 压缩后保留最近 45% 的消息
  let compacting = false;

  /* 追踪条的安全包装：宿主可能没接界面（Node 单测、独立运行），此时 addTraceStrip 缺席或抛错。
     旧实现在 try 块**外面**直接 host.querySelector(...)，一旦宿主没注入界面就抛 TypeError，
     而 compacting = true 已经置位、复位只在 finally 里 —— 之后所有压缩静默失效
     （compactNow 永远回"正在压缩中"）。这里统一收敛成"没有就不画"。 */
  function beginTrace(label) {
    try {
      if (typeof addTraceStrip !== 'function') return null;
      return addTraceStrip(label);
    } catch { return null; }
  }
  function endTrace(el, info) {
    if (!el || typeof fillTraceStrip !== 'function') return;
    try { fillTraceStrip(el, info); } catch { /* 提示条失败不影响压缩结果 */ }
  }

  /** 摘要消息的抬头里带上被压缩的条数，正文可在界面上改 */
  async function summarize(oldSlice) {
    const p = activeProvider();
    /* buildOptions() 返回的是宿主那个**在用的**请求参数对象。
       必须在副本上删 tools：直接 delete 会把它从真身上摘掉，本轮后续每一次请求都不再带工具清单，
       模型收不到工具定义就把调用写成正文（XML/DSML 标记），循环随之"没有工具调用"收尾——
       实测过的连锁故障（压缩一次 → 后面的轮次工具全失效）。 */
    const opts = Object.assign({}, buildOptions());
    delete opts.tools;                                   // 摘要不需要工具
    const prompt = Prompts.text('compact.prompt');
    const cap = compactCap();
    const body = oldSlice.map(m => {
      const who = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : m.role === 'tool' ? '工具' : '系统';
      const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return `【${who}】${String(text).slice(0, cap)}`;
    }).join('\n\n');
    const r = await Agent.complete({
      /* 第 4 个参数是**适配器的 opts**，不是参数表：signal 要放进 opts.signal
         （与 session.js 的规范接线一致，见 README 约定 4）。旧写法把 signal 直接当第 4 参传：
         流式中它是 AbortSignal 对象 → 适配器读 opts.signal 恒 undefined（停止对摘要请求无效）；
         非流式时它是 null → 直接 `Cannot read properties of null (reading 'signal')`，
         于是**手动压缩必然报"压缩失败"**。这是同一处契约在压缩链路上的第二个实例。 */
      stream: (messages, o, signal) => Providers.get(p.type).chat(p, messages, o, {
        signal, sessionId: (curSess() || {}).id,
      }),
      messages: [{ role: 'user', content: prompt + '\n\n---\n\n' + body }],
      opts, signal: abortSignal(),
    });
    return r.text;
  }

  /** 自动压缩是否启用 —— **唯一判据**：提示词登记表里那条 compact.prompt。
   *  关掉（开关）或清空（文本）都算"不用压缩"，此时超限只能靠上面的裁剪兜底。
   *
   *  2026-09-20 审计：此前 compactMessages 从不看这个开关，于是"关掉压缩提示词"实际上
   *  只是**加了一条破坏性的裁剪**（app.js 的裁剪分支正是以 !enabled 为条件），压缩本身照跑
   *  ——关一次得到两种机制叠加：旧消息被 shift 掉，同时又调模型写了一份摘要。判据收敛到
   *  这一个函数后，两边语义一致：开 = 摘要（不丢原文），关 = 裁剪（丢最老的，不调模型）。 */
  function autoCompactOn() {
    return !!(Prompts && Prompts.enabled('compact.prompt')
      && String(Prompts.text('compact.prompt')).trim());
  }

  /* 本轮运行内复用摘要：agent 的 context 只增不减，每一轮 transformContext 收到的都是
     完整前缀——不复用的话，工具每跑一轮就把同样的前缀重新摘要一遍（每轮多烧一次模型调用）。 */
  let compactCache = null;   // { sess, keepFrom, sig: string[], text }

  const msgFp = (m) => m.role + '|' + (typeof m.content === 'string'
    ? m.content.length + ':' + m.content.slice(0, 80)
    : JSON.stringify(m.content || '').length);

  /** 压缩后的请求视图：被覆盖的前缀换成摘要消息，其余**原样保留**。
     这里必须用传入的 agent 上下文来重建——旧实现从 history 重建，会把运行中刚产生的
     工具调用/插话整个丢掉（它们还没落进 history）：请求里留着 assistant(tool_calls)
     却没有对应的 tool 结果，OpenAI 兼容服务直接 400，模型也看不到自己刚做了什么。
     注意不能用宿主的 toApiMsg：它不保留 toolCallId/name，tool 消息会失效。 */
  function compactedView(head, body, from, text) {
    const strip = (m) => {
      const out = { role: m.role, content: m.content };
      if (m.toolCalls && m.toolCalls.length) out.toolCalls = m.toolCalls;
      if (m.role === 'tool') { out.toolCallId = m.toolCallId; out.name = m.name; }
      return out;
    };
    const msgs = [];
    if (head) msgs.push(head);
    // 容忍 compaction 已被取消（uncompact/裁剪作废摘要后残留的复用请求走到这里）：条数取不到就给 0
    msgs.push({ role: 'user', content: compactHeader(curSess().compaction || {}) + '\n\n' + text, __compaction: true });
    msgs.push(...body.slice(from).map(strip));
    // 空正文且没有工具调用的 assistant 消息没有信息量，Anthropic 会直接拒绝，一律不发
    return msgs.filter(m => !(m.role === 'assistant' && !m.content && !(m.toolCalls && m.toolCalls.length)));
  }

  async function compactMessages(messages) {
    if (!autoCompactOn()) return messages;      // 关掉压缩提示词 = 不压缩（改由宿主裁剪兜底）
    const limit = ctxLimit();
    if (tokensOf(messages) <= limit * COMPACT_AT) return messages;
    const sess = curSess(); if (!sess) return messages;

    const head = messages[0] && messages[0].role === 'system' ? messages[0] : null;
    const body = head ? messages.slice(1) : messages.slice();

    // 本轮已压过且前缀没变：直接复用上次的切分点拼视图，不再调模型
    if (compactCache && compactCache.sess === sess && compactCache.keepFrom <= body.length
        && compactCache.sig.length <= body.length
        && compactCache.sig.every((fp, i) => msgFp(body[i]) === fp)) {
      const view = compactedView(head, body, compactCache.keepFrom, compactCache.text);
      if (tokensOf(view) <= limit * COMPACT_AT) return view;
      compactCache = null;                                // 复用后仍超限：走全量压缩，重新划界
    }

    const hasSummary = !!(body[0] && body[0].__compaction);
    const keep = Math.max(4, Math.ceil(body.length * COMPACT_KEEP));
    const oldSlice = body.slice(0, Math.max(0, body.length - keep));
    if (oldSlice.length < 2) return messages;            // 太短，压了没意义
    if (compacting) return messages;                     // 防重入
    compacting = true;
    const el = beginTrace('压缩上下文…');
    try {
      const text = await summarize(oldSlice);
      if (!text) throw new Error('模型没有返回摘要');
      if (curSess() !== sess) return messages;   // await 期间换了会话：摘要属于旧会话，写回来必错位
      const hist = history();
      const covered = oldSlice.length - (hasSummary ? 1 : 0);      // 新覆盖的历史条数
      const prev = hasSummary ? (sess.compaction || {}).upTo || 0 : 0;
      sess.compaction = {
        upTo: Math.min(hist.length, prev + covered),
        count: ((sess.compaction || {}).count || 0) * (hasSummary ? 1 : 0) + covered,
        text, ts: Date.now(),
      };
      compactCache = { sess, keepFrom: oldSlice.length, sig: oldSlice.map(msgFp), text };
      persistSession();
      endTrace(el, { label: `已压缩 ${sess.compaction.count} 条较早消息 → 摘要 ${text.length} 字`,
        ok: true, note: '上下文压缩', result: text });
      toast('上下文接近上限：已把较早的对话压成摘要');
      return compactedView(head, body, oldSlice.length, text);
    } catch (e) {
      endTrace(el, { label: '压缩失败：' + e.message, ok: false, note: '失败' });
      return messages;                                    // 压缩失败就照常发（宁可超限也不卡住）
    } finally { compacting = false; }
  }

  /** 手动压缩 / 取消压缩 */
  async function compactNow() {
    const sess = curSess(); if (!sess) return;
    // 手动压缩同样要过那个开关：提示词被关掉/清空时没有可用的摘要指令，
    // 硬跑只会让模型把对话当成待续写文本，产出一段没用的"摘要"。
    if (!autoCompactOn()) return toast('压缩提示词被关掉了：先在「🧩 注入与提示词 → ⑤ 上下文压缩」里把它打开');
    const hist0 = history();
    if (hist0.length < 4) return toast('对话还太短，不需要压缩');
    if (compacting) return toast('正在压缩中，请稍候');     // 运行中的自动压缩可能同时在跑
    compacting = true;
    const len0 = hist0.length;                 // 数值快照：history() 返回的是引用，splice 后两者同变
    const keep = Math.max(4, Math.ceil(hist0.length * COMPACT_KEEP));
    const oldSlice = hist0.slice(0, Math.max(0, hist0.length - keep)).map(toApiMsg);
    const el = beginTrace('手动压缩：正在生成摘要…');
    try {
      const text = await summarize(oldSlice);
      if (!text) throw new Error('模型没有返回摘要');
      if (curSess() !== sess || history().length !== len0) {
        // await 期间换了会话或删改了消息：坐标基于旧历史，写回去必然错位
        endTrace(el, { label: '压缩取消：等待摘要期间会话或历史发生了变化', ok: false, note: '失败' });
        return;
      }
      sess.compaction = { upTo: hist0.length - keep, count: oldSlice.length, text, ts: Date.now() };
      persistSession();
      endTrace(el, { label: `已压缩 ${oldSlice.length} 条消息`, ok: true, note: '完成', result: text });
      toast('已压缩较早的对话');
    } catch (e) {
      endTrace(el, { label: '压缩失败：' + e.message, ok: false, note: '失败' });
    } finally { compacting = false; }
  }
  function uncompact() {
    const sess = curSess();
    if (!sess || !sess.compaction) return;
    invalidateCompaction();
    persistSession(); toast('已取消压缩（原文重新进入上下文）');
  }
  /** 历史被改写（删消息、回撤、清空）后摘要失效 */
  function invalidateCompaction() {
    const sess = curSess();
    // 摘要作废必须连带作废压缩缓存：compactCache 里存着旧的切分点/摘要文本，
    // 不清的话运行中下一轮 transformContext 会命中复用分支，拼出一份"已取消的摘要"视图
    if (sess && sess.compaction) { delete sess.compaction; compactCache = null; }
  }

  return {
    init, estTokens, ctxLimit, ctxUsage,
    autoCompactOn, compactMessages, transformMessages, compactNow, uncompact, invalidateCompaction,
    compactHeader, trimForRequest,
    COMPACT_AT, COMPACT_KEEP, CTX_TRIM_AT, CTX_KEEP_TAIL,
  };
}

/** 默认实例：界面与单测用的那一份（生命周期与页面/进程同长） */
export const AgentContext = createAgentContext();
