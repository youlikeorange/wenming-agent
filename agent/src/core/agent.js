/* Agent 循环：双循环 + Steering + 工具五步 + 截断保护（ESM 模块） */
/* Agent Core —— 参照 Pi（earendil-works/pi）的 agent harness 结构
 *
 *  Pi 的 agent-core 只有一件事：**LLM + Tools + A Loop**，其余都是数据。它的几个关键设计这里一一对应：
 *
 *    ① 双循环（packages/agent/src/agent-loop.ts）
 *       内循环：有工具调用 **或** 有待注入的 Steering 消息 → 继续调模型
 *       外循环：内循环结束后看有没有 Follow-up 消息 → 有就再进内循环
 *    ② Steering（转向）：Agent 运行中用户还能插话，消息在下一轮开始前注入上下文，
 *       投递固定 one-at-a-time：宿主每次只回一条待注入的插话。
 *    ③ 最晚转换（Late Conversion）：AgentMessage[] → 各家 API 的 Message[] 只在**即将调用模型**时做，
 *       所以中途注入/压缩都不影响已记录的历史。
 *    ④ 工具调用五步生命周期：prepare → beforeToolCall hook → execute → afterToolCall hook → 结果消息。
 *    ⑤ 截断保护：模型输出撞到 token 上限（stopReason === 'length'）时工具参数可能残缺，
 *       一律不执行、回一条"请重新发起"的错误（文案在提示词登记表里可改）。
 *    ⑥ 事件流：agent_start / turn_start / message_* / tool_execution_* / turn_end / agent_end，
 *       界面只订阅事件，不掺进循环逻辑（与 Pi 的 EventStream 同构）。
 *
 *  本文件不碰 DOM，也不认识"服务商"：调用模型的能力由 cfg.stream 注入，
 *  工具执行由 cfg.runTool 注入（宿主：联网搜索 / 记忆读写 / 技能加载与自造）。
 *  也没有 init(deps)：内核**没有**任何模块级宿主依赖，全部经 cfg 现传
 *  （旧实现留着一个只写不读的 Providers 注入点，审计时删掉）。
 */

/** 结果对象：把工具输出归一成 { ok, text, note, files? }
 *  files = **可下载文件清单**（deliver_file 这类"把文件交给用户"的工具才有）：
 *  白名单式保留（只认 name/size/exec/packaged/source/note），内核不认识它的语义，
 *  只负责让它一路传到追踪条上——界面据此画那张文件卡片（见 ui/features/TraceStrip.jsx）。 */
const FILE_KEYS = ['name', 'size', 'exec', 'packaged', 'source', 'note'];
const asFiles = (list) => (Array.isArray(list) ? list.slice(0, 20).map((f) => {
  const out = {};
  for (const k of FILE_KEYS) if (f && f[k] !== undefined) out[k] = f[k];
  return out;
}).filter((f) => f.name) : null);
/** 行数统计（写/改/删 文件后服务端给的那两个数）：追踪条（信息卡片）显示 +N / −M。
 *  白名单式保留，与 files 同一套写法——内核不认识它的语义，只负责一路传到追踪条。 */
const asLines = (v) => {
  if (!v || typeof v !== 'object') return null;
  const added = Math.max(0, Math.floor(Number(v.added) || 0));
  const removed = Math.max(0, Math.floor(Number(v.removed) || 0));
  return (added || removed) ? { added, removed } : null;
};
const asResult = (r) => {
  if (r && typeof r === 'object') {
    const out = { ok: r.ok !== false, text: String(r.text ?? ''), note: r.note || '' };
    const files = asFiles(r.files);
    if (files && files.length) out.files = files;
    const lines = asLines(r.lines);
    if (lines) out.lines = lines;
    return out;
  }
  return { ok: true, text: String(r ?? ''), note: '' };
};

/** assistant 消息工厂：带工具调用时，把这一轮的**扩展思考**一并带上。
 *  为什么必须带：Anthropic 开启 thinking 后，带 tool_use 的轮次要原样回传 thinking 块
 *  （含 signature），否则下一轮整轮 400 —— 现象是"一开推理强度、模型一调工具就废"
 *  （2026-10-01 审计）。thinkingSig / redactedThinking 来自 protocol/anthropic.js 的事件流。 */
const asstMsg = (content, calls, thinking, sig, redacted) => {
  const m = { role: 'assistant', content, toolCalls: calls };
  if (thinking) m.thinking = thinking;
  if (sig) m.thinkingSig = sig;
  if (redacted) m.redactedThinking = redacted;
  return m;
};

