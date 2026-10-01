/** lib/agent/run-core.js —— 托管运行用的 **core 层装配**
 *
 *  循环、工具、协议、组装全都复用浏览器那一份（agent/src/core/*），这里只做两件接线：
 *    ① `installBridge()`：把 core 发出的 HTTP 换成**进程内直调**真实处理函数（run-bridge.js），
 *       于是工具执行只有一份实现，预算/确认/错误分类一行都不用改；
 *    ② `transport.setTransport()`：把"最后一跳"换成服务端直连上游（run-upstream.js），
 *       于是浏览器侧永远不会装到这个实现（模型流量仍走本站代转）。
 *
 *  **一份运行一份实例**（2026-10-01 起）：可以并存多段运行，所以有状态的那五个 core 模块
 *  （Prompts / Memory / AgentDefs / AgentContext / ToolRunner）一律用 `createX()` 现造，
 *  互不共享闭包——A 的提问不会看到 B 的提示词、技能、记忆、预算与确认框。
 *  无状态的那几个（Agent / Params / AgentPolicy / Assemble / Sessions / protocol）全进程共用一份。
 *
 *  两份东西是**进程级**的，与并发无关：
 *    · 进程内桥（core/http.js 的 fetch 实现 + 按运行取账号的 AsyncLocalStorage）；
 *    · 上游直连（run-upstream.js，账号在每次请求时从桥上下文里取）。
 */
let LOADED = null;

/** 加载静态 core 模块并完成进程级接线（只做一次） */
async function modules() {
  if (LOADED) return LOADED;
  const [agent, defs, ctx, mem, prompts, params, policy, runner, proto, assemble, sessions] = await Promise.all([
    import('../../agent/src/core/agent.js'),
    import('../../agent/src/core/agent-defs.js'),
    import('../../agent/src/core/context.js'),
    import('../../agent/src/core/memory.js'),
    import('../../agent/src/core/prompts.js'),
    import('../../agent/src/core/params.js'),
    import('../../agent/src/core/policy.js'),
    import('../../agent/src/core/tool-runner.js'),
    import('../../agent/src/core/protocol.js'),
    import('../../agent/src/core/assemble.js'),
    import('../../agent/src/core/sessions.js'),
  ]);
  const { installBridge } = require('./run-bridge');
  await installBridge();
  /* 协议层的上游一跳换成服务端直连（浏览器侧永不装）：同一份适配器，
     于是 think 拆分、正文型工具调用识别、截断保护这些两端完全一致。 */
  const transport = await import('../../agent/src/core/protocol/transport.js');
  const { nodeChat, nodeModels } = require('./run-upstream');
  transport.setTransport({ chat: nodeChat, models: nodeModels });
  LOADED = {
    /* 无状态、可共用 */
    Agent: agent.Agent, Params: params, AgentPolicy: policy.AgentPolicy,
    getProtocol: proto.getProtocol, Assemble: assemble.Assemble, Sessions: sessions.Sessions,
    /* 有状态、按运行现造 */
    createPrompts: prompts.createPrompts, createMemory: mem.createMemory,
    createAgentDefs: defs.createAgentDefs, createAgentContext: ctx.createAgentContext,
    createToolRunner: runner.createToolRunner,
  };
  return LOADED;
}

/** 造一份**本轮运行专用**的 core 实例（登记表/记忆/工具执行/上下文管理都是新的） */
async function createCoreContext() {
  const M = await modules();
  const Prompts = M.createPrompts();
  const Memory = M.createMemory();
  Memory.init({ Prompts });      // 记忆区块的抬头文案取自登记表（原先服务端这条没接，一直在用兜底文案）
  return {
    ...M,
    Prompts, Memory,
    AgentDefs: M.createAgentDefs(),
    AgentContext: M.createAgentContext(),
    ToolRunner: M.createToolRunner(),
  };
}

/** 共享的静态模块（不造实例）：会话对账、标题生成这类纯函数用它 */
const core = modules;

/** 仅供测试/诊断：静态层是否已经装好 */
const loaded = () => !!LOADED;

module.exports = { core, modules, createCoreContext, loaded };
