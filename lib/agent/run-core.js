/** lib/agent/run-core.js —— 托管运行用的 **core 层装配**（进程内单例）
 *
 *  循环、工具、协议、组装全都复用浏览器那一份（agent/src/core/*），这里只做两件接线：
 *    ① `installBridge()`：把 core 发出的 HTTP 换成**进程内直调**真实处理函数（run-bridge.js），
 *       于是工具执行只有一份实现，预算/确认/错误分类一行都不用改；
 *    ② `transport.setTransport()`：把"最后一跳"换成服务端直连上游（run-upstream.js），
 *       于是浏览器侧永远不会装到这个实现（模型流量仍走本站代转）。
 *
 *  模块级单例 = 同一时刻只允许一个托管运行（见 run-registry.js 的说明）。
 *  这里不碰任何账号数据：账号数据由 run-loop.js 在**每次运行开始时**灌进登记表。
 */
let CORE = null;

async function core() {
  if (CORE) return CORE;
  const [agent, defs, ctx, mem, prompts, params, policy, runner, proto, assemble, http, sessions] = await Promise.all([
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
    import('../../agent/src/core/http.js'),
    import('../../agent/src/core/sessions.js'),
  ]);
  const { installBridge } = require('./run-bridge');
  await installBridge();
  /* 协议层的上游一跳换成服务端直连（浏览器侧永不装）：同一份适配器，
     于是 think 拆分、正文型工具调用识别、截断保护这些两端完全一致。 */
  const transport = await import('../../agent/src/core/protocol/transport.js');
  const { nodeChat, nodeModels } = require('./run-upstream');
  transport.setTransport({ chat: nodeChat, models: nodeModels });
  CORE = {
    Agent: agent.Agent, AgentDefs: defs.AgentDefs, AgentContext: ctx.AgentContext,
    Memory: mem.Memory, Prompts: prompts.Prompts, Params: params, AgentPolicy: policy.AgentPolicy,
    ToolRunner: runner.ToolRunner, getProtocol: proto.getProtocol, Assemble: assemble.Assemble,
    Http: http, Sessions: sessions.Sessions,
  };
  return CORE;
}

/** 仅供测试/诊断：core 是否已经装好 */
const loaded = () => !!CORE;

module.exports = { core, loaded };
