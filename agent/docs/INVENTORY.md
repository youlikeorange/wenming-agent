# 智能体 Agent · 函数与数据全量清单

**这份文档回答两个问题**：项目里有哪些函数（在哪个文件哪一行、干什么）；磁盘上生成了哪些数据文件（谁写的、谁读的、谁清理的）。

- **函数部分是机器生成的**（标记区由 `node scripts/gen-inventory.mjs` 回写，勿手改）：
  提取每个文件的顶层/闭包函数声明与箭头函数赋值，"作用"取定义前最近一条注释的末行——
  本项目注释密度高，绝大多数函数能取到一句话。**口径**：不抓对象字面量方法、类方法与内联回调
  （它们跟着宿主函数走）。行号是生成时刻的快照，改动后以函数名为准、重跑脚本即可刷新。
- **数据文件部分是手工核对的**：每条链路都 grep 过调用方；带 ★ 的是"改了会坏功能"的关键链路。
- 配套：`MODULE-MAP.md`（端点/数据/改动落点，查"我要改 X 动哪些文件"）、`ARCHITECTURE.md`（流程）。

状态快照：2026-10-07 · 111 个源文件 / 1130 个函数（不含测试）。

---

## 一、磁盘数据文件清单（生成 ↔ 消费）

`STATE_DIR` 默认 `~/.local/share/wenming-web`。原子写一律走 `lib/state.js` 的 `atomicWriteJson`。

