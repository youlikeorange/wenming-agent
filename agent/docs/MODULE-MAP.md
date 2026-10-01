# 智能体 Agent · 模块 / 端点 / 数据地图

**这份文档回答**：每个模块负责什么、数据从界面到磁盘经过哪些函数、每个端点的请求/响应长什么样、
改某个功能要动哪几个文件。目标是**下次改代码不用先把整个仓库读一遍**。

配套：
- `../ARCHITECTURE.md` —— 启动顺序与"一条消息从输入框到落盘"的完整流程（**先读那份理解流程**，这份是查字典的）
- `../README.md` —— 怎么构建、怎么跑测试
- `../AUDIT.md` —— 历轮审计与修复记录
- 仓库根 `PROJECT-STRUCTURE.md` —— 整个文档站（非 agent 部分）
- 站点根 `lib/agent/AUDIT-2026-09-30-INDUSTRIAL.md` —— 服务端安全审计

> **两种宿主**：本站是宿主之一（进程入口 `server.js`，还挂着文档/媒体/剧本编辑器）；另一份最小宿主
> 在公开仓库 `github.com/youlikeorange/wenming-agent` 的 `standalone.js`（只做静态服务 + 登录三端点 +
> `/agent/*`，`node standalone.js` 即可跑）。两者共用同一份 `lib/agent/**` 与 `agent/src/**`，
> 数据格式一致、数据目录不同（本站 `~/.local/share/wenming-web`，standalone 默认 `~/.local/share/wenming-agent`）。
> 两边的对应改动要`./tools/sync.sh` 同步（见仓库 README）。

> 文档里的行号是 2026-10-01 的版本。改动后如果对不上，以**函数名**为准（用 `grep -n "函数名" 文件` 定位）。
> 修改任何 `agent/src/**` 之后必须 `cd agent && npm run build`（页面只认
> `public/llm-chat/vendor/agent.js`）；改 `lib/agent/**`（服务端）之后必须 `bash down.sh && bash up.sh`，
> **只重建不重启 = 新客户端打旧服务端**。

---

## 1. 三层与目录（一句话各自是什么）

```
浏览器（agent/src/ui）   只做"显示 + 转达"：React 组件 + ui/state 动作层，不跑 agent 循环
   │  同源 HTTP + SSE（core/http.js 统一出口，带 X-Agent-Client 窗口标识）
服务端（lib/agent）      跑 agent 循环（托管运行）、落盘、鉴权、工具执行、上游代转
   │  同一份 core（服务端动态 import，浏览器用 esbuild 打包）
共享 core（agent/src/core）  零框架、不认识 React：循环 / 工具 / 协议 / 组装 / 压缩 / 登记表 / 记忆
```

| 目录 | 说明 |
|---|---|
| `agent/src/core/` | 零框架业务逻辑，可在 Node 下直接单测（`test/` 里 198 个用例大多在测它） |
| `agent/src/ui/` | React 界面：`features/`（组件）、`state/`（状态容器 + 动作层）、`components/ui/`（shadcn 风基础件） |
| `agent/src/ui/state/` | `store.js` 状态容器 · `host.js` 依赖注入宿主 · `session.js` 一轮对话编排 · `run.js` 托管运行客户端 · `settings.js` 设置类动作 · `projects.js` 项目动作 · `downloads.js` 待下载 |
| `lib/agent/` | 服务端（站点根）：路由 `index.js`、存储 `store.js`、配置 `settings.js`、托管运行 `run*.js`、工具 `tools/` |
| `agent/test/` | `node --test` 用例；改 core 必跑 |
| `agent/build.mjs` | esbuild + Tailwind CLI → `public/llm-chat/vendor/{agent.js,agent.css}` |

---

## 2. 前端状态字段 ↔ 端点 ↔ 磁盘（改界面先查这张）

`agent/src/ui/state/store.js` 的 `state` 是界面的唯一数据源；下表说明每个字段的来路与落点。

