# 智能体 Agent · 构建工程

`public/llm-chat/` 里那三个文件（`index.html` 除外）都是从这里构建出来的。
**改这个子项目的唯一入口就是本目录的 `src/`**——不要在 `public/llm-chat/vendor/` 里改任何东西（下次构建就没了）。

```bash
npm install            # 首次
npm run build          # 产出 ../public/llm-chat/vendor/{agent.js,agent.css}
npm run watch          # 监听 JS 改动（CSS 改动仍需重跑一次 build）
npm test               # node --test：110 个用例
npm run lint           # eslint（显式开 no-undef）
npm run dup            # jscpd：重复代码块
npm run cycles         # madge：模块环
npm run check          # 四件套一起跑
```

审计记录（每一轮改了什么、为什么、怎么验证的）在 [AUDIT.md](./AUDIT.md)。

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

test/                    node --test 用例（119 个）
build.mjs                构建脚本（esbuild + Tailwind CLI）
```

服务端在仓库根的 `lib/agent/`：公共件 `lib/lock.js`（按键串行锁的唯一实现）、
`lib/agent/lock.js` 已并入它；请求体上限的真源是 `lib/agent/store.js` 的 `MAX_BODY_BYTES`
（路由层引用它，不许再写死数字）。

## 六条要记住的约定

1. **core 不认识 React**。core 需要的一切都通过 `init(deps)` 注入（宿主实现在 `src/ui/state/host.js`），
   所以它能在 Node 下单测，换界面时一行不用改（手写 DOM 换成 React 时验证过这一点）。
2. **状态容器用"快照"语义**（`ui/state/store.js`）：`patch()` 就地更新 `state`，但每次 emit 前重建一份浅拷贝
   作为 `getSnapshot()` 的返回值——`useSyncExternalStore` 只在**引用变化**时重渲，
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
