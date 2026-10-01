/** lib/agent/run-loop.js —— 托管运行的**循环本体**：把一轮对话跑完、落盘、收尾
 *
 *  这一层是"服务端那一半 agent"：core 的循环（agent/src/core/agent.js）原样调用，
 *  工具（tool-runner.js）、协议（protocol/*）、组装（assemble.js）也都是同一份。
 *  它只负责**接线的三件事**：
 *    ① 把账号数据灌进 core 的登记表（Prompts/Memory/AgentDefs/AgentContext）；
 *    ② 把内核回调翻译成事件（loopHooks → run-events.emit）；
 *    ③ 流式期间按节流落盘、收尾时写完再广播 end（persist/finish）。
 *
 *  两条容易踩的坑（都在这层）：
 *    · 登记表的 onChange 是**一次运行注册一次**的用法，必须退订：不退订会让回调跨账号累积，
 *      把 B 的数据按 A 的路径写出去（2026-10-01 审计的 P0 之一）；
 *    · 落盘要**写完再广播 end**：客户端收到 end 会立刻重拉会话，落盘没完成就拉到半截快照。
 */
const { core } = require('./run-core');
const { emit, applyToLive, notifyUi } = require('./run-events');
const { ask } = require('./run-confirm');
const reg = require('./run-registry');
const store = require('./store');
const settings = require('./settings');
const projects = require('./projects');

const SAVE_EVERY_MS = 1500;

/* ============================ 落盘 ============================ */

/** 落盘：把这一轮的消息写回会话（流式期间按 1.5s 节流，收尾强制一次） */
async function persist(run, force) {
  const t = Date.now();
  if (!force && t - run.lastSave < SAVE_EVERY_MS) return;
  run.lastSave = t;
  const s = run.session;
  if (!s) return;
  s.msgs = run.history.slice();
  /* 会话记忆（memory_write 的 scope="session"）也要写回会话对象：
     模型在托管运行里写的那条只活在 core 的内存里，不带回去的话，下一轮
     C.Memory.load(…, run.session.memory, …) 又是空的——刷新/换窗口就永久丢了。
     与浏览器侧 host.persistSession() 同一口径。 */
  const C = await core();
  if (C && C.Memory) s.memory = C.Memory.serialize('session');
  s.ts = t;
  if (!s.title || s.title === '新对话') s.title = C.Sessions.titleFrom(s.msgs) || '新对话';
  try { await store.putSession(run.account, s); } catch (e) { run.saveError = e.message; }
}

/* ============================ 循环 ============================ */

