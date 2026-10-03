# 智能体 Agent（`/llm-chat/`）

这个目录是**构建产物**，不是源码：

| 文件 | 来源 |
|---|---|
| `index.html` | 手写（很薄：一个 `<div id="app">` + 两个 `<link>/<script>`） |
| `vendor/agent.js` | `agent/src/` 经 esbuild 打包（React 界面 + core 逻辑，含 React/Radix/lucide） |
| `vendor/agent.css` | `agent/src/ui/styles.css` 经 Tailwind CLI 编译（含主题令牌与组件样式） |

**改界面 / 改逻辑请去 [`agent/`](../../agent/README.md)**，然后：

```bash
cd agent && npm install      # 首次
cd agent && npm run build    # 产出本目录的 vendor/
cd agent && npm run check    # eslint + jscpd + madge + 单测
```

## 它是什么

一个完整规格的 Agent 客户端：多模型对话 + 工具调用（文件 / 命令 / 联网搜索 / 记忆 / 技能 / 子智能体）+
上下文自动压缩 + 全参数可调。服务端在 `lib/agent/`，端点挂在 `/agent/*`。

四条设计取舍（与主流 Agent 客户端的最大不同）：

- **提示词全部可见、可改**：凡是发给模型的文本都在提示词登记表里（设置 → 提示词 逐条列出），
  工具 schema 的描述也取自同一张表——界面上改的就是发给模型的那句；改坏可恢复默认；
- **没有 MCP**：不装 MCP server、没有 JSON-RPC 中转，工具是内核直连的内置工具；
- **纯 CLI**：`run_command` 是真的 shell 进程（以绑定系统账号身份运行），联网搜索走本机 AnySearch CLI，
  技能与记忆是磁盘上的 Markdown / JSON；`node standalone.js` 一条命令即可运行；
- **技能模式**：吃 `SKILL.md` 结构，清单只注入名称与用途、正文按需加载（不占上下文），
  可新建 / 改写 / 从 `~/.agents/skills` 等目录导入（先 dryRun 预览）。

- **登录**用文档站账号（与文档编辑器同一套校验）；
- **授权**靠绑定一个本机账号：Agent 的文件与命令操作以该账号在系统里的权限为上限；
- **模型协议**只认标准 OpenAI 兼容与 Anthropic 两家（本地模型走 OpenAI 兼容端点）。

细节见仓库根 [`README.md`](../../README.md) 的「智能体 Agent」一节。
