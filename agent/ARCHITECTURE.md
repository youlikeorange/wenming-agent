# 智能体 Agent · 模块与调用流程（2026-10-01）

这份文档回答两个问题：**每个模块被谁调用、它自己又做了什么**，以及**一条消息从输入框到落盘的完整路径**。
配套文档：`README.md`（怎么用）、`docs/MODULE-MAP.md`（模块/端点/数据地图：查端点、查数据落在哪个文件、
查"改某个功能动哪几个文件"用那份）、`AUDIT.md`（历轮审计与修复）、仓库根 `PROJECT-STRUCTURE.md`（全站结构）。

阅读顺序建议：先看第 1 节的图与第 2 节的分层，再按第 3 节走一遍主流程（这是最常走的一条路），
第 4 节是"一轮循环内部"的细节，第 5 节是其余入口，第 6 节是逐模块清单（查字典用），
第 7 节是"谁能写哪个文件"的真源表，第 8 节是**必须守住的不变量**（每条都对应一次真实故障）。

---

## 1. 三层结构

```
┌──────────────────────────── 浏览器（agent/src/ui）────────────────────────────┐
│  React 组件（features/）        界面状态容器（ui/state/store.js）               │
│  动作层（ui/state/*.js）：session / run / settings / projects / host           │
│  —— 只做"显示"与"把人的操作送出去"；**不跑 agent 循环**                        │
└───────────────┬───────────────────────────────────────────────────────────────┘
                │ 同源 HTTP + SSE（core/http.js 统一出口，带 X-Agent-Client 窗口标识）
┌───────────────▼──────────── 服务端（lib/agent）───────────────────────────────┐
│  index.js（路由）→ session/settings/store/projects/archive/roots/…            │
│  托管运行：run.js ─ run-core / run-registry / run-events / run-confirm / run-loop
│  工具：run-bridge.js（进程内直调 tools/*）  上游：run-upstream.js（直连模型）   │
└───────────────┬───────────────────────────────────────────────────────────────┘
                │ 同一份 core（服务端用动态 import 加载，浏览器用打包产物）
┌───────────────▼──────────────────── 共享 core（agent/src/core）───────────────┐
│  agent.js（循环）/ tool-runner.js（工具）/ protocol/*（协议）/ assemble.js（组装）
│  context.js（压缩与裁剪）/ prompts.js / memory.js / policy.js / params.js …    │
│  —— 零框架、不认识 React、不认识 Express；依赖全部由宿主注入                    │
└───────────────────────────────────────────────────────────────────────────────┘
```

**一句话分工**：界面负责"显示 + 转达"，服务端负责"跑完并落盘"，core 是两边共用的大脑。
同一份 core 两端复用是刻意的：托管运行（服务端跑）与"浏览器自己跑"（已退场）必须行为一致，
否则同一句提问在两条路上会得到不同的 system 区块、工具清单与压缩行为。

---

## 2. 启动：进程起来到页面可用

### 2.1 服务端进程启动

1. `server.js` 起 HTTP 服务 → `lib/api.js` 的 `handleApi` 分派 → 命中 `/agent/*` 时交给
   `lib/agent/index.js` 的 `handleAgent(req, url, res)`。
2. `handleAgent` 的处理顺序（**每条请求都走**）：
   - `presence.clientIp(req)` 取来源 IP；
   - `/agent/info`（GET）与 `/agent/presence` **免登录**：被顶掉的窗口靠它们刷新提示；
   - 其余端点：`authUser(req)`（lib/auth.js，Cookie 会话）→ 未登录按端点回 401 `needLogin`；
   - `presence.guard(req,res,account)`：单窗口互斥（无 `X-Agent-Client` 头的请求放行）；
   - `session.actorOf(account)`：把"文档站账号"解析成"本机执行身份"（含解锁凭据，只在内存）；
   - 按前缀分派到 store / run / binding / upstream / projects / archive / tools / skills / search。
3. `run.js` 加载时会做一件事：`session.onLogout(...)` 注册"登出/解绑 → 掐断该账号在途的托管运行"。

### 2.2 页面加载（agent/src/main.jsx → ui/state/*）

