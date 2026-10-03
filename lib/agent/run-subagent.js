/** lib/agent/run-subagent.js —— **子智能体**：把一件独立的事交给另一段上下文去跑
 *
 *  为什么要有它（Claude Code 的 Task 工具、opencode 的 subagent 都是同一件事）：
 *  主对话的上下文是稀缺资源。让模型"派一个助手去翻文件/查资料、只把结论带回来"，
 *  主对话就不必装下中间那几十次工具调用——上下文省一半，主循环也不容易被带偏。
 *
 *  实现上刻意**不新造一套循环**：还是 core/agent.js 的 Agent.run，只是换一份入参——
 *    · 自己的 messages：system（子智能体角色说明 + 主对话同一份 system 区块）+ 一条任务；
 *    · 自己的工具集：默认**只读**（读文件/找文件/联网搜索/查记忆/加载技能），
 *      面板开了 subagent_write 才有写的能力；**永不含 spawn_agent**（不许递归派）；
 *    · 自己的上下文管理：新造一个 AgentContext 实例（压缩/裁剪按子任务自己的历史算）；
 *    · 自己的预算：与主对话分开计（子智能体烧不掉主对话的额度），额度在面板「子智能体」里可调
 *      （检索/记忆技能/文件/命令四项，见 core/params.js 的 subagent_*_max）。
 *
 *  过程与结论去哪儿：
 *    · 过程 → 事件流（sub_start / sub_delta / sub_tool / sub_end），界面上的追踪条实时显示；
 *    · 结论 → 作为工具结果原文回给主对话（模型据此继续）；
 *    · 完整转录（每条消息、每次工具调用）→ 留在 run.subs 里，配 GET /agent/run/subagent 查看。
 *
 *  并发：同一个 run 里同时在跑的子智能体受「同时最多几个」限制，超出的**排队**（不丢任务）。
 */
const { emit } = require('./run-events');

const clampInt = (v, lo, hi, def) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : def;
};
const one = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** 子智能体的工具预算：与主对话分开（改东西的才扣，读类不扣——与 tool-runner 同一口径）。
 *  数值来自面板「子智能体」组的四项预算参数；不传 limits 时退回出厂默认（供单测直接调用）。
 *  命令预算仍跟着写开关走：不让它写时是 0（工具也不会注册，双保险）。 */
const subBudget = (allowWrite, limits) => {
  const L = limits || {};
  const num = (v, def) => Math.max(1, Math.floor(Number(v)) || def);
  return {
    search: 0, aux: 0, fs: 0, exec: 0, sub: 0,
    maxSearch: num(L.search, 2), maxAux: num(L.aux, 4), maxFs: num(L.fs, 10),
    maxExec: allowWrite ? num(L.exec, 4) : 0,
    maxSub: 0,                          // 不许它再派子智能体
  };
};

/**
 * 造一个"子智能体执行器"（按 run 一个：并发闸与计数都跟着这一段运行）。
 * @param {{run:object, C:object, val2:Function, rawSettings:object,
 *          resolveProvider:Function, persist:Function}} deps
 *        resolveProvider(idOrEmpty) → 服务商对象（'' = 跟当前对话同一个）
 * @returns {{run:(spec:object)=>Promise<object>, active:()=>number, queued:()=>number}}
 */