async function execute(run, req) {
  const C = await core();
  const t0 = Date.now();
  /* 登记表/记忆的落盘钩子：注册的返回值是**退订函数**，收尾必须逐个调用
     （见文件头：不退订 = 跨账号覆盖写 + 回调持有 run 不放）。 */
  const offs = [];
  try {
    await require('./run-bridge').runWith({ account: run.account, actor: run.actor, run }, async () => {
      /* ---- 账号数据 → core 登记表 ---- */
      const rawSettings = settings.read(run.account);
      const prompts = store.readPrompts(run.account);
      const globalMem = store.readMemory(run.account).entries;
      const projectId = String(run.session.project || '');
      const proj = projectId ? projects.find(run.account, projectId) : null;
      const projectMem = proj ? projects.readMemory(run.account, proj.id).entries : [];

      C.Prompts.load(prompts);
      /* "（本轮已加载）"标记是**本轮**的：上一轮 use_skill 过谁、上一账号看过谁，与这一轮无关。
         不清的话 system 的技能清单会写着"已加载"而正文并不在请求里，模型据此跳过 use_skill。 */
      C.Prompts.clearLoaded();
      C.Memory.load(globalMem, run.session.memory || [], projectMem);
      C.Memory.setProject(proj ? { id: proj.id, name: proj.name, root: proj.root, memoryDir: proj.memoryDir } : null);

      const prov = rawSettings.providers.find((p) => p.id === run.providerId);
      const providerObj = { id: prov.id, type: prov.type, model: prov.model, baseUrl: prov.baseUrl, ctxLimit: prov.ctxLimit };
      const params = C.Assemble.paramsOf(rawSettings, prov.id, prov.model);
      const val2 = (k) => C.Assemble.val2Of(env, k);
      const env = {
        settings: rawSettings, history: run.history, curSess: () => run.session,
        params, Prompts: C.Prompts, Memory: C.Memory, AgentDefs: C.AgentDefs,
        AgentPolicy: C.AgentPolicy, AgentContext: C.AgentContext, TOOL_DEFAULTS: C.Params.TOOL_DEFAULTS,
      };

      /* 落盘钩子：登记表/记忆一改就写回账号目录（与浏览器侧同一套事件） */
      offs.push(C.Prompts.onChange(() => { store.putPrompts(run.account, C.Prompts.serialize()).catch(() => {}); notifyUi(run); }));
      offs.push(C.Memory.onChange(() => {
        store.putMemory(run.account, C.Memory.serialize('global')).catch(() => {});
        if (C.Memory.projectMeta) {
          projects.writeMemory(run.account, C.Memory.projectMeta.id, C.Memory.serialize('project')).catch(() => {});
        }
        notifyUi(run);
      }));

      C.AgentDefs.init({
        Prompts: C.Prompts, val2, me: () => ({ account: run.account }),
        bound: () => !!run.actor.bound, AGENT_API: '/agent',
      });

      C.ToolRunner.init({
        Prompts: C.Prompts, Memory: C.Memory, AgentPolicy: C.AgentPolicy, AgentDefs: C.AgentDefs,
        val2, me: () => ({ account: run.account }), accessOf: () => C.Assemble.accessOfEnv(env, C.Params.TOOL_DEFAULTS),
        AGENT_API: '/agent',
        runSignal: () => run.abort.signal,
        save: () => {}, persistSession: () => persist(run, true),
        renderMemoryPanel: () => notifyUi(run), renderPromptPanel: () => notifyUi(run),
        updateCtxMeter: () => {}, toast: (msg, kind) => emit(run, { type: 'notice', kind: kind || 'notice', text: String(msg) }),
        openLogin: () => {},
        onStatus: () => {}, onNeedBind: () => {}, onNeedUnlock: () => {},
        confirmPluginAction: (name, args) => ask(run, 'plugin', { name, args }),
        confirmSkillChange: (action, name, args) => ask(run, 'skill', { action, name, args }),
        askDangerGrant: (hit, command) => ask(run, 'danger', { hit, command }),
        /* 勾了「以后不再问」的落点：写账号参数（与界面上的参数面板同一份真源）。
           **写数组**——读取端（AgentPolicy.matchRule）与参数面板都认数组，
           旧实现写 `list.join('\n')` 字符串，于是"以后不再问"永不生效、
           还在把已有清单降级成字符串（2026-10-01 实测）。asStringList 顺带把旧数据修回数组。 */
        onExecAllow: (rule) => {
          settings.patch(run.account, (cur) => {
            const list = C.Params.asStringList(cur.params && cur.params.exec_allow);
            if (rule && !list.includes(rule)) list.push(rule);
            cur.params = Object.assign({}, cur.params, {
              exec_allow: C.Params.normalizeValue(C.Params.TOOL_FIELDS.exec_allow, list.slice(-100)),
            });
            return cur;
          }).catch(() => {});
        },
        onSkillRemember: () => {
          settings.patch(run.account, (cur) => {
            cur.params = Object.assign({}, cur.params, { skill_write_confirm: false });
            return cur;
          }).catch(() => {});
        },
      });

      /* 组装（与浏览器同一份 core/assemble.js）：system 区块 + 历史 + 本条输入。
         **不再额外传 req.text**：本条提问在 startRun 里已经追加进 run.history 了，
         再传一次就是同一个问题发两遍（2026-10-01 实测：user,assistant,user,user）。 */
      const messages = C.Assemble.buildMessages(env);
      const opts = buildOpts(C, providerObj, params, C.AgentDefs.activeToolDefs(), prov);
      run.parentMessages = messages;      // 压缩（transformContext）在它上面做

      C.AgentContext.init({
        Prompts: C.Prompts, Providers: { get: C.getProtocol }, Agent: C.Agent,
        activeProvider: () => providerObj,
        numCtx: () => C.Params.ctxLimitOf(rawSettings, providerObj, params),
        buildOptions: () => opts,
        history: () => run.history,
        curSess: () => run.session,
        persistSession: () => persist(run, true),
        addTraceStrip: (label, kind) => emit(run, { type: 'notice', kind: kind || 'compact', text: String(label || '') }),
        fillTraceStrip: () => {},
        toast: (msg, kind) => emit(run, { type: 'notice', kind: kind || 'notice', text: String(msg) }),
        getInjectedBlocks: () => C.Assemble.promptBlocks(env),
        getActiveToolDefs: () => C.AgentDefs.activeToolDefs(),
        abortSignal: () => run.abort.signal,
        toApiMsg: C.Assemble.toApiMsg,
      });

      const { budget, maxRounds } = roundBudget(val2);
      const out = await C.Agent.run({
        maxRounds,
        messages,
        tools: C.AgentDefs.activeToolDefs(),
        opts,
        signal: run.abort.signal,
        stream: (msgs, o, sig) => C.getProtocol(providerObj.type).chat(providerObj, msgs, o, { signal: sig, sessionId: run.sessionId }),
        /* 上下文变换（**唯一入口**）：压缩开着走摘要，关掉走"只裁这一轮请求视图"的兜底。 */
        transformContext: (msgs) => C.AgentContext.transformMessages(msgs),
        /* 插话（Steering）：界面在生成中发来的话排在这里，内核每轮开始前取一条
           （one-at-a-time，与浏览器侧同一语义）；收尾剩下的由 getFollowUps 注入下一轮。 */
        getSteering: () => {
          const t = run.steering.splice(0, 1);
          if (t.length) { reg.markSteer(run, t[0], '下一轮生效'); reg.steerPending(run); }
          return t;
        },
        getFollowUps: () => {
          const rest = run.steering.splice(0);
          for (const t of rest) reg.markSteer(run, t, '最终回答后生效');
          if (rest.length) reg.steerPending(run);
          return rest;
        },
        runTool: (call) => C.ToolRunner.runTool(call, String(req.text || ''), budget),
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
        hooks: loopHooks(run, C),
      });

      await finish(run, out, null);
    });
  } catch (e) {
    await finish(run, null, e);
  } finally {
    /* 退订：这一轮注册的落盘钩子到此为止。漏了这步就是跨账号覆盖写 + 内存泄漏（文件头）。 */
    for (const off of offs) { try { off(); } catch { /* 退订失败不影响收尾 */ } }
    run.wallMs = Date.now() - t0;
  }
}