| state 字段 | 含义 | 谁写 | 走哪个端点 | 服务端落点 |
|---|---|---|---|---|
| `info` | 登录态 / 绑定 / 协议 / 本机默认 | `session.bootstrap` 探针 | `GET /agent/info`（免登录） | — |
| `settings` | 服务端配置（已脱敏，无 apiKey） | `applyServerData` / `settings.js` 各动作 | `GET /agent/store`、`POST /agent/store/settings` | `STATE_DIR/userdata/<账号>/agent.json` |
| `sessions` | 会话索引（含完整 msgs） | `applyServerData` / `persistSession` | `GET /agent/store`、`POST /agent/store/sessions` | `STATE_DIR/agent/<账号>/sessions.json` |
| `activeSessId` | 当前会话 | `session.js` + `settings.currentSess` | 随 settings 保存 | `agent.json` 的 `currentSess` |
| `projects` / `currentProjectId` | 项目清单 / 当前项目指针 | `projects.js` | `/agent/projects/*`、`GET /agent/store` | `agent/<账号>/projects.json` + `projects/<id>/` |
| `history` | 当前会话的消息（含 thinking/trace/injected） | `session.js` / `run.js` | 随会话落盘 | 会话对象 `msgs` |
| `runs` / `streaming` / `hub` | 多会话并行运行状态 / 当前会话在跑 / 统一事件口 | `run.js` | `GET /agent/run/hub`（SSE）、`/agent/run/state` | 服务端 run 登记表（内存，10 分钟后回收） |
| `status` | 当前模型连接情况 | `session.checkStatus` | `POST /agent/upstream/models` | — |
| `agentStatus` | 绑定/白名单/上限/危险清单 | `session.js` | `GET /agent/tools/status` | — |
| `ctx` | 用量环（used/limit/pct） | `updateCtx` | 本地估算（core/context.js） | — |
| `confirm` / `confirmQueue` | 确认框（一次一个，其余排队） | `host.askConfirm` | 服务端 run 的 `confirm` 事件经 hub 下发 | — |
| `promptDrafts` | **提示词登记表的未应用草稿**（`id → 补丁 {text?, name?, description?, auto?}`） | `setPromptDraft`（settings.js:238） | **不落盘**（纯界面态） | — |
| `downloads` | 「📥 待下载」目录 | `downloads.js` | `GET /agent/files` | `agent/<账号>/downloads/` |
| `draft` / `revision` / `drawer` / `presence` | 输入框草稿 / core 改动版本号 / 抽屉 / 单窗口 | 各组件与 `host.js` | — | — |

**提示词登记表不在 `settings` 里**（v2 起移出）：它有自己的端点 `/agent/store/prompts` 与文件
`agent/<账号>/prompts.json`（见 §5）。

---

## 3. 端点总表（`/agent/*`）

公共规则（`lib/agent/index.js`）：
- 除 `GET /agent/info` 与 `POST /agent/presence` 外**全部要求文档站登录**（`index.js:331-352`）；
- 登录后除 info/presence 外全过**单窗口互斥** `presence.guard`（`index.js:354`：按「账号+IP」占用，
  被顶窗口所有需登录端点回 409 + `X-Agent-Client-Lock: taken`；服务端**已在跑的 run 不受顶号影响**）；
- 请求体上限真源在 `lib/agent/store.js:38` 的 `MAX_BODY_BYTES`（store/projects/run 链路）与
  `SMALL_BODY_BYTES = 4MB`（其余）；**新增端点必须走 `store.readAgentJson` 或 `run-http.js` 的口径**，别再写第四个数字。

