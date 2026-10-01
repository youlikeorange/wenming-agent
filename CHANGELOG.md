# 更新记录

只记「一个版本相对上一个版本有什么变化」的要点。模块调用流程见
[`agent/ARCHITECTURE.md`](agent/ARCHITECTURE.md)；逐轮的内部审计记录（每轮发现什么、怎么修、
怎么验证）属于内部资料，不随本仓库公开。

版本号对齐 `agent/package.json` 的 `version`；tag 打在对应快照的提交上。

## v2.1.0 — 2026-10-01（下载即可运行）

**新增：独立运行**（这一版的头号变化）。此前仓库是「源码快照 + 回滚工具」，clone 下来跑不起
服务（宿主的 `server.js` 依赖仓库外的 `lib/api.js`、`lib/media.js` 等）。现在：

- `standalone.js` —— 最小宿主入口：静态服务（`/llm-chat/`）+ 登录三端点
  （`/api/login|logout|session`）+ `/agent/*` 交给 `lib/agent/index.js` 的 `handleAgent`。
  零 npm 依赖，`node standalone.js` 即起（默认 `127.0.0.1:4174`）。
- **界面产物入库**：`public/llm-chat/vendor/{agent.js,agent.css}` 随仓库分发，下载者不必
  `npm install && npm run build`；`tools/sync.sh` / `drift.sh` / `restore.sh` 三处不再排除它。
- **首次启动自动建管理员**并把随机密码打印一次（`AGENT_ADMIN_PASSWORD` 可指定）；
  账号管理 `tools/users.js list | add | passwd`（scrypt 存储格式与文档站互认）。
- 数据目录独立：默认 `~/.local/share/wenming-agent`（`STATE_DIR` 可覆盖），与文档站那份互不干扰；
  两种入口共用同一数据格式，但**不要两个进程同时写同一个目录**（串行锁与单窗口互斥都在进程内存里）。
- 补入宿主公共件 `lib/security.js`（路径安全 + 安全响应头）与 `lib/zip.js`（可执行文件打包），
  独立入口与服务端测试都直接 require 它们；`HOST-DEPS.md` 与 README 相应更新。

同步进来的站点代码（v2.0.0 之后积累的改动）：

- **提示词面板**：技能的两处编辑器合并为 ② 技能组一处（展开条目改名称/用途/加载方式/正文，
  组尾「新建技能」），草稿改为补丁对象、逐字段判「未应用」；内置技能改正文写覆盖表、可恢复默认。
- **待下载目录**（`lib/agent/files.js` + `deliver_file` 工具）：每个账号一个目录，
  可执行文件强制打包 zip，顶栏菜单与会话卡片两处入口。
- **多会话并行 + 子智能体**：一条会话一段运行、账号 3 段 / 进程 8 段；`/agent/run/hub`
  一条 SSE 看全部；`spawn_agent` 子智能体（默认只读、独立预算、转录可查）。
- **模块地图文档** `agent/docs/MODULE-MAP.md`：端点 / 数据 / 改动落点与踩坑清单（查字典用）。
- 测试 170 → **198** 个用例。

## v2.0.0 — 2026-10-01（首个公开快照）

内容是此刻线上跑的那一版：

- **三层结构定型**：`agent/src/core`（零框架：循环 / 工具 / 协议 / 上下文 / 记忆，可在 Node 下单测）、
  `agent/src/ui`（React 界面）、`lib/agent`（`/agent/*` 服务端能力）。
- **托管运行**：一轮对话由服务端跑完（`/agent/run/*`，SSE 观看），关掉浏览器、换窗口都不中断，
  结果照常落盘；`/events`、`/confirm`、`/state` 一律按账号归属校验，跨账号拿不到别人的运行，
  也批准不了别人的危险命令。
- **项目与项目记忆**：项目 = 一个根目录，项目记忆 = 服务端账号目录里的 Markdown 文件夹
  （每条一个 `.md` + `MEMORY.md`），会话归属项目、侧栏按项目/时间分组；会话与项目都可归档恢复。
- **协议适配**：标准 OpenAI / Anthropic 两套；SSE 分帧、`<think>` 拆分、
  **正文型工具调用认回**（把写成正文的调用标记解析成真正的调用）。
- **工具与权限**：文件与命令工具、访问级别（ACL）、危险命令闸门与「总是允许」清单、可访问目录；
  技能从 `SKILL.md` 安装（可 dryRun 预览）、服务端联网搜索。
- **界面**：侧栏 / 顶栏 / 对话区 / 输入区 / 追踪条 / 设置抽屉十个分区；所有自由输入框走 IME 非受控组件
  （受控写回会取消中文输入法组合态）；生成中不抢滚动、浮动回到最新按钮。
- **工程约束**：170 个 `node --test` 用例 + eslint（显式 no-undef）+ jscpd 重复检查 + madge 模块环检查。

> 注：服务端代码的改动要重启站点（`down.sh && up.sh`）才生效。