/** 工具调用的唯一指纹：用于"同一参数重复调用"保护 */
const fingerprint = (name, args) => {
  let s;
  try { s = JSON.stringify(args || {}); } catch { s = String(args); }
  return name + '\u0000' + s;
};

/** 工具参数瘦身：长字符串值截断后再落盘/展示。
 *  为什么必须有：write_file / edit_file 的参数里带着**整个文件内容**（上限 4MB），
 *  会话记录里存一份原文，每次落盘就要序列化几 MB、界面展开"参数"也要在 DOM 里放几 MB ——
 *  写大文件时页面卡死的主因之一（实测）。路径这类短字段照原样留着，界面标题仍然对。
 *  只截**值**、不动键，复制出来的参数至少还能看出结构。
 *  上限可在面板「权限与工具 → 结果与记录」调（`record_args_chars`），默认 2000。 */
const ARG_STR_MAX = 2000;
function shrinkArgs(args, max) {
  if (!args || typeof args !== 'object') return args;
  const cap = Number.isFinite(Number(max)) && Number(max) > 0 ? Math.floor(Number(max)) : ARG_STR_MAX;
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && v.length > cap) {
      out[k] = v.slice(0, cap) + `…（共 ${v.length} 字，已截断）`;
    } else out[k] = v;
  }
  return out;
}

/** 追踪条里单条工具结果的字数上限：默认 4000，面板 `record_trace_chars` 可调。
 *  它只管"记录/显示"——发给模型的工具结果原文不受它限制（见下面的 context.concat）。 */
const TRACE_CHARS = 4000;
const traceCap = (cfg) => {
  const n = Number(cfg && cfg.traceChars);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : TRACE_CHARS;
};

/* 哪些工具重复调用是**正常**的（不该拦）：
   读类在"写完再读回来核对"时参数就是一模一样的；写类改完同一个文件再写全文、
   或用 write_file 整篇重写来兜底失败的 edit_file，参数也会与之前撞上——
   连写两次同样的内容无害，宁可放过，也不要让模型误以为重试过了。
   真正需要拦的是"同一条命令原地反复跑"这种空转（run_command 不在豁免之列）。 */
const REPEAT_OK = new Set(['read_file', 'list_directory', 'directory_tree', 'search_files',
  'get_file_info', 'web_search', 'memory_search', 'memory_read', 'memory_write', 'memory_forget',
  'list_skills', 'use_skill',
  'write_file', 'edit_file', 'create_directory', 'move_file']);
const repeatAllowed = (name) => REPEAT_OK.has(String(name || ''));

/** 注入项可以是纯文本（当作用户消息）或完整的 {role, content} 消息 */
const toMessages = (items) => (items || []).map((m) => (typeof m === 'string' ? { role: 'user', content: m } : m));

/**
 * 跑一次 Agent（一次用户输入 → 可能多轮工具调用 → 最终回答）
 * @param {object} cfg
 *   stream(messages, opts, signal) -> AsyncGenerator   调模型（唯一入口；最晚转换在调用前完成）
 *   messages [{role, content, toolCalls?, toolCallId?, name?}]   初始上下文（含 system）
 *   tools    [schema] 注册给模型的工具定义
 *   opts     生成参数
 *   signal   AbortSignal
 *   maxRounds 工具轮次上限
 *   getSteering() -> string[]|null   取待注入的插话（一次一条，由宿主切片）
 *   getFollowUps() -> string[]|null  取收尾后的追加消息（Pi 的外循环）
 *   runTool(call) -> Promise<{ok,text,note}>   执行工具
 *   toolMode(name) -> 'parallel'|'sequential' 工具执行策略（默认 parallel；写类工具宜 sequential）
 *   transformContext(messages) -> Promise<messages>  上下文变换（压缩在这里做；返回发给模型的最终消息）
 *   guardDuplicate(bool)   同一参数重复调用是否直接回绝（默认开）
 *   traceChars(number) 追踪条里单条工具结果的字数上限（默认 4000，面板 record_trace_chars）
 *   argsChars(number)  追踪条里参数长字符串的截断上限（默认 2000，面板 record_args_chars）
 *   texts { truncated, guard, maxRounds, noContent }  循环内文案（宿主从提示词登记表注入，可改）
 *   hooks { onStart,onTurnStart,onTurnEnd,onDelta,onToolStart,onToolEnd,onNotice,onStop,onEnd }
 *        onNotice 的 kind 是结构化的：'empty_retry' | 'truncated' | 'max_rounds' | 'error'（error 同时会 throw）
 *        ——宿主按 kind 决定呈现，不要去匹配文案（文案随时会改）。
 */
