# 宿主依赖（`lib/*.js`、`server.js`）—— 为什么它们在仓库里，回滚却不带它们

`lib/agent/` 不可能单独跑起来，它依赖宿主站点的公共件。为了三件事，这些文件也被同步进了
本仓库（**放在真实相对路径上**）：

1. **独立运行**：仓库根的 `standalone.js`（最小宿主）直接 require 它们，于是 clone 下来就能
   `node standalone.js` 起服务，不必先搭一个文档站。
2. **仓库里能直接跑测试**：`agent/test/server-store.test.mjs` 等用例通过 `../../lib/agent/*`
   引服务端模块，服务端再引 `../userdata`、`../lock` 等 —— 宿主依赖不在原位，测试就没法跑。
3. **留档**：出问题时能回答「那一刻线上跑的是哪一版 `lib/http.js`」。

| 文件 | 智能体为什么需要它 |
| --- | --- |
| `server.js` | 宿主站点入口，把 `/agent/*` 挂到 `lib/agent/index.js`（还有登录态、配额等宿主能力）；独立运行时的对应物是 `standalone.js` |
| `lib/config.js` | 站点根目录 / 状态目录 / 端口等配置（`STATE_DIR` 在这里定） |
| `lib/http.js` | HTTP 基座（请求体读取、单窗口互斥用的客户端标识头） |
| `lib/auth.js` | 账号登录与权限（scrypt 口令、Cookie 会话、登录限流、审计日志） |
| `lib/state.js` | `STATE_DIR` 下的原子写与小文件存储（`permissions.json` / 会话 / 配额） |
| `lib/lock.js` | 按键串行锁的唯一实现（会话/项目/配额读写都靠它） |
| `lib/security.js` | 路径安全（穿越 / 符号链接）与安全响应头 —— `standalone.js` 的静态服务用它 |
| `lib/upstream-http.js` | 上游模型请求的传输层（代理、超时、流式） |
| `lib/userdata.js` | 按「账号」存配置（模型密钥只进不出） |
| `lib/zip.js` | 零依赖 ZIP（待下载目录里的可执行文件强制打包成 zip） |

**但它们不参与回滚**（`tools/restore.sh` 默认跳过，要一起回滚才加 `--with-host-deps`）：
这些是宿主公共件，文档站其他子项目（编辑器、剧本编辑器）也在用，为了让智能体回到旧版
而顺手把别人也回退，代价可能更大。要一起回滚时，先想清楚这一点。

另外：这里**没有** `permissions.json`、`userdata/`、`agent/<账号>/` 之类的东西 —— 账号、口令散列、
用户数据、模型密钥全在 `STATE_DIR`（独立运行默认 `~/.local/share/wenming-agent`；挂到文档站时是
`~/.local/share/wenming-web`），永远不入库。独立运行时首次启动会自动创建管理员账号
（见 `standalone.js`），加人 / 改密用 `tools/users.js`。
