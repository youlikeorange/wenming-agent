<div align="center">

# 智能体 Agent

**一个能读写文件、执行命令、记住项目的智能体客户端，和一个让它关掉浏览器也能跑完的服务端。**

零框架内核 · React 界面 · 标准 OpenAI / Anthropic 协议 · 服务端托管运行 · **下载即可运行**

![Node](https://img.shields.io/badge/Node-%E2%89%A5%2020-339933?logo=nodedotjs&logoColor=white)
![tests](https://img.shields.io/badge/tests-198%20passing-brightgreen)
![build](https://img.shields.io/badge/build-esbuild%20%C2%B7%20Tailwind%20v4-4b32c3)
![protocol](https://img.shields.io/badge/protocol-OpenAI%20%7C%20Anthropic-1f6feb)
![runtime](https://img.shields.io/badge/core-zero--framework-orange)
![standalone](https://img.shields.io/badge/standalone-node%20standalone.js-2ea44f)

</div>

---

> **下载即可运行**：`git clone` 之后 `node standalone.js`，打开终端里打印的地址就能用
> （界面产物已随仓库提供，服务端零 npm 依赖、不用 `npm install`）。见 [快速开始](#快速开始)。

## 这是什么

从自用的文档站里抽出来的智能体子项目：浏览器里一个完整的对话界面，服务端一套
`/agent/*` 能力。模型走**标准 OpenAI / Anthropic 协议**（自建网关、官方 API、中转站都能接），
密钥只存在服务端，不下发前端。

- **双层运行**：可以在浏览器里跑本地循环，也可以交给服务端跑——**托管运行时关掉标签页、断网、换窗口都不中断**，回来接着看。
- **工具与权限**：文件读写、命令执行、联网搜索；访问级别 + 危险命令闸门（「总是允许」清单）+ 可访问目录白名单。
- **记忆三层**：全局记忆 / 项目记忆（服务端 Markdown 文件夹）/ 会话记忆，另有自动压缩与用量统计。
- **技能**：吃主流 `SKILL.md` 结构，可预览（dryRun）后再安装。
- **工程态度**：内核零框架、可在 Node 下直接单测；状态容器快照语义；198 个用例 + lint / 重复代码 / 模块环三道静态检查，全部离线可跑。
- **两种宿主**：可以挂进自带文档站的宿主（`server.js`，仓库里留档），也可以**单独跑**——
  仓库自带 `standalone.js` 这一份最小宿主（静态服务 + 登录 + `/agent/*`），clone 下来就能起来。

## 架构

```mermaid
flowchart LR
  subgraph B["浏览器"]
    UI["React 界面<br/>agent/src/ui"]
    Core["零框架内核<br/>agent/src/core"]
  end
  subgraph S["服务端 · lib/agent（/agent/*）"]
    Router["路由 · 身份 · 单窗口互斥"]
    Run["托管运行<br/>run-*"]
    Store["会话 · 记忆 · 项目 · 技能"]
    Tools["工具执行<br/>tools/*"]
  end
  Model["上游模型<br/>OpenAI / Anthropic 兼容"]
  UI --> Router
  Core --> Router
  Router --> Run
  Router --> Store
  Run --> Tools
  Run --> Model
  Model -.->|SSE 事件流| UI
```

一轮对话的两种跑法：**本地循环**（`core/agent.js` 在浏览器里跑，请求经 `/agent/upstream/*` 代转）
与**托管运行**（`POST /agent/run/start` 起在服务端，界面订阅 SSE）。两者共用同一份内核代码。
模块清单与调用流程见 [`agent/ARCHITECTURE.md`](agent/ARCHITECTURE.md)。

| 层 | 位置 | 说明 |
| --- | --- | --- |
| 内核 | `agent/src/core/` | 循环 / 工具分发 / 协议适配 / 上下文压缩 / 记忆 / 策略。不认识 React，依赖全部注入 |
| 界面 | `agent/src/ui/` | React 19 + Tailwind v4 + shadcn 风格组件；快照式状态订阅 |
| 服务端 | `lib/agent/` | `/agent/*`：探针 · 存储 · 上游代转 · 托管运行 · 工具 · 技能 · 项目 · 归档 · 搜索 |

## 目录结构

```
standalone.js         ★ 独立运行入口：不需要宿主站点，node standalone.js 直接起服务
agent/               界面构建工程（改这个子项目的唯一入口）
  src/core/            零框架内核（可在 Node 下单测）
  src/ui/              React 界面：state / features / components
  test/                node --test 用例（当前 198 个）
  build.mjs            esbuild + Tailwind CLI 构建脚本
  README.md            工程说明 + 开发约定（改代码前先读）
  ARCHITECTURE.md      模块清单 · 调用流程 · 必须守住的不变量
lib/agent/           服务端（/agent/* 的实现）
public/llm-chat/     页面壳 index.html + 构建产物 vendor/（★ vendor 入库，见下）
server.js            宿主站点入口（留档）：/agent/* 怎么挂上来的
lib/*.js             宿主依赖留档（standalone.js 也直接用它们，见 HOST-DEPS.md）
tools/users.js       ★ 账号管理（独立运行用）：list / add / passwd
tools/sync.sh        站点 → 仓库：同步 + 提交 + 推送
tools/restore.sh     仓库 → 站点：回滚（自动备份 + 重建 + 提示重启）
tools/paths.conf     上面两个脚本共用的路径清单
```

> `public/llm-chat/vendor/`（界面构建产物，约 850KB）**随仓库分发**：没有它，下载者必须先
> `npm install && npm run build` 才能看到界面。它由 `agent/src` 构建得出，`tools/sync.sh`
> 会随站点一起刷新；只想改后端 / 跑服务端的人可以完全不碰 `agent/`。

## 快速开始

要求：**Node ≥ 20**（界面产物已随仓库提供，不用 `npm install`）。

### 一、直接跑起来（推荐先走这条）

```bash
git clone https://github.com/youlikeorange/wenming-agent.git
cd wenming-agent
node standalone.js
```

终端会打印地址与**首次自动创建的管理员密码**（只显示这一次）：

```
  界面      http://127.0.0.1:4174/llm-chat/
  数据      ~/.local/share/wenming-agent
  管理员    admin / xxxxxxxxxxxxx
```

浏览器打开该地址 → 右上角登录（用上面打印的账号）→ **设置 → 模型** 里填一个服务商
（OpenAI / Anthropic 协议都行，密钥只存服务端、不下发浏览器）→ 开始对话。

```bash
node standalone.js --port 8080 --host 0.0.0.0    # 换端口 / 供局域网访问
node standalone.js --state-dir ./data            # 数据放到指定目录
node tools/users.js list                         # 账号管理
node tools/users.js add someone hunter2 --admin  # 建账号（省略密码则随机生成）
node tools/users.js passwd admin                 # 改密码
```

独立运行说明：
- **数据目录**默认 `~/.local/share/wenming-agent`（`STATE_DIR` 可覆盖）。账号、会话、记忆、
  技能、模型密钥全在这里，格式与挂到文档站时完全一致。
- **单用户开箱即用**：首次启动建一个 `admin`；没有注册页，加人用 `tools/users.js`。
- 受 SECURITY 约束的端口默认只监听 `127.0.0.1`；要给别人用请自行加反代 / TLS（`--host 0.0.0.0`
  会把「用绑定账号执行命令」的能力暴露给能访问该端口的人）。
- 文件与命令工具的权限 = **你在「设置 → 本机账号」里绑定的那个系统账号的权限**（绑定用 `su`
  验一次密码，密码不落盘）；不绑定也能用，只是没有文件与命令工具。
- 联网搜索需要一个 AnySearch CLI（`ANYSEARCH_CLI` 指定脚本路径），没装则该工具报错，其余功能不受影响。

### 二、参与开发（构建界面 + 跑测试）

```bash
cd agent
npm install          # 首次
npm run build        # 产出 ../public/llm-chat/vendor/{agent.js,agent.css}
npm test             # node --test：内核 / 协议 / 工具闸门 / 参数 / 状态编排（198 个）
npm run lint         # eslint（显式开 no-undef，warning 有只减不增的预算）
npm run dup          # jscpd：重复代码块（有预算上限）
npm run cycles       # madge：模块环（必须为 0）
npm run check        # 上面几件一起跑
```

> 想把这套挂回自带的文档站（含文档/媒体/剧本编辑器），用仓库根的 `server.js` —— 那需要
> 仓库外的宿主模块（`lib/docs.js`、`lib/media.js`、`lib/api.js` 等），本仓库只有留档。
> 独立运行不需要它们，入口就是 `standalone.js`。

## 部署

### 独立部署（standalone.js）

```bash
# 前台跑
node standalone.js --host 0.0.0.0 --port 4174

# 后台跑（nohup；日志自己收）
nohup node standalone.js --host 0.0.0.0 --port 4174 > agent-standalone.log 2>&1 &
```

### 挂到宿主站点

```bash
# 界面：产物落到站点的 public/llm-chat/vendor/，刷新页面即生效
cd agent && npm run build

# 服务端：lib/agent/* 的改动必须重启站点才生效
cd .. && ./down.sh && ./up.sh
```

> 两种入口共用同一份数据格式，但**别让两个进程同时写同一个 `STATE_DIR`**：串行锁
> （`lib/lock.js`）与单窗口互斥（`lib/agent/presence.js`）都在进程内存里，跨进程互相看不见。

## 版本管理与回滚

这个仓库的存在理由：**改了出问题，一条命令退回去**。

```bash
# 站点代码 → 本仓库（同步 + 提交 + 推送；--check 只看差异）
./tools/sync.sh -m "修复 xxx"
./tools/sync.sh --check

# 留一个可回滚的版本点
git tag -a v2.0.1 -m "稳定版：xxx" && git push origin main --follow-tags

# 回滚：备份现状 → 覆盖 → 重建界面 → 提示重启
./tools/restore.sh --dry-run v2.0.0     # 先看它准备做什么
./tools/restore.sh v2.0.0
```

两个脚本都从 `tools/paths.conf` 读路径清单，站点根目录按 `-s` > `SITE_ROOT` > `tools/site.conf`
（本机配置，不入库）的顺序取。`restore.sh` 的安全设计：覆盖前把站点现状打包到
`../wenming-agent-backups/`、打印「站点与目标版本的差异」防止误回滚、默认不动宿主公共件、
回滚后自动重建界面产物。

## 数据边界：仓库里没有什么

用户数据与模型密钥**不在本仓库任何路径下**——它们由进程运行时写在宿主机的 `STATE_DIR`：

| 部署方式 | `STATE_DIR` 默认值 |
| --- | --- |
| 独立运行（`standalone.js`） | `~/.local/share/wenming-agent` |
| 挂到文档站 | `~/.local/share/wenming-web`（站点与其它子项目共用） |

目录内的结构（权限 0600）：

| 位置 | 内容 |
| --- | --- |
| `permissions.json` | 账号（scrypt 口令散列）与登录会话 |
| `userdata/<账号>/agent.json` | 模型配置（含 API 密钥）/ 参数 / 外观 / 账号绑定 / 可访问目录 |
| `agent/<账号>/sessions.json` | 会话（含会话记忆与压缩摘要） |
| `agent/<账号>/memory.json`、`prompts.json` | 全局记忆、提示词登记表与技能 |
| `agent/<账号>/projects/<id>/`、`archive/`、`downloads/` | 项目元信息与项目记忆 Markdown、归档、待下载 |

同样不入库的还有：`node_modules`、内部审计记录（工程文档里提到的 `AUDIT*.md` 是内部资料，
只留本机）、每台机器自己的 `tools/site.conf`。构建产物 `public/llm-chat/vendor/` 则**入库**
（下载即可运行的前提，见「目录结构」）。

## 宿主依赖

`lib/agent/` 依赖站点公共件：`lib/auth.js`（登录）、`lib/config.js`、`lib/http.js`、`lib/lock.js`、
`lib/security.js`（路径安全与安全响应头）、`lib/state.js`、`lib/upstream-http.js`、`lib/userdata.js`、
`lib/zip.js`（可执行文件打包），以及 `server.js` 里对 `/agent/*` 的挂载。它们按真实相对路径同步在
仓库里——**`standalone.js` 与仓库里的服务端测试都直接 require 它们**；`restore.sh` 默认**不写回**
站点，因为它们是站点公共件，其他子项目也在用。清单与原因见 [`HOST-DEPS.md`](HOST-DEPS.md)。

## 开发约定

- [`agent/README.md`](agent/README.md)：要记住的约定，每条都对应一次真实故障
  （内核不认识 React、状态快照语义、输入框必须走 IME 组件、适配器第 4 参数是 opts……）。
- [`agent/ARCHITECTURE.md`](agent/ARCHITECTURE.md)：模块清单与调用流程，§8 是回归清单。
- [`CHANGELOG.md`](CHANGELOG.md)：版本要点。

## 说明

- 仓库未附许可证：代码公开可见，但保留所有权利；要复用请先开 issue 聊。
- 版本号与 `agent/package.json` 的 `version` 对齐，tag 打在对应快照的提交上（当前 `v2.1.0`）。