| 方法 | 路径 | 用途 | 关键请求字段 | 关键响应字段 | 实现 |
|---|---|---|---|---|---|
| GET | `/agent/info` | 探针（免登录） | — | `loggedIn,user,binding,protocols,presence,unlockTtlMs,siteUser` | `index.js:82-95` |
| POST | `/agent/presence` | 单窗口登记/查询/让位（免登录） | `{cid, claim?, leave?}` | `{active,takeover,owner,enforce}` | `presence.js` |
| GET | `/agent/store` | 一次拉全；`?light=1` 不要会话与设置 | — | `settings?,sessions?,memory[],prompts{overrides,skills,extra},projects[],currentProject,meta` | `index.js:100-124` |
| POST | `/agent/store/settings` | 保存配置（密钥空串=保持；TOFU 主机校验） | `{settings:{providers,activeId,params,theme,ui,tools,currentSess}}` | `{ok,settings}`（脱敏） | `index.js:131-134` · `settings.js:110-186` |
| POST | `/agent/store/sessions` | 新增/覆盖会话（单条或批量） | `{session}` 或 `{sessions[]}` | `{ok,id?,saved,sessions,dropped}` | `index.js:135-140` · `store.js:229-277` |
| POST | `/agent/store/session/delete` | 删除单会话（不可逆；界面已改用归档） | `{id}` | `{ok,sessions}` | `index.js:141-146` |
| POST | `/agent/store/session/archive` | 归档单会话 | `{id}` | `{ok,id,title}` | `index.js:147-153` · `archive.js:76-88` |
| POST | `/agent/store/memory` | 全局记忆整体覆盖 | `{entries[]}` | `{ok,entries:条数}` | `index.js:154-157` |
| POST | `/agent/store/prompts` | **提示词登记表整体覆盖** | `{prompts:{overrides,skills,extra}}` | `{ok,prompts}` | `index.js:158-161` · `store.js:306-310` |
| GET | `/agent/binding` | 绑定状态 | — | `{binding{bound,osUser,unlocked,…}}` | `session.js:265-281` |
| POST | `/agent/binding/bind` | 绑定本机账号（su 验密，密码不落盘） | `{osUser,password}` | `{ok,binding}` | `session.js:155-192` |
| POST | `/agent/binding/unbind` | 解绑（清绑定+凭据，掐运行） | — | `{ok,binding}` | `session.js` |
| POST | `/agent/binding/unlock` | 内存解锁（默认 12h TTL） | `{password}` | `{ok,unlock,binding}` | `session.js:207-231` |
| POST | `/agent/binding/lock` | 丢弃解锁凭据 | — | `{ok,binding}` | `session.js` |
| GET | `/agent/projects/browse` | 列子目录（只能在"起点"内向下） | `?path=` | `{path,parent,start,entries[],atStart}` | `projects.js:416-441` |
| GET | `/agent/projects/memory` | 读某项目记忆（**唯一取数路径**） | `?id=` | `{ok,id,entries[]}` | `index.js:224-228` |
| POST | `/agent/projects/create` | 建项目 + 记忆文件夹 + 种子记忆 | `{root,name}` | `{ok,project,current,entries}` | `projects.js:317-353` |
| POST | `/agent/projects/rename` / `current` / `delete` / `archive` / `memory` | 改名 / 设当前 / 删 / 归档（连会话）/ 项目记忆整体覆盖 | `{id,…}` | `{ok,…}` | `index.js:240-258` |
| GET | `/agent/archive` | 归档清单 | — | `{sessions[],projects[]}` | `archive.js:221-231` |
| POST | `/agent/archive/restore` / `delete` | 恢复 / 彻底删除 | `{kind,id}` | `{ok,…}` | `archive.js:183-231` |
| POST | `/agent/upstream/chat` | 模型代转（流式；密钥只存服务端） | `{provider?,type?,baseUrl?,apiKey?,body,sessionId?}` | 上游原始流（头 `X-Agent-Proxy: upstream`） | `upstream.js:188-248` |
| POST | `/agent/upstream/models` | 拉模型清单 | `{provider\|type,baseUrl,apiKey}` | 上游 JSON 透传 | `upstream.js:203-226` |
| POST | `/agent/search` | 联网搜索（内置技能用） | `{query,max_results 1-10}` | `{ok,markdown}` / `{ok:false,error}` | `search.js:26-77` |
| POST | `/agent/skills/import` | 从 SKILL.md 装技能（`dryRun` 预览） | `{path,auto?,dryRun?}` | `{items[{name,description,auto,file,chars}]}` | `index.js:299-323` · `skills.js:177-205` |
| GET | `/agent/files` | 待下载目录列表 | — | `{dir,entries[{name,size,exec,packaged,downloadName}]}` | `files.js:96-123` |
| GET | `/agent/files/download` | 下载（可执行自动改发 zip） | `?name=` | 文件字节（头 `X-Agent-Packaged`） | `files.js:239-260` |
| POST | `/agent/files/delete` | 删除待下载文件 | `{name}` | `{ok}` | `files.js:267-274` |
| GET | `/agent/tools/status` | 身份/白名单/上限/危险清单/工具表 | — | `{binding,roots,start,limits,deny[],tools[]}` | `tools/index.js:47-76` |
| POST | `/agent/tools/roots` | 可访问目录 / 项目起点 | `{action:'add'\|'remove'\|'set'\|'reset'\|'start',…}` | `{ok,roots[]}` / `{ok,start}` | `tools/index.js:78-92` |
| POST | `/agent/tools/deny-check` | 危险命令预检 | `{command}` | `{ok,hit,grant}` | `tools/index.js:94-104` |
| POST | `/agent/tools/call` | 执行工具（**唯一工具出口**） | `{name,args,limits,grant}` | `{ok,text,note,ms,files?}`；失败带 `needBind/needUnlock/needGrant/needPermission/hit` | `tools/index.js:106-145` |
| POST | `/agent/run/start` | 起一段托管运行（立即返回） | `{sessionId,text,providerId?,history?,localEdits?}` | `{ok,runId}`；忙时 409 + `busy[]` | `run-http.js:65-82` · `run.js:75-125` |
| GET | `/agent/run/hub` | **前端唯一 SSE 口**：本账号全部运行事件 | — | SSE：`hub_snapshot`、带 `runId/sessionId` 的事件、`confirm` | `run-events.js:41-70` |
| GET | `/agent/run/events` | 单运行 SSE（先回放再续播；诊断用） | `?id=` | SSE 事件流 | `run-events.js:122-146` |
| GET | `/agent/run/state` | 某会话在跑吗 + 本账号在跑清单 | `?sessionId=` | `{run\|null,runs[],busy[]}` | `run-registry.js:74-78` |
| GET | `/agent/run/subagent` | 子智能体完整转录（结束保留 10 分钟） | `?id=<runId>&sub=<subId>` | `{sub{steps[],answer,…}}` | `run.js:148-162` |
| POST | `/agent/run/stop` / `steer` / `confirm` | 停止 / 生成中插话 / 回答确认 | `{id,…}` | `{ok}` | `run-http.js:84-97` |
| POST/GET | `/api/login` · `/api/logout` · `/api/session` | 文档站账号（宿主的，不在 agent 内实现） | — | — | `core/endpoints.js:63-65` |