| 顺序 | 调用 | 内部动作 |
|---|---|---|
| 1 | `store.js`（ui 状态容器）模块求值 | 建立 `state` 与快照机制（`patch`/`touch`/`useApp`） |
| 2 | `host.js` 的 `wireCore()` | 把 core 的依赖注入接上：`AgentDefs.init` / `ToolRunner.init` / `AgentContext.init` / `Memory.init`；把 `Prompts.onChange`、`Memory.onChange` 接回 `Store.queuePrompts/queueMemory` + `persistSession`（**整个页面生命周期只注册一次**） |
| 3 | `session.js` 的 `bootstrap()` | `Store.init()` 探针 `/agent/info` → 未登录就用 `defaultSettings()` 起界面；已登录 `Store.pull()` 拉全量数据 → `applyServerData` |
| 4 | `applyServerData(d)` | `Prompts.load` → `Memory.load(global, session)` → `Memory.setProject` → `patch(settings/sessions/history/projects)` → `applyAppearance()` → `updateCtx()` |
| 5 | `syncProjectWithSession()` | 当前项目 = 当前会话的项目；条目走 `GET /agent/projects/memory?id=`（唯一取数路径） |
| 6 | `Run.reattach(sessionId)` | 问 `/agent/run/state`：有在跑的运行就订阅它的 SSE；没有就结清"孤儿占位"（服务端重启过的那种） |
| 7 | 组件订阅 | `useApp()` 读快照；Composer/ChatView/Sidebar/设置抽屉各自渲染 |

---

## 3. 主流程：发一条消息（从回车到落盘）

```
Composer.submit
  └─ session.send(text)                    ← 只做编排，不跑循环
       ├─ blockReason()                    未配置模型 / 被顶掉 / 未登录 = 不发
       ├─ ensureSession()                  没有当前会话就建一条（写 currentSess 指针）
       ├─ startTurn()                      组装"给界面看的那一份"：
       │    · 本轮之前的历史 = before（原样交给服务端）
       │    · 用户消息 + 助手占位（各带稳定 id）立刻进 state.history
       └─ Run.startRun({sessionId, text, providerId, live, before, localEdits})
            ├─ POST /agent/run/start
            └─ ensureHub()        ← SSE：GET /agent/run/hub（**一条流看全部会话**）
```

服务端一侧：

```
run-http.handleRun  /start
  └─ run.startRun(req)
       ├─ gateErrors()                     三道闸：这条会话已在跑 → 409；账号/全局并发上限 → 429
       ├─ store.readSessions → 找会话；没落盘就按 id 现造（客户端防抖窗口）
       ├─ settings.read → 取服务商；没有 → 400
       ├─ createCoreContext()              造**本段运行专用**的 core 实例（登记表/记忆/工具/上下文）
       ├─ Sessions.reconcileHistory(...)   客户端那份落后一轮时用服务端那份（见第 8 节）
       ├─ Sessions.trimTrailingQuestion()  老客户端把提问也放进来时去重
       ├─ reg.create(run)                  登记运行（history/live/core/abort/事件日志/确认表）
       ├─ run.history.push(用户消息, live) 本轮提问只追加这一次
       ├─ loop.persist(run, true)          **先落盘再返回**（关掉浏览器也找得回"我问过什么"）
       ├─ events.emit(run_started, liveId) 向统一事件口宣告这一段开始了（客户端据此认领消息）
       └─ loop.execute(run, req)           后台跑（不 await）——**可以同时跑好几段**
```

浏览器一侧继续：

```
subscribe(runId, sessionId, live)
  ├─ cur = {runId, sessionId, live, ac, ended}     本次连接的身份（判活只看它）
  ├─ patch({streaming:true, abortSignal})
  └─ 逐行读 SSE：HANDLERS[ev.type](ev, msg)
       replay_start → 清空这条消息（除非 truncated）
       content/thinking → 追加到 msg（touchSoon 节流 ~12fps）
       tool_start/tool_end → 写 msg.trace[token]
       notice → 提示条；steer_* → 排队条数与回填草稿
       confirm → askThenAnswer：弹既有确认框，回答 POST /agent/run/confirm
       data_changed → hostHook('onRunDataChanged') → refreshLightSoon()
       end → settle()
```

收尾（浏览器）：