/** 这个异常是不是"用户要求的中断"（宿主 abort / 读取端抛出的 AbortError）。
 *  四个来源都要认：宿主给的 signal、浏览器的 ApiError（带 aborted:true）、
 *  服务端的 AbortError、以及"连接被掐断"那条兜底错误（也带 aborted:true）。 */
const isAbort = (e, signal) => !!((signal && signal.aborted)
  || (e && (e.name === 'AbortError' || e.aborted === true)));

/** 调一个宿主钩子；钩子自己出错不能带崩整个循环 */
const call = (fn, ...a) => { try { return fn && fn(...a); } catch (e) { console.warn('[agent] hook error', e); } };

/** 读一轮的流式输出：正文/思考/统计/工具调用，边读边把增量交给宿主（onDelta）。
 *
 *  **中断不是失败**：用户点「停止」时宿主 abort，上游连接随之被掐断，读流处会抛
 *  AbortError（服务端是 run-upstream 的 AbortError，浏览器是 ApiError(aborted)）。
 *  这里把它收成 `stopped=true` 交回调用方——已生成的内容一个字不丢，宿主按"已停止生成"
 *  收尾；其它错误一律抛出（真故障不许被伪装成"用户停止"，那样错误就再也看不见了）。 */
async function readRound(cfg, messages, H) {
  const out = { content: '', thinking: '', stats: null, stop: '', sig: '', redacted: '', calls: [], recovered: false, stopped: false };
  try {
    for await (const ev of cfg.stream(messages, cfg.opts || {}, cfg.signal)) {
      if (ev.type === 'content') { out.content += ev.text; call(H.onDelta, { type: 'content', text: ev.text }); }
      else if (ev.type === 'thinking') { out.thinking += ev.text; call(H.onDelta, { type: 'thinking', text: ev.text }); }
      else if (ev.type === 'thinking_sig') { out.sig += ev.text; }
      else if (ev.type === 'thinking_redacted') { out.redacted += ev.text; }
      else if (ev.type === 'tool_calls') { out.calls.push(...ev.calls); if (ev.recovered) out.recovered = true; }
      else if (ev.type === 'stats') { out.stats = ev.raw; }
      else if (ev.type === 'stop') { out.stop = ev.reason || ''; }
      else if (ev.type === 'error') { call(H.onNotice, { kind: 'error', text: ev.message }); throw new Error(ev.message); }
    }
  } catch (e) {
    if (!isAbort(e, cfg.signal)) throw e;
    out.stopped = true;
  }
  return out;
}