前端所有路径的唯一真源是 `agent/src/core/endpoints.js` 的 `EP`（**加端点先加这里**），统一请求层是
`agent/src/core/http.js`（自动带 `X-Agent-Client`；401 且带 `x-agent-auth` 才当"要登录"）。

---

## 4. 磁盘数据布局（`STATE_DIR`，默认 `~/.local/share/wenming-web`）

```
STATE_DIR/
├── userdata/<文档站账号>/agent.json     # 小配置（providers/params/theme/ui/tools/binding/currentSess）
│                                        # ★ apiKey 明文只在这里；HTTP 下发一律经 publicSettings 脱敏
└── agent/<账号>/                        # 账号隔离：一个账号一个 0700 目录
    ├── sessions.json                    # {version:1, sessions:[Session]}(+会话记忆+压缩摘要)
    ├── memory.json                      # {version:1, entries:[MemoryEntry]}（全局记忆）
    ├── prompts.json                     # {overrides{}, skills[], extra[]}（★磁盘上没有 version 字段）
    ├── projects.json                    # {version:1, current, projects:[{id,root,name,created,updated}]}
    ├── projects/<项目id>/               # id = slug(basename)-sha1(abs).slice(0,8)，同根目录恒定
    │   ├── project.json                 # 项目元信息
    │   ├── MEMORY.md                    # 记忆索引（Markdown 链接列表）
    │   └── memory/*.md                  # 每条记忆一个 Markdown（YAML frontmatter + 正文）
    ├── downloads/                       # 待下载目录（可执行文件落成 <名>.zip）
    └── archive/
        ├── sessions.json                # 归档会话（原样 + archivedAt）
        ├── projects.json                # 归档项目元信息（+ archivedAt/memoryCount/sessions）
        └── projects/<项目id>/           # 归档项目文件夹（整份搬来）
```