function createSubAgentRunner(deps) {
  const { run, C } = deps;
  const maxParallel = clampInt(deps.val2('subagent_parallel'), 1, 8, 2);
  const defaultRounds = clampInt(deps.val2('subagent_rounds'), 1, 30, 6);
  const writeAllowed = !!deps.val2('subagent_write');   // 面板总开关（工具参数只能更严，不能更松）
  /* 子智能体自己的工具预算（面板四项）：每段运行读一次，与上面三个同口径 */
  const budgetLimits = {
    search: deps.val2('subagent_search_max'),
    aux: deps.val2('subagent_mem_max'),
    fs: deps.val2('subagent_fs_max'),
    exec: deps.val2('subagent_exec_max'),
  };
  /* 记录类上限（面板「结果与记录」/「子智能体」）：转录每步的结果与参数、转录保留几步。
     与主对话的追踪条同一口径——两处不一样长的话，同一次工具调用在主对话与转录里会是两种长度。 */
  const num = (v, def) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
  };
  const traceChars = num(deps.val2('record_trace_chars'), 4000);
  const argsChars = num(deps.val2('record_args_chars'), 2000);
  const stepsMax = num(deps.val2('subagent_steps'), 200);

  let active = 0;
  const waiting = [];

  /** 并发闸：满了就在队列里等（**排队而不是拒绝**——模型的并行调用不该被丢掉） */
  function acquire() {
    if (active < maxParallel) { active++; return Promise.resolve(); }
    return new Promise((resolve) => { waiting.push(resolve); });
  }
  function release() {
    active--;
    const next = waiting.shift();
    if (next) { active++; next(); }
  }

  async function execute(spec) {
    await acquire();
    try { return await runOne(spec || {}); } finally { release(); }
  }

  async function runOne(spec) {
    const task = String(spec.task || '').trim();
    const label = String(spec.label || '').trim().slice(0, 40) || task.slice(0, 30);
    const subId = 'sub-' + (++run.subSeq);
    const callId = String(spec.callId || '');
    const providerObj = deps.resolveProvider(spec.providerId);
    /* 轮次：面板值是**硬上限**，模型只能在单次调用里要求更少（工具参数不可信）。 */
    const rounds = Math.min(clampInt(spec.maxRounds, 1, 30, defaultRounds), defaultRounds);
    const allowWrite = !!spec.allowWrite && writeAllowed;
    const tools = C.AgentDefs.subagentToolDefsFor(C.AgentDefs.activeToolDefs(), allowWrite);
    const budget = subBudget(allowWrite, budgetLimits);
    const subParams = C.Assemble.paramsOf(deps.rawSettings, providerObj.id, providerObj.model);

    /* 子智能体的 system = 角色说明 + **主对话同一份** system 区块。
       用同一份而不是另写一套：记忆索引、技能清单、工具说明在里面，子智能体因此"知道同样的规矩"；
       只有这一条任务不同。父对话没组装过 system（异常路径）时就只有角色说明。 */
    const parentSys = (run.parentMessages && run.parentMessages[0] && run.parentMessages[0].role === 'system')
      ? String(run.parentMessages[0].content || '') : '';
    const intro = C.Prompts.text('loop.subagent.intro');
    const messages = [
      { role: 'system', content: parentSys ? intro + '\n\n---\n\n' + parentSys : intro },
      { role: 'user', content: C.Prompts.text('loop.subagent.task').replace(/\{task\}/g, task) },
    ];

    emit(run, {
      type: 'sub_start', subId, callId, label,
      task: one(task).slice(0, 160), model: providerObj.model, rounds,
      tools: tools.map((d) => d.function.name),
    });

    /* 子任务自己的上下文管理（压缩/裁剪）：curSess 是个一次性壳，摘要只作用于这一段子任务。 */
    const buildOpts = () => C.Assemble.buildRequestOptions({
      params: subParams, defs: tools, model: providerObj.model, extraBody: providerObj.extraBody,
    });
    const childCtx = C.createAgentContext();
    const subSess = { id: run.sessionId + '#' + subId, msgs: messages };
    childCtx.init({
      Prompts: C.Prompts, Providers: { get: C.getProtocol }, Agent: C.Agent,
      activeProvider: () => providerObj,
      numCtx: () => C.Params.ctxLimitOf(deps.rawSettings, providerObj, subParams),
      buildOptions: buildOpts,
      history: () => messages,
      curSess: () => subSess,
      persistSession: () => {},
      addTraceStrip: () => null, fillTraceStrip: () => {},
      toast: (msg) => emit(run, { type: 'sub_note', subId, callId, text: String(msg) }),
      getInjectedBlocks: () => ({ blocks: [] }),
      getActiveToolDefs: () => tools,
      abortSignal: () => run.abort.signal,
      toApiMsg: C.Assemble.toApiMsg,
    });

    const t0 = Date.now();
    const transcript = { subId, label, task, model: providerObj.model, rounds: 0, tools: [], startedAt: t0 };
    run.subs.set(subId, transcript);
    try {
      const out = await C.Agent.run({
        maxRounds: rounds,
        messages,
        tools,
        opts: buildOpts(),
        signal: run.abort.signal,
        stream: (msgs, o, sig) => C.getProtocol(providerObj.type).chat(providerObj, msgs, o, { signal: sig, sessionId: run.sessionId }),
        transformContext: (msgs) => childCtx.transformMessages(msgs),
        runTool: (call) => C.ToolRunner.runTool(call, task, budget),
        toolMode: (name) => (C.AgentDefs.CONFIRM_SEQUENTIAL.has(name) ? 'sequential' : 'parallel'),
        texts: {
          truncated: C.Prompts.text('loop.truncated'),
          guard: C.Prompts.text('loop.guard'),
          maxRounds: C.Prompts.text('loop.max_rounds'),
          noContent: C.Prompts.text('loop.no_content'),
          textCalls: C.Prompts.text('loop.text_tool_calls'),
          truncatedAnswer: C.Prompts.text('loop.truncated_answer'),
        },
        guardDuplicate: true,
        traceChars, argsChars,               // 内核那份 trace 与上面转录同一口径
        hooks: {
          onDelta: ({ type, text }) => { if (type !== 'thinking') emit(run, { type: 'sub_delta', subId, callId, text }); },
          onToolStart: ({ call }) => {
            transcript.tools.push({ name: call.name, label: C.AgentDefs.labelOf(call), args: C.Agent.shrinkArgs(call.args, argsChars), ok: true, ms: 0 });
            emit(run, { type: 'sub_tool', subId, callId, label: C.AgentDefs.labelOf(call), state: 'running' });
          },
          onToolEnd: ({ call, result, ms }) => {
            const at = transcript.tools[transcript.tools.length - 1];
            if (at && at.name === call.name) Object.assign(at, { ok: result.ok !== false, note: result.note || '', ms, result: String(result.text || '').slice(0, traceChars) });
            emit(run, { type: 'sub_tool', subId, callId, label: C.AgentDefs.labelOf(call), state: 'done', ok: result.ok !== false, ms });
          },
          onNotice: ({ kind, text }) => emit(run, { type: 'sub_note', subId, callId, kind: kind || 'notice', text: String(text || '') }),
        },
      });
      const answer = String(out.content || '').trim();
      const ms = Date.now() - t0;
      transcript.rounds = out.rounds || 0;
      transcript.ms = ms;
      transcript.answer = answer;
      transcript.stopped = !!out.stopped;
      /* 转录留一份（供界面展开看它到底做了什么）：**有上限**——内核给的 trace 每条
         已把参数瘦身、结果截到 record_trace_chars（见 core/agent.js 的 shrinkArgs / trace.push），
         这里再限条数（面板 subagent_steps），避免内存无上限。 */
      transcript.steps = Array.isArray(out.trace) ? out.trace.slice(0, stepsMax) : [];
      emit(run, {
        type: 'sub_end', subId, callId, ok: !!answer && !out.stopped, ms,
        rounds: transcript.rounds, tools: transcript.tools.length,
        text: answer.slice(0, traceChars),
        stopped: !!out.stopped,
      });
      const head = C.Prompts.text('loop.subagent.note')
        .replace(/\{label\}/g, label).replace(/\{rounds\}/g, String(transcript.rounds));
      return {
        ok: !!answer,
        note: answer ? '子智能体完成' : '子智能体没有给出结论',
        text: answer ? head + '\n' + answer : head + '\n（没有给出结论：请换一种问法或自己完成）',
      };
    } catch (e) {
      const ms = Date.now() - t0;
      const msg = (e && e.message) || String(e);
      transcript.ms = ms;
      transcript.error = msg;
      emit(run, { type: 'sub_end', subId, callId, ok: false, ms, rounds: transcript.rounds, tools: transcript.tools.length, error: msg });
      return { ok: false, note: '子智能体失败', text: `子智能体「${label}」失败：${msg}。可以自己继续完成这件事。` };
    }
  }

  return { run: execute, active: () => active, queued: () => waiting.length, maxParallel, defaultRounds, writeAllowed };
}

module.exports = { createSubAgentRunner, subBudget };