```
settle(ev)
  ├─ 结清 streaming 标记、写 wallMs、失败时追加一行说明（内容一个字都不删）
  ├─ hostHook('onRunEnded', sessionId)
  │    ├─ persistSession(sessionId)   → 把这一轮写回**会话对象**并排队落盘（切走也不丢）
  │    └─ refreshAllSoon(sessionId)   → 1.5 秒后整份重拉（服务端那份标题/记忆/用量）
  └─ 若读流断开（而不是 end）：dropKind(e) 分派
       kicked → 退出生成态（顶部横幅提示换窗口）
       needLogin → 退出生成态 + 弹登录框（进度在服务端，回来还能接上）
       gone(404) → 0.5 秒后 reattach（取回服务端落盘的那份）
       leave（页面要走）→ 什么都不做
       drop（普通断线）→ 保持生成态，2.5 秒后重连一次
```

服务端收尾（`run-loop.finish`）：

```
finish(run, out, err)
  ├─ 合并内核结果进 live（停止时追加 *[已停止生成]*；失败时保留已生成内容）
  ├─ 剩下的插话 → emit steer_leftover（界面回填输入框）
  ├─ await persist(run, true)     ← **写完再广播 end**（否则客户端重拉会拿到半截快照）
  ├─ emit {type:'end'}            ← 浏览器 settle 的触发点
  ├─ reg.release(run)             让出全局占用，运行本体保留 10 分钟供"回来接上"
  └─ 关闭所有 SSE 订阅者
```

---

## 4. 一轮循环内部（core/agent.js，两端共用）

`Agent.run(cfg)` 是 Pi 式的双循环，`run-loop.execute` 只负责给它接线：

1. **内循环**：`transformContext(messages)` → 调模型（流式）→ 有工具调用就执行 → 继续；
   用户插话（Steering）每轮开始前取**一条**注入。
2. **外循环**：内循环结束后取 `getFollowUps()`（收尾时排队的插话）→ 有就再进内循环。
3. **上下文变换**（`AgentContext.transformMessages`，唯一入口）：
   - 压缩开着（提示词 `compact.prompt` 非空且启用）→ `compactMessages`：超过 `ctxLimit*0.8` 时
     让模型把较早对话压成摘要（原文仍在会话里）；本轮内复用摘要，不重复调用。
   - 压缩关掉 → `trimForRequest`：**只裁这一轮发出去的请求视图**（对齐到 user 边界），
     会话原文一条不动；提示条走 `toast` → 事件流。
4. **工具五步**：prepare（截断保护）→ `beforeToolCall`（确认框在这里）→ 执行 → `afterToolCall` → 结果消息。
   - 写类/命令类工具 `toolMode = 'sequential'`（整批串行），其余并行；
   - 重复调用保护只拦"成功过的写类/命令类空转"，读类不拦、失败不入册。
5. **每次调用模型前后**：
   - `run-loop` 的 `loopHooks` 把内核回调翻译成事件（`emit`）并维护 `live.trace`；
   - 流式期间 `persist(run,false)` 按 1.5 秒节流落盘（`store.putSession`）。
6. **人工闸门**（`run-confirm.ask`）：需要点头时推 `confirm` 事件并**等**；超时按拒绝；
   多个确认并存（Map，按 confirmId 结算）；无人值守绝不默认放行。
7. **账号数据回写**：`Prompts.onChange` / `Memory.onChange` 在 `execute` 里注册，
   **收尾时逐个退订**（不退订 = 跨账号覆盖写 + 回调持有 run 不放）。

---

## 5. 其余入口流程

