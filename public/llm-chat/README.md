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

一个完整规格的 Agent 客户端：多模型对话 + 工具调用（文件 / 命令 / 联网搜索 / 记忆 / 技能）+
上下文自动压缩 + 全参数可调。服务端在 `lib/agent/`，端点挂在 `/agent/*`。

- **登录**用文档站账号（与文档编辑器同一套校验）；
- **授权**靠绑定一个本机账号：Agent 的文件与命令操作以该账号在系统里的权限为上限；
- **模型协议**只认标准 OpenAI 兼容与 Anthropic 两家（本地模型走 OpenAI 兼容端点）。

细节见仓库根 [`README.md`](../../README.md) 的「智能体 Agent」一节。