| 数据文件 | 内容 | 生成（写）函数与链路 | 消费（读）函数与链路 | 删除 / 清理 |
|---|---|---|---|---|
| ★ `userdata/<账号>/agent.json` | 服务商（含 apiKey 明文）/params/theme/ui/tools/binding/currentSess | `lib/agent/settings.js` 的 `save`/`patch`（`POST /agent/store/settings` ← core `Store.queueSettings` ← `ui/state/host.js` 的 `saveSettings`+`settingsForSave` 白名单；服务端托管运行 `run-loop.js` 的 onExecAllow/onSkillRemember 也 patch 它） | `settings.read`：`run-loop.js:68`（灌本段运行的 core 实例）、`run.js:92`（startRun 挑服务商）、`roots.js:32,41`（可访问目录/起点）、`osaccess`/`session.js`（绑定与权限判定）、`index.js`（GET /agent/store 脱敏下发） | 覆盖式保存；无独立删除（解绑只清 binding 字段） |
| ★ `agent/<账号>/sessions.json` | 全部会话（msgs/trace/undo/compaction/memory） | `lib/agent/store.js` 的 `putSession`/`putSessions`：① `index.js:142`（`POST /agent/store/sessions` ← core `Store` 的 sessionWriter ← 前端一切会话改动）；② `run-loop.js:54`（`persist`，流式 1.5s 节流 + 收尾强制）；③ `run.js:189`（`syncUndoMessage` 撤销进度）；④ `archive.js:161,178`（恢复归档时写回） | `store.readSessions`：`index.js:120`（GET /agent/store）、`run.js:84`（startRun 历史对账）、`archive.js:124`（归档项目时找关联会话）；单会话由 `sanitizeSession` 兜底 | `store.deleteSession`（`POST /agent/store/session/delete`）；超限静默丢最旧（store.js 的 dropped 上报） |
| ★ `agent/<账号>/prompts.json` | 提示词登记表 `{overrides, skills[], extra[]}` | `store.putPrompts`：① `index.js:158`（`POST /agent/store/prompts` ← `Store.queuePrompts` ← host.js 的 Prompts.onChange）；② `run-loop.js:113`（托管运行的 Prompts.onChange）；③ `skills.js` 的 `applyImport`（锁内 `updatePrompts`） | `store.readPrompts`：`index.js:117`（GET /agent/store）、`run-loop.js:68→74`（灌本段运行的 Prompts）；磁盘无 version 字段（见 MODULE-MAP 坑①） | 覆盖式保存 |
| `agent/<账号>/memory.json` | 全局记忆条目 | `store.putMemory`：① `index.js:154`（`POST /agent/store/memory` ← `Store.queueMemory`，显式 entries 数组才收）；② `run-loop.js:115`（Memory.onChange 的 global 分支） | `store.readMemory`：`index.js:119`（GET /agent/store）、`run-loop.js:69→78`（灌 core Memory） | 覆盖式；≤300 条丢最旧 |
| `agent/<账号>/projects.json` | 项目清单 + 当前项目指针 | `projects.js` 的 `writeList`（create/rename/current/delete/archive/restore 各动作末尾） | `projects.readList`：`index.js`（GET /agent/store 的 projects/currentProject、GET /agent/projects/*）、`run-loop.js:71`（`projects.find` 定位当前项目的记忆目录）、`archive.js` | 归档/删除时重写 |
| `agent/<账号>/projects/<id>/project.json` | 单个项目的元信息（名字/根目录/时间） | `projects.js:354`（`create` 时原子写） | 随文件夹整体搬移（归档/恢复/删除）；id 由根目录推出、同根恒定 | 随 `projects/<id>/` 目录删除 |
| ★ `agent/<账号>/projects/<id>/memory/*.md` + `MEMORY.md` | 项目记忆（真源是 Markdown；每条一个 .md + frontmatter） | `projects.writeMemoryLocked`（`POST /agent/projects/memory` ← core `Store.queueProjectMemory` ← host.js 的 Memory.onChange project 分支，带 baseCount 空覆盖保护；托管运行 `run-loop.js:117` 同链路）——**全量覆盖**，不在本次集合里的 .md 会被删 | `projects.readMemory`：`index.js` 的 `GET /agent/projects/memory`（唯一取数路径 ← `ui/state/host.js` 的 `fetchProjectMemory` → applyServerLight / refreshCurrentMemory）、`run-loop.js:72`（灌 core） | `writeMemoryLocked` 覆盖；归档/删项目整目录搬走 |
| `agent/<账号>/downloads/` | 「📥 待下载」交付文件（可执行后缀自动打包成 zip） | `tools/deliver.js`（`deliver_file` 工具：复制/打包进目录，返回下载名与 inline 预览提示） | `files.js` 的 `listFiles`（`GET /agent/files` ← `ui/state/downloads.js` 顶栏菜单）、下载路由（`GET /agent/files/download`，`?inline=1` 走白名单 + Range，会话卡片 `<a download>` / 媒体标签消费） | `files.js` 的删除路由（`POST /agent/files/delete`）与 prune（500 项 / 512MB / 2GB 上限裁最旧） |
| ★ `agent/<账号>/undo/<会话id>/<运行id>/`（`meta.json` + `blobs/bN`） | 一次运行的**文件改动日志**（被改/被删文件的原内容备份 + 行数），一键撤销的依据 | `undo.js`：`wrap`（五个写类工具执行前后拍快照，进程内记账）→ `finishRun`（收尾时写 meta.json 与 summary，挂 msg.undo） | `undo.readJournal`（`run.js` 的 `undoRun`/`undoDiff` ← `POST /agent/run/undo`、`/agent/run/undo/diff` ← 界面撤销菜单/比对抽屉）、`undo.undo`（恢复：把 blobs 写回文件系统）、`undo.readDiff`（比对两侧内容） | `dropSession`（彻底删除会话时连日志清掉，归档不清）、`prune`（份数/字节/30 天三重上限） |
| `agent/<账号>/todo/<会话id>.json` | 任务清单（右上角浮层） | `todo.js` 的 `write`（`todo_write` 工具 → `tools/index.js` 的 `callTool`，ctx 会话 id 来自 run-bridge 的 run 上下文或 HTTP body） | `todo.handleTodo`（`GET/POST /agent/todo`，`index.js:399`；前端 `ui/state/todo.js:32` 按 sessionId 拉）→ `view` 给界面渲染 | `drop`（清空清单 / 彻底删会话时连带）、prune（≤200 份） |
| `agent/<账号>/archive/sessions.json`、`projects.json`、`projects/<id>/` | 归档区（会话/项目原样 + archivedAt） | `archive.js` 的 `archiveSession`/`archiveProject`（侧栏归档按钮 `POST /agent/store/session/archive`、设置页 `POST /agent/archive/*`） | `archive.list`（`GET /agent/archive` ← 设置 → 存档）、`restoreSession`/`restoreProject`（恢复时写回主区各文件） | `archive.remove`（彻底删除：不可恢复，连 undo/todo 日志一并清） |
| `public/llm-chat/vendor/agent.js` + `agent.css` | 前端构建产物（页面唯一引用的脚本/样式） | `agent/build.mjs`（esbuild 打包 `agent/src/**` + Tailwind CLI；改 src 后必须重跑） | 浏览器（`/llm-chat/` 页面）、公开仓库的 `standalone.js` 同路径引用 | 重新构建覆盖 |
| `STATE_DIR/auth.log` | 审计日志（登录、工具调用、危险命令、撤销/清理事件，一行一条） | `lib/auth.js` 的 `auditLog`（`tools/index.js` 的 callTool、undo.js 的 prune、auth 各端点都打） | 人工取证用（grep/逐行）；控制字符已转义保行结构 | 追加式，不自动清理 |
| `logs/server.log` | 服务端 stdout/stderr 重定向（up.sh）；托管运行每轮的 round/finish 形态记录在这里 | `run-loop.js` 的 `onRoundShape`/`finish`（`console.warn('[agent/run] …')`，**刻意走 stderr** 避免污染探针） | 人工取证（"半句停住"那次就靠它） | up.sh 轮转策略外置 |

### 内存态数据（不落盘，但也是"谁生成谁消费"）

| 内存结构 | 模块 | 生成 | 消费 |
|---|---|---|---|
| 运行登记表 `runs`（Map） | `lib/agent/run-registry.js` | `create`（startRun 时） | 三道并发闸（`capacity`/`stateOf`）、hub 快照（`objectsOf` → run-events）、stopRun/steer；字段归属表见 create 头注 |
| 运行事件日志 `run.events` | `run-events.js` 的 `emit` | 每个事件推入（超上限丢最旧并标 trimmed）；2026-10-07 起有 `live_reset`（调用保护中断重调时清半截正文，`applyToLive` 与客户端 HANDLERS 同清）与累计口径的 `stats` | `attach`/`hubAttach` 的回放（刷新接上） |
| 确认槽 `run.confirms` | `run-confirm.js` 的 `ask` | 服务端要人点头时入槽 | `answerConfirm` 结算（run.js 转发）、回放时重发 |
| 单窗口占用表 | `lib/agent/presence.js` | `POST /agent/presence` 的 claim/心跳 | `presence.guard`（所有需登录端点 409 顶号）、`App.jsx` 的冻结层 |
| 授权票据 | `lib/agent/grants.js` 的 `issueGrant` | 危险命令 deny-check 命中时签发 | `tools/exec.js` 执行时校验（一次性） |
| kill 族归属登记表 `roots`（命令根 pid）/`seen`（子树采样）/`managed`（libuv 在管的子进程） | `lib/agent/proctree.js` | `noteSpawn`（exec.js 每次 spawn 登记；2026-10-07）+ 4s 采样器（降级模式记 seen）+ `ChildProcess.prototype.spawn` 钩子（记 managed） | `isAgentOwned`（kill 族"自启进程免授权"的三条证据链）→ `killExempt`（deny-check 两处 + exec 闸门） |
| subreaper 插件（prctl 标记 + 按pid收僵尸） | `lib/agent/proctree.js` 启动时现编 `proctree-subreaper.c`（gcc，产物缓存 `os.tmpdir()/agent-proctree/`） | 站点进程标记 `PR_SET_CHILD_SUBREAPER`：agent 派生的孤儿（setsid 后台任务）归养回站点，祖先链永远可查 | `sweepZombies` 收被收养的僵尸（只收非 libuv 管的）；插件不可用自动降级（那类孤儿查不到 → kill 回到要票） |
| usage 累计器 `usageAcc`（Agent.run 闭包内 {totals, round}） | `core/agent.js` 的 `run()`（2026-10-07） | `streamHandlers` 的 stats 事件分支累加（`acc.round` 每次尝试清零）；`bankUsage` 在每轮成功返回后入账 | `out.stats`（收尾）与 `onStats`（实时）都给"各次调用注入/输出合计"；被中断尝试不计入 |
| 前端 runs 快照 | `ui/state/run.js` 的 `runs` Map | adoptRun/mergeRun/registerRun（getOrCreate 外壳） | `publish()` → state.runs → 侧栏小标/Composer 生成态 |

---

## 二、函数全量清单

<!-- GEN:FUNCTIONS START（本区由 scripts/gen-inventory.mjs 生成，勿手改） -->

### 共享 core（agent/src/core，零框架、两端同一份）——23 个文件 / 235 个函数

#### `src/core/agent-defs.js`（18 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `p` | src/core/agent-defs.js:76 |  | schema 工厂 |
| `createAgentDefs` | src/core/agent-defs.js:81 | ✓ | 造一份独立的工具登记表实例（依赖 + 判定都在闭包里） |
| `init` | src/core/agent-defs.js:93 |  |  |
| `SKILL_TOOL_SPECS` | src/core/agent-defs.js:116 |  | 技能工具（Pi 的 progressive disclosure：清单里只有名字与用途，正文由模型按需加载） |
| `skillsToolDefs` | src/core/agent-defs.js:164 |  | 本轮注册的技能工具：skill_write 始终有（否则攒不出第一份技能）； |
| `FS_TOOL_SPECS` | src/core/agent-defs.js:173 |  | 文件与目录的 schema |
| `DELIVER_TOOL_SPEC` | src/core/agent-defs.js:222 |  | 传输文件（交付产出物给用户）：路径走与读文件同一套闸门 |
| `EXEC_TOOL_SPEC` | src/core/agent-defs.js:229 |  |  |
| `WAIT_TOOL_SPEC` | src/core/agent-defs.js:239 |  | 等待：长任务"提交后台 → 等一段时间 → 查进度"的中间那步。原地延时，不占命令条数。 |
| `SCREEN_TOOL_SPECS` | src/core/agent-defs.js:246 |  | 屏幕操作（OmniParser + xdotool）：看屏幕 + 键鼠。开关 plugin_screen_on 默认关。 |
| `pluginGateNote` | src/core/agent-defs.js:275 |  | 插件工具被上面那道闸门挡下时，宿主该注入给模型的一句说明；闸门放行时返回 null。 |
| `todoToolDefs` | src/core/agent-defs.js:289 |  | 任务清单（todo_write）：**没有开关**——agent 自己决定要不要列（列了才有）。 |
| `pluginToolDefs` | src/core/agent-defs.js:308 |  | 本轮注册的插件工具：开关在侧栏「🔌 插件」里，关掉即不注册、也不注入它的说明。 |
| `subagentToolDefs` | src/core/agent-defs.js:330 |  | 本轮注册的子智能体工具：参数由模型按任务定（模型可覆盖的只有这几个， |
| `memoryToolDefs` | src/core/agent-defs.js:346 |  | 记忆类工具 |
| `activeToolDefs` | src/core/agent-defs.js:373 |  | 本轮注册给模型的全部工具定义（联网搜索 + 技能 + 记忆 + 插件 + 子智能体），上下文统计与实际请求共用 |
| `subagentToolDefsFor` | src/core/agent-defs.js:388 |  | 子智能体**能用**的工具（默认只读）：主对话的工具清单按名字过滤。 |
| `labelOf` | src/core/agent-defs.js:401 |  | 工具卡片的标题（追踪条与落盘的 trace 都用它）。 |

#### `src/core/agent.js`（30 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `asFiles` | src/core/agent.js:35 |  |  |
| `asLines` | src/core/agent.js:42 |  | 行数统计（写/改/删 文件后服务端给的那两个数）：追踪条（信息卡片）显示 +N / −M。 |
| `asUndoRef` | src/core/agent.js:51 |  | 改动的定位信息（哪一轮 / 日志里第几条 / 动了哪些路径）：追踪条那条 +N/−M 卡片点击后， |
| `asTodo` | src/core/agent.js:64 |  | 任务清单（todo_write 的结果）：原样带到界面（右上角浮层）。**null 与 undefined 是两回事**： |
| `attach` | src/core/agent.js:70 |  | 白名单式附带：算出来不是 undefined 就带上（files / lines / undoRef / todo 同一套写法） |
| `asResult` | src/core/agent.js:72 |  |  |
| `asstMsg` | src/core/agent.js:88 |  | assistant 消息工厂：带工具调用时，把这一轮的**扩展思考**一并带上。 |
| `fingerprint` | src/core/agent.js:97 |  | 工具调用的唯一指纹：用于"同一参数重复调用"保护 |
| `shrinkArgs` | src/core/agent.js:110 |  |  |
| `traceCap` | src/core/agent.js:125 |  |  |
| `loopText` | src/core/agent.js:133 |  | 循环内文案：宿主注入的 texts 优先，缺了取登记表 DEFAULTS 的出厂正文 |
| `repeatAllowed` | src/core/agent.js:147 |  |  |
| `toMessages` | src/core/agent.js:150 |  | 注入项可以是纯文本（当作用户消息）或完整的 {role, content} 消息 |
| `isAbort` | src/core/agent.js:183 |  | 跑一次 Agent（一次用户输入 → 可能多轮工具调用 → 最终回答） |
| `call` | src/core/agent.js:187 |  | 调一个宿主钩子；钩子自己出错不能带崩整个循环 |
| `retryableError` | src/core/agent.js:204 | ✓ |  |
| `shortErr` | src/core/agent.js:212 |  |  |
| `retryText` | src/core/agent.js:215 |  | 重试提示的文案（模板在提示词登记表 loop.retry，可改） |
| `stoppedRound` | src/core/agent.js:222 |  | "等待重试期间被停止"时那一轮的占位结果（空内容 + stopped，与读流被中止同一形状） |
| `addUsage` | src/core/agent.js:235 |  | usage 累加（一次提问会经历多次模型调用，每次调用都注入一遍上下文： |
| `withLiveTotals` | src/core/agent.js:248 |  | 实时事件里的合并 stats：上游这次的原始值 + 本轮到此为止的累计（界面两档显示都用累计口径） |
| `totalsStats` | src/core/agent.js:251 |  | 收尾/落盘用的累计 stats（不掺单轮字段；tok/s  累计输出 / 累计生成时长） |
| `bankUsage` | src/core/agent.js:263 |  | usage 入账（2026-10-07）：一次调用成功返回后，把它贡献的量并入累计，返回累计后的 |
| `sleepAbortable` | src/core/agent.js:274 |  | 等一会儿，可被「停止」打断；返回 false  期间被中止（调用方按"已停止"收尾） |
| `streamHandlers` | src/core/agent.js:286 |  | 流事件的逐条处理（表格驱动，与客户端 run.js 的 HANDLERS 同款——for-await 里只剩查表， |
| `readRound` | src/core/agent.js:346 |  | 读一轮的流式输出：正文/思考/统计/工具调用，边读边把增量交给宿主（onDelta）。 |
| `handleSoftRetry` | src/core/agent.js:417 |  | 软中断（超时/思考循环）的重调处理：返回 true  已处理（继续下一次尝试）。 |
| `readRoundRetry` | src/core/agent.js:435 |  | 读一轮 + 中断重调（超时/思考循环，立即重调）+ 上游出错重试 / 结束形态记录 |
| `run` | src/core/agent.js:465 |  |  |
| `complete` | src/core/agent.js:753 |  | 单独跑一次"非流式"的模型调用（压缩摘要用）：把流读完拼成文本 |

#### `src/core/assemble.js`（11 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `activeProviderOf` | src/core/assemble.js:21 | ✓ | 当前服务商（activeId 指向的那个；找不到就用第一个） |
| `paramsOf` | src/core/assemble.js:29 | ✓ | 参数取值：出厂 → 全局 → 每模型覆盖（唯一真源在 core/params.js） |
| `effParams` | src/core/assemble.js:32 | ✓ | 生效参数对象（env.params 优先，否则按服务商现算） |
| `val2Of` | src/core/assemble.js:39 | ✓ | 单个参数：生效值 → 工具参数出厂默认 → 普通参数出厂默认 |
| `accessOfEnv` | src/core/assemble.js:49 | ✓ | 四档访问级别 → "哪些操作要问"的实际判定。 |
| `promptBlocks` | src/core/assemble.js:54 | ✓ | 本轮注入的区块与工具名（界面展示与实际发送同源） |
| `systemMessage` | src/core/assemble.js:93 | ✓ | 本轮 system 消息（区块之间用 --- 分隔，与实际发送完全同源） |
| `toApiMsg` | src/core/assemble.js:98 |  |  |
| `buildMessages` | src/core/assemble.js:103 | ✓ | 组装发给模型的 messages：system 区块 +（压缩摘要）+ 历史 + 本条输入 |
| `sendPreview` | src/core/assemble.js:120 | ✓ | 「发送预览」用：区块清单 + 实际 messages（JSON）+ 工具 schema |
| `buildRequestOptions` | src/core/assemble.js:135 | ✓ | 本轮请求参数（**两端唯一的实现**）：参数表 → 协议字段；有工具就带上；模型名兜底。 |

#### `src/core/binding.js`（6 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `unwrap` | src/core/binding.js:15 |  |  |
| `status` | src/core/binding.js:22 | ✓ |  |
| `bind` | src/core/binding.js:27 | ✓ |  |
| `unbind` | src/core/binding.js:34 | ✓ |  |
| `unlock` | src/core/binding.js:41 | ✓ |  |
| `lock` | src/core/binding.js:48 | ✓ |  |

#### `src/core/context.js`（13 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `createAgentContext` | src/core/context.js:39 | ✓ | 造一份独立的上下文管理实例 |
| `init` | src/core/context.js:69 |  |  |
| `estTokens` | src/core/context.js:93 |  | 估算 token 数：中文按字计，其他按 ~3.6 字符/token（无需 tokenizer，足够指导决策） |
| `ctxLimit` | src/core/context.js:109 |  | 上下文上限：优先用宿主注入的 numCtx()（服务商配置里的 ctxLimit），否则按远程 API 的常见量级（128K）。 |
| `ctxUsage` | src/core/context.js:122 |  | 计算当前占用（系统提示词 + 工具说明 + 工具 schema + 历史 + 当前输入） |
| `trimForRequest` | src/core/context.js:152 |  | 把"这一轮要发出去的消息"裁到安全线以内。**只裁请求视图，不动会话原文**： |
| `notifyTrim` | src/core/context.js:171 |  |  |
| `beginTrace` | src/core/context.js:201 |  |  |
| `endTrace` | src/core/context.js:207 |  |  |
| `autoCompactOn` | src/core/context.js:250 |  | 自动压缩是否启用 —— **唯一判据**：提示词登记表里那条 compact.prompt。 |
| `compactedView` | src/core/context.js:268 |  |  |
| `uncompact` | src/core/context.js:363 |  |  |
| `invalidateCompaction` | src/core/context.js:370 |  | 历史被改写（删消息、回撤、清空）后摘要失效 |

#### `src/core/http.js`（10 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `cid` | src/core/http.js:13 | ✓ |  |
| `errText` | src/core/http.js:32 |  | 错误体 → 人话：本站是 {error:'文本'}，OpenAI/Anthropic 是 {error:{message}} |
| `setFetchImpl` | src/core/http.js:46 | ✓ |  |
| `doFetch` | src/core/http.js:47 |  |  |
| `classify` | src/core/http.js:50 |  | 三个"响应头或响应体里说"的判定（判据见 endpoints.js 的头标记） |
| `apiError` | src/core/http.js:61 |  | 非 2xx / ok:false → **统一分类**的 ApiError。raw 与非 raw 共用这一处： |
| `throwIfBadRaw` | src/core/http.js:82 |  | raw 路径的错误响应：错误响应**不是流**，把正文读出来分类（读不动就按状态码兜底） |
| `request` | src/core/http.js:92 | ✓ | 统一 fetch：带窗口标识、归类错误、解析 JSON 体。 |
| `get` | src/core/http.js:170 | ✓ | GET JSON |
| `post` | src/core/http.js:172 | ✓ | POST JSON |

#### `src/core/markdown.js`（3 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `inline` | src/core/markdown.js:9 |  | 行内 ---------------- |
| `tableFrom` | src/core/markdown.js:20 |  | 表格 ---------------- |
| `render` | src/core/markdown.js:38 |  |  |

#### `src/core/memory.js`（13 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `createMemory` | src/core/memory.js:47 | ✓ | 造一份独立的记忆实例（每种作用域一组列表 + 一组订阅者） |
| `init` | src/core/memory.js:68 |  |  |
| `sanitizeList` | src/core/memory.js:105 |  |  |
| `load` | src/core/memory.js:132 |  | 载入：全局来自 settings.memory，会话来自当前会话对象；项目条目**不从这里进** |
| `setProject` | src/core/memory.js:148 |  | 换当前项目（宿主在"设当前项目 / 登录拉数据 / 切换项目"时调用）。 |
| `write` | src/core/memory.js:170 |  | 新增或按标题合并（同标题视为同一条记忆，避免模型反复写同一条） |
| `update` | src/core/memory.js:202 |  |  |
| `remove` | src/core/memory.js:215 |  |  |
| `search` | src/core/memory.js:239 |  | 检索：标题/标签/正文里找关键词（大小写不敏感），返回摘要片段 |
| `indexBlock` | src/core/memory.js:257 |  | 全局记忆索引（常驻注入，只给标题/标签/摘要，正文按需 memory_read） |
| `fullBlock` | src/core/memory.js:264 |  | 全局记忆全文（另一种注入方式：条目少时可以把正文全带上，省掉 memory_read 往返） |
| `projectBlock` | src/core/memory.js:274 |  | 项目记忆（含"这个项目在哪"的事实 + 记忆索引/全文）。 |
| `sessionBlock` | src/core/memory.js:295 |  | 会话记忆正文（通常很短，整段常驻注入） |

#### `src/core/params.js`（14 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `isBlank` | src/core/params.js:212 |  | 取值解析 |
| `resolve` | src/core/params.js:215 | ✓ | 覆盖链：出厂 → 全局 → 每模型。空值（''/undefined） 用上一层，不是"设为空"。 |
| `pickNonBlank` | src/core/params.js:227 |  |  |
| `modelKey` | src/core/params.js:234 | ✓ |  |
| `overriddenBy` | src/core/params.js:237 | ✓ | 该键在"全局"与"每模型"上的差异（面板上标出被覆盖的项） |
| `normalizeValue` | src/core/params.js:244 | ✓ | 把任意输入收敛成 schema 允许的形状（保存前调用；越界一律夹回范围） |
| `toStopList` | src/core/params.js:263 | ✓ | 停止序列：每行一条（空行丢掉） |
| `asStringList` | src/core/params.js:273 | ✓ | kind:'list' 参数的取值收敛（唯一真源）：数组原样、换行/逗号分隔的字符串拆成数组、其余当空。 |
| `normalizeParam` | src/core/params.js:286 | ✓ | 单个参数的归一化（**唯一入口**：前端 setParam 与服务端落盘前都调它）。 |
| `normalizeParamBag` | src/core/params.js:295 | ✓ | 一整袋参数（settings.params、paramsByModel 里的某一模型）逐键归一；非对象 → 空袋 |
| `toRequestParams` | src/core/params.js:308 | ✓ | 参数 → 各协议通用的请求字段（canonical）。 |
| `ctxLimitOf` | src/core/params.js:326 | ✓ | 每模型生效的上下文上限（用量环的分母）：参数 > 服务商设置 > 出厂默认 |
| `callTimeoutOf` | src/core/params.js:336 | ✓ | 单次调用最高时长（秒）：只看参数（每模型一份）；0/负数  不限。 |
| `parseExtraBody` | src/core/params.js:343 | ✓ | 额外请求体：JSON 文本 → 对象（解析失败返回 null，调用方给提示） |

#### `src/core/policy.js`（12 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `meta` | src/core/policy.js:38 |  |  |
| `modeOf` | src/core/policy.js:40 |  |  |
| `pick` | src/core/policy.js:46 |  | 取值：会话里的参数优先，其次出厂默认（与 app.js 的 val2() 同一套语义）。 |
| `eff` | src/core/policy.js:53 |  | 档位 → 四类操作"要不要先问" |
| `summary` | src/core/policy.js:66 |  | 一句话说明当前档位的实际效果（面板与徽章都用它） |
| `norm` | src/core/policy.js:131 |  |  |
| `normalizeRule` | src/core/policy.js:132 |  |  |
| `baseName` | src/core/policy.js:133 |  |  |
| `ruleFor` | src/core/policy.js:139 |  | 为这条命令提议一条允许规则（如 `git status -sb` → `git status`，`cat a.txt` → `cat`）。 |
| `matchRule` | src/core/policy.js:160 |  | 命中允许清单则返回命中的规则，否则 null。按词边界前缀匹配（`git s` 不匹配 `git status`）。 |
| `addRule` | src/core/policy.js:176 |  | 加一条规则（去重、归一化、上限 100 条） |
| `removeRule` | src/core/policy.js:182 |  |  |

#### `src/core/presence.js`（11 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `onChange` | src/core/presence.js:15 | ✓ |  |
| `emit` | src/core/presence.js:16 |  |  |
| `isActive` | src/core/presence.js:24 | ✓ |  |
| `ownerOf` | src/core/presence.js:25 | ✓ |  |
| `enforced` | src/core/presence.js:26 | ✓ |  |
| `claim` | src/core/presence.js:29 | ✓ | 主动查询/上位：claimtrue 表示夺回（顶掉对方） |
| `leave` | src/core/presence.js:34 | ✓ | 让位（关页/跳转时说一声）；让位不算"被顶掉"，之后照常放行 |
| `call` | src/core/presence.js:38 |  |  |
| `setActive` | src/core/presence.js:54 |  |  |
| `noteKicked` | src/core/presence.js:62 | ✓ | 任何请求收到"被顶掉"的标记时，也立刻切到冻结态（不必等下一次心跳） |
| `start` | src/core/presence.js:64 | ✓ |  |

#### `src/core/prompts.js`（15 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `defaultLoopText` | src/core/prompts.js:529 | ✓ |  |
| `createPrompts` | src/core/prompts.js:537 | ✓ | 造一份独立的提示词登记表实例（覆盖项 / 技能 / 自定义条目 / 订阅者都在闭包里）。 |
| `text` | src/core/prompts.js:558 |  | 某条目的最终文本：用户覆盖 > 内置默认（空串  用户明确要求为空） |
| `descText` | src/core/prompts.js:565 |  | 条目的"用途/描述"：内置条目允许用 <id>.desc 覆盖（技能清单与 <skill> 标签都用它） |
| `set` | src/core/prompts.js:578 |  | 写入覆盖（空串也表示"用户改过"，与默认不同就是 dirty） |
| `all` | src/core/prompts.js:605 |  | 全部条目（内置 + 用户新增 + 技能），按注入顺序分组 |
| `systemBlocks` | src/core/prompts.js:622 |  | 系统区块（真正发给模型的 system 拼接顺序） |
| `skillIndexBlock` | src/core/prompts.js:648 |  | 技能清单区块（有按需技能时追加到 system 末尾） |
| `findSkill` | src/core/prompts.js:666 |  |  |
| `applyTemplate` | src/core/prompts.js:685 |  | 变量填值；返回 { text, missing:[未填的变量] }。 |
| `load` | src/core/prompts.js:706 |  |  |
| `addSkill` | src/core/prompts.js:741 |  |  |
| `updateSkill` | src/core/prompts.js:752 |  |  |
| `removeSkill` | src/core/prompts.js:765 |  |  |
| `addEntry` | src/core/prompts.js:772 |  |  |

#### `src/core/protocol.js`（1 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `getProtocol` | src/core/protocol.js:12 | ✓ |  |

#### `src/core/protocol/anthropic.js`（6 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `toMsg` | src/core/protocol/anthropic.js:19 | ✓ | 内部消息 → Anthropic 线格式（工具结果包成 user 的 tool_result 块） |
| `mergeAdjacent` | src/core/protocol/anthropic.js:37 |  | 合并相邻的同角色 user 消息（Anthropic 要求严格交替，否则直接 400） |
| `toTools` | src/core/protocol/anthropic.js:51 | ✓ | 内部工具定义 → Anthropic tools（把 function 摊平） |
| `buildBody` | src/core/protocol/anthropic.js:62 | ✓ |  |
| `listModels` | src/core/protocol/anthropic.js:90 | ✓ |  |
| `pickMessage` | src/core/protocol/anthropic.js:98 |  | 上游非 2xx 的正文抽取：认 error.message / message，都不是就原样压缩（与 openai.js 同口径， |

#### `src/core/protocol/openai.js`（5 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `toMsg` | src/core/protocol/openai.js:14 | ✓ | 内部消息 → OpenAI 线格式 |
| `toTools` | src/core/protocol/openai.js:28 | ✓ | 内部工具定义 → OpenAI tools（两边形状本来就一样，只做字段筛选） |
| `buildBody` | src/core/protocol/openai.js:36 | ✓ | 请求体构造（canonical 参数 → 线格式） |
| `listModels` | src/core/protocol/openai.js:60 | ✓ |  |
| `pickMessage` | src/core/protocol/openai.js:72 |  | 上游报错时把**它自己说的话**带上：只给一句"HTTP 401"，用户既不知道是密钥错了、 |

#### `src/core/protocol/sse.js`（5 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `readChunk` | src/core/protocol/sse.js:17 |  |  |
| `takeSseBlocks` | src/core/protocol/sse.js:34 |  | 把缓冲区切出完整的 SSE 事件块（块之间以空行分隔；兼容 \r\n\r\n） |
| `blockData` | src/core/protocol/sse.js:46 |  | 从事件块里取 data（SSE 规范：多个 data: 行以 \n 拼接，且只去掉一个前导空格） |
| `stopReason` | src/core/protocol/sse.js:119 | ✓ | 各家对"输出被 token 上限截断"的叫法不同，统一成 'length'（截断保护据此判断） |
| `safeJson` | src/core/protocol/sse.js:124 | ✓ | 解析工具参数。**失败时不静默给 {}**：旧实现把"JSON 没拼完"与"工具本来就不要参数" |

#### `src/core/protocol/textcalls.js`（12 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `dsml` | src/core/protocol/textcalls.js:31 |  | DSML 标签：小于号 + [斜杠] + 竖线 DSML 竖线 + 名字 + [属性] + 大于号。 |
| `xml` | src/core/protocol/textcalls.js:35 |  | XML 形态的标签（第 ② 种泄漏）：属性可能是空格分隔的 name"…"，也可能是旧写法的 "值" 简写。 |
| `closeAt` | src/core/protocol/textcalls.js:63 |  | 在 s 的 [from, …] 里找闭合标签的位置（找不到返回 -1） |
| `firstOpen` | src/core/protocol/textcalls.js:81 |  |  |
| `decodeValue` | src/core/protocol/textcalls.js:102 |  | 参数值解码：string"true" 原样（只去掉转义引号那种 JSON 字符串壳）；否则试 JSON，失败保底字符串 |
| `makeCall` | src/core/protocol/textcalls.js:120 |  |  |
| `parseParams` | src/core/protocol/textcalls.js:134 |  | 参数段（invoke/function 的 body）→ 参数对象 |
| `parseDsmlBlock` | src/core/protocol/textcalls.js:158 |  | DSML 形态：块里可能并排多个 invoke |
| `jsonOrEmpty` | src/core/protocol/textcalls.js:179 |  | 块里没有 parameter 时，body 本身可能就是一段 JSON。 |
| `parseXmlBlock` | src/core/protocol/textcalls.js:182 |  | XML 形态：tool_call 里可能是 JSON，也可能是 function / parameter 结构 |
| `parseCallBlock` | src/core/protocol/textcalls.js:218 | ✓ | 块 → 调用数组（认不出返回空数组，调用方原样当正文） |
| `textCallSplitter` | src/core/protocol/textcalls.js:230 | ✓ | 流式拆分器：feed(chunk) → 事件数组；flush() → 收尾事件。 |

#### `src/core/protocol/think.js`（1 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `thinkSplitter` | src/core/protocol/think.js:13 | ✓ |  |

#### `src/core/protocol/transport.js`（11 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `refOf` | src/core/protocol/transport.js:27 | ✓ | 组装 ref（发给 /agent/upstream/* 的"用哪套配置"说明）。 |
| `resolveTools` | src/core/protocol/transport.js:52 | ✓ | 工具定义的口径兼容（两个协议适配器共用一份，警告也只写这一处）： |
| `errorText` | src/core/protocol/transport.js:62 | ✓ | 上游非 2xx：状态码 + 正文摘要（两个协议适配器共用一份口径）。 |
| `modelError` | src/core/protocol/transport.js:72 |  | 统一的分类在 core/http.js（needLogin / kicked / upstream / 状态码，从响应头与响应体判）； |
| `upstream` | src/core/protocol/transport.js:82 |  | 模型流量也走**统一请求层**（core/http.js 的 request）：窗口标识头 X-Agent-Client、 |
| `sessionIdOf` | src/core/protocol/transport.js:89 |  | 会话标识只带**形状合法**的值（服务端还会再校验一次）；拿不到就不带，由服务端回落成账号级 id。 |
| `browserChat` | src/core/protocol/transport.js:94 |  | 流式对话：body 由适配器按协议构造，响应（SSE）原样回给解析器 |
| `browserModels` | src/core/protocol/transport.js:102 |  | 模型清单：原样回上游 JSON（openai/anthropic 都是 {data:[{id}]}） |
| `setTransport` | src/core/protocol/transport.js:111 | ✓ | 只在服务端启动时装一次；浏览器侧永不调用 |
| `upstreamChat` | src/core/protocol/transport.js:115 | ✓ |  |
| `upstreamModels` | src/core/protocol/transport.js:116 | ✓ |  |

#### `src/core/sessions.js`（4 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `titleFrom` | src/core/sessions.js:12 | ✓ | 标题：第一条有内容的用户消息的前 26 字（没有就返回空串，交给调用方保留原值） |
| `newMsgId` | src/core/sessions.js:20 | ✓ | 消息 id：界面拿它当 React key（**下标当 key 会在删除/回撤后错位**：展开的思考/工具详情 |
| `trimTrailingQuestion` | src/core/sessions.js:24 | ✓ | 防御性兜底：老客户端可能把"本条提问"也放进 history 末尾（服务端会再追加一次）—— |
| `reconcileHistory` | src/core/sessions.js:44 | ✓ | 服务端该采用哪一份历史：**客户端交上来的**，还是**自己落盘的那份**。 |

#### `src/core/store.js`（23 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `on` | src/core/store.js:27 | ✓ |  |
| `emit` | src/core/store.js:28 |  |  |
| `send` | src/core/store.js:34 |  | 通用发送：把 ApiError 的分类翻译成宿主能用的信号 |
| `init` | src/core/store.js:53 | ✓ | 初始化与拉取 |
| `looksLikeStore` | src/core/store.js:68 |  | 已登录则拉取服务端数据；未登录返回 null（由调用方退回内存态）。 |
| `pull` | src/core/store.js:72 | ✓ |  |
| `pullLight` | src/core/store.js:80 | ✓ | 轻量拉取：只有面板数据（记忆/提示词/项目清单），**不含会话**。 |
| `pendingWrites` | src/core/store.js:87 | ✓ | 有没有还没落到服务端的本地改动（"面板要跟服务端对齐"之前必须问一句： |
| `hasPendingProjectWrites` | src/core/store.js:94 | ✓ | 只问**项目记忆**那条链路有没有待写。面板刷新用这个而不是上面那个"全都在内"的口径： |
| `refreshInfo` | src/core/store.js:97 | ✓ | 重新探一次登录态与绑定状态（登录/解绑后调用） |
| `makeWriter` | src/core/store.js:109 |  | "整份覆盖"链路共用的小写入器：防抖合并 + **失败放回并重排定时器** + 超过 MAX_RETRIES 放手并报一条。 |
| `queueSettings` | src/core/store.js:147 | ✓ |  |
| `hasPendingSession` | src/core/store.js:157 | ✓ | 这条会话有没有还没落到服务端的本地编辑：托管运行拿它判断"该以谁的历史为准" |
| `queueSession` | src/core/store.js:159 | ✓ |  |
| `flushSession` | src/core/store.js:166 |  |  |
| `archiveSession` | src/core/store.js:200 | ✓ | 归档一个会话（搬进归档区，可恢复）。**先取消它在途的落盘**：否则排队中的写入会把它又写回列表。 |
| `setProjectId` | src/core/store.js:212 | ✓ |  |
| `queueMemory` | src/core/store.js:233 | ✓ |  |
| `queueProjectMemory` | src/core/store.js:236 | ✓ | @param {Array} entries 整份项目记忆 |
| `queuePrompts` | src/core/store.js:238 | ✓ |  |
| `flushProjectMemory` | src/core/store.js:243 | ✓ | 只把**项目记忆**那条待写落地（刷新项目记忆前先调：让本地改动先上去， |
| `resetPending` | src/core/store.js:249 |  | 收尾 |
| `flush` | src/core/store.js:257 | ✓ | 关页/切到后台前把待写数据发出去 |

#### `src/core/thinkloop.js`（3 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `endsWithRepeat` | src/core/thinkloop.js:31 |  | 结尾是否是 b 一字不差地连排 k 遍（不构造重复串，直接分段比较） |
| `thinkLoopHit` | src/core/thinkloop.js:40 | ✓ | 思考流是否在循环：命中返回一句人话描述，没命中返回 ''（供 notice 与单测） |
| `thinkOnlyRunaway` | src/core/thinkloop.js:58 | ✓ | 纯思考兜底：这轮是不是只有思考且已超量（content/calls 都空、thinking 超过 THINK_ONLY_CAP） |

#### `src/core/tool-runner.js`（8 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `createToolRunner` | src/core/tool-runner.js:38 | ✓ | 造一份独立的工具执行实例 |
| `init` | src/core/tool-runner.js:51 |  |  |
| `stripBadArgs` | src/core/tool-runner.js:88 |  | 去掉参数里的 __badArgs / __raw 标记（providers.js 的解析失败标记，只给内核看） |
| `importFail` | src/core/tool-runner.js:224 |  | skill_import 的失败出口：把服务端的分类错误翻成模型看得懂的话（与插件工具同一套口径） |
| `mergedSignal` | src/core/tool-runner.js:240 |  | 固定超时 + 本轮 run signal 合并成一个信号。 |
| `takeBudget` | src/core/tool-runner.js:273 |  | 扣一格预算；超额返回拒绝结果（ok:false，模型据此收尾），null  扣费成功继续执行 |
| `runMemoryTool` | src/core/tool-runner.js:314 |  |  |
| `subAgentSpec` | src/core/tool-runner.js:546 |  | 参数在这一层做**形状校验**（预算与上限在宿主注入的 runSubAgent 里执行）： |

### UI 顶层（agent/src/ui：App 入口等）——1 个文件 / 2 个函数

#### `src/ui/App.jsx`（2 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `App` | src/ui/App.jsx:27 | ✓ |  |
| `BootScreen` | src/ui/App.jsx:113 |  |  |

### UI 基础件（agent/src/ui/components，shadcn 风）——2 个文件 / 11 个函数

#### `src/ui/components/ui/ime-field.jsx`（4 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `textOf` | src/ui/components/ui/ime-field.jsx:18 |  |  |
| `useImeSafe` | src/ui/components/ui/ime-field.jsx:21 | ✓ | 非受控绑定：ref + 事件。onChange 沿用 DOM 事件签名（e.target.value），换标签即可替换受控写法 |
| `ImeInput` | src/ui/components/ui/ime-field.jsx:39 | ✓ |  |
| `ImeTextarea` | src/ui/components/ui/ime-field.jsx:44 | ✓ |  |

#### `src/ui/components/ui/toast.jsx`（7 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `emit` | src/ui/components/ui/toast.jsx:14 |  | 通知所有订阅者（<Toaster/> 用 useSyncExternalStore 订阅） |
| `subscribe` | src/ui/components/ui/toast.jsx:18 |  |  |
| `getSnapshot` | src/ui/components/ui/toast.jsx:23 |  |  |
| `dismissToast` | src/ui/components/ui/toast.jsx:28 | ✓ | 移除一条（点掉或到点自动消失）；重复调用无副作用 |
| `toast` | src/ui/components/ui/toast.jsx:41 | ✓ | 弹一条提示。 |
| `ToastItem` | src/ui/components/ui/toast.jsx:60 |  |  |
| `Toaster` | src/ui/components/ui/toast.jsx:78 | ✓ | 挂一次即可（放在应用根节点）：右下角从下往上堆叠 |

### UI 组件（agent/src/ui/features）——32 个文件 / 213 个函数

#### `src/ui/features/AboutAgent.jsx`（4 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `openAbout` | src/ui/features/AboutAgent.jsx:12 | ✓ | 打开对话框（页头与欢迎页都调它；与 openDownloads 同一形状） |
| `closeAbout` | src/ui/features/AboutAgent.jsx:16 |  |  |
| `Highlight` | src/ui/features/AboutAgent.jsx:21 | ✓ | 一条卖点：图标 + 标题 + 一句话（标题与描述都来自 brand.js） |
| `AboutAgentDialog` | src/ui/features/AboutAgent.jsx:35 | ✓ |  |

#### `src/ui/features/ChatView.jsx`（3 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `EmptyState` | src/ui/features/ChatView.jsx:28 |  | 空状态：品牌（名字 + 定位 + 卖点）+ 三个可点的建议 chips（底下保留「打 / 用模板」与「生成中回车  插话」两条提示） |
| `CompactionNotice` | src/ui/features/ChatView.jsx:86 |  | 压缩摘要：.marker-sep 分隔标签 + .marker 行（展开看摘要，可重新压缩 / 取消压缩） |
| `ChatView` | src/ui/features/ChatView.jsx:131 | ✓ |  |

#### `src/ui/features/Composer.jsx`（2 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `AccessMenu` | src/ui/features/Composer.jsx:24 |  | 访问级别菜单（向上弹出）：四档来自 AgentPolicy.MODES，当前档位显示实际效果摘要 |
| `Composer` | src/ui/features/Composer.jsx:68 | ✓ |  |

#### `src/ui/features/ConfirmDialog.jsx`（1 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `ConfirmDialog` | src/ui/features/ConfirmDialog.jsx:14 | ✓ |  |

#### `src/ui/features/ContextMeter.jsx`（2 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `Row` | src/ui/features/ContextMeter.jsx:14 |  | 明细里的一行 |
| `ContextMeter` | src/ui/features/ContextMeter.jsx:23 | ✓ |  |

#### `src/ui/features/DirectoryPicker.jsx`（1 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `DirectoryPicker` | src/ui/features/DirectoryPicker.jsx:18 | ✓ |  |

#### `src/ui/features/DownloadsDialog.jsx`（3 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `Row` | src/ui/features/DownloadsDialog.jsx:19 |  | 一行：名字（链接）+ 大小/时间 + 标记 + 下载/删除 |
| `Body` | src/ui/features/DownloadsDialog.jsx:53 |  | 列表体（含空态/错误态）：单独一个组件，让对话框本身只做编排 |
| `DownloadsDialog` | src/ui/features/DownloadsDialog.jsx:66 | ✓ |  |

#### `src/ui/features/FileDiffSheet.jsx`（16 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `sideNote` | src/ui/features/FileDiffSheet.jsx:28 |  | 一侧不能逐行比时的说明（目录/二进制/没备份/不存在）——别让用户对着一片空白猜 |
| `absentSide` | src/ui/features/FileDiffSheet.jsx:39 |  | 一侧是"文件不存在"吗（当作空文件比：新建  全篇 +、删除  全篇 −） |
| `bothText` | src/ui/features/FileDiffSheet.jsx:41 |  | 两侧都是可比的文本吗 |
| `computeDiff` | src/ui/features/FileDiffSheet.jsx:46 |  | 两侧文本都在（或一侧是"文件不存在"）→ 现算差异；其余（目录/二进制/没备份/被闸门拦）→ null。 |
| `SidePreview` | src/ui/features/FileDiffSheet.jsx:58 |  | 一侧读不到时的兜底：把**能读到的那一侧**原样铺出来（比如没解锁时"之前"仍来自服务端备份）。 |
| `LineNo` | src/ui/features/FileDiffSheet.jsx:82 |  |  |
| `Row` | src/ui/features/FileDiffSheet.jsx:86 |  |  |
| `DiffSummary` | src/ui/features/FileDiffSheet.jsx:106 |  | 差异上方的概览行：+N/−M + "之后"的来源说明 |
| `DiffRows` | src/ui/features/FileDiffSheet.jsx:129 |  |  |
| `DiffBody` | src/ui/features/FileDiffSheet.jsx:143 | ✓ | 差异主体：加载中 / 读不到 / 不可比（说明块）/ 有差异（概览 + 逐行）。 |
| `scopeTextOf` | src/ui/features/FileDiffSheet.jsx:176 |  | 头部里的一句话：这条命令的改动 还是 这个文件本轮的累计改动（同轮改过多次要说清） |
| `LineCounts` | src/ui/features/FileDiffSheet.jsx:180 |  |  |
| `HeadBar` | src/ui/features/FileDiffSheet.jsx:193 |  | 头部：路径 + 动作 + 行数 + 已恢复标记 + 一句话说明改动的维度 |
| `FileTabs` | src/ui/features/FileDiffSheet.jsx:211 |  | 一条命令动了多个路径时的文件标签（其余情况不画） |
| `FootBar` | src/ui/features/FileDiffSheet.jsx:227 |  | 底栏：只恢复这一个的说明 + 按钮（走与工具同一套权限闸门） |
| `FileDiffSheet` | src/ui/features/FileDiffSheet.jsx:243 | ✓ |  |

#### `src/ui/features/Header.jsx`（4 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `IconBtn` | src/ui/features/Header.jsx:16 |  |  |
| `AccessBadge` | src/ui/features/Header.jsx:35 |  | 访问级别徽章：完全访问档用醒目样式（模型不再逐条问你，必须一眼能看见） |
| `StatusLine` | src/ui/features/Header.jsx:54 |  | 连接状态点 + 标题/当前模型（错误时 title 显示原因） |
| `Header` | src/ui/features/Header.jsx:70 | ✓ |  |

#### `src/ui/features/JumpButton.jsx`（2 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `nearBottom` | src/ui/features/JumpButton.jsx:7 |  |  |
| `JumpButton` | src/ui/features/JumpButton.jsx:9 | ✓ |  |

#### `src/ui/features/KickedOverlay.jsx`（1 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `KickedOverlay` | src/ui/features/KickedOverlay.jsx:12 | ✓ |  |

#### `src/ui/features/LoginDialog.jsx`（2 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `clearProjects` | src/ui/features/LoginDialog.jsx:28 |  | 换身份/登出时把"项目"也清干净：项目记忆与项目清单都属于上一个账号，绝不能留着 |
| `LoginDialog` | src/ui/features/LoginDialog.jsx:34 | ✓ |  |

#### `src/ui/features/Message.jsx`（19 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `Actions` | src/ui/features/Message.jsx:22 |  | 一条消息的操作行（悬停/聚焦出现；触屏由 .touch-visible 常显） |
| `Thinking` | src/ui/features/Message.jsx:41 |  |  |
| `ErrorBlock` | src/ui/features/Message.jsx:69 |  | 错误块 + 「重试这一轮」（从 Meta 抽出：这一块自带三层条件，留在 Meta 里就超复杂度棘轮） |
| `Meta` | src/ui/features/Message.jsx:91 |  | 元信息 + 未跑完 / 空回答的说明（元信息只用一行小字，不做徽章） |
| `filesText` | src/ui/features/Message.jsx:117 |  | 撤销确认框与结果里的文件清单（最多列 8 个，其余写"等 N 个"） |
| `undoBody` | src/ui/features/Message.jsx:124 |  | 撤销确认框的正文：说清会发生什么、列出文件、记录不全时如实提醒 |
| `reportUndo` | src/ui/features/Message.jsx:134 |  | 撤销结果 → 一句 toast；返回 true  全部恢复（按钮可以收起来） |
| `confirmUndo` | src/ui/features/Message.jsx:150 |  | 点「撤销」：确认 → 请求服务端 → 一句结果；返回组件该切到的状态。 |
| `WallTime` | src/ui/features/Message.jsx:169 |  | 运行时长（一句话，tabular-nums 让数字对齐） |
| `liveUsage` | src/ui/features/Message.jsx:180 |  | 实时条 tokens 的两档数值：真实 usage 优先；否则按现有约定估算并标 ≈（同 statsParts 的口径）。 |
| `liveFooterParts` | src/ui/features/Message.jsx:192 |  | 实时收尾条的各个块（用时/输入/输出，null 项不显示）——全部条件集中在这一个纯函数里 |
| `LiveFooter` | src/ui/features/Message.jsx:213 |  | 运行中的收尾条：与结束后 RunFooter 同一位置、同一格式——「本轮用时」+ 输入/输出 tokens。 |
| `RunFooter` | src/ui/features/Message.jsx:248 |  | 本轮收尾条：**运行时长** + 「撤销本轮文件改动」。 |
| `footerView` | src/ui/features/Message.jsx:257 |  | 这一条消息该不该有收尾条、里面各块显示不显示（判据集中在这里，组件只管画） |
| `FooterBody` | src/ui/features/Message.jsx:265 |  |  |
| `UndoButton` | src/ui/features/Message.jsx:277 |  | 撤销按钮  一个下拉菜单（UndoMenu）：逐文件明细 + "点开看对比" + 底部"全部恢复"。 |
| `UndoneNote` | src/ui/features/Message.jsx:282 |  | 撤销过之后的痕迹：留在原位（刷新后也知道"这一轮已经撤过了"） |
| `Message` | src/ui/features/Message.jsx:305 |  |  |
| `undoRevOf` | src/ui/features/Message.jsx:452 | ✓ | **流式中的那条必须永远重渲**——这一条比"省开销"重要，别再删（2026-09-30 实测的坑）。 |

#### `src/ui/features/SessionOutline.jsx`（8 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `buildItems` | src/ui/features/SessionOutline.jsx:29 | ✓ | 大纲条目：每条 user 消息一条（下标 mi 用来在 DOM 里找那条消息） |
| `jumpTo` | src/ui/features/SessionOutline.jsx:41 |  | 跳到某条提问：滚到它的位置并让它闪一下（.ol-target，见 styles.css） |
| `useCurrent` | src/ui/features/SessionOutline.jsx:55 |  | "读到哪"：以视口上方 1/3 处为基准线，最后一条越过基准线的提问就是当前段。 |
| `OutlineLine` | src/ui/features/SessionOutline.jsx:85 |  | 桌面轨的单条横线（+ 悬停卡片）：默认只是 12px 宽的小横线，悬停时线变长、卡片淡入 |
| `OutlineRail` | src/ui/features/SessionOutline.jsx:120 |  | 桌面轨：贴消息区右缘的一列横线（等距，条数多时由 CSS 自动压缩间距）。 |
| `OutlineList` | src/ui/features/SessionOutline.jsx:141 | ✓ | 手机列表：一条提问一行原文（点一行  跳过去）。自己就是滚动容器—— |
| `PhoneOutline` | src/ui/features/SessionOutline.jsx:177 |  | 手机：左下角浮标（与右下角的"回到底部"JumpButton 左右对称）+ 底部列表 |
| `SessionOutline` | src/ui/features/SessionOutline.jsx:211 | ✓ |  |

#### `src/ui/features/Sidebar.jsx`（10 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `Brand` | src/ui/features/Sidebar.jsx:17 |  | 品牌头 |
| `ModelCard` | src/ui/features/Sidebar.jsx:40 |  | 当前模型卡片 |
| `bucketOf` | src/ui/features/Sidebar.jsx:69 |  |  |
| `groupSessions` | src/ui/features/Sidebar.jsx:81 |  | 分组：按项目（项目文件夹  一个组，未归属的归"未归项目"）或按最后处理时间 |
| `rounds` | src/ui/features/Sidebar.jsx:111 |  | 会话的"轮数"  用户消息条数（侧栏副标题里那个 N 轮） |
| `SessionItem` | src/ui/features/Sidebar.jsx:113 |  |  |
| `SessionList` | src/ui/features/Sidebar.jsx:175 |  |  |
| `ProjectCard` | src/ui/features/Sidebar.jsx:263 |  | 当前项目卡：点进去管理项目；右边一个归档按钮——**连它下面的会话一起**收进存档 |
| `BindRow` | src/ui/features/Sidebar.jsx:320 |  |  |
| `Sidebar` | src/ui/features/Sidebar.jsx:359 | ✓ | 侧栏 |

#### `src/ui/features/TodoPanel.jsx`（4 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `pct` | src/ui/features/TodoPanel.jsx:14 |  |  |
| `Bar` | src/ui/features/TodoPanel.jsx:16 |  |  |
| `Item` | src/ui/features/TodoPanel.jsx:25 |  |  |
| `TodoPanel` | src/ui/features/TodoPanel.jsx:44 | ✓ |  |

#### `src/ui/features/TraceGroup.jsx`（2 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `Head` | src/ui/features/TraceGroup.jsx:34 |  | 一行摘要：图标 + 步数（进行中走 shimmer）+ 失败数 + 改动处数 + 分类计数 + 累计耗时。 |
| `TraceGroup` | src/ui/features/TraceGroup.jsx:69 | ✓ |  |

#### `src/ui/features/TraceStrip.jsx`（18 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `isSteer` | src/ui/features/TraceStrip.jsx:17 |  |  |
| `isSub` | src/ui/features/TraceStrip.jsx:18 |  |  |
| `labelOf` | src/ui/features/TraceStrip.jsx:20 |  |  |
| `StateIcon` | src/ui/features/TraceStrip.jsx:23 |  | 状态图标：进行中转圈、失败 ✕、成功 ✓（装饰性的，语义由文字承担） |
| `charsOf` | src/ui/features/TraceStrip.jsx:30 |  | 结果字数的两个数：**显示了 / 一共**（一共  模型实际收到的字数，记录上限截断前的）。 |
| `metaText` | src/ui/features/TraceStrip.jsx:38 |  | 一行右侧的元信息：备注 / 耗时 / 字数（进行中不重复写「进行中」——shimmer 文字本身就是状态）。 |
| `charsSuffix` | src/ui/features/TraceStrip.jsx:48 |  | 字数后缀（RecordList 与 metaText 同一口径；截断时写成"显示了/一共 字"） |
| `prefixOf` | src/ui/features/TraceStrip.jsx:54 |  | 标题前缀（插话与子智能体各有一个小标记，类型一目了然） |
| `openDiffOf` | src/ui/features/TraceStrip.jsx:57 |  | 打开「比对修改」抽屉并带定位（点击与键盘两处共用一份载荷） |
| `DiffChip` | src/ui/features/TraceStrip.jsx:68 |  | 写入 / 删除的行数（写文件、改文件、删文件、移动/建目录才有）： |
| `Head` | src/ui/features/TraceStrip.jsx:105 |  | 一行 Marker：状态图标 + 标题（进行中走 shimmer）+ 改动行数 + 备注/耗时/字数（tabular-nums） |
| `MediaPreview` | src/ui/features/TraceStrip.jsx:132 |  | 媒体预览（图片 / 视频 / 音频）：deliver_file 交付的"能显示的文件"直接画在卡片里， |
| `FileCards` | src/ui/features/TraceStrip.jsx:165 | ✓ | 可下载文件卡（deliver_file 那张）：图片/视频/音频（且不是打包产物）直接带预览（MediaPreview）， |
| `Block` | src/ui/features/TraceStrip.jsx:200 |  | 详情里的一块（参数 / 结果）：没有内容就什么都不画 |
| `truncHint` | src/ui/features/TraceStrip.jsx:215 |  | 被记录上限截断时的说明：说清"这里少显示的只是记录，模型收到的是完整的"， |
| `SubCard` | src/ui/features/TraceStrip.jsx:222 |  | 子智能体那张卡的详情：任务/模型 + 「查看记录」（完整转录按 runId+subId 现取）。 |
| `RecordList` | src/ui/features/TraceStrip.jsx:252 |  | 子智能体转录：每一步（工具/参数/结果）一张小卡；服务端保留最近一段时间的记录 |
| `TraceStrip` | src/ui/features/TraceStrip.jsx:269 | ✓ |  |

#### `src/ui/features/UndoMenu.jsx`（6 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `pendingOf` | src/ui/features/UndoMenu.jsx:20 | ✓ | 还剩几个没恢复（新数据看 pendingCount；旧数据回退到 undone 标记） |
| `filesOf` | src/ui/features/UndoMenu.jsx:27 | ✓ | 菜单里的文件清单：优先 fileList（有行数与动作），旧数据回退成路径列表 |
| `Counts` | src/ui/features/UndoMenu.jsx:32 |  |  |
| `triggerText` | src/ui/features/UndoMenu.jsx:44 |  | 触发器文案：整轮都没恢复过 → "（N 处）"；部分恢复过 → "（还剩 K 处）" |
| `FileRow` | src/ui/features/UndoMenu.jsx:47 |  | 菜单里的一行文件：动作 + 路径 + 行数 + 状态；点击打开比对抽屉 |
| `UndoMenu` | src/ui/features/UndoMenu.jsx:71 | ✓ | @param {object} p.undo        msg.undo（服务端摘要） |

#### `src/ui/features/chat-utils.js`（5 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `requestScrollBottom` | src/ui/features/chat-utils.js:21 | ✓ |  |
| `takeScrollBottom` | src/ui/features/chat-utils.js:22 | ✓ |  |
| `codeRenderer` | src/ui/features/chat-utils.js:28 |  | 代码块 HTML：结构与 core 的 styles.css 约定一致（.codeblock / .codeblock-head）； |
| `renderMarkdownHtml` | src/ui/features/chat-utils.js:36 | ✓ | 渲染正文：MD.render 内部已转义，可安全 dangerouslySetInnerHTML |
| `handleCodeCopy` | src/ui/features/chat-utils.js:40 | ✓ | 事件委托：点在 [data-copy] 上就复制同一代码块里的 <pre><code>； |

#### `src/ui/features/settings/AppearanceSection.jsx`（2 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `AccentDot` | src/ui/features/settings/AppearanceSection.jsx:23 |  |  |
| `AppearanceSection` | src/ui/features/settings/AppearanceSection.jsx:42 | ✓ |  |

#### `src/ui/features/settings/ArchiveSection.jsx`（1 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `ArchiveSection` | src/ui/features/settings/ArchiveSection.jsx:21 | ✓ |  |

#### `src/ui/features/settings/BindingSection.jsx`（10 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `phaseOf` | src/ui/features/settings/BindingSection.jsx:20 |  | 状态卡 |
| `bindRows` | src/ui/features/settings/BindingSection.jsx:25 |  |  |
| `InfoRow` | src/ui/features/settings/BindingSection.jsx:42 |  |  |
| `StatusCard` | src/ui/features/settings/BindingSection.jsx:50 |  |  |
| `BindForm` | src/ui/features/settings/BindingSection.jsx:65 |  | 绑定 / 解锁表单 |
| `UnlockForm` | src/ui/features/settings/BindingSection.jsx:106 |  |  |
| `ManageActions` | src/ui/features/settings/BindingSection.jsx:141 |  | 已绑定后的管理动作 |
| `BindingBody` | src/ui/features/settings/BindingSection.jsx:160 |  | 已绑定/未绑定走完全不同的入口；不可校验的部署只留一句说明 |
| `useBindingActions` | src/ui/features/settings/BindingSection.jsx:178 |  | 绑定相关的动作都包一层 busy + 失败提示 |
| `BindingSection` | src/ui/features/settings/BindingSection.jsx:193 | ✓ | 分区 |

#### `src/ui/features/settings/DataSection.jsx`（6 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `ExportCard` | src/ui/features/settings/DataSection.jsx:18 |  | 四块内容 |
| `StatsCard` | src/ui/features/settings/DataSection.jsx:34 |  |  |
| `CleanupCard` | src/ui/features/settings/DataSection.jsx:50 |  |  |
| `ContextCard` | src/ui/features/settings/DataSection.jsx:77 |  |  |
| `useDataActions` | src/ui/features/settings/DataSection.jsx:120 |  | 动作 |
| `DataSection` | src/ui/features/settings/DataSection.jsx:136 | ✓ | 分区 |

#### `src/ui/features/settings/MemorySection.jsx`（7 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `parseTags` | src/ui/features/settings/MemorySection.jsx:19 |  |  |
| `MemoryCard` | src/ui/features/settings/MemorySection.jsx:23 |  | 单条记忆 |
| `MemoryComposer` | src/ui/features/settings/MemorySection.jsx:85 |  | 新增表单 |
| `MemoryColumn` | src/ui/features/settings/MemorySection.jsx:113 |  | 一栏（全局 / 项目 / 会话） |
| `ProjectHint` | src/ui/features/settings/MemorySection.jsx:135 |  | 项目记忆那一栏的头顶：没项目时先说清"为什么这里是空的、去哪建项目"； |
| `TransferBar` | src/ui/features/settings/MemorySection.jsx:161 |  | 导入 / 导出 |
| `MemorySection` | src/ui/features/settings/MemorySection.jsx:190 | ✓ | 分区 |

#### `src/ui/features/settings/ModelsSection.jsx`（14 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `testRef` | src/ui/features/settings/ModelsSection.jsx:26 |  |  |
| `runTest` | src/ui/features/settings/ModelsSection.jsx:30 |  |  |
| `TemplateGrid` | src/ui/features/settings/ModelsSection.jsx:39 |  | 模板快速添加 |
| `ProviderList` | src/ui/features/settings/ModelsSection.jsx:60 |  | 列表本体：点一行展开编辑，点已展开的那行收起 |
| `ProviderRow` | src/ui/features/settings/ModelsSection.jsx:83 |  |  |
| `ModelChips` | src/ui/features/settings/ModelsSection.jsx:129 |  | 模型清单（拉取后点选填入） |
| `useProviderDraft` | src/ui/features/settings/ModelsSection.jsx:163 |  | 表单草稿：全部本地 state，点「保存」才写服务端（密钥留空  保持原值） |
| `NameTypeFields` | src/ui/features/settings/ModelsSection.jsx:180 |  |  |
| `ModelKeyFields` | src/ui/features/settings/ModelsSection.jsx:200 |  |  |
| `KeyHintRow` | src/ui/features/settings/ModelsSection.jsx:218 |  |  |
| `AdvancedFields` | src/ui/features/settings/ModelsSection.jsx:228 |  |  |
| `FormHeader` | src/ui/features/settings/ModelsSection.jsx:270 |  |  |
| `ProviderForm` | src/ui/features/settings/ModelsSection.jsx:283 |  |  |
| `ModelsSection` | src/ui/features/settings/ModelsSection.jsx:364 | ✓ | 分区 |

#### `src/ui/features/settings/ParamsSection.jsx`（7 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `ScopePicker` | src/ui/features/settings/ParamsSection.jsx:19 |  | 作用范围 |
| `PresetBar` | src/ui/features/settings/ParamsSection.jsx:44 |  | 快速预设 |
| `GroupBlock` | src/ui/features/settings/ParamsSection.jsx:61 |  | 单个参数分组 |
| `ActiveModelBar` | src/ui/features/settings/ParamsSection.jsx:91 |  | 当前模型条 |
| `scopeOf` | src/ui/features/settings/ParamsSection.jsx:109 |  | 每模型覆盖的键：<服务商id>::<模型名>；模型换了就回落到全局，避免改错对象 |
| `modelPair` | src/ui/features/settings/ParamsSection.jsx:110 |  |  |
| `ParamsSection` | src/ui/features/settings/ParamsSection.jsx:112 | ✓ |  |

#### `src/ui/features/settings/ProjectsSection.jsx`（3 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `ProjectRow` | src/ui/features/settings/ProjectsSection.jsx:23 |  | 一个项目 |
| `StartRow` | src/ui/features/settings/ProjectsSection.jsx:59 |  | 起点：目录选择器从这里开始、项目必须落在它下面（不影响 agent 能读写哪些目录） |
| `ProjectsSection` | src/ui/features/settings/ProjectsSection.jsx:84 | ✓ |  |

#### `src/ui/features/settings/PromptsSection.jsx`（18 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `isExtra` | src/ui/features/settings/PromptsSection.jsx:36 |  | 用户新增的条目（addEntry 生成的 id 以 px- 开头）；自定义技能另由 all() 标 custom |
| `isCustomSkill` | src/ui/features/settings/PromptsSection.jsx:37 |  |  |
| `KindBadges` | src/ui/features/settings/PromptsSection.jsx:51 |  | 条目行 |
| `removable` | src/ui/features/settings/PromptsSection.jsx:62 |  |  |
| `PromptActions` | src/ui/features/settings/PromptsSection.jsx:65 |  | 展开后的操作行：应用 / 恢复默认 / 删除 + 未应用提示 |
| `SkillMetaFields` | src/ui/features/settings/PromptsSection.jsx:85 |  | 自定义技能的名称 / 加载方式 / 用途（与正文同一套「草稿 → 应用」，见 setPromptDraft） |
| `draftView` | src/ui/features/settings/PromptsSection.jsx:113 |  | 一条目的最终值  当前值叠上草稿补丁；dirty 按**逐字段比较**判定—— |
| `toggleItem` | src/ui/features/settings/PromptsSection.jsx:125 |  | 开关：对普通条目写覆盖表；自定义技能不走覆盖表，用 updateSkill 直接改（关掉  不注入/不可加载） |
| `applyItem` | src/ui/features/settings/PromptsSection.jsx:130 |  | 应用一条草稿：自定义技能的名称/用途/加载方式/正文整份交给 updateSkill（登记表自己 notify → 落盘） |
| `removeItem` | src/ui/features/settings/PromptsSection.jsx:137 |  | 删除内置/技能条目（不可逆）：与全站约定一致先过 askConfirm（原先直接删 + toast，2026-10-06 补上） |
| `PresetChips` | src/ui/features/settings/PromptsSection.jsx:152 |  | 主系统提示词的快选（core/prompts.js 的 presets）：填成草稿，点「应用」才生效 |
| `PromptEditor` | src/ui/features/settings/PromptsSection.jsx:166 |  |  |
| `PromptItem` | src/ui/features/settings/PromptsSection.jsx:184 |  |  |
| `PromptGroup` | src/ui/features/settings/PromptsSection.jsx:211 |  | 一个分组：标题 + 条目卡（footer 放"新建"这类挂在组尾的入口，见 ② 技能组） |
| `AddSkillForm` | src/ui/features/settings/PromptsSection.jsx:226 |  | 新建技能（挂在 ② 技能组列表下方） |
| `AddEntryForm` | src/ui/features/settings/PromptsSection.jsx:259 |  |  |
| `PreviewDialog` | src/ui/features/settings/PromptsSection.jsx:295 |  | 发送预览 |
| `PromptsSection` | src/ui/features/settings/PromptsSection.jsx:331 | ✓ | 分区 |

#### `src/ui/features/settings/SettingsDrawer.jsx`（3 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `NavItem` | src/ui/features/settings/SettingsDrawer.jsx:34 |  |  |
| `DrawerFooter` | src/ui/features/settings/SettingsDrawer.jsx:56 |  | 底部一行状态：当前模型与连接情况（抽屉里改完模型能立刻看到结果） |
| `SettingsDrawer` | src/ui/features/settings/SettingsDrawer.jsx:73 | ✓ |  |

#### `src/ui/features/settings/ToolsSection.jsx`（11 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `AccessCard` | src/ui/features/settings/ToolsSection.jsx:37 |  | 访问级别 |
| `AccessLevels` | src/ui/features/settings/ToolsSection.jsx:63 |  |  |
| `SearchBuiltinRow` | src/ui/features/settings/ToolsSection.jsx:90 |  |  |
| `ToolGroup` | src/ui/features/settings/ToolsSection.jsx:104 |  |  |
| `ToolField` | src/ui/features/settings/ToolsSection.jsx:123 |  | 工具参数一行：控件与说明都走共用的 ParamRow（list 型自动用 chips 渲染） |
| `RootsCard` | src/ui/features/settings/ToolsSection.jsx:136 |  | 可访问目录 |
| `ServerInfo` | src/ui/features/settings/ToolsSection.jsx:191 |  | 服务端只读信息 |
| `rootsOf` | src/ui/features/settings/ToolsSection.jsx:230 |  | 可访问目录：优先服务端下发的生效值，其次设置里的记录 |
| `rootsAction` | src/ui/features/settings/ToolsSection.jsx:233 |  |  |
| `ServerPanels` | src/ui/features/settings/ToolsSection.jsx:238 |  |  |
| `ToolsSection` | src/ui/features/settings/ToolsSection.jsx:248 | ✓ |  |

#### `src/ui/features/settings/parts.jsx`（18 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `SettingRow` | src/ui/features/settings/parts.jsx:19 | ✓ | 设置行：左标签（带问号说明）+ 右控件；below 放需要整行宽度的内容（chips、清单） |
| `NoteBox` | src/ui/features/settings/parts.jsx:55 | ✓ | 说明块（危险清单、安全提醒这类成段文字） |
| `EmptyHint` | src/ui/features/settings/parts.jsx:70 | ✓ | 空列表提示 |
| `GroupCard` | src/ui/features/settings/parts.jsx:79 | ✓ | 分组卡容器：设置分区里"一块带边框的条目组"（原先七个分区各写一遍同一串类，2026-10-06 收敛） |
| `ListRow` | src/ui/features/settings/parts.jsx:84 | ✓ | 列表行：项目/技能/自定义条目这类"一行一条"的可点条目（原先三处各写一遍） |
| `ChoiceGroup` | src/ui/features/settings/parts.jsx:93 | ✓ | 分段选择（外观的模式/字号/密度、技能的加载方式） |
| `textOf` | src/ui/features/settings/parts.jsx:122 |  | 受控输入（本地草稿，失焦/回车才提交） |
| `NumberInput` | src/ui/features/settings/parts.jsx:127 | ✓ | 数字输入：草稿态只在本组件里，提交时夹回 min/max。 |
| `useDraft` | src/ui/features/settings/parts.jsx:161 |  | 草稿态：null  跟随外部值，非 null  用户正在编辑；settle() 一次性结算（失焦时调） |
| `DraftTextarea` | src/ui/features/settings/parts.jsx:174 |  | 多行文本域：草稿 + 失焦提交 |
| `JsonTextarea` | src/ui/features/settings/parts.jsx:188 | ✓ | JSON 文本域：失焦时先解析，解析失败保留草稿并提示（不写坏设置） |
| `NumBadge` | src/ui/features/settings/parts.jsx:208 |  | 数值徽章（滑块右侧的当前值） |
| `RangeControl` | src/ui/features/settings/parts.jsx:219 |  | 滑块：拖动中只改本地草稿，松手（onValueCommit）才写设置 |
| `SelectControl` | src/ui/features/settings/parts.jsx:238 |  |  |
| `ParamControl` | src/ui/features/settings/parts.jsx:254 |  | 按 kind 渲染一项参数的控件；list 型（chips）由调用方用 below 渲染 |
| `ParamRow` | src/ui/features/settings/parts.jsx:270 | ✓ | 参数行：标签 + 问号说明 + 控件；被每模型覆盖的键在说明里标出来 |
| `ChipsEditor` | src/ui/features/settings/parts.jsx:294 |  | chips（允许清单这类条目集合） |
| `downloadText` | src/ui/features/settings/parts.jsx:340 | ✓ | 触发浏览器下载（导出数据 / 记忆用；不经过服务端） |

### UI 纯函数库（agent/src/ui/lib）——6 个文件 / 33 个函数

#### `src/ui/lib/diff.js`（10 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `toLines` | src/ui/lib/diff.js:28 |  | 文本 → 行数组。`'a\nb\n'` 是 2 行（末尾换行不是"多一行空的"），`'a\n\n'` 是 2 行（含一个空行）。 |
| `commonEdges` | src/ui/lib/diff.js:37 |  | 公共前缀/后缀的行数（掐掉两头，中间段通常只剩改动附近那几行） |
| `lcsTable` | src/ui/lib/diff.js:46 |  | LCS 长度表（dp[i][j]  从 i/j 起的公共子序列长度，一维 Int32Array 存放） |
| `backtrack` | src/ui/lib/diff.js:60 |  | 沿长度表回溯出一条对齐序列：[{type:'ctx'∣'del'∣'add', ai?, bj?}] |
| `align` | src/ui/lib/diff.js:74 |  | 中间段的行对齐；规模过大返回 null（调用方退化处理） |
| `midRow` | src/ui/lib/diff.js:81 |  | 对齐项 → 带行号的 diff 行（a/b 是各自侧 1 起的行号，pre 是公共前缀长度） |
| `buildRows` | src/ui/lib/diff.js:88 |  | 铺 rows：前缀 ctx + 中间段（LCS 或退化）+ 后缀 ctx |
| `foldRows` | src/ui/lib/diff.js:108 |  | 折叠：每个改动周围保留 ctx 行，其余未变区合成一条 gap（ctxInfinity 时全展开） |
| `tally` | src/ui/lib/diff.js:131 |  |  |
| `diffLines` | src/ui/lib/diff.js:145 | ✓ | 两侧文本 → diff 行。`opts.context` 是每个改动周围保留的上下文行数（默认 3；给 Infinity 就全展开）。 |

#### `src/ui/lib/filekind.js`（2 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `extOf` | src/ui/lib/filekind.js:22 |  |  |
| `fileKind` | src/ui/lib/filekind.js:29 | ✓ | 'image' ∣ 'video' ∣ 'audio' ∣ null（null  只给下载卡片） |

#### `src/ui/lib/format.js`（12 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `shortPath` | src/ui/lib/format.js:12 | ✓ | 路径显示：家目录换成 ~（只认 /home/<user> 这一段，用于列表里省地方） |
| `fmtTime` | src/ui/lib/format.js:15 | ✓ | 本地时间（zh-CN、24 小时制）；时间戳非法时回落到"现在" |
| `fmtChars` | src/ui/lib/format.js:20 | ✓ | 字符数（**不是字节**）：说"这段文本多大"，用于写文件、提示词长度这类 |
| `fmtBytes` | src/ui/lib/format.js:30 | ✓ | 字节数：说"磁盘/传输上限多大"（面板上的参数值本身是 KB，调用方先乘 1024） |
| `fmtNum` | src/ui/lib/format.js:38 | ✓ | 数值（滑块读数）：最多三位小数、去掉多余的 0 |
| `fmtCount` | src/ui/lib/format.js:41 | ✓ | 整数（统计读数）：千分位 |
| `fmtTokens` | src/ui/lib/format.js:44 | ✓ | token 数缩写：32000 → 32K（万位以上不留小数） |
| `timeAgo` | src/ui/lib/format.js:51 | ✓ | 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / M-D |
| `fullTime` | src/ui/lib/format.js:64 | ✓ | 完整时间（title 提示用） |
| `outlineLabel` | src/ui/lib/format.js:69 | ✓ | 一句提问的「名字」（右侧会话大纲的悬停标题）。 |
| `fmtDuration` | src/ui/lib/format.js:92 | ✓ | 运行时长（人话）：12.3 秒 / 1 分 23 秒 / 1 小时 2 分。 |
| `statsParts` | src/ui/lib/format.js:105 | ✓ | 一轮的元信息：tok/s · tokens · prompt · 耗时（拿不到 usage 时按字数估算 tokens） |

#### `src/ui/lib/trace.js`（6 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `traceKind` | src/ui/lib/trace.js:22 | ✓ | 条目的类别（缺省 tool；旧数据没有 kind 字段） |
| `traceRunning` | src/ui/lib/trace.js:25 | ✓ | 是否还在进行中：优先看 state；旧数据（没有 state）按当时的文案回推 |
| `shortToolName` | src/ui/lib/trace.js:47 | ✓ | 一条追踪条在折叠摘要里的短名 |
| `summarizeTraces` | src/ui/lib/trace.js:65 | ✓ | 一轮里的全部追踪条 → 折叠摘要（一行能看懂的计数；界面只负责画，口径在这里、可单测）。 |
| `tally` | src/ui/lib/trace.js:77 |  | 把一条追踪条记进摘要（各项计数 + 分类计数）；分类表按 label 去重，`at` 记首次出现的次序 |
| `linesOf` | src/ui/lib/trace.js:93 | ✓ | 一条追踪条记的改动行数（负数/NaN 一律当 0）。 |

#### `src/ui/lib/useMedia.js`（2 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `useMediaQuery` | src/ui/lib/useMedia.js:13 |  |  |
| `useIsPhone` | src/ui/lib/useMedia.js:27 | ✓ |  |

#### `src/ui/lib/utils.js`（1 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `cn` | src/ui/lib/utils.js:6 | ✓ | 合并任意类名输入，并消解 Tailwind 同属性冲突（如 h-8 与 h-9 只留后者） |

### UI 状态层（agent/src/ui/state，React 之外的"动作层"）——10 个文件 / 220 个函数

#### `src/ui/state/downloads.js`（7 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `downloadUrl` | src/ui/state/downloads.js:18 | ✓ | 下载链接（**这是唯一入口**：卡片与菜单都用它，形状一致） |
| `inlineUrl` | src/ui/state/downloads.js:23 | ✓ | 内联预览链接（会话卡片里的 <img>/<video>/<audio> 引用这条）： |
| `loadDownloads` | src/ui/state/downloads.js:25 | ✓ |  |
| `openDownloads` | src/ui/state/downloads.js:42 | ✓ |  |
| `closeDownloads` | src/ui/state/downloads.js:47 | ✓ |  |
| `removeDownload` | src/ui/state/downloads.js:52 | ✓ | 删掉一个（待下载目录会越攒越多，菜单里能清） |
| `markChanged` | src/ui/state/downloads.js:65 | ✓ | 服务端说"目录变了"（模型刚 deliver_file）：刷新列表（菜单没开也刷新——菜单上的计数要跟上） |

#### `src/ui/state/fileDiff.js`（12 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `cur` | src/ui/state/fileDiff.js:20 |  |  |
| `put` | src/ui/state/fileDiff.js:21 |  |  |
| `stale` | src/ui/state/fileDiff.js:24 |  | 这次请求的结果还作数吗——加载期间用户可能切了文件、关了抽屉或换了运行 |
| `openFileDiff` | src/ui/state/fileDiff.js:33 | ✓ | 打开抽屉。`files`  `[{ path, entry? }]`（entry 只在"这一条命令的改动"入口给； |
| `closeFileDiff` | src/ui/state/fileDiff.js:44 | ✓ |  |
| `selectFileDiff` | src/ui/state/fileDiff.js:47 | ✓ | 切到清单里的另一个文件（多路径的卡片 / 菜单逐个点开时） |
| `fetchDiff` | src/ui/state/fileDiff.js:55 |  | 请求当前文件的两侧内容（单独的取数函数：加载流程的"判定/写状态"都在 loadFileDiff 里） |
| `settleDiff` | src/ui/state/fileDiff.js:61 |  | 取数的两种落点（都在 stale 检查之后调用）：成功写 data，失败写 error 并按需引导 |
| `loadFileDiff` | src/ui/state/fileDiff.js:69 |  | 取当前文件的两侧内容；回来时对不上（切了文件/关了抽屉）就丢弃这次结果。 |
| `reloadFileDiff` | src/ui/state/fileDiff.js:81 | ✓ | 重新拉一次当前文件的两侧内容（"仅恢复这一个"成功之后用：两侧应当变得一致） |
| `reportRestoreFails` | src/ui/state/fileDiff.js:84 |  | 恢复结果里有失败 → 提示 + 闸门引导；返回 true 表示"这一趟没有成功" |
| `restoreFileDiff` | src/ui/state/fileDiff.js:97 | ✓ | 「仅恢复这一个」：把当前文件恢复成这一轮开始前的样子（同一轮里被改过多次就一起回退）。 |

#### `src/ui/state/host.js`（30 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `me` | src/ui/state/host.js:32 | ✓ | 直接读 state 的小访问器 |
| `bound` | src/ui/state/host.js:33 | ✓ |  |
| `hasServer` | src/ui/state/host.js:34 |  |  |
| `promptDraftCount` | src/ui/state/host.js:37 | ✓ | 提示词登记表里有几条未应用的草稿（徽章与发送前提醒共用这一处口径； |
| `providers` | src/ui/state/host.js:39 | ✓ |  |
| `activeProvider` | src/ui/state/host.js:40 | ✓ |  |
| `paramsOf` | src/ui/state/host.js:48 | ✓ | 参数取值：出厂 → 全局 → 每模型覆盖（唯一真源在 core/params.js） |
| `assembleEnv` | src/ui/state/host.js:55 |  |  |
| `val2` | src/ui/state/host.js:63 | ✓ |  |
| `accessOf` | src/ui/state/host.js:69 | ✓ |  |
| `traceChars` | src/ui/state/host.js:73 |  | 追踪条单条结果的字数上限（面板 record_trace_chars，默认 4000）。 |
| `promptBlocks` | src/ui/state/host.js:81 | ✓ | 本轮注入的区块与工具（界面展示与实际发送同源） |
| `sendPreview` | src/ui/state/host.js:91 | ✓ | 「发送预览」用：区块清单 + 实际 messages（JSON）+ 工具 schema |
| `curSess` | src/ui/state/host.js:97 | ✓ | 当前会话 / 当前项目 |
| `adoptProject` | src/ui/state/host.js:112 | ✓ | 把"当前项目"灌进 core（项目记忆 + 项目事实）与 Store（项目记忆写给谁）。 |
| `persistSession` | src/ui/state/host.js:120 | ✓ | 把当前 history 写回会话对象并排队落盘（生成中也会定期调，刷新不丢） |
| `fetchProjectMemory` | src/ui/state/host.js:138 | ✓ | 读某个项目的记忆条目（服务端真源；唯一一份——原先 session.js 与 projects.js 各有一份 |
| `saveSettings` | src/ui/state/host.js:149 | ✓ |  |
| `settingsForSave` | src/ui/state/host.js:154 |  | 交给服务端的配置快照（密钥字段只在"新填/改过"时带上，其余保持服务端原值） |
| `addTraceStrip` | src/ui/state/host.js:186 | ✓ | 往"当前正在生成的助手消息"上挂一条状态条；返回 token（内核会原样回传到 onToolEnd） |
| `fillTraceStrip` | src/ui/state/host.js:198 | ✓ |  |
| `askConfirm` | src/ui/state/host.js:223 | ✓ | 弹一个确认框，返回 Promise<{ok, remember}>；同一时刻只处理一个（排队） |
| `resolveConfirm` | src/ui/state/host.js:237 | ✓ | 确认框的结算（由 ConfirmDialog 组件调用） |
| `guardStreaming` | src/ui/state/host.js:254 | ✓ | "这条会话生成中不许做某事"的统一拦截（清空/回撤/删一轮/重新生成…）。 |
| `wireCore` | src/ui/state/host.js:294 | ✓ | 装配 core 层：进程启动时调一次（main.jsx） |
| `askConfirmPlugin` | src/ui/state/host.js:416 |  |  |
| `askConfirmSkillImport` | src/ui/state/host.js:428 |  | 技能导入的确认框（三技能动作里形状最特殊的一个，单独成函数） |
| `askConfirmSkill` | src/ui/state/host.js:437 |  |  |
| `askRunConfirm` | src/ui/state/host.js:450 | ✓ | 托管运行的确认（服务端把"要问什么"发过来，文案仍旧用上面那三个确认框： |
| `askDangerGrant` | src/ui/state/host.js:462 |  | 危险命令的一次性授权窗（票据由服务端签发，人点了才跑） |

#### `src/ui/state/projects.js`（21 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `byId` | src/ui/state/projects.js:25 |  |  |
| `setServerCurrent` | src/ui/state/projects.js:28 |  | 把"当前项目"写到服务端（projects.json 的 current）。返回是否成功。 |
| `currentProjectId` | src/ui/state/projects.js:34 |  | 当前项目 id（''  不归属任何项目）——读写 state 的口径集中在这一处 |
| `toastSwitched` | src/ui/state/projects.js:37 |  | 换项目成功后的提示（名字可能已不在清单里，兜底用 id） |
| `applyCurrentProject` | src/ui/state/projects.js:46 |  | **换"当前项目"的唯一实现**（两个入口共用：设置里选项目、点开别的项目的会话）。 |
| `latestSessionOf` | src/ui/state/projects.js:57 |  | 该项目最近处理过的会话（侧栏排序口径：ts 最新） |
| `followProject` | src/ui/state/projects.js:67 |  | 会话跟着项目走（切项目 / 建项目共用）： |
| `selectProject` | src/ui/state/projects.js:81 | ✓ | 切到某个项目（id 传 ''  不归属任何项目）：换项目记忆 + 换到该项目的最近会话 |
| `nextAlignGuard` | src/ui/state/projects.js:112 |  | "还要不要这次切换"的判据：连续切换时只有**最后一次**算数（切项目/切会话共用） |
| `followSessionProject` | src/ui/state/projects.js:116 | ✓ |  |
| `refreshCurrentMemory` | src/ui/state/projects.js:133 | ✓ | 当前项目的记忆从服务端重拉一份（界面显示的唯一来源就是它）。 |
| `createProject` | src/ui/state/projects.js:150 | ✓ | 新建项目：选一个根目录 → 服务端建项目记忆文件夹 → 设为当前项目 |
| `renameProject` | src/ui/state/projects.js:175 | ✓ |  |
| `browseDir` | src/ui/state/projects.js:189 | ✓ | 目录浏览（选择器用；path 省略  从**项目起点**起步，一路只能在起点内往下走） |
| `makeDir` | src/ui/state/projects.js:196 | ✓ | 在浏览到的目录里新建一个文件夹（选择器「新建文件夹」用），返回新目录的绝对路径。 |
| `setStart` | src/ui/state/projects.js:202 | ✓ | 改项目起点（默认 /media/leo/DATA/workspace）：只约束"项目放哪"，不影响 agent 能读写哪些目录 |
| `archiveProject` | src/ui/state/projects.js:212 | ✓ | 归档一个项目：**连它下面的会话一起**搬进归档区（记忆文件夹整份搬走），随时可恢复 |
| `loadArchive` | src/ui/state/projects.js:241 | ✓ | 拉归档清单（设置 → 存档） |
| `restoreArchived` | src/ui/state/projects.js:247 | ✓ | 从存档里恢复（kind: 'session' ∣ 'project'）；恢复项目会连它的会话一起回来 |
| `purgeArchived` | src/ui/state/projects.js:281 | ✓ | 彻底删除归档里的东西（不可逆） |
| `syncProjectMemory` | src/ui/state/projects.js:291 | ✓ | 把当前项目记忆整份写回服务端（界面里手工改完立刻落盘；模型写的那条走 Memory.onChange）。 |

#### `src/ui/state/run.js`（55 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `touchSoon` | src/ui/state/run.js:32 |  |  |
| `isRunning` | src/ui/state/run.js:52 | ✓ | 这条会话现在有在跑的运行吗（侧栏小标、归档/清空等操作的前置判断用它） |
| `activeRunId` | src/ui/state/run.js:54 | ✓ | 当前会话在跑的那一段（没有就是 ''） |
| `publish` | src/ui/state/run.js:61 |  | 把本地记录映射进 state（UI 只读 state.runs），并同步"当前会话是否在生成" |
| `syncActive` | src/ui/state/run.js:75 | ✓ | 当前会话的生成态（Composer 的"停止/插话"、guard 判断都读 state.streaming 这一个口径） |
| `sessionById` | src/ui/state/run.js:86 |  |  |
| `ensureMsgs` | src/ui/state/run.js:88 |  |  |
| `lastStreaming` | src/ui/state/run.js:97 |  | 事件要写的那条助手消息：先按服务端 liveId 找，找不到就用本窗口的占位认领这个名字， |
| `claimLocal` | src/ui/state/run.js:105 |  | 本窗口刚发的那条占位：把它的 id 认成服务端的 liveId（否则会出现两条助手气泡）。 |
| `msgFor` | src/ui/state/run.js:117 |  |  |
| `traceArr` | src/ui/state/run.js:138 |  |  |
| `indexSlot` | src/ui/state/run.js:146 |  | 追踪条的槽位：优先用内核给的 token（下标，顺序与服务端一致）， |
| `slotFor` | src/ui/state/run.js:154 |  |  |
| `fillToolEnd` | src/ui/state/run.js:170 |  | 工具结束事件 → 追踪条条目（与落盘那份同形；服务端没给的字段就不写）。 |
| `syncSteering` | src/ui/state/run.js:306 |  | 待注入条数**以服务端的队列为准**（服务端按 run 记数，客户端不自己数）—— |
| `sessionTitle` | src/ui/state/run.js:311 |  |  |
| `getOrCreate` | src/ui/state/run.js:318 |  | 三份"合并式登记"（adoptRun / mergeRun / registerRun）共用的取记录外壳。 |
| `adoptRun` | src/ui/state/run.js:324 |  | 把一段运行登记进本地表（别处开的、刷新接上的、本窗口刚发的都走这里）。 |
| `applyEvent` | src/ui/state/run.js:338 |  |  |
| `host` | src/ui/state/run.js:349 |  |  |
| `hostHook` | src/ui/state/run.js:353 |  |  |
| `askThenAnswer` | src/ui/state/run.js:362 |  | 服务端要人点头：用**界面上原有的那几个确认框**（文案一处都不重复），再把人话回传。 |
| `noteFailure` | src/ui/state/run.js:376 |  | 失败只**追加**一行说明，绝不清空已经生成的部分（那是用户等了半天的东西） |
| `adoptServerContent` | src/ui/state/run.js:386 |  | **以服务端那份最终正文为准**（2026-10-03）：停止/失败/被掐断时，服务端会在流结束之后 |
| `ensureStopMarker` | src/ui/state/run.js:393 |  | 服务端没给正文时的兜底：停止/失败各补一句说明（与 lib/agent/run-loop.js 的文案一致） |
| `finishMsg` | src/ui/state/run.js:401 |  | 收尾时把这条消息结清：内容一律保留，停止/失败各补一句说明 |
| `applyEndMeta` | src/ui/state/run.js:413 |  | end 事件里"只有服务端才知道"的那几样（标题/摘要/会话记忆）写回会话对象 |
| `settle` | src/ui/state/run.js:421 |  | 收尾：整段结束（正常/停止/失败都走这里）。内容一律保留。 |
| `ensureHub` | src/ui/state/run.js:441 | ✓ | 连上统一事件口（幂等：已经在连就什么都不做）。断线自动重连，重连时服务端会回放。 |
| `pump` | src/ui/state/run.js:467 |  | 读这条 SSE：逐行解析并分发（换连接/关页面时旧流作废——只认"我这条"） |
| `mergeRun` | src/ui/state/run.js:478 |  | 快照  "这个账号现在有哪几段在跑"：本地没有的补上，本地有而快照里没有的（掉线期间跑完了）收尾。 |
| `adoptRuns` | src/ui/state/run.js:490 |  | 服务端的运行摘要清单 → 本地记录（快照与 /state 两处共用），返回这次见到过的会话 id |
| `settleVanished` | src/ui/state/run.js:499 |  | 掉线期间这一段跑完了：本地的正文可能不完整 → 结清 + 让宿主以服务端那份为准重拉这条会话。 |
| `adoptSnapshot` | src/ui/state/run.js:508 |  |  |
| `dropped` | src/ui/state/run.js:522 |  |  |
| `reset` | src/ui/state/run.js:531 | ✓ | 换账号/登出：断开这条流（运行本体在服务端，按账号存，与本窗口无关）。 |
| `startRun` | src/ui/state/run.js:547 | ✓ | 开一轮托管运行。 |
| `dropPlaceholder` | src/ui/state/run.js:580 |  | 把"这一段是我刚开的"记进本地表（**合并进已有记录**而不是整个替换： |
| `placeholderOf` | src/ui/state/run.js:594 |  | 这一段在本窗口的占位消息 id（没给就沿用记录里的；都没有就是 ''） |
| `dropStalePlaceholder` | src/ui/state/run.js:598 |  | 事件先到 → 已经按 liveId 建过消息 → 本窗口那条占位是多余的（摘掉，别留一个空气泡）。 |
| `registerRun` | src/ui/state/run.js:603 |  |  |
| `unregisterLocal` | src/ui/state/run.js:620 |  | 起跑失败（POST 没成功）：把刚才那条"我先开一段"的登记撤掉（只撤还没拿到 runId 的） |
| `steerRun` | src/ui/state/run.js:626 | ✓ | 生成中插话（下一轮开始前注入；不打断当前调用） |
| `stopRun` | src/ui/state/run.js:640 | ✓ | 停止：让**服务端**停下当前会话这一轮（不是断开观看——断开不影响它） |
| `undoRun` | src/ui/state/run.js:657 | ✓ | 撤销：把某一次运行的文件改动恢复原状——**默认整轮，传 paths 时只恢复这几个文件** |
| `undoProgressPatch` | src/ui/state/run.js:668 |  | 服务端摘要 → 进度字段（undoneAt 为 0 时不带，保持本地已有的那个值）。 |
| `applyOneUndo` | src/ui/state/run.js:679 |  | 更新一条消息的 undo 进度：有完整 summary 用它的；没有（精简响应）按旧语义标全恢复 |
| `applyUndoSummary` | src/ui/state/run.js:690 | ✓ | 把服务端的撤销进度（summary  undo.summaryOf 的形状）写回本地那份 msg.undo。 |
| `subagentRecord` | src/ui/state/run.js:701 | ✓ | 子智能体的完整转录（界面展开看"它到底做了什么"）；失败回 null。 |
| `reattach` | src/ui/state/run.js:732 | ✓ | 换会话/刷新后：把"这个会话有没有在跑的运行"与服务端对齐一次。 |
| `settleLocal` | src/ui/state/run.js:757 |  | 服务端说这条会话没有在跑的运行了：本地记录同步收尾（已有记录才动） |
| `pullLatest` | src/ui/state/run.js:766 |  | 重新拉一份服务端数据（会话 + 面板数据），只在"以为还在跑、其实已经结束"这条路上用。 |
| `streamingMsgs` | src/ui/state/run.js:777 |  | 没有在跑的运行了：把**这条会话里**还挂着 streaming 的助手消息结清（与"生成被中断"同一呈现） |
| `clearOrphanPlaceholders` | src/ui/state/run.js:779 |  |  |
| `rehydrate` | src/ui/state/run.js:800 | ✓ | 整份数据重拉之后（session.js 的 applyServerData）：把还在跑的那几条重新认到新对象上。 |

#### `src/ui/state/session.js`（42 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `bootBare` | src/ui/state/session.js:34 |  | 未登录 / 拉取失败时的界面初始形状（原先两个失败分支各 patch 一份逐字相同的） |
| `bootstrap` | src/ui/state/session.js:38 | ✓ |  |
| `pickActiveSession` | src/ui/state/session.js:66 |  | 从服务端数据里挑"当前会话"：preferSess（用户正在看的）优先，服务端 currentSess 指针其次， |
| `hydrateProjectFacts` | src/ui/state/session.js:76 |  | 项目事实（名字/根目录/记忆文件夹位置）灌给 core：注入区块与 memory_write 的 scope"project" 都靠它。 |
| `applyServerData` | src/ui/state/session.js:86 | ✓ | 把服务端数据灌进 core 层的登记表与界面状态 |
| `syncProjectWithSession` | src/ui/state/session.js:127 | ✓ | 当前项目  当前会话归属的项目（这就是"直接关联"的落点）。 |
| `whenWritesSettled` | src/ui/state/session.js:134 |  | 本地还有没落盘的改动时先等它落地：否则"服务端旧快照"会把刚改的记忆/设置盖回去。 |
| `applyServerLight` | src/ui/state/session.js:144 |  | 把"轻量拉取"（GET /agent/store?light1）的结果装进界面与 core。 |
| `refreshLightSoon` | src/ui/state/session.js:163 | ✓ | 面板数据从服务端重拉（合并成一次延迟执行：一轮里模型可能连写好几条记忆）。 |
| `userKey` | src/ui/state/session.js:176 |  | 整份重拉（含会话）并应用。@param {{onlyIfSession?:string}} 期间换了会话就放弃这次结果 |
| `canApply` | src/ui/state/session.js:183 |  | 这次重拉的结果还能不能用（await 期间世界可能已经变了 —— 重拉是锦上添花， |
| `refreshAll` | src/ui/state/session.js:192 | ✓ |  |
| `refreshAllSoon` | src/ui/state/session.js:207 | ✓ | 一轮托管运行结束后（稍等一会儿再）整份重拉：会话标题、最终内容、项目归属、记忆面板 |
| `applyAppearance` | src/ui/state/session.js:242 | ✓ | 主题/强调色/字号/密度 → <html> 上的 data 属性（CSS 只认属性，不认 JS） |
| `checkStatus` | src/ui/state/session.js:256 | ✓ | 状态探测 |
| `loadAgentStatus` | src/ui/state/session.js:271 | ✓ |  |
| `updateCtx` | src/ui/state/session.js:278 | ✓ | 上下文用量 |
| `newId` | src/ui/state/session.js:294 |  | 会话 |
| `projectOf` | src/ui/state/session.js:297 |  | 新会话默认归属**当前项目**（有的话）：侧栏按项目分组、项目记忆跟着项目走 |
| `saveCurrentSess` | src/ui/state/session.js:304 |  | 把"当前会话指针"写到服务端配置。**每次换会话都必须写**： |
| `newSessionRecord` | src/ui/state/session.js:310 |  | 建一条空会话对象（归属当前项目） |
| `addSession` | src/ui/state/session.js:317 |  | 新会话挂到列表最前 + 排队落盘 + 写"当前会话"指针（ensureSession / newSession 共用的三连）。 |
| `ensureSession` | src/ui/state/session.js:325 | ✓ |  |
| `newSession` | src/ui/state/session.js:331 | ✓ |  |
| `selectSession` | src/ui/state/session.js:353 | ✓ |  |
| `renameSession` | src/ui/state/session.js:388 | ✓ |  |
| `archiveSession` | src/ui/state/session.js:398 | ✓ | 归档一个对话（侧栏的按钮，原先是"删除"）：搬进账号目录里的归档区，**不丢任何内容**， |
| `clearChat` | src/ui/state/session.js:414 | ✓ |  |
| `lastUserIndex` | src/ui/state/session.js:428 |  | 最后一条用户消息的下标（回撤/重新生成共用同一份倒序找法；没有就是 -1） |
| `undoLast` | src/ui/state/session.js:434 | ✓ | 回撤最后一轮（提问放回输入框） |
| `deleteRound` | src/ui/state/session.js:448 | ✓ | 删除某一轮的整对消息（用户 + 回答）。组件层已有确认框，这里再加生成闸门与其它"改历史"动作对齐 |
| `steer` | src/ui/state/session.js:473 | ✓ | 生成中的输入  插话（Steering，不打断当前调用，下一轮开始前注入）。 |
| `stop` | src/ui/state/session.js:483 | ✓ | 停止：让服务端停下这一轮（不是断开观看——断开不影响它） |
| `regenerateLast` | src/ui/state/session.js:488 | ✓ | 重新生成最后一轮回答 |
| `startTurn` | src/ui/state/session.js:514 |  | 生成前的组装：把"这一轮要发什么"记在消息上。 |
| `failTurn` | src/ui/state/session.js:545 |  | **启动**失败（服务端没接上 / 已被另一段运行占用 / 未登录）：把占位换成一句可读的错误。 |
| `blockReason` | src/ui/state/session.js:559 |  | 发送前的闸门：返回一句"为什么不能发"（null  可以发）。 |
| `send` | src/ui/state/session.js:568 | ✓ |  |
| `injectSummary` | src/ui/state/session.js:606 |  | 注入预览的摘要文本（给界面看：这一轮到底塞了哪些区块） ---- |
| `injectText` | src/ui/state/session.js:610 |  |  |
| `openDrawer` | src/ui/state/session.js:621 | ✓ | 抽屉（仅界面状态） |
| `closeDrawer` | src/ui/state/session.js:624 | ✓ |  |

#### `src/ui/state/settings.js`（39 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `copy` | src/ui/state/settings.js:20 |  |  |
| `S` | src/ui/state/settings.js:25 |  | 配置快照取值：登出后 state.settings 是 null，直接解引用会抛 "Cannot read properties of null" |
| `setTheme` | src/ui/state/settings.js:29 | ✓ | 外观 |
| `setUi` | src/ui/state/settings.js:39 | ✓ | 界面偏好（纯客户端：侧栏收没收、会话怎么分组…） |
| `newProviderId` | src/ui/state/settings.js:48 |  | 模型（服务商） |
| `addProvider` | src/ui/state/settings.js:50 | ✓ |  |
| `updateProvider` | src/ui/state/settings.js:71 | ✓ |  |
| `removeProvider` | src/ui/state/settings.js:81 | ✓ |  |
| `setActiveProvider` | src/ui/state/settings.js:91 | ✓ |  |
| `listModels` | src/ui/state/settings.js:103 | ✓ | 拉模型清单（写回 provider.models 缓存，供下拉用） |
| `testProvider` | src/ui/state/settings.js:118 | ✓ | 测试连接：拉一次模型清单就够了（能列出来说明地址/密钥/协议都对） |
| `setParam` | src/ui/state/settings.js:135 | ✓ | scope: ''  全局；否则是该模型 key（'<providerId>::<model>'）。 |
| `resetParamSection` | src/ui/state/settings.js:151 | ✓ |  |
| `applyPreset` | src/ui/state/settings.js:166 | ✓ |  |
| `clearModelOverrides` | src/ui/state/settings.js:172 | ✓ | 清掉某个模型的全部覆盖（回到全局参数） |
| `postToolsField` | src/ui/state/settings.js:185 | ✓ | 工具配置的公共三步：POST 服务端 → settings.tools[field] 与 agentStatus 同步 → toast。 |
| `setRoots` | src/ui/state/settings.js:201 | ✓ |  |
| `setInfoBinding` | src/ui/state/settings.js:207 |  | 本机账号绑定 |
| `bindOsAccount` | src/ui/state/settings.js:211 | ✓ |  |
| `unbindOsAccount` | src/ui/state/settings.js:218 | ✓ |  |
| `unlockOsAccount` | src/ui/state/settings.js:225 | ✓ |  |
| `lockOsAccount` | src/ui/state/settings.js:232 | ✓ |  |
| `setPromptDraft` | src/ui/state/settings.js:251 | ✓ |  |
| `applyPromptText` | src/ui/state/settings.js:256 | ✓ | 应用一条草稿（普通条目）：写进登记表（→ onChange → 落盘）+ 清掉草稿 |
| `setSkillFields` | src/ui/state/settings.js:262 | ✓ | 自定义技能的立刻写入（不加草稿）：开关这类"一眼可见"的改动走这里； |
| `clearPromptDraft` | src/ui/state/settings.js:266 | ✓ | 丢掉一条草稿（应用后 / 恢复默认 / 删除条目时用） |
| `setPromptEnabled` | src/ui/state/settings.js:273 | ✓ |  |
| `resetPrompt` | src/ui/state/settings.js:276 | ✓ |  |
| `addPromptEntry` | src/ui/state/settings.js:280 | ✓ |  |
| `removePromptEntry` | src/ui/state/settings.js:283 | ✓ |  |
| `addSkill` | src/ui/state/settings.js:287 | ✓ |  |
| `removeSkill` | src/ui/state/settings.js:290 | ✓ |  |
| `addMemory` | src/ui/state/settings.js:297 | ✓ | 记忆 |
| `removeMemory` | src/ui/state/settings.js:301 | ✓ |  |
| `memoryExport` | src/ui/state/settings.js:304 | ✓ |  |
| `memoryImport` | src/ui/state/settings.js:312 | ✓ |  |
| `exportAll` | src/ui/state/settings.js:328 | ✓ | 数据（导出 / 压缩） |
| `compactNow` | src/ui/state/settings.js:343 | ✓ |  |
| `uncompact` | src/ui/state/settings.js:349 | ✓ |  |

#### `src/ui/state/store.js`（8 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `defaultSettingsShape` | src/ui/state/store.js:57 |  | 出厂配置的形状（与服务端 lib/agent/settings.js 的 DEFAULTS 同形）。 |
| `defaultSettings` | src/ui/state/store.js:67 | ✓ |  |
| `subscribe` | src/ui/state/store.js:77 | ✓ |  |
| `getState` | src/ui/state/store.js:78 |  |  |
| `patch` | src/ui/state/store.js:81 | ✓ | 合并式更新：只覆盖传进来的键 |
| `touch` | src/ui/state/store.js:87 | ✓ | 触发重绘（core 层对象被改动、但 state 引用没变时用） |
| `schedule` | src/ui/state/store.js:92 |  |  |
| `useApp` | src/ui/state/store.js:103 | ✓ | React 侧读状态：读整个快照（组件少且树不深，够用；要精细切片就在组件里自己挑）。 |

#### `src/ui/state/todo.js`（5 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `cur` | src/ui/state/todo.js:14 |  |  |
| `put` | src/ui/state/todo.js:15 |  |  |
| `setTodoOpen` | src/ui/state/todo.js:18 | ✓ | 浮层的折叠开关（界面状态，不落盘；刷新后默认展开） |
| `applyTodo` | src/ui/state/todo.js:21 | ✓ | 工具结果里的清单（事件流实时推来）。别的会话的事件不显示在当前画面上。 |
| `loadTodo` | src/ui/state/todo.js:28 | ✓ | 拉当前会话的清单（刷新/切会话/换窗口）。拉不到就保持现状——清单不是关键路径。 |

#### `src/ui/state/undo-help.js`（1 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `undoGateHelp` | src/ui/state/undo-help.js:31 | ✓ | 结构化错误（needUnlock / needBind）→ toast + 引导；其余只 toast 原因。 |

### 服务端 · 其余（lib/agent）——21 个文件 / 302 个函数

#### `lib/agent/archive.js`（19 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `dirOf` | lib/agent/archive.js:31 |  |  |
| `fileOf` | lib/agent/archive.js:35 |  |  |
| `sessionsFile` | lib/agent/archive.js:39 |  |  |
| `projectsFile` | lib/agent/archive.js:40 |  |  |
| `emptySessions` | lib/agent/archive.js:42 |  |  |
| `emptyProjects` | lib/agent/archive.js:43 |  |  |
| `readSessions` | lib/agent/archive.js:47 |  | 读写 |
| `readProjects` | lib/agent/archive.js:51 |  |  |
| `write` | lib/agent/archive.js:55 |  |  |
| `moveDir` | lib/agent/archive.js:63 |  | 搬家（rename，跨设备回落复制） |
| `roundsOf` | lib/agent/archive.js:74 |  | 会话 |
| `archiveSession` | lib/agent/archive.js:77 |  | 归档一个会话：从 sessions.json 搬到归档区（原样保留，含它的会话记忆与压缩摘要） |
| `archiveSessions` | lib/agent/archive.js:92 |  | 把一批会话写进归档区（项目归档时整批搬） |
| `takeArchivedSessions` | lib/agent/archive.js:106 |  | 从归档区取出若干会话（恢复用；取走即从归档清单里删掉） |
| `archiveProject` | lib/agent/archive.js:121 |  | 归档一个项目：清单摘掉 + 记忆文件夹搬家 + **它下面的会话一起搬**（用户要求"连同里面的会话"） |
| `restoreProject` | lib/agent/archive.js:146 |  | 恢复一个项目：记忆文件夹搬回 + 回清单 + 它的会话一起回来 |
| `restoreSession` | lib/agent/archive.js:174 |  | 恢复 / 彻底删除 / 列表 |
| `remove` | lib/agent/archive.js:184 |  | 彻底删除（不可逆）：归档区里的会话或项目 |
| `list` | lib/agent/archive.js:222 |  | 归档清单（只给摘要：标题/时间/轮数，正文留在文件里等恢复） |

#### `lib/agent/deny.js`（17 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `rule` | lib/agent/deny.js:27 |  | 给规则挂一个可读标签：命中时授权弹窗与设置面板显示标签（没有标签的显示正则原文）。 |
| `textOf` | lib/agent/deny.js:28 |  |  |
| `escRe` | lib/agent/deny.js:29 |  |  |
| `pathTok` | lib/agent/deny.js:93 |  | 受保护路径的匹配形式：可带引号，尾部允许 / 或 *（`<根>/*` 是清盘；`<根>/logs` 不算—— |
| `fileTok` | lib/agent/deny.js:94 |  |  |
| `baseCmd` | lib/agent/deny.js:128 |  |  |
| `isDangerProg` | lib/agent/deny.js:133 |  |  |
| `commandSegments` | lib/agent/deny.js:139 |  | 按 shell 分隔符切行，并对每一段剥掉 `VARx` 前缀与包装器，取出"真正在跑的程序 + 它的参数"。 |
| `firstNonOpt` | lib/agent/deny.js:171 |  | 跳过选项取"子命令"：`systemctl --user stop x` 的子命令是 stop（`-H host` 这类带值选项 |
| `segmentsHit` | lib/agent/deny.js:174 |  | 命令位置上的危险程序名 → 命中项；否则 null |
| `normalizeForDeny` | lib/agent/deny.js:202 |  | 引号对启发式解析只在这个副本上做：剥掉后"参数文本"与命令词的边界会丢 |
| `payloadFromTokens` | lib/agent/deny.js:228 |  | 取 token 流里载荷选项（-c/-e/-r/-S/--command）后面的整段；遇到位置参数（脚本名）就停。 |
| `suPayloadFromTokens` | lib/agent/deny.js:243 |  | `su` 的 -c 载荷：位置参数（要切换的用户名）可以出现在 -c **之前** |
| `interpreterHit` | lib/agent/deny.js:253 |  | 解释器载荷检查：在**整行**的 token 流里找解释器与其 -c 载荷 |
| `codePayloadHit` | lib/agent/deny.js:273 |  | 代码载荷里的"任意位置危险词"：kill/account 程序名（词边界）+ mkfs + 块设备写 |
| `denyHit` | lib/agent/deny.js:286 |  | 命中危险清单 → 命中的规则文本（有标签用标签，否则正则原文）；否则 null |
| `denyList` | lib/agent/deny.js:315 |  | 面板上展示的清单（只读展示用；命中不等于拒绝，是"要人点授权"） |

#### `lib/agent/files.js`（18 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `dirOf` | lib/agent/files.js:60 |  | 待下载目录 `<agent>/<账号>/downloads`；账号名不合法 → null（调用方必须处理） |
| `safeName` | lib/agent/files.js:66 |  | 文件名是否合法（挡 `../`、绝对路径、控制字符、隐藏文件） |
| `extOf` | lib/agent/files.js:73 |  |  |
| `isExecutable` | lib/agent/files.js:76 |  | 这个文件算不算"可执行"：**只看后缀名**（不看执行位——NTFS/exFAT 挂载点上全是 0777） |
| `ensureDir` | lib/agent/files.js:78 |  |  |
| `uniqueName` | lib/agent/files.js:86 |  | 目录里没有同名时用原名，重名就加 ` (2)`、` (3)`…（在扩展名前） |
| `totalBytes` | lib/agent/files.js:97 |  | 目录总量（含子目录——正常不会有，但手工拷进来的要算上） |
| `list` | lib/agent/files.js:111 |  | 待下载目录的内容（界面菜单与文件卡片用）。按时间倒序（最新放的在最上面）。 |
| `resolveFile` | lib/agent/files.js:139 |  | 取一个文件（**只在待下载目录里**取；realpath 复核，符号链接指向外面也不行） |
| `downloadOf` | lib/agent/files.js:157 |  | 下载要发的那份：**可执行文件一律改发 zip**（现打现发，原始文件不动） |
| `remove` | lib/agent/files.js:169 |  |  |
| `saveBuffer` | lib/agent/files.js:180 |  | 从 Buffer 放一个文件（内部用：发布时打包、测试） |
| `publish` | lib/agent/files.js:205 |  | 把一个**已经存在于磁盘上**的文件放进待下载目录（工具 deliver_file 的唯一落点）。 |
| `mimeOf` | lib/agent/files.js:242 |  |  |
| `inlineMimeOf` | lib/agent/files.js:257 |  |  |
| `contentDisposition` | lib/agent/files.js:261 |  | RFC 5987：中文/空格文件名必须这么写，否则各浏览器各乱码。 |
| `parseRange` | lib/agent/files.js:265 |  | 解析 Range 头（音视频拖动进度条时浏览器发）：返回 {start,end} / null（没有或看不懂） / -1（越界，应回 416） |
| `handleFiles` | lib/agent/files.js:279 |  |  |

#### `lib/agent/grants.js`（2 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `issueGrant` | lib/agent/grants.js:18 |  |  |
| `takeGrant` | lib/agent/grants.js:34 |  | 消费一张票据：命中则放行（返回 true）。取走即删——重放、复用一律不认。 |

#### `lib/agent/index.js`（11 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `needLogin` | lib/agent/index.js:58 |  | 未登录的统一出口：带上标记，前端据此区分"要登录"与"上游报错" |
| `bodyLimitFor` | lib/agent/index.js:70 |  | 路由 → 请求体上限。**上限的真源在 lib/agent/store.js**（它由配额与每条上限推导出来）， |
| `body` | lib/agent/index.js:78 |  | 读 JSON 体（失败回 400，别让它冒到统一出口变成 500） |
| `infoPayload` | lib/agent/index.js:86 |  | 探针：页面启动就要问它拿登录态与绑定状态 |
| `handleStore` | lib/agent/index.js:102 |  | 存储端点 |
| `readPost` | lib/agent/index.js:193 |  | POST 路由的公共两步：非 POST 回 405；body 非法时 body() 已回过错误。 |
| `handleBinding` | lib/agent/index.js:198 |  |  |
| `handleProjects` | lib/agent/index.js:244 |  | /agent/projects/* —— 项目清单与项目记忆。 |
| `handleArchive` | lib/agent/index.js:308 |  | /agent/archive/* —— 归档区：会话与项目（连会话）搬进来，可恢复、可彻底删除。 |
| `handleSkillsImport` | lib/agent/index.js:342 |  | POST /agent/skills/import —— 把磁盘上的 SKILL.md 装进该账号的技能表。 |
| `handleAgent` | lib/agent/index.js:369 |  | 总入口 |

#### `lib/agent/limits.js`（6 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `capCallTimeout` | lib/agent/limits.js:27 |  | 单次模型调用的最高时长（秒）服务端硬上限：面板值（call_timeout_sec）只能比它小； |
| `effLimits` | lib/agent/limits.js:33 |  |  |
| `clamp` | lib/agent/limits.js:58 |  |  |
| `clampPos` | lib/agent/limits.js:67 |  | 同名参数的"正数才认"版本：0 与负数一律当"没传"，用默认值。 |
| `kb` | lib/agent/limits.js:73 |  |  |
| `makeGate` | lib/agent/limits.js:85 |  | 并发 + 频率闸门（纯逻辑，可单测）：给"每次调用都要拉起一个外部进程"的操作兜底。 |

#### `lib/agent/osaccess.js`（13 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `groupsOf` | lib/agent/osaccess.js:43 |  | 账号的组集合（含主组）。查不到返回空集——只按主组判定，宁严不宽。 |
| `idsFor` | lib/agent/osaccess.js:63 |  | 账号身份：uid/gid 由绑定信息给出，组集合现场查（带缓存） |
| `permits` | lib/agent/osaccess.js:72 |  | 单个 stat 结果 + 权限位 → 是否通过 |
| `parseAcl` | lib/agent/osaccess.js:86 |  | getfacl -n 输出 → { users:Map<uid,bits>, groups:Map<gid,bits>, mask, other }； |
| `aclOf` | lib/agent/osaccess.js:103 |  | 读一个路径的 ACL（带 1 分钟缓存；getfacl 不存在/失败 → null，方向是收紧） |
| `aclBits` | lib/agent/osaccess.js:117 |  | ACL 给这个账号的位；没有可用条目时返回 other 位 |
| `permitsAt` | lib/agent/osaccess.js:133 |  | mode 位判定 + ACL 兜底（只在 mode 位拒绝时才去读 ACL，快路径不受影响） |
| `kernelAllows` | lib/agent/osaccess.js:141 |  | 内核判定：同账号档下它就是权威（ACL / 挂载选项 / capabilities 全算在内）。 |
| `nearestExisting` | lib/agent/osaccess.js:156 |  | 最近的**已存在**祖先（含自身）。新建/删除要问的是它，不是"父目录"本身—— |
| `describe` | lib/agent/osaccess.js:167 |  |  |
| `checkAncestors` | lib/agent/osaccess.js:170 |  | 逐级检查祖先目录的 x 位（从根一直到 parent）。返回第一个不放行的目录。 |
| `checkByBits` | lib/agent/osaccess.js:184 |  | mode 位走查（含 ACL 兜底）—— 'su' 档的唯一判定，也是 'same' 档内核拒绝时的人话解释 |
| `check` | lib/agent/osaccess.js:230 |  | 判定 access(path, need) 是否被绑定账号允许。 |

#### `lib/agent/params-schema.js`（5 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `load` | lib/agent/params-schema.js:17 |  |  |
| `loaded` | lib/agent/params-schema.js:28 |  | 同步取（未就绪  null）；供诊断/测试 |
| `ready` | lib/agent/params-schema.js:30 |  | 异步取（写路径用）；加载失败返回 null |
| `normalizeBag` | lib/agent/params-schema.js:33 |  | 同步归一"一袋参数"；未就绪或形状不对时原样返回 |
| `normalizeByModel` | lib/agent/params-schema.js:39 |  | 同步归一 paramsByModel（{模型键 → 参数袋}）；未就绪时原样返回 |

#### `lib/agent/presence.js`（13 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `clientIp` | lib/agent/presence.js:36 |  | 来源地址（去掉 IPv6 映射前缀） |
| `shortUa` | lib/agent/presence.js:41 |  |  |
| `keyOf` | lib/agent/presence.js:44 |  | 身份 key：已登录按文档站账号，未登录按来源地址 |
| `cidOf` | lib/agent/presence.js:46 |  |  |
| `publicOwner` | lib/agent/presence.js:51 |  |  |
| `markSeen` | lib/agent/presence.js:53 |  |  |
| `killStreams` | lib/agent/presence.js:59 |  | 占用者被顶掉时：在途流全部掐断（客户端也会自己中止，这里是服务端兜底） |
| `claim` | lib/agent/presence.js:68 |  |  |
| `status` | lib/agent/presence.js:85 |  | 查询（claimfalse）：自己仍是占用者 → 续期；占用者已离开（超过 STALE_MS）→ 自动上位 |
| `release` | lib/agent/presence.js:100 |  | 让位（关页/跳转时前端说一声）：只有占用者本人能让位；**不是被顶掉**， |
| `guard` | lib/agent/presence.js:109 |  | 干活端点上的校验：被顶掉的 cid 一律拒绝；带占用的请求顺带续期；无头请求放行（脚本） |
| `trackStream` | lib/agent/presence.js:128 |  | 登记在途响应（流式回答）：被顶替时由 killStreams 掐断 |
| `handlePresence` | lib/agent/presence.js:142 |  | POST /agent/presence  { cid, claim?, leave? } |

#### `lib/agent/proctree.js`（16 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `readStat` | lib/agent/proctree.js:47 |  | /proc 读取（测试可注入） |
| `readCmdlineImpl` | lib/agent/proctree.js:67 |  |  |
| `readCmdline` | lib/agent/proctree.js:77 |  |  |
| `scanAll` | lib/agent/proctree.js:79 |  |  |
| `noteSpawn` | lib/agent/proctree.js:137 |  | exec.js spawn 出命令根进程时登记（归属判定的证据链锚点） |
| `sweepZombies` | lib/agent/proctree.js:170 |  | 采样（降级兜底 + 僵尸清扫） |
| `sample` | lib/agent/proctree.js:179 |  | 全量扫一次 /proc：降级模式把站点子树记进 seen；顺带清扫被收养的僵尸 |
| `rootOk` | lib/agent/proctree.js:208 |  | pid 是不是登记过的命令根（活着要 starttime 对得上，防 PID 复用顶名；死了认——组号兜底要用） |
| `isAgentOwned` | lib/agent/proctree.js:217 |  | 目标进程是不是 agent 自启的（stats 可注入，供单测造假 /proc） |
| `isSignalTok` | lib/agent/proctree.js:247 |  |  |
| `outerQuotes` | lib/agent/proctree.js:249 |  | 剥最外层引号（`pkill -f "train.py"` 的模式 token 带引号） |
| `parsePkill` | lib/agent/proctree.js:255 |  | pkill [flags] <pattern>：只认 -f/-x/-i/-e、-<信号>、--signal[v]、--full/--exact/--ignore-case |
| `parseKill` | lib/agent/proctree.js:297 |  | kill [-s v∣-n v∣--signal[v]∣-l∣--help] <pid∣-%pgid>…：负 pid 是进程组，-1（全部）绝不放 |
| `parseKillall` | lib/agent/proctree.js:326 |  | killall [-<信号>∣--signal[v]] <名>…：按 comm（≤15 字节）精确匹配，其余选项一律看不懂 |
| `resolveKillTargets` | lib/agent/proctree.js:351 |  | 解析一条 kill 族命令要杀的目标；返回 { bail }（看不懂→不放行）/ { none }（不杀东西）/ { targets:[pid] }。 |
| `killExempt` | lib/agent/proctree.js:385 |  | 命中的是 kill 族、且目标全是 agent 自启进程（或不杀任何东西）→ 免票据放行 |

#### `lib/agent/projects.js`（31 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `accountDir` | lib/agent/projects.js:44 |  | 账号 → 账号目录（账号名不合法 → null；校验与拼接同一步，见 lib/paths.js） |
| `listFile` | lib/agent/projects.js:45 |  |  |
| `projectDir` | lib/agent/projects.js:50 |  | 项目文件夹（不存在也返回路径，由调用方决定建不建） |
| `memoryDir` | lib/agent/projects.js:55 |  |  |
| `slugify` | lib/agent/projects.js:61 |  | 由根目录推出稳定的项目 id：`<目录名>-<路径哈希8位>`（与 ZCode 的项目 slug 同一思路） |
| `idFor` | lib/agent/projects.js:70 |  |  |
| `empty` | lib/agent/projects.js:78 |  | 项目清单（projects.json） |
| `readList` | lib/agent/projects.js:80 |  |  |
| `cleanProject` | lib/agent/projects.js:92 |  |  |
| `ensureDir` | lib/agent/projects.js:111 |  |  |
| `writeList` | lib/agent/projects.js:116 |  | 写项目清单：目录与 JSON 落盘复用 store 的正本（建目录、updatedAt、原子写都在那边） |
| `yamlValue` | lib/agent/projects.js:127 |  | frontmatter 值：简单值直写，含特殊字符的用双引号（YAML 双引号串与 JSON 兼容） |
| `fmtIso` | lib/agent/projects.js:133 |  |  |
| `renderMd` | lib/agent/projects.js:135 |  |  |
| `parseMd` | lib/agent/projects.js:152 |  | 文件 → 条目。认自家的 frontmatter，也认 ZCode 的 `metadata:` 块（type/source 在里面） |
| `readMemory` | lib/agent/projects.js:175 |  | 读一个项目的全部记忆（按文件名排序，稳定的顺序） |
| `renderIndex` | lib/agent/projects.js:192 |  |  |
| `fileBaseFor` | lib/agent/projects.js:208 |  | 条目 → 文件名（去掉路径花样；重复的加 -2、-3） |
| `writeMemory` | lib/agent/projects.js:224 |  | 全量重写某个项目的记忆：写新文件、删掉不再存在的、重建 MEMORY.md。 |
| `writeMemoryLocked` | lib/agent/projects.js:228 |  |  |
| `resolveRoot` | lib/agent/projects.js:298 |  | 校验并规范化项目根目录：必须是**起点内**真实存在的目录。 |
| `view` | lib/agent/projects.js:313 |  |  |
| `list` | lib/agent/projects.js:322 |  | 列表（含当前项目指针与各自记忆条数） |
| `find` | lib/agent/projects.js:330 |  |  |
| `create` | lib/agent/projects.js:333 |  | 建项目：落 projects.json + 建项目记忆文件夹（已存在同根目录的项目时直接复用） |
| `rename` | lib/agent/projects.js:372 |  | 改名（只动显示名，根目录与 id 不变） |
| `setCurrent` | lib/agent/projects.js:386 |  | 设当前项目（''  不归属任何项目） |
| `take` | lib/agent/projects.js:398 |  | 从清单里摘掉（**不动记忆文件夹**）：归档用。真正连文件夹一起删是 remove() 的事。 |
| `remove` | lib/agent/projects.js:411 |  | 删项目：连项目记忆文件夹一起删（会话不受影响，只是不再归属项目） |
| `browse` | lib/agent/projects.js:432 |  | 列一层子目录：给"选项目根目录"的选择器用。 |
| `mkdir` | lib/agent/projects.js:464 |  | 在起点内建一个空目录（选择器的「新建文件夹」用）。 |

#### `lib/agent/roots.js`（9 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `defaultsFor` | lib/agent/roots.js:26 |  | 出厂默认的可访问范围：**整个文件系统**（限制交给绑定账号权限与服务端硬上限）。 |
| `list` | lib/agent/roots.js:31 |  | 生效的可访问范围 |
| `startFor` | lib/agent/roots.js:40 |  | 生效的项目起点：面板设置 > 默认值 > 绑定账号家目录（都要求真实存在） |
| `setStart` | lib/agent/roots.js:49 |  | 面板动作：设起点（必须是真实存在的目录） |
| `insideStart` | lib/agent/roots.js:59 |  | 路径是否落在起点内（realpath 复核，杜绝 ../ 与软链接绕出去） |
| `apply` | lib/agent/roots.js:69 |  | 面板动作：add / remove / set / reset / start（前四个改可访问范围，最后一个改项目起点） |
| `resolveReal` | lib/agent/roots.js:100 |  | 把可能不存在的路径解析成"最接近的真实路径 + 剩余段"，避免用 ../ 或软链接绕出白名单 |
| `inside` | lib/agent/roots.js:116 |  |  |
| `resolveInRoots` | lib/agent/roots.js:121 |  | 解析并校验一个路径：必须落在该身份的可访问目录内。 |

#### `lib/agent/sanitize.js`（12 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `str` | lib/agent/sanitize.js:30 |  |  |
| `num` | lib/agent/sanitize.js:31 |  |  |
| `plain` | lib/agent/sanitize.js:34 |  | 递归净化普通 JSON 值：限深、限键数、限长度，丢弃危险键名 |
| `hostOfUrl` | lib/agent/sanitize.js:58 |  | 从 Base URL 取主机名（小写，含端口）；取不到返回 '' |
| `hostOf` | lib/agent/sanitize.js:62 |  | keyHost 的白名单：小写主机名（可含端口），长度受限 |
| `provider` | lib/agent/sanitize.js:68 |  | 服务商（模型配置）。apiKey 的三态语义见文件头注释。 |
| `prompts` | lib/agent/sanitize.js:104 |  | 提示词登记表：覆盖项 + 技能 + 自定义条目（会原样注入给模型，属用户数据而非秘密） |
| `memory` | lib/agent/sanitize.js:140 |  | 记忆条目：白名单重建 + 限长限量 |
| `roots` | lib/agent/sanitize.js:161 |  | 可访问目录：只接受绝对路径数组（调用方负责 resolve 与存在性校验） |
| `absPath` | lib/agent/sanitize.js:167 |  | 单个绝对路径（项目起点用）：不是绝对路径就当没填（空串  回落默认） |
| `theme` | lib/agent/sanitize.js:173 |  | 外观：主题模式 / 强调色 / 字号 / 密度 / 消息宽度 |
| `uiState` | lib/agent/sanitize.js:183 |  | 界面状态（谁在哪、侧栏收没收、抽屉上次开到哪一节）——纯客户端偏好，限长即可 |

#### `lib/agent/search.js`（5 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `apiKeyOf` | lib/agent/search.js:30 |  | 服务端进程要给 AnySearch 用的 Key（可选）。不设  匿名，见文件头。 |
| `cliArgs` | lib/agent/search.js:34 |  | CLI 参数。`--api_key` 是 argparse 的**全局**选项，必须排在子命令之前（放后面会被拒）。 |
| `quotaLike` | lib/agent/search.js:39 |  | 匿名额度用完时给一句可执行的提示（别让用户只看到英文 429） |
| `runSearch` | lib/agent/search.js:45 |  | 真正执行搜索（服务端托管运行也用它，避免第二份实现）。 |
| `handleSearch` | lib/agent/search.js:70 |  |  |

#### `lib/agent/session.js`（17 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `SITE_USER` | lib/agent/session.js:28 |  | 站点进程自身的用户：以它作绑定  不改身份（无需 su，也不需要密码） |
| `SU_BIN` | lib/agent/session.js:30 |  |  |
| `lookupUser` | lib/agent/session.js:58 |  | 读取系统账号信息（uid/gid/home/shell）；不存在返回 null |
| `verifyPassword` | lib/agent/session.js:72 |  | 用 su 校验密码：成功  该账号的密码正确。 |
| `rateLimited` | lib/agent/session.js:101 |  |  |
| `noteTry` | lib/agent/session.js:107 |  |  |
| `putUnlock` | lib/agent/session.js:125 |  |  |
| `getUnlock` | lib/agent/session.js:128 |  |  |
| `dropUnlock` | lib/agent/session.js:135 |  |  |
| `unlockedAt` | lib/agent/session.js:136 |  |  |
| `onLogout` | lib/agent/session.js:141 |  |  |
| `logout` | lib/agent/session.js:144 |  | 文档站账号登出时调用（lib/api.js 的 handleLogout 挂上）：立刻收回该账号的一切 |
| `bind` | lib/agent/session.js:155 |  | 绑定：验证归属后记录本机账号（不存密码） |
| `unbind` | lib/agent/session.js:194 |  |  |
| `unlock` | lib/agent/session.js:207 |  | 解锁：以绑定账号的密码换一段内存凭据。 |
| `actorOf` | lib/agent/session.js:242 |  | 文档站账号 → 执行身份。工具层只认这个对象。 |
| `bindingView` | lib/agent/session.js:265 |  | 面板展示用的绑定状态（不下发任何密码相关的东西） |

#### `lib/agent/settings.js`（15 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `read` | lib/agent/settings.js:50 |  | 读原始配置（含密钥）。只给服务端自己用；下发前端一律走 publicSettings。 |
| `normalize` | lib/agent/settings.js:56 |  | 补齐结构：旧数据/缺字段一律回落到默认值（缺 providers 不能变成 undefined，否则一调用就炸） |
| `bindingOf` | lib/agent/settings.js:89 |  | 绑定记录的白名单（**绝不包含密码**：绑定只记"是谁"，解锁凭据只活在内存，见 session.js） |
| `save` | lib/agent/settings.js:114 |  | 整体覆盖保存（客户端把整份配置发回来；密钥靠 userdata 的合并语义保持） |
| `patch` | lib/agent/settings.js:127 |  | 只改服务端自己关心的某一小块（绑定、可访问目录、当前会话指针）；其余字段原样保留。 |
| `sanitizeSettings` | lib/agent/settings.js:144 |  | 字段**没出现**（undefined） 沿用 prev，出现了  按提交的来（空数组  显式清空）。 |
| `keyHint` | lib/agent/settings.js:203 |  | 下发前脱敏 |
| `publicProvider` | lib/agent/settings.js:205 |  |  |
| `publicSettings` | lib/agent/settings.js:211 |  |  |
| `providerFor` | lib/agent/settings.js:217 |  | 取某个服务商（含密钥）——只给服务端代转用，绝不走 HTTP 输出 |
| `getBinding` | lib/agent/settings.js:224 |  | 绑定信息 |
| `hasBinding` | lib/agent/settings.js:225 |  |  |
| `setBinding` | lib/agent/settings.js:227 |  |  |
| `clearBinding` | lib/agent/settings.js:234 |  |  |
| `setRoots` | lib/agent/settings.js:246 |  | 写可访问目录（校验/默认值都在 roots.js，这里只落盘） |

#### `lib/agent/skills.js`（7 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `unquote` | lib/agent/skills.js:37 |  | frontmatter 解析 |
| `parseYamlSubset` | lib/agent/skills.js:46 |  | YAML 子集：`key: value` / `key: "value"` / `key: ∣` 块 / `key: >` 折叠块 / 缩进续行 |
| `splitFrontmatter` | lib/agent/skills.js:74 |  | 拆 frontmatter 与正文。**没有收尾的 `---` 就当没有 frontmatter**（宁可不解析，也不吞正文） |
| `parseSkillMd` | lib/agent/skills.js:87 |  | 一段 Markdown → 一条技能记录。description 缺省时取正文第一句（非标题、非代码围栏） |
| `collectMarkdown` | lib/agent/skills.js:113 |  | 收出待导入的 Markdown： |
| `planImport` | lib/agent/skills.js:151 |  | 读 + 解析（不做任何写入）——dryRun 预览与正式导入共用这一份结果 |
| `applyImport` | lib/agent/skills.js:177 |  | 把 plan 的结果写进该账号的提示词登记表。同名技能  改写（与 skill_write 同口径）。 |

#### `lib/agent/store.js`（23 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `readAgentJson` | lib/agent/store.js:44 |  | Agent 各路由读 JSON 体的**唯一入口**：按路径选上限，并把 413 与"JSON 坏了"分开回。 |
| `dirOf` | lib/agent/store.js:53 |  | 账号 → 数据目录（账号名不合法 → null；校验与拼接同一步，见 lib/paths.js） |
| `fileOf` | lib/agent/store.js:54 |  |  |
| `readJson` | lib/agent/store.js:65 |  | 读一个 JSON 文件；文件损坏时先留 .bak 再以默认值继续（绝不能直接覆盖，否则原数据无声丢失） |
| `writeJson` | lib/agent/store.js:82 |  |  |
| `sanitizeMsg` | lib/agent/store.js:91 |  | 会话 |
| `sanitizeSession` | lib/agent/store.js:200 |  |  |
| `emptySessions` | lib/agent/store.js:235 |  |  |
| `readSessions` | lib/agent/store.js:237 |  |  |
| `enforceQuota` | lib/agent/store.js:249 |  | 超出总容量时丢最旧的会话（保留刚写入的那个），返回被丢弃条数。 |
| `putSession` | lib/agent/store.js:284 |  | 新增/覆盖单个会话（按 id 合并）。 |
| `putSessions` | lib/agent/store.js:292 |  | 一次写入多个会话（客户端首屏批量上传/迁移用），返回条数与丢弃数 |
| `takeSessions` | lib/agent/store.js:308 |  | 取走若干会话（**归档**用）：从 sessions.json 摘掉并原样返回，调用方负责存进归档区。 |
| `deleteSession` | lib/agent/store.js:321 |  |  |
| `emptyMemory` | lib/agent/store.js:333 |  | 全局记忆 |
| `readMemory` | lib/agent/store.js:335 |  |  |
| `backupPrev` | lib/agent/store.js:344 |  | 覆盖前留一份上一版（`<文件>.bak`）：全局记忆 / 提示词登记表都是**整体覆盖**语义， |
| `fileHasContent` | lib/agent/store.js:350 |  | 旧文件里"有内容"吗（>100 字节 ≈ 至少一条记录 + JSON 信封）。用于"清空告警"： |
| `putMemory` | lib/agent/store.js:354 |  |  |
| `emptyPrompts` | lib/agent/store.js:372 |  | 提示词登记表 |
| `readPrompts` | lib/agent/store.js:374 |  |  |
| `putPrompts` | lib/agent/store.js:382 |  |  |
| `updatePrompts` | lib/agent/store.js:403 |  | 读-改-写**在锁内**完成（技能安装用）。 |

#### `lib/agent/todo.js`（12 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `todoRoot` | lib/agent/todo.js:33 |  | 路径 |
| `fileFor` | lib/agent/todo.js:37 |  |  |
| `read` | lib/agent/todo.js:45 |  | 读一份清单（没有/读不动 → null；坏文件按"没有"处理，不让它挡住主流程） |
| `view` | lib/agent/todo.js:64 |  | 交给界面/模型的一份摘要（带计数，省得两边各算一遍） |
| `normalize` | lib/agent/todo.js:76 |  | 规整模型给的清单：非空 text、去重（同文只留第一条）、status 只认两档、条数与字数封顶 |
| `save` | lib/agent/todo.js:94 |  |  |
| `write` | lib/agent/todo.js:108 |  | 写整份清单（agent 的唯一入口）。 |
| `drop` | lib/agent/todo.js:136 |  | 丢弃（删除文件）：全完成时的自动丢弃、显式清空、会话被彻底删除时都走它 |
| `prune` | lib/agent/todo.js:145 |  | 账号内清理：只留最近 MAX_FILES 份（按 updatedAt/文件 mtime 排；读不动的也算旧的） |
| `sessionOf` | lib/agent/todo.js:163 |  | 从运行上下文取会话 id：托管运行在 ctx.run 里，HTTP 直调由前端在 body 里带 |
| `writeTool` | lib/agent/todo.js:170 |  | `todo_write` 工具的执行体（注册在 tools/index.js 的 TOOLS 里）。 |
| `handleTodo` | lib/agent/todo.js:197 |  | 界面取当前会话的清单（刷新/切会话/换窗口）。只读，账号隔离由调用方保证。 |

#### `lib/agent/undo.js`（40 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `undoRoot` | lib/agent/undo.js:56 |  | 路径 |
| `sessionDir` | lib/agent/undo.js:60 |  |  |
| `runDir` | lib/agent/undo.js:64 |  |  |
| `metaFile` | lib/agent/undo.js:68 |  |  |
| `splitLines` | lib/agent/undo.js:72 |  | 行数：信息卡片上的 +N / −M |
| `countLines` | lib/agent/undo.js:75 |  | 行数（`a\nb\n` 是 2 行，不是 3 行——空文件 0 行） |
| `countMap` | lib/agent/undo.js:82 |  |  |
| `lineDiff` | lib/agent/undo.js:91 |  | 行数差：先按公共前缀/后缀收窄，再按"行的多重集"计增删。 |
| `textOf` | lib/agent/undo.js:106 |  | 二进制（含 NUL）不逐行比、也不算行数：行数对二进制没有意义 |
| `sha1` | lib/agent/undo.js:110 |  |  |
| `putBlob` | lib/agent/undo.js:115 |  | 记一个 blob（原内容）；返回文件名（日志内引用它） |
| `captureDir` | lib/agent/undo.js:126 |  | 目录快照：列出整棵树（含每个文件的原内容）。超过上限就 truncatedtrue—— |
| `capture` | lib/agent/undo.js:157 |  | 拍一个路径的快照。`blobstrue` 时把文件内容落到 blobs/（撤销要用的那份）。 |
| `toStored` | lib/agent/undo.js:175 |  | 落盘前把内存里的 text 摘掉（它可能是一整篇文件，不进 meta.json） |
| `sameSnap` | lib/agent/undo.js:183 |  | 快照内容没变吗（缺一边当"没变"——宁可不记，也不记错） |
| `pathsFor` | lib/agent/undo.js:199 |  | 这个工具动了哪些路径（原样入参，解析交给 roots——`~` 展开、相对路径、白名单都在那一处） |
| `resolvePaths` | lib/agent/undo.js:207 |  | 入参路径 → 真实路径（解析不了就跳过记录：工具自己会拒绝，这边的错误不该抢在它前面） |
| `stateFor` | lib/agent/undo.js:216 |  |  |
| `canRecord` | lib/agent/undo.js:232 |  | 还能记吗（条数 / 备份字节）——到顶就停记并标 incomplete，撤销时会如实说明 |
| `sumTreeLines` | lib/agent/undo.js:240 |  |  |
| `isFileSnap` | lib/agent/undo.js:241 |  |  |
| `statOf` | lib/agent/undo.js:248 |  | 这一条改动的行数（+写入 / −删除）：改文件用逐行比，建/删按整篇行数算。 |
| `actionOf` | lib/agent/undo.js:270 |  |  |
| `record` | lib/agent/undo.js:272 |  |  |
| `wrap` | lib/agent/undo.js:296 |  | 包住一次会改文件的工具调用：前后各拍一次快照 → 记录 → 把行数挂到工具结果上。 |
| `summaryOf` | lib/agent/undo.js:345 |  | 交给界面/会话消息的那一句摘要（文件清单只给前 20 个，完整清单在服务端日志里）。 |
| `dirBytes` | lib/agent/undo.js:385 |  | 目录大小（清理用；备份文件不多，逐个 stat 足够） |
| `prune` | lib/agent/undo.js:400 |  | 账号内的日志清理：先按天数，再按份数，最后按总字节（都是"最老的先走"） |
| `readJson` | lib/agent/undo.js:425 |  |  |
| `finishRun` | lib/agent/undo.js:430 |  | 收尾：把内存态日志落盘并交回一句摘要（没有改动就什么都不留，返回 null） |
| `readJournal` | lib/agent/undo.js:455 |  | 按 runId 找日志（会话 id 是提示，没有就逐个会话目录找一遍） |
| `textSide` | lib/agent/undo.js:478 |  | buffer → 一侧的内容（二进制判 NUL、超长截断、行数） |
| `sideOfSnap` | lib/agent/undo.js:489 |  | 一侧  日志里的快照（内容在 blobs/ 里）。source 标内容来自哪（journal备份 / disk当前文件） |
| `sideOfDisk` | lib/agent/undo.js:511 |  | 另一侧  **当前磁盘上的文件**（这条改动之后没有人再改过它时用）。 |
| `readDiff` | lib/agent/undo.js:546 |  | 读一次改动的**两侧内容**（界面的「比对修改」抽屉用）。 |
| `restoreOne` | lib/agent/undo.js:596 |  | 按快照把一个路径恢复原状；返回 'removed'（删掉运行中新建的东西）∣ 'restored'（写回原内容）。 |
| `restoreTree` | lib/agent/undo.js:625 |  | 目录：整棵树照快照重建（缺的建、多的删、内容写回） |
| `pruneTree` | lib/agent/undo.js:649 |  | 删掉快照里没有的条目（恢复"原状"的必要一步） |
| `undo` | lib/agent/undo.js:669 |  | 撤销：把一次运行的文件改动恢复原状。**整轮或按文件**（opts.paths）都走这里。 |
| `dropSession` | lib/agent/undo.js:725 |  | 会话被**彻底删除**时清掉它的撤销日志（归档保留——归档可恢复，日志也要跟着回去） |

#### `lib/agent/upstream.js`（11 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `sessionHeaderFor` | lib/agent/upstream.js:70 |  |  |
| `sessionValue` | lib/agent/upstream.js:82 |  | 会话标识的**值**：前端带上"这次对话"的 id（同一段对话恒定不变 → 上游据此做路由与 |
| `normalizeRef` | lib/agent/upstream.js:95 |  | 旧数据的类型升级：ollama 原生 → openai 兼容，其余非法值回落 openai。 |
| `resolveTarget` | lib/agent/upstream.js:102 |  | 本次请求用哪套配置：已保存的（带密钥）或临时传入的（"测试连接"） |
| `buildUpstream` | lib/agent/upstream.js:118 |  | 配置 → 上游 URL 与首部（密钥在这里注入，浏览器永远看不到） |
| `applyExtraBody` | lib/agent/upstream.js:148 |  | 把用户填的"额外请求体"（JSON 文本）合并进请求体；不允许覆盖核心字段 |
| `sendUpstream` | lib/agent/upstream.js:161 |  |  |
| `describe` | lib/agent/upstream.js:168 |  | 连接类错误翻译成人话（带上目标主机，便于区分"没启动"和"没登录"） |
| `tryOrigin` | lib/agent/upstream.js:177 |  |  |
| `proxyError` | lib/agent/upstream.js:181 |  |  |
| `handleUpstream` | lib/agent/upstream.js:188 |  | 端点 |

### 服务端 · 托管运行 run* 家族（lib/agent）——10 个文件 / 71 个函数

#### `lib/agent/run-bridge.js`（6 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `current` | lib/agent/run-bridge.js:33 |  |  |
| `runWith` | lib/agent/run-bridge.js:34 |  |  |
| `installBridge` | lib/agent/run-bridge.js:38 |  | 装一次（进程级）：core/http.js 的 fetch 之后一律走这里 |
| `respond` | lib/agent/run-bridge.js:45 |  |  |
| `bodyOf` | lib/agent/run-bridge.js:50 |  | 请求体（core/http.js 发的是 JSON 字符串） |
| `bridgeFetch` | lib/agent/run-bridge.js:58 |  | 按路径分发。未覆盖的路径一律 501——**绝不静默成功**： |

#### `lib/agent/run-confirm.js`（2 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `ask` | lib/agent/run-confirm.js:19 |  | 需要人点确认时：推给当前挂着的客户端并等回答。 |
| `answerConfirm` | lib/agent/run-confirm.js:40 |  | 客户端回答一个确认（人点了按钮 / 输入框）。grant 是危险命令的一次性票据。 |

#### `lib/agent/run-core.js`（2 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `modules` | lib/agent/run-core.js:21 |  | 加载静态 core 模块并完成进程级接线（只做一次） |
| `createCoreContext` | lib/agent/run-core.js:59 |  | 造一份**本轮运行专用**的 core 实例（登记表/记忆/工具执行/上下文管理都是新的） |

#### `lib/agent/run-events.js`（10 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `line` | lib/agent/run-events.js:21 |  |  |
| `hubWrite` | lib/agent/run-events.js:29 |  |  |
| `hubSend` | lib/agent/run-events.js:32 |  | 推给某个账号的事件口（emit 内部调；没有订阅者时什么都不做） |
| `hubAttach` | lib/agent/run-events.js:41 |  | 挂一个账号级订阅者：先给一份**快照**（这个账号现在有哪些在跑），再把每段运行的 |
| `view` | lib/agent/run-events.js:74 |  | 对外的运行摘要（**唯一一份**，run-registry 也从这里 import——原先两边各拼一份同形的， |
| `replayTo` | lib/agent/run-events.js:80 |  | 把一段运行已经发生的事件推给**任意**订阅者（hub 回放用；标签是 runId/sessionId 而不是裸事件） |
| `emit` | lib/agent/run-events.js:89 |  | 广播一条事件：进日志（供回放）、推给本运行的订阅者、推给账号事件口 |
| `applyToLive` | lib/agent/run-events.js:111 |  | 流式正文/思考/用量：直接累加到 run.live（落盘的就是它，与界面口径一致）。 |
| `notifyUi` | lib/agent/run-events.js:121 |  | 登记表/记忆被模型改了：给界面一条"数据变了"的提示（面板内容由客户端自己重拉） |
| `attach` | lib/agent/run-events.js:124 |  | 挂一个 SSE 订阅者：先回放已发生的事件（人走开再回来  画面补齐），再续播 |

#### `lib/agent/run-http.js`（3 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `body` | lib/agent/run-http.js:22 |  |  |
| `errorPayload` | lib/agent/run-http.js:32 |  | 撤销/比对两个端点的 catch 共用：把结构化错误里"该给界面看"的字段挑出来 |
| `handleRun` | lib/agent/run-http.js:38 |  |  |

#### `lib/agent/run-loop.js`（9 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `intParam` | lib/agent/run-loop.js:32 |  | 记录类上限的读取口径（面板「结果与记录」可调，schema 已归一，这里只兜住空值/非法值）。 |
| `persist` | lib/agent/run-loop.js:40 |  | 落盘：把这一轮的消息写回会话（流式期间按 1.5s 节流，收尾强制一次） |
| `execute` | lib/agent/run-loop.js:60 |  | 循环 |
| `buildOpts` | lib/agent/run-loop.js:255 |  | 本轮请求参数（与浏览器侧同一实现：Assemble.buildRequestOptions）。 |
| `roundBudget` | lib/agent/run-loop.js:266 |  |  |
| `loopTexts` | lib/agent/run-loop.js:286 |  | 循环内提示文案（主对话与子智能体共用这一份；键 ↔ 登记表条目 id 的映射唯一真源 |
| `loopHooks` | lib/agent/run-loop.js:297 |  | 内核回调 → 事件流（形状与浏览器侧 turnHooks 一致，界面因此同一套渲染）。 |
| `finish` | lib/agent/run-loop.js:391 |  | 收尾：把内核结果合并进 live、落盘、广播结束事件、释放占用。 |
| `classifyError` | lib/agent/run-loop.js:471 |  | 把上游错误归类成界面能说清楚的一类（只影响显示与提示，不影响重试） |

#### `lib/agent/run-registry.js`（13 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `newId` | lib/agent/run-registry.js:25 |  |  |
| `create` | lib/agent/run-registry.js:38 |  | 登记一次新运行；调用方负责把 live/历史/会话/core 补齐（见 run.js 的 startRun）。 |
| `get` | lib/agent/run-registry.js:58 |  | 取一个运行。传了 account 就必须是它主人的（**端点一律要传**，防跨账号） |
| `objectsOf` | lib/agent/run-registry.js:67 |  | 内部用：本账号还在"占着"的 **run 对象**（含 abort / 事件日志 / 转录）。 |
| `listOf` | lib/agent/run-registry.js:81 |  | 本账号还在"占着"的运行清单（对外的视图，最近的在前）——统一事件口与 /state 都用它。 |
| `busyOf` | lib/agent/run-registry.js:86 |  | 这个账号有没有在跑的运行（`/agent/run/state` 用它——只回本账号那几段，不泄露别人的 runId） |
| `stateOf` | lib/agent/run-registry.js:89 |  | 这条会话有没有在跑的运行（同一会话不许两段：它们会互相覆盖历史） |
| `capacity` | lib/agent/run-registry.js:99 |  | 还能不能开新的一段（三道闸：会话级由 stateOf 管，这里是账号级与全进程级） |
| `stopRun` | lib/agent/run-registry.js:111 |  |  |
| `release` | lib/agent/run-registry.js:119 |  | 收尾后的登记处理：保留一段供"回来接上"，到点删除（内存有上限） |
| `steer` | lib/agent/run-registry.js:129 |  | 生成中用户输入的话排进队列，内核下一轮开始前注入。 |
| `markSteer` | lib/agent/run-registry.js:144 |  | 插话在追踪条上的那条（"待注入" → "下一轮生效" → "最终回答后生效"）。 |
| `steerPending` | lib/agent/run-registry.js:156 |  | 内核取走插话后同步一次待注入条数（界面上的"已排队 N 条"据此归零） |

#### `lib/agent/run-subagent.js`（6 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `clampInt` | lib/agent/run-subagent.js:26 |  |  |
| `one` | lib/agent/run-subagent.js:30 |  |  |
| `subBudget` | lib/agent/run-subagent.js:40 |  |  |
| `createSubAgentRunner` | lib/agent/run-subagent.js:64 |  | 造一个"子智能体执行器"（按 run 一个：并发闸与计数都跟着这一段运行）。 |
| `acquire` | lib/agent/run-subagent.js:90 |  | 并发闸：满了就在队列里等（**排队而不是拒绝**——模型的并行调用不该被丢掉） |
| `release` | lib/agent/run-subagent.js:94 |  |  |

#### `lib/agent/run-upstream.js`（5 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `toResponse` | lib/agent/run-upstream.js:15 |  | Node 的 IncomingMessage → web Response（适配器只用到 status/ok/headers/body.getReader） |
| `requestOnce` | lib/agent/run-upstream.js:48 |  |  |
| `targetOf` | lib/agent/run-upstream.js:73 |  | 本次运行用哪套服务商配置（账号从异步上下文取——见 run-bridge.js 的说明） |
| `nodeChat` | lib/agent/run-upstream.js:85 |  | 与浏览器侧 /agent/upstream/chat 同形状：ref 里带 provider id，body 是协议请求体 |
| `nodeModels` | lib/agent/run-upstream.js:95 |  | 模型清单（设置面板/探测用；托管运行本身不需要，保持同形状以免适配器分支） |

#### `lib/agent/run.js`（15 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `gateErrors` | lib/agent/run.js:62 |  | 起跑前的三道闸：同一会话不许并行、同账号限流、全进程限流（都把话说明白） |
| `startRun` | lib/agent/run.js:77 |  | 启动一次托管运行。**立即返回 runId**，循环在后台跑——所以关掉浏览器不影响它。 |
| `attach` | lib/agent/run.js:131 |  | 挂一个 SSE 订阅者（**只允许 run 的主人**：跨账号读别人的事件流是信息泄露）。 |
| `attachHub` | lib/agent/run.js:138 |  | 挂账号事件口（统一口：一条流收这个账号全部运行的事件，按 account 过滤）。 |
| `answerConfirm` | lib/agent/run.js:144 |  | 回答一个确认（**只允许 run 的主人**：否则任何人拿到 confirmId 就能替别人批准危险命令）。 |
| `subAgentOf` | lib/agent/run.js:153 |  | 某个子智能体的转录（给界面展开看"它到底做了什么"）；按 account 过滤。 |
| `syncUndoMessage` | lib/agent/run.js:179 |  | 撤销（整轮或逐文件）后把会话里那条消息的 `undo` 摘要更新成服务端最新进度。 |
| `undoRun` | lib/agent/run.js:202 |  | 撤销：把一次运行的文件改动恢复原状——**默认整轮，传 opts.paths 时只恢复这些文件** |
| `undoDiff` | lib/agent/run.js:235 |  | 比对修改：读一次改动的两侧内容（before 从备份、after 从下一条快照或当前文件）。 |
| `stateOf` | lib/agent/run.js:238 |  | 这一轮还在跑吗（供 run-http 的 /state 用；只回本账号那几段） |
| `busyOf` | lib/agent/run.js:239 |  |  |
| `listOf` | lib/agent/run.js:240 |  |  |
| `stopRun` | lib/agent/run.js:241 |  |  |
| `steer` | lib/agent/run.js:242 |  |  |
| `busy` | lib/agent/run.js:246 |  | 内部用（测试/诊断）：全局在跑的那几段，**不带账号过滤**；没有在跑的就是 null。 |

### 服务端 · 工具实现（lib/agent/tools）——6 个文件 / 43 个函数

#### `lib/agent/tools/deliver.js`（1 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `deliverFile` | lib/agent/tools/deliver.js:14 |  |  |

#### `lib/agent/tools/exec.js`（8 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `ENV_PASS_EXTRA` | lib/agent/tools/exec.js:32 |  |  |
| `baseEnv` | lib/agent/tools/exec.js:36 |  |  |
| `trackChild` | lib/agent/tools/exec.js:54 |  |  |
| `untrackChild` | lib/agent/tools/exec.js:61 |  |  |
| `killChildrenOf` | lib/agent/tools/exec.js:69 |  | 杀掉某个账号下所有在跑的子进程（返回条数）。先按进程组杀，杀不到再退回落单进程。 |
| `spawnSpec` | lib/agent/tools/exec.js:93 |  | 启动方式：同用户直接跑；身份不同用 su 拉起（密码走 stdin）。 |
| `runOnce` | lib/agent/tools/exec.js:115 |  |  |
| `runCommand` | lib/agent/tools/exec.js:152 |  |  |

#### `lib/agent/tools/fs.js`（16 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `fmtMode` | lib/agent/tools/fs.js:18 |  |  |
| `guard` | lib/agent/tools/fs.js:21 |  | 路径解析 + 绑定账号权限判定：工具实现的第一步都走这里 |
| `readFile` | lib/agent/tools/fs.js:48 |  | 只读 |
| `readSlice` | lib/agent/tools/fs.js:66 |  | 按行切片读取（向前流式扫描）：大文件分段读、限额、行号三者同时成立。 |
| `listDirectory` | lib/agent/tools/fs.js:94 |  |  |
| `directoryTree` | lib/agent/tools/fs.js:114 |  |  |
| `searchFiles` | lib/agent/tools/fs.js:139 |  |  |
| `fileInfo` | lib/agent/tools/fs.js:175 |  |  |
| `writeFile` | lib/agent/tools/fs.js:197 |  | 写入 |
| `editFile` | lib/agent/tools/fs.js:211 |  |  |
| `createDirectory` | lib/agent/tools/fs.js:228 |  |  |
| `copyThenRemove` | lib/agent/tools/fs.js:235 |  | 跨设备时 rename 会 EXDEV：退回"复制后删源" |
| `moveFile` | lib/agent/tools/fs.js:240 |  |  |
| `deletePath` | lib/agent/tools/fs.js:254 |  |  |
| `defaultCwd` | lib/agent/tools/fs.js:270 |  | 命令工具的工作目录：落在白名单内且绑定账号能进入 |
| `cwdFor` | lib/agent/tools/fs.js:285 |  |  |

#### `lib/agent/tools/index.js`（6 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `linesOf` | lib/agent/tools/index.js:64 |  | 工具结果里的行数（工具没改文件、或没记成日志时为 undefined）——响应里只带这两个数 |
| `toolResultBody` | lib/agent/tools/index.js:74 |  | 工具结果 → 响应体（**两条调用路径的唯一一份**：HTTP 的 /tools/call 与托管运行的进程内桥）。 |
| `toolErrorBody` | lib/agent/tools/index.js:87 |  | 工具失败 → 响应体（同样两条路唯一一份）：needUnlock / needGrant / needBind… |
| `callTool` | lib/agent/tools/index.js:101 |  | 工具执行的**唯一入口**：会改文件的工具由 undo.wrap 包一层—— |
| `statusInfo` | lib/agent/tools/index.js:110 |  | 面板展示 + 前端据它决定注册哪些工具（未绑定 → 前端不注册文件/命令工具） |
| `handleTools` | lib/agent/tools/index.js:134 |  |  |

#### `lib/agent/tools/screen.js`（10 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `parserUrl` | lib/agent/tools/screen.js:33 |  | OmniParser 本机服务（只允许 localhost，出 URL 的是服务端运维不是模型）。 |
| `displayEnv` | lib/agent/tools/screen.js:42 |  | 找到可用的 DISPLAY / XAUTHORITY（站点进程就是桌面用户本人；su 不参与—— |
| `run` | lib/agent/tools/screen.js:59 |  | 数组式 spawn（不经 shell），收集 stdout/stderr/退出码 |
| `capture` | lib/agent/tools/screen.js:74 |  | 截一张全屏到 pngPath（X11 root 窗口）。失败时给人话（常见：Wayland / 没有显示）。 |
| `parseImage` | lib/agent/tools/screen.js:89 |  | 调 OmniParser 服务解析一张图。服务没起 → 给出启动方法。 |
| `intArg` | lib/agent/tools/screen.js:120 |  | 参数校验（白名单） |
| `screenSee` | lib/agent/tools/screen.js:130 |  | screen_see：截图 → 解析 → 元素清单（模型"看"屏幕的唯一入口） |
| `screenClick` | lib/agent/tools/screen.js:162 |  | screen_click：在屏幕像素坐标上点击（左/右/双击） |
| `screenType` | lib/agent/tools/screen.js:179 |  | screen_type：向当前聚焦的窗口输入文本（可选先全选清空） |
| `screenKey` | lib/agent/tools/screen.js:195 |  | screen_key：发按键/组合键（如 ctrl+c、Return、alt+F4） |

#### `lib/agent/tools/wait.js`（2 个）

| 函数 | 位置 | 导出 | 作用（取定义前注释的末行） |
|---|---|---|---|
| `delay` | lib/agent/tools/wait.js:17 |  | 等待到点或等到停止信号（哪个先到算哪个）。返回是否被停止。 |
| `waitTool` | lib/agent/tools/wait.js:34 |  |  |
<!-- GEN:FUNCTIONS END -->