| 入口 | 客户端 | 服务端 | 说明 |
|---|---|---|---|
| 停止 | `session.stop()` → `Run.stopRun()` → POST `/run/stop` | `reg.stopRun` → `run.abort.abort()` | 只掐这一轮；读取连接不断开 |
| 插话 | `Composer`（生成中回车）→ `session.steer` → `Run.steerRun` | `reg.steer` 入队 + 事件回执 | 下一轮开始前注入；失败返回 false，草稿**不清** |
| 确认 | `askThenAnswer` → 既有确认框 | `run-http /confirm` → `run-confirm.answerConfirm` | 只认 run 主人 + confirmId |
| 刷新续播 | 页面加载 → `Run.reattach` | `/run/state` + `/run/events` | 判据是本模块的 `cur`，不是消息上的 `streaming` |
| 换会话 | `session.selectSession` | —— | 历史取自会话对象；`syncProjectWithSession` 跟着换项目 |
| 切项目 | `projects.selectProject` | `POST /agent/projects/current` | 带序号防串台；连续点击只有最后一次算数 |
| 建项目 | `projects.createProject` | `projects.create` | 建记忆文件夹 + 种"项目根目录"那条记忆 |
| 归档 | 侧栏按钮 → `Store.archiveSession` | `archive.archiveSession` | 搬家不销毁；彻底删除只在设置 → 存档 |
| 装技能 | 界面/模型 `skill_import` | `index.handleSkillsImport` → `skills.planImport/applyImport` | 读-改-写在 `store.updatePrompts` 的锁内 |
| 联网搜索 | `tool-runner` → `/agent/search` | `search.handleSearch` → `runSearch` | 并发/频率闸门（`limits.makeGate`） |
| 模型流量 | `transport.browserChat` | `/agent/upstream/*`（浏览器侧）或 `run-upstream.nodeChat`（托管运行） | 密钥永不下发浏览器 |

---

## 6. 模块清单

### 6.1 服务端 `lib/agent/`

