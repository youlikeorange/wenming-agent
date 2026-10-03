# 智能体 Agent · 构建工程

`public/llm-chat/` 里那三个文件（`index.html` 除外）都是从这里构建出来的。
**改这个子项目的唯一入口就是本目录的 `src/`**——不要在 `public/llm-chat/vendor/` 里改任何东西（下次构建就没了）。

```bash
npm install            # 首次
npm run build          # 产出 ../public/llm-chat/vendor/{agent.js,agent.css}
npm run watch          # 监听 JS 改动（CSS 改动仍需重跑一次 build）
npm test               # node --test：217 个用例
npm run lint           # eslint（显式开 no-undef）
npm run dup            # jscpd：重复代码块
npm run cycles         # madge：模块环
npm run check          # 四件套一起跑
```

审计记录（每一轮改了什么、为什么、怎么验证的）在 [AUDIT.md](./AUDIT.md)。

**查字典的文档**：[docs/MODULE-MAP.md](./docs/MODULE-MAP.md) —— 模块 / 端点 / 数据地图：
前端状态字段 ↔ 端点 ↔ 磁盘文件对照、每个端点的请求/响应、提示词登记表（技能）的完整数据流、
"改某个功能要动哪几个文件"的落点表、以及每条都真踩过的坑。**改代码前先看它**，能省一遍通读；
流程与启动顺序看 [ARCHITECTURE.md](./ARCHITECTURE.md)。

## 目录

```
src/core/                零框架的业务逻辑（不碰 DOM，可在 Node 下直接单测）
  endpoints.js             与服务端的唯一契约（所有 /agent/* 路径都在这里）
  http.js                  统一请求层（注入单窗口标识头、错误分类）
  params.js                参数 schema 的唯一真源（默认值/范围/说明/适用协议 + 三层取值解析）
  protocol.js              协议注册表 + 服务商模板
  protocol/                openai.js · anthropic.js · sse.js（分帧）· think.js（思考标签拆分）·
                           textcalls.js（把“写成正文的工具调用”认回来）· transport.js
  agent.js                 Agent 循环（双循环 + Steering + 工具五步 + 截断/空回答/重复调用保护）
  agent-defs.js            工具定义与注册闸门（未登录/未绑定 → 不注册文件与命令工具）
  tool-runner.js           工具执行（预算、危险命令授权、错误分类）
  context.js               上下文：token 估算、用量、自动压缩、裁剪兜底
  prompts.js               提示词登记表（所有注入文本，可看可改可恢复默认）
  memory.js                记忆（全局 + 项目 + 会话；项目记忆与服务端的 .md 文件夹同步）
  policy.js                访问级别与"总是允许"规则
  markdown.js              Markdown 渲染
  store.js / binding.js / presence.js   服务端存储 / 绑定 / 单窗口互斥的客户端

src/ui/                  React 界面
  main.jsx  App.jsx        入口与外壳（含 init 失败的兜底屏：读 state.bootError）
  styles.css               Tailwind 入口 + 主题令牌（data-theme / data-accent / data-density）
  lib/format.js            纯格式化函数（路径/时间/字符/字节/数值/token/相对时间）——**只有这一处**
  lib/trace.js             追踪条条目的纯函数（kind/state 规范化 + 收尾合并，可在 Node 下单测）
  state/store.js           状态容器（快照式订阅，见下）
  state/host.js            把 core 接到界面的**宿主对象**：依赖注入 + 提示词组装 + 确认框 + guardStreaming
  state/session.js         一轮对话的编排：send 拆成 startTurn/runTurn/deliverTurn/failTurn 四个阶段
  state/projects.js        项目动作：选/建/改名/归档项目、目录浏览（起点内）、会话与项目记忆的跟随
  state/settings.js        设置类动作：外观 / 模型 / 参数 / 绑定 / 工具 / 记忆 / 数据 + 压缩的唯一入口
  features/                侧栏（按项目/时间分组、归档按钮）、顶栏、对话区、消息、输入区、目录选择器、弹层
  features/settings/       设置抽屉的十个分区（含 项目 / 存档）+ 共用零件（parts.jsx）
  components/ui/           shadcn 风格基础组件（只留本界面真正用到的那些）

test/                    node --test 用例（217 个，含并行会话与子智能体的行为回归）
build.mjs                构建脚本（esbuild + Tailwind CLI）
```