/** 本轮请求参数（与浏览器侧同一实现：Assemble.buildRequestOptions） */
function buildOpts(C, providerObj, params, defs, prov) {
  return C.Assemble.buildRequestOptions({
    params, defs, model: providerObj.model, extraBody: prov && prov.extraBody,
  });
}

/** 轮次上限 = 各工具预算之和（与浏览器侧同一算法） */
function roundBudget(val2) {
  const num = (k, def) => Math.max(1, Math.floor(Number(val2(k)) || def));
  const budget = {
    search: 0, aux: 0, fs: 0, exec: 0,
    maxSearch: num('tool_search_max', 3), maxAux: num('tool_mem_max', 8),
    maxFs: num('plugin_fs_max', 12), maxExec: num('plugin_exec_max', 6),
  };
  return { budget, maxRounds: Math.max(2, budget.maxSearch + budget.maxAux + budget.maxFs + budget.maxExec) };
}

/** 内核回调 → 事件流（形状与浏览器侧 turnHooks 一致，界面因此同一套渲染）。
 *  追踪条的状态在这里维护（token = 在下标），因为内核会把 onToolStart 的返回值原样
 *  回传给 onToolEnd——不返回就等于丢弃了这次工具的结果与耗时（实测踩过）。 */
/** @param {object} C core 装配（labelOf 的唯一真源在 core/agent-defs.js：两端必须同一个标题） */
function loopHooks(run, C) {
  const live = () => run.live || {};
  const traceOf = () => { const l = live(); if (!Array.isArray(l.trace)) l.trace = []; return l.trace; };
  const labelOf = (call) => (C && C.AgentDefs ? C.AgentDefs.labelOf(call) : (call && call.name) || '');
  return {
    onTurnStart: ({ round }) => emit(run, { type: 'turn_start', round }),
    onDelta: ({ type, text }) => {
      const ev = type === 'thinking' ? { type: 'thinking', text } : { type: 'content', text };
      applyToLive(run, ev);
      emit(run, ev);
      persist(run, false).catch(() => {});
    },
    onToolStart: ({ call }) => {
      const trace = traceOf();
      const token = trace.length;
      const label = labelOf(call);
      trace.push({ kind: 'tool', state: 'running', label, name: call.name, ok: true, note: '' });
      emit(run, { type: 'tool_start', token, name: call.name, args: call.args, label });
      return token;
    },
    onToolEnd: ({ call, token, result, ms }) => {
      const label = labelOf(call);
      const at = traceOf()[token];
      if (at) Object.assign(at, { state: 'done', ok: result.ok !== false, note: result.note || '', args: call.args, result: String(result.text || '').slice(0, 4000), ms });
      emit(run, {
        type: 'tool_end', token, name: call.name, args: call.args, label,
        ok: result.ok !== false, note: result.note || '', result: String(result.text || '').slice(0, 4000), ms,
      });
    },
    onNotice: ({ kind, text }) => {
      if (kind === 'error') return;
      traceOf().push({ kind: 'notice', state: 'done', label: text, ok: true, note: '提示' });
      emit(run, { type: 'notice', kind, text });
    },
    onEnd: () => {},
  };
}