| 模块 | 职责 | 被谁调用 | 内部主要操作 / 关键约束 |
|---|---|---|---|
| `index.js` | 路由与守卫 | `lib/api.js` | 探针 → 登录 → 单窗口互斥 → 取 actor → 分派；`bodyLimitFor()` 决定请求体上限（store/projects/run 用 `store.MAX_BODY_BYTES`） |
| `session.js` | 身份层：文档站账号 → 本机账号 → 执行身份 | index / run-bridge / run | `bind`（su 验密码）、`unlock`（内存 vault，12 小时）、`actorOf`（**每次工具执行前重新取**）、`onLogout` 钩子 |
| `settings.js` | 配置（模型/参数/外观/绑定） | index / run-loop / run-upstream | 存 `userdata/<账号>/agent.json`；密钥三态（缺省=保持、null=清除、非空=覆盖）；`patch()` 读改写全在锁内 |
| `store.js` | 大对象：会话 / 全局记忆 / 提示词表 | index / run-loop / skills / projects(引用) | 按账号一个目录；`putSession(s)` 合并+配额+落盘；`enforceQuota` **增量扣减**（不做 O(n²) 全库序列化）；`updatePrompts` 提供锁内读改写 |
| `projects.js` | 项目（根目录 + 记忆文件夹） | index / run-loop | 每条记忆一个 `.md` + `MEMORY.md` 索引；`writeMemory` 在账号锁内（内部用 `writeMemoryLocked` 防自锁）；读不动的大文件不在重写时删除 |
| `archive.js` | 归档区（会话/项目） | index | 搬进 `archive/`，可恢复；`remove` 只接受合法 id（挡路径穿越） |
| `roots.js` / `osaccess.js` / `deny.js` / `grants.js` | 可访问目录白名单 / POSIX 权限判定 / 危险命令清单 / 一次性授权票据 | tools / index | 只收紧不放宽；票据一次性；清单含**站点自保**（进程/服务/受保护路径，`AGENT_PROTECT` 可追加受保护路径） |
| `presence.js` | 单窗口占用 | index | 按 `X-Agent-Client` 头判定；被顶掉的窗口不许让模型干活，也不许写数据 |
| `upstream.js` / `search.js` | 模型代转 / 联网搜索 | index | 出口只允许公网；搜索有并发与每账号频率闸门 |
| `tools/index.js` + `tools/fs.js` + `tools/exec.js` | 文件与命令工具 | run-bridge / index | 每个工具先过 roots + osaccess + deny；命令走 `spawnSpec`（以绑定身份执行） |
| `skills.js` | 技能安装（SKILL.md） | index / run-bridge | `planImport` 解析预览，`applyImport` 在 `store.updatePrompts` 锁内落盘 |
| `run.js` | 托管运行**编排**（公开 API） | run-http / 测试 | `startRun`（校验→对账→登记→先落盘→后台跑）、`attach/answerConfirm/stopRun/steer/stateOf/busyOf`（**全部按 account 过滤**）；注册登出即掐断 |
| `run-core.js` | core 装配：静态层共用 + **每段运行一份实例** | run.js / run-loop | `modules()`（动态 import + `installBridge()` + `transport.setTransport`，进程内一次）、`createCoreContext()`（`createPrompts/Memory/AgentDefs/AgentContext/ToolRunner` 现造） |
| `run-registry.js` | 运行登记表与生命周期 | run.js / run-loop / run-http | `create/get/listOf/objectsOf/stateOf/capacity/stopRun/release`；插话队列 `steer/markSteer/steerPending`；**可同时跑多段**（一条会话一段 + 账号上限 `AGENT_RUNS_PER_ACCOUNT`(3) + 全局上限 `AGENT_RUNS_TOTAL`(8)）；`settled` = 落盘完成（不是 status） |
| `run-events.js` | 事件日志 + 单运行 SSE + **账号统一事件口** | run-registry / run-loop / run-confirm | `emit`（进日志 + 推本运行的订阅者 + 推账号 hub）、`applyToLive`、`attach`（回放→续播→重发未答确认）、`hubAttach`（快照 + 每段回放 + 续播，事件带 `runId/sessionId/liveId`）、`notifyUi` |
| `files.js`（服务端 `lib/agent/`） | **待下载目录**（每账号一个）+ 下载链接 + 可执行文件打包 | index（路由）/ tools/deliver | `list/publish/downloadOf/remove`；文件名白名单 + realpath 复核（挡穿越与符号链接）；可执行文件**按后缀名判**（不看执行位：NTFS 挂载点上全是 0777）发布时打包、下载时再兜一道；单文件/总量上限 |
| `tools/deliver.js` | `deliver_file` 工具（把产出物交给用户） | tools/index 的 /call 与 run-bridge | 与 `read_file` **同一套闸门**（roots + 权限 + 解锁）；返回 `files`（内核带进追踪条 → 界面画下载卡片） |
| `run-subagent.js` | **子智能体**（spawn_agent） | run-loop（注入 ToolRunner） | 自己一段上下文（新 `AgentContext`）+ 默认**只读**工具集（`AgentDefs.subagentToolDefsFor`，永不含 spawn_agent）+ 独立预算；并发闸按 run 排队；过程进事件流（`sub_*`）、结论作为工具结果回主对话、完整转录留在 `run.subs`（`GET /agent/run/subagent`） |
| `run-confirm.js` | 人工闸门 | run-loop / run.js | `ask`（Map 多槽位、超时按拒绝）、`answerConfirm`（只结算自己的 id） |
| `run-loop.js` | 循环本体 | run.js | `execute`（灌账号数据 → init 各 core 模块 → 注册 onChange → 跑 `Agent.run` → finish）、`persist`（1.5s 节流落盘）、`finish`（写完再广播 end）、`loopHooks`、`roundBudget` |
| `run-bridge.js` | 进程内端点桥 | run-loop（装一次） | 把 core 的 HTTP 调用接回真实处理函数（形状不变）；**每次工具执行前重新取 actor**；未覆盖路径一律 501（绝不静默成功） |
| `run-upstream.js` | 托管运行的上游一跳 | run-core 传入 transport | 用 `lib/upstream-http` + 同一套出口校验直连上游，把 Node 响应包成 web `Response` |
| `run-http.js` | `/agent/run/*` 端点 | index | start/**hub**/events/state/**subagent**/stop/steer/confirm；每个入口都把 account 交给 run.js 过滤 |
| `limits.js` / `sanitize.js` | 硬上限与收敛 / 标识符与字段清洗 | 全体 | `effLimits`（只能收紧）、`makeGate`（并发+频率闸门）、`ACCOUNT_RE/PROJECT_RE/ENTRY_ID_RE` |

### 6.2 共享 core `agent/src/core/`