服务端在仓库根的 `lib/agent/`：公共件 `lib/lock.js`（按键串行锁的唯一实现）、
`lib/agent/lock.js` 已并入它；请求体上限的真源是 `lib/agent/store.js` 的 `MAX_BODY_BYTES`
（路由层引用它，不许再写死数字）。

## 多会话并行 · 子智能体 · 统一事件口（2026-10-01）

**并行**：服务端可以同时跑多段运行——一条会话一段，每个账号最多 3 段、全进程最多 8 段
（`AGENT_RUNS_PER_ACCOUNT` / `AGENT_RUNS_TOTAL` 可调）。界面因此**生成中也能切会话、也能新建对话**：
`state.streaming` 的含义收窄成"**当前这条**会话正在生成"，别的会话在跑不挡你任何操作（侧栏会转圈标记）。
实现要点：每段运行持有自己的 core 实例（`createCoreContext()`），所以登记表/记忆/上下文互不串。

**统一事件口**：界面只连一条 SSE（`GET /agent/run/hub`），它推本账号**全部**运行的事件，
每条事件带 `runId / sessionId / liveId`——客户端据此把事件写回"它那条会话"的助手消息。
`GET /agent/run/events?id=` 仍保留（单段诊断用），界面不再使用。

**子智能体**（`spawn_agent`）：模型可以把一件独立的事派给子智能体——它跑在**自己的上下文**里，
默认**只读**（读文件/找文件/联网搜索/查记忆/加载技能），**不能**再派子智能体；结论作为工具结果回到主对话，
过程实时显示在那张"👥 子智能体"卡上（可点「查看子智能体记录」看完整转录）。
参数在「设置 → 权限与工具 → 子智能体」：开关、单轮最多派几次、同时最多几个、每个最多几轮、是否允许它改东西；
`spawn_agent` 自己也接受 `label / max_rounds / allow_write / provider`（工具参数只能更严，不能更松）。

**传输文件（待下载）**：每个账号在服务端有一个待下载目录（`STATE_DIR/agent/<账号>/downloads/`）。
模型用 `deliver_file` 把产出物放进去；界面顶栏的「📥 待下载」菜单列全部内容（点一下就下载），
会话里那张工具卡片上也有同样的下载链接——两处都是**普通 `<a href download>` 链接**直连
`GET /agent/files/download?name=`（浏览器自己下载，不经 JS 中转）。
**可执行文件不给裸的**：发布时就打包成 `<名>.zip`（目录里根本不出现裸的可执行文件），
下载时再兜一道（手动拷进来的也会现打成 zip）；判据 = **只看后缀名**（exe/deb/rpm/apk/appimage/…，
各操作系统里双击就跑或装的那些，不分大小写）。**不看执行位**——NTFS/exFAT 挂载点会把所有文件都报成
0777，按执行位判会把数据盘上的普通文档也打成 zip（2026-10-03 用户报，已改）。
它在「设置 → 权限与工具 → 文件与目录」里可以关（`plugin_deliver_on`），读取路径走与读文件同一套闸门。

**LLM 出错要在会话里看得见**：上游报错 → 会话里出现红色错误块（带**上游自己说的话**，如
`HTTP 401：Missing or invalid API key…`）+ 「重试这一轮」；错误会落盘（刷新后还在），侧栏那条会话也会标出来。

## 内设上限都可调（2026-10-02）

以前"读文件在追踪条里只留 4000 字"这类数字硬编码在七个地方，用户撞上了也没有入口。
现在凡是会撞到的内设数字都归到「设置 → 权限与工具」，默认值只在 `agent/src/core/params.js`
的 `TOOL_FIELDS` 里写一次：