/** 收尾：把内核结果合并进 live、落盘、广播结束事件、释放占用。
 *  **async 是有意的**：落盘要**写完再广播 end**——客户端收到 end 之后可能立刻重拉会话
 *  （标题、最终内容），落盘还没完成的话它拉到的就是半截快照，界面会停在"正在思考…"。 */
async function finish(run, out, err) {
  if (run.finished) return;      // 幂等：execute 的 catch 兜底再调一次时不会重复广播/重复释放
  run.finished = true;
  const live = run.live || (run.history[run.history.length - 1] || {});
  if (out) {
    if (out.content) live.content = out.content;
    if (out.thinking) live.thinking = out.thinking;
    live.stats = out.stats;
    if (out.stopped || run.abort.signal.aborted) live.content = (live.content || '') + '\n\n*[已停止生成]*';
    run.status = run.abort.signal.aborted ? 'stopped' : 'done';
  } else {
    const msg = err && err.message ? err.message : String(err);
    run.status = run.abort.signal.aborted ? 'stopped' : 'error';
    run.error = msg;
    if (live.content) live.content += '\n\n*[请求失败：' + msg + ']*';
    else { live.content = ''; live.error = '请求失败：' + msg; }
  }
  delete live.streaming;
  live.wallMs = Date.now() - run.startedAt;
  run.endedAt = Date.now();
  /* 收尾时还排着的插话**交回给界面**（回填输入框）——绝不静默丢弃，
     与浏览器侧"放回输入框 + 一条提示"是同一条产品约定。 */
  if (run.steering.length) {
    emit(run, { type: 'steer_leftover', texts: run.steering.splice(0) });
    reg.steerPending(run);
  }
  await persist(run, true).catch(() => { /* 写盘失败：把结果留在内存里，下面照常广播结束 */ });
  /* 广播 end 时**把这一轮的压缩摘要一起交回**：客户端收到 end 会把这一轮写回自己的会话对象
     （切走也不丢），而摘要只有服务端有——不带回去的话，那次写回会把服务端刚写的摘要抹掉
     （下次得重新压一遍、界面上的摘要条也会消失）。null = 这一轮结束时确实没有摘要。 */
  emit(run, {
    type: 'end', status: run.status, error: run.error || '', ms: live.wallMs,
    compaction: run.session && run.session.compaction ? run.session.compaction : null,
  });
  reg.release(run);
  /* 收尾后把订阅者留着（它们会自己断开），运行本体保留一段时间供"回来接上" */
  for (const res of run.clients) { try { res.end(); } catch { /* 已断 */ } }
  run.clients.clear();
}

module.exports = { execute, persist, finish, roundBudget, buildOpts };