| 模块 | 职责 | 被谁调用 | 内部主要操作 |
|---|---|---|---|
| `agent.js` | Agent 循环（双循环/Steering/工具五步/截断保护） | run-loop、测试 | 收 `cfg`（stream/runTool/transformContext/hooks/texts），不认识宿主 |
| `agent-defs.js` | 工具定义与闸门 | loop / tool-runner | `activeToolDefs()`、`CONFIRM_SEQUENTIAL`、`labelOf`、插件闸门说明 |
| `tool-runner.js` | 工具分发与预算 | agent 循环 | 按工具族分派；确认/授权；预算在确认通过后扣 |
| `protocol/` | 协议适配（openai / anthropic / sse / textcalls / think / transport） | agent / context | 统一事件流；正文型工具调用识别；**扩展思考的 signature 原样回传**；上游一跳可替换 |
| `assemble.js` | 组装（system 区块 + 历史 + 请求参数） | run-loop / host | `buildMessages(env)`（**不再另传本条提问**）、`buildRequestOptions`（两端唯一实现）、`promptBlocks` |
| `context.js` | 用量估算、压缩、裁剪 | agent / host | `transformMessages`（压缩或裁剪，唯一入口）、`compactNow/uncompact`、`ctxUsage` |
| `prompts.js` / `memory.js` | 提示词登记表 / 三类记忆 | 全体 | `load/serialize/onChange`（**返回退订函数**）、注入区块 |
| `policy.js` / `params.js` | 访问级别与允许清单 / 参数 schema | tool-runner / host | `matchRule` 容忍字符串清单（`asStringList`）、`resolve` 三层取值、`normalizeValue` |
| `sessions.js` | 会话规则（共用） | run-loop / host | `titleFrom`、`trimTrailingQuestion`、`reconcileHistory`（客户端落后一轮时用服务端那份）、`newMsgId` |
| `store.js`（core） | 服务端数据客户端 + 写队列 | ui/state | 防抖写入（失败放回**只在槽位空着时**）、`pull/pullLight` 形状校验、`hasPendingSession` |
| `http.js` | 统一请求层 | 全体 | `X-Agent-Client` 头、超时/中断、错误分类、**2xx 非 JSON 一律报错** |
| `presence.js` / `binding.js` / `endpoints.js` / `markdown.js` | 心跳与顶号 / 绑定动作 / 端点表 / Markdown 渲染 | ui | —— |

### 6.3 界面 `agent/src/ui/`

| 模块 | 职责 | 被谁调用 | 内部主要操作 |
|---|---|---|---|
| `state/store.js` | 状态容器 | 全部组件 | `state` 单例、`patch/touch/useApp`、`defaultSettings()` |
| `state/host.js` | 依赖注入宿主 | main.jsx | `wireCore()`（一次性接线）、`persistSession(sessionId)`、确认框文案、`guardStreaming` |
| `state/session.js` | 对话动作 | 组件 | `bootstrap/send/steer/stop/selectSession/newSession/回撤/清空`；`applyServerData`、`refreshAll`（带 `canApply` 复核）、`hooks.onRunEnded` |
| `state/run.js` | 托管运行的客户端一半 | session.js | `startRun`（含 localEdits）、`subscribe`（连接身份绑定）、`dropConnection`（按类型分派）、`reattach`、`settle`；宿主端口 `host()` 集中一处 |
| `state/settings.js` | 设置类动作 | 设置抽屉 | 取值统一走 `S()`（登出后不为 null）；允许清单写数组 |
| `state/projects.js` | 项目动作 | 侧栏/抽屉 | `selectProject`（序号防串台）、`followSessionProject`、`refreshCurrentMemory` |
| `features/*` | 渲染 | App.jsx | `Message` 用消息 id 作 key；`Composer` 只在插话成功后清草稿；设置抽屉各分区 |

---

## 7. 数据与唯一真源

| 数据 | 存哪 | 谁写 | 谁读 |
|---|---|---|---|
| 会话 / 全局记忆 / 提示词表 | `STATE_DIR/agent/<账号>/*.json` | 服务端 `store.js`（托管运行落盘、界面经 HTTP 写入） | 两端 |
| 项目记忆 | `STATE_DIR/agent/<账号>/projects/<id>/memory/*.md` + `MEMORY.md` | `projects.writeMemory`（锁内整份重写；**空列表要带对得上的 `baseCount`**，否则 409） | 唯一取数路径 `GET /agent/projects/memory?id=` |
| 技能（Skill） | `STATE_DIR/agent/<账号>/prompts.json` 的 `skills[]` | `skill_write` / `skill_import`（走确认框；`store.updatePrompts` 锁内） | 注入 system：清单常驻、正文按需 `use_skill` |
| 配置 / 绑定 / 密钥 | `STATE_DIR/userdata/<账号>/agent.json` | `settings.js` | 服务端（密钥不下发） |
| 解锁凭据 | 进程内存 vault | `session.bind/unlock` | `actorOf` |
| 运行（事件/确认/插话） | 进程内存 `run-registry` | `run-loop` | SSE 订阅者 |
| 界面状态 | 浏览器内存 | `ui/state/*` | React |
| 会话"当前指针" | `settings.currentSess` | 客户端 `saveCurrentSess` | 页面加载时选会话 |