- **结果与记录**（新分组）：追踪条单条结果上限（默认 4000 字）、追踪条单条参数上限（2000 字）、
  压缩输入单条上限（4000 字）。**只影响记录与显示**——发给模型的内容不受它们限制；
- **子智能体**：多了一项「每个转录保留几步」（默认 200）；
- **文件与目录**：补上「单次写入上限」（4MB）与「目录树/找文件结果上限」（800 项），
  与原有的单次读取/输出上限一样**只能比服务端硬上限更小**；
- 服务端硬 5 项（读/写/输出/节点/超时）在面板底部列出，并写明抬高它们的环境变量
  （`AGENT_READ_MAX_BYTES` 等，改完重启站点生效）；
- 数值控件现在会显示量纲（KB / 秒 / 项 / 字），不再只是一个光秃秃的数字。

改这些参数**不用重启**：托管运行每开一段读一次；追踪条上限同时作用于内核记录、
服务端事件流与浏览器实时显示（三处同一口径，`agent/test/agent-core.test.mjs` 场景 M、
`test/agent-server-test.js` 的两条 ★★ 用例、`test/record-limits-ui-check.mjs` 各守一段）。
另注意「输出上限」管的是**所有工具结果**：读大文件会先被它截一次（默认 16KB），
再被追踪条上限截一次（默认 4000 字）——用户说"读到的内容不全"时两个都要看。

**追踪条会如实报字数**：被记录上限截断时，行末显示「显示了/共 字」（如 `4,000/65,536 字`），
展开详情还有一句说明——截断的只是记录，模型收到的是完整的。这个"共多少字"由条目上的
`resultChars` 字段带来（截断前统计，落盘时白名单放行，刷新后仍在；旧数据没有它就按显示量回推）。

## 改动行数 / 运行时长 / 一键撤销（2026-10-03）

三件事都长在**服务端的一份"运行改动日志"**上（`lib/agent/undo.js`），界面只负责画：

- **信息卡片上的 `+N / −M 行`**：写文件、改文件、删文件（含目录树）、移动时，服务端在工具
  执行前后各拍一次快照，比出行数差（`lineDiff`：先收窄公共前后缀，再按行多重集计数——与
  `git diff --stat` 同口径；纯行序调整算 0）。移动的**源路径不计行数**（文件没被删，只是换了地方）。
- **卡片底部的「本轮用时 X 分 X 秒」**：`msg.wallMs`（服务端从这一轮开始到结束计），随会话落盘，
  刷新/关浏览器回来还在。这条消息的元信息里不再重复写 `12.3s`，只留 tok/s 与 tokens
  （两处都写时间会让人以为是两个不同的数）。
- **「撤销本轮文件改动（N 处）」**：把这一轮新建的文件删掉、改过的写回运行前的内容、删掉的补回来、
  移动的回滚（按**相反顺序**重放日志，同一文件被改两次也能回到最初）。确认框里列出文件清单，
  撤销后原地留一句「已撤销 N 处文件改动」，刷新后仍是这个状态。

数据在哪：`STATE_DIR/agent/<账号>/undo/<会话id>/<运行id>/`（`meta.json` + `blobs/`），
按账号+会话+运行隔离，**关掉浏览器、换窗口、重启站点都不丢**（站点重启丢的只是"在途那一轮"，
因为日志在收尾时才落盘）。撤销状态同时写回会话消息（`msg.undo`，`store.js` 的白名单放行）。

四条必须知道的边界（都踩过）：

1. **撤销要过与工具同一套闸门**（roots 白名单 + 绑定账号权限 + 解锁）。没解锁时一个文件都不会动，
   界面会直接打开「本机账号」的解锁表单；**全部失败时日志不标"已撤销"**，解锁后可以再点一次
   （部分失败也一样：按钮留着，toast 说明还有几处没恢复）。
2. **只覆盖文件工具**（`write_file` / `edit_file` / `create_directory` / `move_file` / `delete_path`）。
   `run_command` 改了什么，进程外无从知晓——文案里如实写着，不做"看起来能撤销"的假象。
