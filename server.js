#!/usr/bin/env node
/**
 * 文明论研究 · 本地文档 Web 服务器（零依赖，Node >= 16）
 *
 * 入口只做三件事：挂安全头 → 按前缀分发（API / Agent / 媒体 / 静态）→ 监听端口。
 * 业务按职责拆分在 lib/ 下（一文件一模块，参照 Node.js CommonJS 规范）：
 *   lib/config.js   全局配置与常量
 *   lib/security.js 路径安全（穿越/符号链接防御）与 HTTP 安全头
 *   lib/state.js    状态文件（权限/会话/上传账本）读写、原子写、迁移
 *   lib/auth.js     认证与会话（scrypt 密码、Cookie、登录限流、审计日志）——**唯一的用户校验**
 *   lib/http.js     HTTP 工具（请求体读取、JSON 响应、错误脱敏）
 *   lib/docs.js     文档树/正文读写与文件管理端点
 *   lib/media.js    媒体识别（魔数）、静态与媒体服务（Range/206）
 *   lib/agent/      智能体 Agent 子项目的服务端（登录沿用文档站账号 + 本机账号绑定），见下
 *   lib/userdata.js  按「文档站账号 × 平台」存平台设置（/api/me/data，密钥只进不出）
 *   lib/packstore.js 剧本包编辑器的包库（含图片二进制）与 AI 会话（/api/pack-editor/*）
 *   lib/llm-proxy.js 剧本编辑器的模型代转（用户级，密钥只在服务端）
 *   lib/api.js      API 路由与登录/会话/权限/上传端点
 *
 * lib/agent/ 的分工（一文件一件事，互不反向依赖）：
 *   session.js   文档站账号 → 绑定的本机账号 → 可执行身份（解锁凭据只在内存）
 *   settings.js  配置（模型/参数/外观/绑定/工具白名单）→ STATE_DIR/userdata/<账号>/agent.json
 *   store.js     大对象（会话/全局记忆/提示词登记表）→ STATE_DIR/agent/<账号>/
 *   roots.js     可访问目录白名单        osaccess.js  绑定账号的 POSIX 权限判定
 *   deny.js      危险命令清单            grants.js    一次性授权票据
 *   upstream.js  标准 OpenAI / Anthropic 代转          search.js 联网搜索
 *   presence.js  单窗口占用              tools/       文件与命令工具
 *
 * 路由：
 *   GET  /                    → 302 重定向到门户首页 /home/（门户自包含在 public/home/）
 *   GET  /home/               → 站点门户首页（未来科技风，子项目导航）
 *   GET  /docs/               → 文档站（md 浏览 + WYSIWYG 编辑，public/docs/）
 *   GET  /pack-editor/        → 剧本包编辑器（public/pack-editor/）
 *   GET  /llm-chat/           → 智能体 Agent（public/llm-chat/，多模型对话 + 工具 + 联网搜索）
 *   /agent/info               → 探针：登录态、本机账号绑定状态、支持的协议（见 lib/agent/index.js）
 *   /agent/presence           → 单窗口占用：登记/查询/让位
 *   /agent/binding/*          → 本机账号的绑定/解绑/解锁/锁定
 *   /agent/store/*            → 配置、会话、记忆、提示词登记表（按文档站账号）
 *   /agent/upstream/*         → 模型代转（密钥在服务端；只认标准 OpenAI / Anthropic 协议）
 *   /agent/tools/*            → 文件与目录、命令行（以绑定账号的权限执行）
 *   /agent/search             → 服务端联网搜索（AnySearch，API Key 不下发前端）
 *   GET  /<静态文件>          → public/ 下的静态资源（目录路径自动补 index.html；
 *                               public 内媒体免登录，文档根媒体仍走鉴权）
 *
 * 子项目自包含约定：home/、docs/、pack-editor/、llm-chat/ 四个目录各自携带自己的 css/js/图片，
 * 内部资源全部用相对路径引用，跨子项目链接也用相对路径（如 docs 里回门户写 ../）。
 * 唯一例外是 /api/*、/files/* 与 /agent/*（宿主的服务契约，本就挂在站点根，不随子项目搬迁）。
 *   GET  /api/tree            → 整个文档文件夹的目录树（镜像磁盘结构，含标题/大小/mtime）
 *   GET  /api/structure       → structure.json（兼容保留：图标/合集元数据）
 *   GET  /api/doc?path=xx.md  → 某文档原始 markdown
 *   GET  /api/raw?path=xx.md  → 纯文本原文
 *   POST /api/save            → {path, content} 写回 md 文件（自动保存用）
 *
 * 安全：路径解析限制在文档根内，禁止目录穿越；读写仅允许 .md。
 */
const http = require('http');
const path = require('path');
const { PORT, HOST, DOC_ROOT, STATE_DIR, MEDIA_EXT } = require('./lib/config');
const { securityHeadersFor } = require('./lib/security');
const { initStateDir } = require('./lib/state');
const { json, serverError } = require('./lib/http');
const { handleApi } = require('./lib/api');
const { handleAgent } = require('./lib/agent');
const { serveMedia, servePublicMedia, serveStatic } = require('./lib/media');

initStateDir();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    for (const [k, v] of Object.entries(securityHeadersFor(url.pathname))) res.setHeader(k, v);
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    // 智能体 Agent 子项目的服务端接入：登录/绑定/存储/模型代转/工具（见 lib/agent/）
    if (url.pathname.startsWith('/agent/')) return await handleAgent(req, url, res);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, url, res);
    // 站点根 → 门户首页（门户自包含在 /home/，此处只做一次重定向）
    if (url.pathname === '/') { res.writeHead(302, { Location: '/home/' }); return res.end(); }
    // 文档根目录文件：站点根路径（assets/x.png）、/docs/ 前缀（文档站页面里相对引用的解析结果，
    // serveMedia 内剥前缀）与 /files/ 前缀均可引用；/files/ 同时承接本地文件链接
    // （媒体内联、白名单文档内联、其余强制下载，均受登录 + scope 管控）
    if (url.pathname.startsWith('/files/')) return await serveMedia(url, res, false, req);
    if (MEDIA_EXT.has(path.extname(url.pathname).toLowerCase())) {
      // public/ 下随站点分发的媒体（首页配图等）免登录；否则走文档根媒体鉴权链
      if (servePublicMedia(url.pathname, res)) return;
      return await serveMedia(url, res, true, req);
    }
    return serveStatic(url.pathname, res);
  } catch (e) {
    // 已知客户端错误（readJson 的 400/413）原样返回；其余走统一脱敏出口
    if (e && (e.status === 400 || e.status === 413)) return json(res, e.status, { error: e.message });
    return serverError(res, e);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  🏛️  文明论研究 · 文档 Web`);
  console.log(`  →  http://${HOST}:${PORT}\n`);
  console.log(`  文档根目录: ${DOC_ROOT}`);
  console.log(`  状态目录: ${STATE_DIR}`);
  console.log(`  停止: Ctrl + C\n`);
});