**当前项目 = 当前会话的 `project`**（唯一真源）；项目清单与 current 指针在 `projects.json`，条目在记忆文件夹。

---

## 8. 必须守住的不变量（每条都对应一次真实故障）

1. **可以同时跑多段运行，但有三道闸**：一条会话同时只有一段（两段会互相覆盖历史）、每账号 ≤ `AGENT_RUNS_PER_ACCOUNT`、
   全进程 ≤ `AGENT_RUNS_TOTAL`；对外只暴露本账号那几段（`listOf/stateOf/get(id, account)`）。
   **每段运行必须持有自己的 core 实例**（`createCoreContext()`）——core 的登记表/记忆/上下文管理都是**实例内**状态，
   共用一份就会串账号数据（2026-10-01 之前正是靠"全局只允许一段"绕开这件事）。
2. **统一事件口只连一条**（`/agent/run/hub`）：事件带 `runId/sessionId/liveId`，客户端据此把每条事件写回**它那条会话**的
   助手消息；`run_started` 必须发（服务端在 POST 响应之前就写它），否则客户端认不出服务端那条消息、每个事件冒一条气泡。
3. **`settled`（落盘完成）才是"跑完了"的判据**，`status` 只是显示态——按 status 判会读到半截快照。
4. **`onChange` 必须退订**：托管运行按"一次运行注册一次"用，收尾不退订就会跨账号覆盖写数据。
5. **落盘写完再广播 `end`**（否则客户端重拉拿到半截快照）。
6. **客户端上交的历史与服务端那份要对账**：客户端那份是服务端那份的严格前缀时用服务端的（它落后了）；
   本地有未落盘编辑时以客户端为准。
7. **本轮提问只追加一次**：`run.history` 加了就不再传给 `buildMessages`。
8. **确认闸门无人值守按拒绝**；确认按 id 结算，不认别人的。
9. **工具执行前重新取身份**（登出/解绑/上锁立即生效）；登出还会掐断在途运行。
10. **清单类参数（exec_allow）落盘是数组**，读取端容忍旧字符串；写法统一走 `normalizeValue`。
11. **2xx 但正文不是 JSON = 错误**；`pull()` 还要校验形状（空对象不能当成"服务端没有数据"）。
12. **消息带稳定 id**（界面 key）；下标当 key 会在删除/回撤后错位。
13. **压缩关掉时裁剪只作用于请求视图**，会话原文不动，且对齐到 user 边界（否则上游 400）。
14. **Anthropic 扩展思考必须原样回传**（thinking + signature），落盘白名单里要有这两个字段。
15. **上游报错要把上游自己说的话带上**（`errorText`：只有"HTTP 401"用户无从修起），
   且 `msg.error` **必须落盘**（`sanitizeMsg` 的白名单里要有它）——刷新一次错误就消失等于没反映出来。
16. **子智能体不许递归**（工具集里永不含 spawn_agent）、默认只读（写权限要面板开关 + 工具参数双开）、
   结论必须作为**工具结果**回主对话（过程走事件流，完整转录留在运行里）。
17. **服务端改动要重启站点才生效**；前端产物重建后刷新即可（`npm run build`）。
18. **记忆变更按作用域分发**（`Memory.onChange` 的参数是变了的类）：只写那一类，
    **绝不"一变全写"**——项目记忆是整份覆盖，顺手写一次就可能用陈旧快照把它清空（2026-10-03 事故）。
19. **项目条目与项目 id 绑定、没取回来过不许写回**（`projectLoaded`）；整份写回带 `baseCount`，
    服务端拒绝"空列表 + 基准对不上"（409），客户端收到后重新取回。项目记忆取数前先把本地待写落地。
20. **技能与记忆是两套**：技能记"怎么做"（`prompts.json` 的 `skills[]`，按需注入正文），
    记忆记"事实"；同一件事只写一处（模型侧口径在 `system.skills_memory` 与两个工具的说明里）。