3. **备份有上限**：单文件 8MB、目录 32MB/500 项、单轮 200 条/128MB、每账号 200 份/512MB/30 天
   （`AGENT_UNDO_*` 环境变量可调，属"数据保留类"、刻意不上面板）。备份不下的路径撤销时**如实报失败**
   （"没有备份"），其余路径照常恢复。
4. 日志的取数只有一条路：按 `runId` 找（`readJournal`）。会话被**彻底删除**时日志一并清掉
   （归档保留——归档能恢复，日志也要跟着回去）。

验证：`test/agent-server-test.js` 的 undo 小节（行数差、七种改动 → 撤销恢复原状、备份不下时的诚实、
没解锁时不动文件且可重试、端点端到端、落盘白名单）+ `agent/test/undo-ui.test.mjs`（事件 → 消息 → 渲染）
+ `test/undo-ui-check.mjs`（**真实 Chrome**，跑在**自带沙箱站点**上：卡片行数/时长/按钮 →
未解锁被拦 → 界面解锁 → 重试成功 → 磁盘文件真恢复 → 刷新后仍在，20 项）。

## 设置面板的两页边界 + 内置联网搜索可关（2026-10-03）

- **「参数」页只放模型生成参数**（`core/params.js` 的 `FIELDS`：温度/采样/重复惩罚/上下文上限/
  额外请求体），可以按模型单独覆盖；**「权限与工具」页只放工具与权限**（`TOOL_FIELDS` 与访问级别）：
  能不能用（开关/确认/访问级别）、**能调用几次**（单轮与每个子智能体的次数）、单次能读/写/输出多大
  （各上限）、工具能碰哪些目录。两页曾各画一份工具参数（同键两处可改）——已去重：
  `ParamsSection.jsx` 不许再引用 `TOOL_FIELDS`（`agent/test/params.test.mjs` 有源码级守门用例）。
- **内置联网搜索可关**：开关在「设置 → 权限与工具 → 联网搜索 → 内置联网搜索（web_search）」。
  它读写的**不是参数**，而是提示词登记表里那条内置技能 `skill.web_search` 的启停（唯一真源）——
  关掉 = `web_search` 工具不注册（`core/agent-defs.js` 的 `searchOn()`）+ 它的技能正文与
  工具描述都不再注入（`core/prompts.js` 的 `systemBlocks()`）；「提示词 → ② 技能 → 联网搜索」
  那一行是同一个值的另一个视图。需要联网时可以自己装一份搜索技能（`skill_import` 或面板新建），
  例如让模型用 `run_command` 调一个搜索 CLI。
  验证：`node test/settings-menu-ui-check.mjs`（真实 Chrome + CDP，21 项：两页归属、
  开关落盘 `prompts.json`、发送预览里区块与工具数各少 1）。

## 多轮上下文里有什么（2026-10-02 实测钉住的契约）

- **同一条运行内**：模型在工具调用之后的下一次调用里，一定看得到工具输出全文（且与 `tool_calls`
  的 id 正确配对）——这条有回归用例守着（`test/agent-server-test.js` 的「多轮上下文」★★）。
- **跨轮**：带上的是"用户原话 + 助手自己上一轮的正文"；**原始工具输出不带**。会话里只落
  `user` 与 `assistant`（正文 + 追踪条），工具消息只活在运行时内存里；追踪条里的工具结果
  **只给界面看，不进模型**。所以第二轮模型看不到上一轮 `read_file` 的原文，只会看到自己上一轮
  写下的结论——需要原文它会再读一次（读类工具不受"重复调用保护"拦，就是为这条留的路）。
- **压缩（compaction）**触发后：较早的消息（含同轮内的工具原文）在**请求里**被摘要替换；
  原文仍留在会话里，界面上可以展开看。
- 想改成"工具输出跨轮保留"是个产品决策，要一起动三处（成对持久化 assistant+tool、
  `Assemble.toApiMsg` 补 `toolCallId`、压缩/裁剪懂配对），见 `docs/MODULE-MAP.md` §6.1。

## 六条要记住的约定

