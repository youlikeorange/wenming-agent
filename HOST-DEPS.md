# 宿主依赖（`lib/*.js`、`server.js`）—— 为什么它们在仓库里，回滚却不带它们

`lib/agent/` 不可能单独跑起来，它依赖宿主站点的公共件。为了两件事，这些文件也被同步进了
本仓库（**放在真实相对路径上**）：

1. **仓库里能直接跑测试**：`agent/test/server-store.test.mjs` 等用例通过 `../../lib/agent/*`
   引服务端模块，服务端再引 `../userdata`、`../lock` 等 —— 宿主依赖不在原位，测试就没法跑。
2. **留档**：出问题时能回答「那一刻线上跑的是哪一版 `lib/http.js`」。

| 文件 | 智能体为什么需要它 |
| --- | --- |
| `server.js` | 站点进程入口，把 `/agent/*` 挂到 `lib/agent/index.js`（还有登录态、配额等宿主能力） |
| `lib/config.js` | 站点根目录 / 状态目录 / 端口等配置（`STATE_DIR` 在这里定） |
| `lib/http.js` | HTTP 基座（请求体读取、单窗口互斥用的客户端标识头） |
| `lib/auth.js` | 文档站账号登录与权限（`permissions.json` 的 ACL 判定） |
| `lib/state.js` | `STATE_DIR` 下的原子写与小文件存储 |
| `lib/lock.js` | 按键串行锁的唯一实现（会话/项目/配额读写都靠它） |
| `lib/upstream-http.js` | 上游模型请求的传输层（代理、超时、流式） |
| `lib/userdata.js` | 按「文档站账号」存配置（模型密钥只进不出） |

**但它们不参与回滚**（`tools/restore.sh` 默认跳过，要一起回滚才加 `--with-host-deps`）：
这些是宿主公共件，文档站其他子项目（编辑器、剧本编辑器）也在用，为了让智能体回到旧版
而顺手把别人也回退，代价可能更大。要一起回滚时，先想清楚这一点。

另外：这里**没有** `permissions.json`、`state/`、`userdata/` 之类的东西 —— 账号、口令散列、
用户数据、模型密钥全在 `STATE_DIR`（默认 `~/.local/share/wenming-web`），永远不入库。