async function run(cfg) {
  const H = cfg.hooks || {};

  const maxRounds = Number.isFinite(cfg.maxRounds) ? cfg.maxRounds : 8;
  /* 记录类上限（面板「结果与记录」）：只影响追踪条/落盘，不影响发给模型的内容 */
  const caps = { trace: traceCap(cfg) };
  const seen = new Set();                    // 已成功执行过的工具指纹
  const trace = [];                          // 本轮工具调用记录（随消息落盘）
  let context = (cfg.messages || []).slice();
  let pending = [];                          // 待注入的 Steering 消息
  let content = '', thinking = '', stats = null, stopReason = '';
  let rounds = 0, stopped = false, injectedTurns = 0, emptyRounds = 0;

  /* 取待注入的插话。轮次已到顶就**不消费**：插话留在宿主队列里（Pi 同款语义——queue 里的
     消息没被 dequeue 就还在），由宿主决定怎么善后；内核若照取照注入，rounds 会绕过
     maxRounds 一路涨上去（旧实现的隐患：用户持续插话 = 无限续轮）。 */
  const takeSteering = () => {
    if (!cfg.getSteering || rounds >= maxRounds) return [];
    const v = cfg.getSteering();
    return Array.isArray(v) ? v : (v ? [v] : []);   // 宿主忘了包数组也给兜住（单个字符串按一条算）
  };

  /* 哪些工具**必须**带参数（从注册给模型的 schema 里读 required）。
     用来识别"参数没拼完就被截断"：没有 stop 事件时，safeJson 会把残缺的 JSON 变成 {}，
     此时参数全空的调用基本可以断定是截断（真有工具不要参数，这里就不会误判）。 */
  const needsArgs = new Set();
  for (const t of (cfg.tools || [])) {
    const fn = t && (t.function || t);
    const req = fn && fn.parameters && fn.parameters.required;
    if (fn && fn.name && Array.isArray(req) && req.length) needsArgs.add(fn.name);
  }
  call(H.onStart, { messages: context.length, tools: (cfg.tools || []).length });

  outer: while (true) {
    let hasMoreToolCalls = true;

    /* ---------------- 内循环：工具调用 / Steering ---------------- */
    while (hasMoreToolCalls || pending.length) {
      if (cfg.signal && cfg.signal.aborted) { stopped = true; break outer; }
      if (pending.length) {
        context = context.concat(toMessages(pending));
        pending = [];
        injectedTurns++;
      }

      // 最晚转换：这里才把内部消息交给宿主变换（压缩）并送进模型
      const sendMessages = cfg.transformContext ? await cfg.transformContext(context.slice()) : context;

      call(H.onTurnStart, { round: rounds });

      /* --- 调用模型（流式） --- */
      const round = await readRound(cfg, sendMessages, H);
      /* **先记账再判中断**：中断时这一轮已经流出来的正文/思考照常交回（一个字都不丢） */
      content += round.content;
      thinking += round.thinking;
      if (round.stopped) { stopped = true; break outer; }   // 读流期间被中止：按"停止"收尾
      const roundContent = round.content, roundThinking = round.thinking, stop = round.stop;
      const roundSig = round.sig, roundRedacted = round.redacted;   // Anthropic 思考签名 / 判红块（原样回传）
      const calls = round.calls, recovered = round.recovered;       // 工具调用（可能是从正文里认回来的）
      if (round.stats) stats = round.stats;
      if (stop) stopReason = stop;

      /* --- 空回答保护：这一轮没有正文、也没有工具调用 = 没回答 ---
         判据是**正文**，不是"有没有产生 token"。两种实测过的失败形态都会落在这里：
           ① 只吐 1~2 个 token 就停（eval_count=2；2026-09-17）；
           ② 思考完就停、正文一个字没写（2026-09-22 实测：助手消息 thinking 1451 字 + 工具 6 条，
              正文空 —— 用户看到空气泡，以为"消息发出去了但没调用模型"）。
         旧判据把 ② 放了过去（它检查 !roundThinking），于是空回答被当成"回答完成"存下来。
         现在统一重试两次；第二次重试前追加一句提醒（登记表 loop.no_content，可改），
         仍拿不到正文就明确报错——绝不静默留一个空气泡。 */
      if (!roundContent && !calls.length) {
        emptyRounds++;
        if (emptyRounds <= 2) {
          const hint = cfg.texts && cfg.texts.noContent;
          if (hint) context = context.concat([{ role: 'user', content: hint }]);   // 只进本轮工作上下文，不写进会话
          call(H.onNotice, { kind: 'empty_retry', text: `模型没有给出回答正文${roundThinking || thinking ? '（只有思考）' : ''}，正在自动重试（${emptyRounds}/2）…` });
          continue;                                  // 不推进 rounds：重试不算一轮工具调用
        }
        throw new Error('模型连续三轮没有给出回答正文（只在思考、或直接停下）。可以再发一次；'
          + '若反复如此，请检查模型是否正常加载、think 与输出上限（num_predict）等参数。');
      }
      emptyRounds = 0;

      /* --- 截断保护（Pi: stopReason === 'length'）--- */
      // 参数残缺的另一种来源：服务商没发 finish_reason/stop，而工具调用的 JSON 就没拼完。
      // providers.js 的 safeJson 遇到解析失败会挂 `__badArgs`（不再静默变成 {}），
      // 这里据此识别。另有兜底判据：schema 里声明了必填、却一个参数都没有。
      const starved = calls.length > 0 && calls.some((c) => {
        const a = c.args;
        if (!a || typeof a !== 'object') return false;
        if (a.__badArgs === true) return true;
        const keys = Object.keys(a).filter((k) => k !== '__raw');
        return needsArgs.has(c.name) && keys.length === 0;
      });
      if (calls.length && (stop === 'length' || starved)) {
        context = context.concat([asstMsg(roundContent, calls, roundThinking, roundSig, roundRedacted)]);
        for (const c of calls) {
          const msg = (cfg.texts && cfg.texts.truncated || '工具调用「{name}」没有执行：回答被输出上限截断，请用完整参数重新发起。')
            .replace(/\{name\}/g, c.name);
          context = context.concat([{ role: 'tool', toolCallId: c.id, name: c.name, content: msg }]);
          trace.push({ name: c.name, label: c.name, ok: false, note: '截断未执行', args: shrinkArgs(c.args), result: msg, ms: 0 });
          call(H.onToolEnd, { call: c, result: { ok: false, text: msg, note: '截断未执行' }, ms: 0, skipped: true });
        }
        call(H.onNotice, { kind: 'truncated', text: '模型输出撞到上限（或工具参数没能完整生成），工具调用未执行（已要求模型重新发起）' });
        // 必须**继续**调模型：上面那条"请重新发起"是发给模型的，不接着调它永远读不到，
        // 用户看到的就是"模型停在半路、没有回答"（旧实现就是这里直接结束了内循环）。
        hasMoreToolCalls = true;
        rounds++;
        if (rounds >= maxRounds) break outer;
        pending = takeSteering();
        continue;
      }

      /* --- 没有工具调用：内循环结束 --- */
      if (!calls.length) {
        /* 正文撞到输出上限、也没有工具调用：这是"回答被截断"，不能当完整回答静默收尾
           （旧实现只对"有工具调用"的截断做保护，纯正文截断用户完全看不出来）。 */
        if (stop === 'length' && roundContent) {
          call(H.onNotice, { kind: 'truncated_answer',
            text: (cfg.texts && cfg.texts.truncatedAnswer) || '这一轮回答撞到了输出上限，内容被截断，不是完整回答。' });
        }
        // 模型直接把最终回答给出来了。此刻把积压的插话（Steering）取出来：
        // 用户是在生成中输入的，界面承诺"下一轮生效"——有插话就再跑一轮注入它，
        // 别让 send() 的 finally 把队列无声清空（旧实现只在"有工具调用"的分支里取插话）。
        pending = takeSteering();
        hasMoreToolCalls = pending.length > 0;
      }
      else {
        /* 上游没把工具调用放进结构化字段、被我们从正文里认回来的：给用户与模型各留一句说明。
           （模型那边不必多说——调用照常执行；用户那边要说清"为什么正文里出现过一串标记"。） */
        if (recovered) {
          call(H.onNotice, { kind: 'text_tool_calls',
            text: (cfg.texts && cfg.texts.textCalls) || '模型把工具调用写成了正文（上游没有解析成结构化调用），已自动识别并执行。' });
        }
        /* --- 工具调用：五步生命周期 --- */
        context = context.concat([asstMsg(roundContent, calls, roundThinking, roundSig, roundRedacted)]);
        const prepared = calls.map((c) => ({ call: c, token: call(H.onToolStart, { call: c, round: rounds }) }));

        const execOne = async (item) => {
          const c = item.call;
          let result, t0 = null;                       // 计时从**确认通过后**才起（2026-09-19 五轮审计：
          const fp = fingerprint(c.name, c.args);      // 旧版把用户在确认框前的停留算进"完成 · 19725ms"）
          /* 重复调用保护：**只对"已经成功执行过"的调用生效**，也只拦真正的空转。
             旧实现有两个坑（2026-09-17 实测）：
               ① 指纹在执行**之前**就写进 seen，且失败后从不撤销 →
                  模型看到 ETIMEDOUT 后用同样参数重试，服务端**一次都没收到**，
                  却被回了一句"结果同上"。模型据此认为重试过了，直接放弃——
                  用户看到的就是"命令该重跑却没跑"。
               ② 不分工具类型：`读文件 → 改文件 → 再读回来核对` 的第三次读
                  参数与第一次完全相同，被误判成重复，模型无法自查改动结果。
             现在：失败不入册（下次照跑）、读类工具不拦（重复读无害）、
             只有"成功过的写类/命令类空转"才回绝。 */
          if (cfg.guardDuplicate !== false && !repeatAllowed(c.name) && seen.has(fp)) {
            const dup = (cfg.texts && cfg.texts.guard || '你已经用完全相同的参数调用过 {name}，结果同上。').replace(/\{name\}/g, c.name);
            result = { ok: true, text: dup, note: '重复调用' };
          } else {
            try {
              if (cfg.beforeToolCall) {                     // Pi: hook 可拦截（确认框在这里）
                const block = await cfg.beforeToolCall({ call: c, args: c.args });
                if (block && block.block) result = { ok: false, text: String(block.reason || '调用被拦截'), note: '已拦截' };
              }
              if (!result) {
                t0 = (globalThis.performance || Date).now();    // 同意了才真正开始执行
                result = asResult(await cfg.runTool(c));
              }
              if (cfg.afterToolCall) {                      // Pi: hook 可改写结果
                const patch = await cfg.afterToolCall({ call: c, result });
                if (patch) result = Object.assign({}, result, patch);
              }
            } catch (e) {
              result = { ok: false, text: '调用失败：' + (e && e.message ? e.message : e), note: '失败' };
            }
            // 只在**真的成功**时入册：失败必须允许原样重试
            if (result.ok !== false) seen.add(fp);
          }
          const ms = t0 == null ? 0 : Math.round(((globalThis.performance || Date).now()) - t0);
          call(H.onToolEnd, { call: c, token: item.token, result, ms });
          const fullText = String(result.text || '');
          trace.push({
            name: c.name, label: c.name, ok: result.ok, note: result.note || '',
            args: shrinkArgs(c.args, cfg.argsChars), ms, result: fullText.slice(0, caps.trace),
            /* 真实字数（**未截断前**）：追踪条据此显示"模型实际收到多少 / 这里只显示前 N 字"。
               上限只截记录正文、不截这个计数——否则界面上会变成"无论读了多少都显示 4000"。 */
            resultChars: fullText.length,
            /* 可下载文件清单（deliver_file）：内核自己的 trace 也带上，与实时追踪条同一形状——
               两条 trace 都可能有下游消费者（收尾合并 / 落盘），少一处就会"卡片只在一边有"。 */
            ...(result.files && result.files.length ? { files: result.files } : {}),
            /* 写入/删除的行数（服务端 undo.wrap 记的）：同上，两条 trace 必须同形 */
            ...(result.lines ? { lines: result.lines } : {}),
          });
          context = context.concat([{ role: 'tool', toolCallId: c.id, name: c.name, content: result.text }]);
        };

        const sequential = prepared.some((p) => (cfg.toolMode ? cfg.toolMode(p.call.name) === 'sequential' : false));
        if (sequential) { for (const p of prepared) await execOne(p); }
        else { await Promise.all(prepared.map(execOne)); }   // Pi 默认：并行执行

        rounds++;
        hasMoreToolCalls = rounds < maxRounds;
        if (!hasMoreToolCalls) {
          const t = (cfg.texts && cfg.texts.maxRounds) || '已达本轮工具调用上限，停止继续调用';
          call(H.onNotice, { kind: 'max_rounds', text: t });
        }
        pending = takeSteering();
      }
      call(H.onTurnEnd, { round: rounds, calls: calls.length });
    }

    /* ---------------- 外循环：Follow-up ---------------- */
    /* 轮次闸门必须在这里也判一次：第一轮审计只堵了内循环的 takeSteering（到顶不消费队列），
       外循环却照取不误——只要用户在生成中持续输入，模型就能一直续轮，而 out.rounds
       始终停在 maxRounds（实测：maxRounds=2 时模型被调用 6 次）。到顶就把队列原样留给
       宿主善后（回填输入框），与"每轮最多几轮"的语义一致。 */
    if (rounds >= maxRounds) break;
    const fv = cfg.getFollowUps ? cfg.getFollowUps() : null;
    const follow = Array.isArray(fv) ? fv : (fv ? [fv] : []);   // 同 takeSteering：兜住宿主的疏忽
    if (follow.length) { pending = follow; continue; }
    break;
  }

  call(H.onEnd, { rounds, stopReason, injectedTurns });
  return { content, thinking, stats, trace, rounds, stopped, stopReason, injectedTurns };
}

/** 单独跑一次"非流式"的模型调用（压缩摘要用）：把流读完拼成文本 */
async function complete(cfg) {
  let text = '';
  for await (const ev of cfg.stream(cfg.messages, cfg.opts || {}, cfg.signal)) {
    if (ev.type === 'content') text += ev.text;
    else if (ev.type === 'error') throw new Error(ev.message);
  }
  return { text: text.trim() };
}

/* 原文件末尾的 IIFE 外壳（取浏览器全局，Node 下退回 globalThis）连同其注释
   "兜底 globalThis：Node 里也能加载验算" 一并去掉：这里是 ESM 具名导出。 */
export const Agent = { run, complete, shrinkArgs };