1. **core 不认识 React**。core 需要的一切都通过 `init(deps)` 注入（宿主实现在 `src/ui/state/host.js`），
   所以它能在 Node 下单测，换界面时一行不用改（手写 DOM 换成 React 时验证过这一点）。
2. **状态容器用"快照"语义**（`ui/state/store.js`）：`patch()` 就地更新 `state`，但每次 emit 前重建一份浅拷贝   作为 `getSnapshot()` 的返回值——`useSyncExternalStore` 只在**引用变化**时重渲，
   直接返回那个被就地改的对象会导致界面一次都不更新（实测踩过）。
3. **扩展字段默认值不下发**（`core/params.js` 的 `toRequestParams`）：`top_k` / `seed` / 惩罚项这类
   "各家叫法不同、不认识的字段有的忽略有的直接 400"的参数，只在用户改过时才发出去。
   想要"协议之外"的厂商参数，用服务商配置里的**额外请求体（JSON）**。
4. **适配器的 `chat(cfg, messages, params, opts)` 第 4 个参数是 opts，不是参数表**。
   `opts.signal`（点「停止」要中断在途请求）与 `opts.sessionId`（服务端写进"会话标识头"，
   opencode 的 Go 网关缺它就 400）都靠它传下去。`ui/state/session.js` 里那句
   `stream: (messages, o, signal) => …chat(p, messages, o, { signal, sessionId })` 是唯一入口——
   曾经把 signal 当 opts 传（适配器读 `opts.signal` 恒 undefined），"停止"只能等上游写完。
   同理，服务商配置的字段还要在 `ui/state/host.js` 的 `settingsForSave()` **白名单**里登记，
   否则表单里改了也存不下来（漏 sessionHeader 实测踩过）。
5. **让用户自由打字的输入框一律用 `components/ui/ime-field.jsx` 的 `ImeInput` / `ImeTextarea`**（非受控 + 输入法组合态保护）。
   受控输入框每次输入后 React 都要把值回写 DOM，而 Chromium 的输入法组合态经不起这次回写：
   组合被取消后，下一次预编辑不是"替换上一段"而是"插到光标处"，于是拼音与汉字叠加、
   一个键出多个字母（`n` → `nni` → `nninihao你好`）。包装里 `value` 只当"外部真源"，
   只在**外部**改动（预填 / 清空 / 恢复默认 / 快选）且不在组合中时才写回 DOM，
   组合结束后把最终文本再上报一次；用户打字全程不经过 React 的受控往返。
   消息输入框（`features/Composer.jsx`）有一套等价的内联实现（它还要自增高 / Enter 发送 / Tab 模板菜单），
   同样别给它加 `value`/`defaultValue`，`placeholder` 也要保持恒定。
   验证姿势：真实 Chrome + CDP 的 `Input.imeSetComposition`（比在页面里派发合成 CompositionEvent 真实），
   同一序列打在普通 textarea 上做对照——两者的结果必须一致（现成脚本：`../test/ime-composition-check.mjs`，
   覆盖消息输入框、提示词编辑框、新建技能 / 记忆 / 登录等输入框；框里有初始文本时用同一初始文本做基准）。
6. **项目记忆的"空列表回写"会抹掉服务端的种子记忆**：项目记忆的真源是服务端账号目录里的
   Markdown 文件夹（`STATE_DIR/agent/<账号>/projects/<项目id>/memory/*.md`），前端只是镜像。
   `Memory.setProject(meta, entries)` 一旦 emit，宿主就会把当前列表整份写回服务端——
   所以**建项目后必须先把服务端返回的真实条目灌进 core**（含服务端种下的那条「项目根目录」），
   否则一个空数组就把刚生成的记忆抹了（实测踩过）。同理：没有当前项目时**绝不**发项目记忆写请求
   （见 `ui/state/host.js` 的 `Memory.onChange`）。