| 文件 | 顶层结构 | 写入者 |
|---|---|---|
| `userdata/<账号>/agent.json` | `{version:2,providers[],activeId,params{},paramsByModel{},theme{},ui{},binding?,tools{roots[],start},currentSess?,updatedAt}` | `lib/agent/settings.js` 的 `save/patch`（`userdata.js` 原子写 + 256KB 上限） |
| `sessions.json` | `{version:1,sessions[]}` | `store.putSession/putSessions/deleteSession`、`archive` 恢复 |
| `memory.json` | `{version:1,entries[]}` | `store.putMemory` |
| `prompts.json` | `{overrides{},skills[],extra[]}` | `store.putPrompts`；`skills.applyImport` 走 `store.updatePrompts`（锁内读改写） |
| `projects.json` | `{version:1,current,projects[]}` | `projects.writeList` |
| `projects/<id>/memory/*.md` | frontmatter：`name/description/id/source/tags/updated` + 正文 | `projects.writeMemoryLocked`（**全量覆盖：不在本次集合里的 .md 会被删**） |

上限（`lib/agent/store.js:28-40`）：会话 ≤300 条、消息 ≤2000/会话、单会话 ≤32MB、内容 ≤2MB/条、
全局记忆 ≤300 条、trace ≤100 条；超限**静默丢最旧**并在响应 `dropped` 上报（前端会 toast）。

---

## 5. 提示词登记表（Prompts）专项 —— 技能/提示词的唯一真源

### 5.1 数据与两端的角色

- **core（`agent/src/core/prompts.js`）是登记表的唯一真源**：`DEFAULTS` 是内置默认（全部可见可改），
  用户改动分三处存：
  - `overrides`：`id → {text?, enabled?}`，内置条目的覆盖（如 `system.base`、内置技能 `skill.web_search`）；
  - `skills[]`：**用户/模型建的技能**（`{id,name,description,text,enabled,auto}`；
    `auto:true` = 按需加载，`auto:false` = 常驻注入）；
  - `extra[]`：用户新增的其它条目（`px-` 开头，分到 system/tools/loop/compact）。
- 服务端（`lib/agent/store.js:296-323` + `lib/agent/sanitize.js:111-143`）**只做白名单净化与存档**，
  不解释内容：overrides ≤500 条、skills ≤100 条（正文为空丢弃）、extra ≤200 条。

### 5.2 界面 → 落盘：每一步的函数

```
输入（不生效）
  ImeInput/ImeTextarea onChange
    → setPromptDraft(id, patch)          ui/state/settings.js:238   （只写 state.promptDrafts）
点「应用」
  → applyItem(item, view)                ui/features/settings/PromptsSection.jsx:127
      ├ 自定义技能：setSkillFields(id,{name,description,auto,text})   settings.js:249
      │     → Prompts.updateSkill(id, patch)                       core/prompts.js:566
      └ 其它条目：  applyPromptText(id, text) → Prompts.set(id,text) core/prompts.js:392
  → 两者都会 notify(id)（core/prompts.js:365）
宿主订阅（整个页面生命周期只注册一次，wireCore）
  → Prompts.onChange → Store.queuePrompts(Prompts.serialize())   ui/state/host.js:330
  → promptsWriter 防抖 600ms → POST /agent/store/prompts          core/store.js:19,228
服务端
  → store.putPrompts → sanitize.prompts → 原子写 prompts.json     index.js:158 / store.js:306
托管运行里写入（模型自造技能 / 界面在别处改）
  → run-loop.js:59 读 → :65 Prompts.load → :83 Prompts.onChange(→ putPrompts)，收尾必须退订（:206-208）
```

**要点**：
- 登记表**任何**写入口都会 `notify` → 宿主统一落盘；**不存在"在调用方再手动保存一次"的正路**
  （审计删掉了冗余的 `syncPrompts`，`host.js:222-224` 有注释）。
- 开关（`Switch`）是**立刻生效**的（`setPromptEnabled` / `updateSkill({enabled})`），不走草稿；
  名称/用途/加载方式/正文都走「草稿 → 应用」。
- `dirty` 判定是**逐字段比较**（`draftView`，`PromptsSection.jsx:110`）——草稿改回原样不算"未应用"。