7. **"归档"是侧栏唯一的删除动作，"彻底删除"只在设置 → 存档里**：会话/项目归档走 `lib/agent/archive.js`
   （搬进 `STATE_DIR/agent/<账号>/archive/`，内容一字不改、也不再进上下文）。前端归档前必须先
   `Store.archiveSession(id)` 取消它在途的落盘（`pendingSessions`），否则排队中的写入会把会话又写回列表。
8. **改登记表数据必须让它自己通知**（`core/prompts.js` 的 `notify()`）：宿主的落盘与重绘都挂在
   `Prompts.onChange` 上。曾经 `addSkill` / `updateSkill` / `removeSkill` 都不通知（`onDirty` 更是
   全项目从未接线），于是**模型用 skill_write 建的技能只活在内存里，刷新即丢**——
   而 UI 那条路径"看起来正常"，只是因为它显式调了 `syncPrompts()`。新加任何写入入口都要调 `notify()`。

9. **正文里的工具调用必须认回来**（`core/protocol/textcalls.js`）：
   上游会把工具调用写进正文（DeepSeek 系列的 DSML 标记、或老 XML 形态），
   旧实现只读 `delta.tool_calls`，于是整块被当成“最终回答”、循环直接收尾。
   两个适配器的正文流都过这道拆分器；认不出的块**原样当正文**，绝不吞内容。
   另：`core/context.js` 的 `summarize()` 必须在 `buildOptions()` 的**副本**上删 `tools`
   ——它返回的是宿主正在用的请求参数对象，直接 delete 会让本轮剩下的每一次请求都不再带工具。

10. **流式重绘要有上限**（`ui/state/session.js` 的 `touchSoon()` + `ui/features/Message.jsx` 的尾巴模式）：
    每个 token 都重绘整棵树、每次都把**整篇正文**重新解析成 Markdown，
    在长回答下是平方级开销（实测 400KB 正文：渲染进程 100% CPU、交互被饿死）。
    现在：重绘合并到 ~12fps；正文超过 2 万字时流式期间只画尾巴（纯文本、DOM 恒定），
    收尾再整体渲染一次；工具参数落盘前过 `Agent.shrinkArgs()`
    （`write_file` 的参数里带着整个文件内容）。

11. **提示词登记表是"草稿 → 应用"制，草稿住在 `state.promptDrafts`**（`ui/state/settings.js`）：
    输入只写草稿，点「应用」才写进登记表（登记表自己 notify → 落盘）。所以"有未应用的修改"
    是**界面状态**而不是 core 状态——`ui/state/host.js` 的 `promptDraftCount()` 是唯一口径
    （面板徽章与发送前提醒共用它）。**不要**再往 `Prompts` 上挂 `isDirty` 之类的函数：
    审计时发现有两处在调一个从未存在的 `Prompts.isDirty()`，那个徽章从来没显示过。

12. **追踪条条目的判据是结构化字段 `kind` / `state`，不是中文文案**（`ui/lib/trace.js`）：
    `kind: 'tool'|'notice'|'steer'|'compact'`、`state: 'running'|'done'`，收尾合并用纯函数
    `mergeTrace()`（有单测）。旧会话数据没有这两个字段，`traceRunning()` 会按当年的文案
    回推一次——兼容逻辑只在那一个函数里，别处不许再出现 `note === '进行中'` 这种判断。
    另外 `addTraceStrip` 的 token 记的是**消息对象与条目本身**，不再用 history 下标
    （历史被裁剪/回撤后下标记会静默错位，追踪条会永远停在"进行中"）。

13. **同一件事只许有一份实现**（本轮审计的教训，见 AUDIT.md）：格式化函数在 `ui/lib/format.js`
    （字符/字节两种单位分开命名）、确认框只有 `askConfirm`（组件侧
    `const r = await askConfirm({title, body, okText, danger}); if (r.ok) …`）、
    "生成中不许做某事"用 `host.guardStreaming('新建对话')`、压缩只有 `settings.js` 的两个动作、
    状态订阅只有 `store.js` 的 `useApp`、服务端的按键锁只有 `lib/lock.js`。
    新增一处重复之前，先想清楚为什么上面这些不够用。