### 5.3 注入（发给模型的那一步）

`core/prompts.js` 的 `all()` → `systemBlocks()`（`:436-447`）：

| 条目 kind | 注入方式 |
|---|---|
| `system` | 正文按组顺序拼进 system 消息 |
| `tool` | 工具使用说明（`工具说明 · <名>`） |
| `skill` 且 `auto:false`（常驻技能） | 按 agentskills.io 规范包成 `<skill name="…" description="…">正文</skill>`（`skillTag`，:451） |
| `skill` 且 `auto:true`（按需技能） | **不注入正文**；只在 system 末尾列清单（`skillIndexBlock`，:462；`- 名字：用途`），模型用 `use_skill` 取正文 |
| `schema` | 只作工具定义里的 description，不单独注入 |
| `helper` | 由代码拼进对应区块（记忆抬头、技能清单抬头…） |
| `template` | 输入框打 `/` 触发，不进系统提示 |

内置技能「联网搜索」= 条目 `skill.web_search`（`group:'skills'`, `kind:'skill'`, `auto:false`, `builtin:true`），
关掉它 = 不注册 `web_search` 工具（`core/agent-defs.js` 按它判定）。

### 5.4 提示词面板的 UI 结构（`PromptsSection.jsx`）

```
顶部：条数徽章 + 「有 N 处未应用的修改」 + 「本轮发送预览」
说明：NoteBox（草稿→应用 的语义）
① 系统区块 ② 技能 ③ 工具说明 ④ 循环内提示 ⑤ 上下文压缩 ⑥ 提示词模板   （PromptGroup 按 GROUP_ORDER 渲染）
   ② 组特有：组尾挂 <AddSkillForm/>（「新建技能」）；展开条目 = 名称/用途/加载方式 + 正文 + 应用/删除
自定义条目：extra[] 列表 + AddEntryForm
```

- **技能的一切增删改都在 ② 组**（2026-10-01 合并）：内置技能可改正文（写 `overrides`）、可停用，
  不可删除；自定义技能可改 名称/用途/加载方式/正文 + 删除（`PromptItem` + `SkillMetaFields` + `AddSkillForm`）。
- 面板里原来的「技能（可增删改）」独立区**已删除**（同一份数据两个编辑器的重复）；界面上不要再加第二个技能编辑器。
- 数据读取：`Prompts.all()`（内置 + extra + 技能，按 `revision` 重算）；`Prompts.skills()` 只剩 core 内部用。

---

## 6. 会话 / 记忆 / 项目 的数据结构

### 6.1 会话（`sessions.json`）

```js
Session = { id, title(≤80), ts, provider, project?, msgs:[Msg], memory?[]（会话记忆）, compaction?{upTo,count,text,ts} }
Msg = { role:'user'|'assistant'|'system'|'tool', content(≤2MB), id?, streaming?, error?,
        thinking?, thinkingSig?, redactedThinking?, stats?, wallMs?,
        toolCalls[{id,name,args}]?, trace[{name,label,ok,note,args,ms,result,kind?,state?,files?}]?,
        injected{summary,text}? }
```

**必须落盘的字段**（删了会坏功能）：`error`（错误块/重试）、`thinkingSig`/`redactedThinking`（Anthropic 回传）、
`trace[].files`（下载卡片）、`session.memory`、`session.compaction`。

### 6.2 记忆（三类）

| 类 | 位置 | 注入方式 |
|---|---|---|
| 全局 | `memory.json`，`{id,title,content,tags[],ts,updated,source:'user'\|'model'}` | 默认只注入索引（可切全文）；抬头文案在登记表 `memory.index.intro` 等 |
| 项目 | `projects/<id>/memory/*.md` + `MEMORY.md` 索引 | 只注入索引；**真源是 Markdown 文件** |
| 会话 | 该会话对象的 `memory[]` | 正文整段注入（通常很短） |

写入通道：前端 `host.js:334-341`（`Memory.onChange` → `queueMemory`/`queueProjectMemory` + `persistSession`）；
服务端托管运行 `run-loop.js:84-85`。项目记忆的取数**只有** `GET /agent/projects/memory?id=` 一条路，
`GET /agent/store` **不带**项目记忆（2026-10-01 归口）。