14. **"当前项目"= 当前会话归属的项目**（2026-10-01 起，见 AUDIT.md 第四轮）：会话的 `project`
    字段是唯一真源，服务端 `projects.json` 的 `current` 只是它的镜像。两个方向必须走同一份实现
    （`ui/state/host.js` 的 `adoptProject` + `ui/state/projects.js` 的 `applyCurrentProject`）：
    在设置里切项目 → 换会话（`followProject`），点开别的项目的会话 → 换项目
    （`followSessionProject`，经 `hooks.onSessionChange` 回调，别直接 import：session ↔ projects 会成环）。
    原因：一轮运行用什么项目记忆由**会话**决定（`lib/agent/run.js`），两边不一致就会出现
    "我在看 A 的对话、菜单里却是 B 的记忆"。菜单显示的数据一律**按当前项目从服务端取**
    （打开记忆面板 / 一轮结束 / `data_changed` 都重拉），本地还有没落盘的改动时先等它落地再拉。

15. **刷新页面要能接上服务端在跑的那一轮**（`ui/state/run.js` 的 `reattach`）：**不能**用消息对象上的
    `streaming` 判断"本地已经在跟"——托管运行一开始就把 `streaming: true` 的占位写进了会话，
    刷新后从服务端拉到的历史里它恒为 true（旧实现据此 return，用户看到的就是"agent 停了"）。
    判据只能是本地那条读取连接（模块里的 `cur`）；读取断开也不等于这一轮结束：排一次自动重连
    （回到前台 / 网络恢复也会补一次），由服务端裁定；已经结束就先 `hooks.onPullLatest` 重拉落盘那份
    再判孤儿。服务端那边配套：`finish()` **await 落盘后才广播 `end`**（客户端收到 end 会立刻重拉）。

16. **取数归口：显示数据只有一条取数路径，模型流量也走统一请求层**（2026-10-01，见 AUDIT.md 第五轮）：
    · **项目记忆**的唯一取数路径是 `GET /agent/projects/memory?id=`——`GET /agent/store`（含 `?light=1`）
      **不带** `projectMemory`，只给"当前项目指针"。载入数据后由 `syncProjectWithSession()` 取回来；
      组件永远不读第二份副本。`adoptProject(project, entries)` 的硬约定：entries 必须是**服务端那次 GET 的结果**
      或者干脆不给（`undefined` = 不改条目）——拿本地拼的（尤其空）数组灌进去会 emit 一次整份回写，
      把那个项目的记忆抹空（踩过两次）。项目记忆的**写入目标 id 与条目一起入队**（`core/store.js`），
      不能在 flush 时才读当前项目（600ms 防抖窗口里切项目 = A 的记忆写进 B）。
    · **模型流量**（`core/protocol/transport.js`）用 `core/http.js` 的 `request(..., { raw: true })`，
      不再自己 fetch：窗口标识头 `X-Agent-Client`、首字节超时、abort 转发、错误分类（needLogin/kicked/upstream）
      都只有那一份实现。**别在别处再写 fetch**——唯一例外是 `core/presence.js`（它自己就是"顶掉"机制，
      必须在被冻结时仍能发言，见那份头注）。
    · `newSession`/`ensureSession` 也要写 `settings.currentSess`（当前会话指针）：`applyServerData` 按它挑
      "刷新后回到哪条对话"，漏写会导致整份重拉时画面切回上一条会话；`refreshAll` 另有 `preferSess`
      兜底"保持用户正在看的会话"。

## 与服务端的边界

服务端在 `../lib/agent/`，端点契约见 `src/core/endpoints.js`（**改契约只改这一处**）。
两边各自有单测：这里跑 `npm test`，服务端的跑 `node ../test/agent-server-test.js`。
`GET /agent/store?light=1` 是"只要面板数据（记忆/提示词/项目清单）、不要会话"的形态：
托管运行结束或模型改过数据后客户端用它刷面板，**生成中不要**拉整份 store
（会把正在流式写入的消息对象换掉，事件就落到旧对象上了）。项目记忆两种形态都不带，
见约定 16。