### 6.3 项目

- 项目 = 一个根目录 + 一份记忆文件夹；id 由根目录推出（同根目录恒定，归档恢复靠这一点）。
- 起点（可选项目的根范围）默认 `/media/leo/DATA/workspace`，可访问目录默认 `/`；
  两者都在 `lib/agent/roots.js`，界面入口在设置 → 权限与工具。
- 会话的 `project` 字段是"当前项目"的事实来源：客户端 `followSessionProject` 用它对齐
  `projects.json.current`（`ui/state/projects.js`），`adoptProject`（`host.js:106`）是唯一换项目的实现。
- **切换顺序不能反**：先 `Store.setProjectId` 再 `Memory.setProject`（注释在 `host.js:94-105`：
  反了会把项目 A 的记忆写进项目 B 的文件夹）。

---

## 7. 常见改动落点表（"我要改 X，动这些文件"）

| 想做的事 | 前端 | core | 服务端 | 还要注意 |
|---|---|---|---|---|
| 加一条**内置提示词**（可改可关） | — | `core/prompts.js` 的 `DEFAULTS` | 不用改（净化是白名单式，不枚举 id） | 组/kind 决定注入位置；`systemBlocks` 认的 kind 见 §5.3 |
| 改某个工具的**说明文案** | — | `core/prompts.js` 对应条目 | — | 工具 schema 描述也是条目（`kind:'schema'`） |
| 加一个**工具** | 设置里给开关？ | `core/agent-defs.js`（定义与注册闸门）+ `core/tool-runner.js`（执行） | `lib/agent/tools/index.js` 分发表 + `tools/*.js` | 三处都要改：定义、执行、服务端实现；权限走 `roots + osaccess + limits` |
| 加一个**端点** | `core/endpoints.js` 的 `EP` + 调用处 | — | `lib/agent/index.js` 路由 + 模块实现 | 请求体上限走 `store.readAgentJson`；登录/presence 已被总入口统一处理 |
| 加一个**设置项** | 设置分区组件 + `ui/state/settings.js` 动作 | `core/params.js`（如果是生成参数） | 若是 provider 字段：`settingsForSave()`（`host.js:133`）**白名单** + `sanitize.js` | 前端白名单漏了 = "界面改了存不下来"（踩过：`sessionHeader`） |
| 改**会话/消息结构** | `ui/state/session.js`、`Message.jsx` | `core/sessions.js`、`core/assemble.js` | `store.js` 的 `sanitizeSession/sanitizeMsg`（白名单） | 新字段要在 sanitize 里放行，否则落盘即丢 |
| 改**技能编辑 UI** | `PromptsSection.jsx`（② 组） | — | — | 只有这一处编辑器；写入口用 `updateSkill`（技能）或 `set`（覆盖） |
| 改**提示词保存链路** | `ui/state/host.js`（Prompts.onChange） | `core/prompts.js`（notify/serialize） | `index.js` store 路由 + `store.putPrompts` + `sanitize.prompts` | 托管运行那条订阅（`run-loop.js:83`）要跟着改，且**必须退订** |
| 改**用量/压缩** | `ContextMeter.jsx`、`ui/state/settings.js` 的 `compactNow/uncompact` | `core/context.js` | — | 压缩提示词在登记表 `compact.*` |
| 改**侧栏/分组** | `Sidebar.jsx`、`ui/state/session.js` | `core/sessions.js` 的 `titleFrom` | — | 会话分组是纯客户端（`settings.ui`） |

构建与交付：

```bash
cd agent
npm run build     # 改了 src/** 必做（产物 public/llm-chat/vendor/agent.js）
npm test          # node --test，198 个用例
npm run lint && npm run lint:budget   # warning 是棘轮：只减不增（当前 79）
npm run dup && npm run cycles         # 重复块 / 模块环
npm run check     # 上述一起跑
# 改了 lib/agent/**：bash down.sh && bash up.sh（只重建不重启 = 新客户端打旧服务端）
```

---

## 8. 已确认的坑（每条都是真踩过的）

1. **`prompts.json` 磁盘上没有 `version`**：`readPrompts` 只在**返回对象**上补 `version:1`
   （`store.js:298-304`），写盘走 `sanitize.prompts` 的 `{overrides,skills,extra}`。
   写"按 version 迁移"的代码永远不会触发。
2. **项目记忆是全量覆盖**：`projects.writeMemoryLocked` 会删掉不在本次 entries 里的 `.md`
   （`projects.js:253-272`）。所以客户端有三道守卫：不给 entries 就别灌（`host.js:105-111`）、
   没有当前项目不发（`core/store.js:224-227`）、建项目要拿服务端真实种子（`ui/state/projects.js`）。
   **空数组 = 清空该项目记忆**。
3. **项目记忆不在 `GET /agent/store` 里**（`index.js:106-119` 明确归口），只有
   `GET /agent/projects/memory?id=` 一条取数路径。
4. **请求体上限有五个入口**，加新端点选错就会 413 或形同虚设：
   `index.js:67-80`（主路由）、`store.readAgentJson`（`store.js:46-50`）、`run-http.js:19`、
   `files.js:264`（64KB）、`search.js:49-77`（手工收流 64KB）。真源常量在 `store.js:38-40`。
5. **单窗口互斥是"账号+IP"**，不是账号全局（`presence.js:44`）；同一账号两台设备可同时活跃。
   被顶窗口所有需登录端点都 409，但**服务端在跑的 run 不受影响**（只有登出/解绑才 abort）。
6. **前端配置保存有白名单**：`settingsForSave()`（`host.js:133-149`）没列出的字段服务端收不到。
7. **`settings.js`（服务端）读路径会补 TOFU 锚点 `keyHost`**，保存时比对；改 baseUrl 不带密钥会 400。
   直接改 `agent.json` 绕不过（读路径也会钉锚点）。
8. **`Memory.load` 内容没变不发 `onChange`**（`core/memory.js:99-105`）：别为了"加载后自动保存"
   改成无条件 emit —— 会触发 `persistSession` 把刚加载的空会话写回去（历史事故）。
9. **托管运行的两条订阅必须退订**（`run-loop.js:206-208`）：`Prompts.onChange`/`Memory.onChange`
   捕获了注册那一刻的账号，不退订会造成**跨账号覆盖写**（2026-10-01 实测复现的 P0）。
10. **`run` 的并发**：一个会话一段、账号 3 段、进程 8 段（`run-registry.js:8-21`）；
    `run-bridge.js` 文件头"同一时刻只允许一个托管运行"的注释**已过时**。
11. **技能/登记表数据在 `prompts.json`，不在 `agent.json`**：改配置保存链路时别把它算进 settings。
12. **界面输入框必须用 `ImeInput/ImeTextarea`**：受控输入框的值回写会取消 Chromium 输入法组合态
    （拼音+汉字叠加、一键出多字母）。新增任何文本框都别直接用 `<input>`。
13. **`agent/src` 改了不 build = 页面行为不符合源码**（页面只引用 `vendor/agent.js`）。

---

## 9. 验证姿势（本项目的"实测"标准）

1. **core/服务端逻辑**：`cd agent && npm test`（198 用例）。新增行为补一条用例，跑得快、能定位。
2. **界面改动**：`npm run build` 后在真实浏览器里走一遍（内置浏览器 / 真实 Chrome + CDP 都行）。
   本项目的历史教训是"测试全绿而真机坏"（桩与生产注入不同），所以**界面改动必须真机点一遍**。
3. **落盘类改动**：改完去 `~/.local/share/wenming-web/agent/<账号>/{prompts.json,sessions.json,...}`
   直接看文件（比看界面可靠）；测试账号用 `tester/123456`，别动 admin 的真实数据。
4. **内置浏览器的已知坑**（验证时的操作要点）：`locator.click()` 不一定投递事件 → 用
   `evaluate` 里的 `element.click()`；Radix 弹层退场动画会卡住（`data-scroll-locked`/`pointer-events:none`
   残留）→ 刷新页面重来，**不要手删 React 拥有的节点**（会整树卸载）；截图可能过期 → 以 DOM 读值为准。
5. **提交前**：`npm run check`（lint + 预算 + 重复块 + 模块环 + 测试）。
