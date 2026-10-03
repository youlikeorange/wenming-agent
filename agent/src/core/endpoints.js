/* core/endpoints.js —— 与服务端的唯一契约（复用时只改这一处）
 *
 *  Agent 子项目挂在站点根 /agent/* 下（见 lib/agent/index.js）。所有请求都要求**文档站登录**
 *  （与文档编辑器同一套账号，见 lib/auth.js），密钥与模型流量一律经服务端代转，浏览器不接触密钥。
 *
 *  独立运行（无宿主）时把 BASE 改成 '' 并自行提供同名端点；没有服务端时登录、绑定、工具、
 *  服务端存储都不可用，界面会明确提示（不再退回 localStorage——版本 2 起只做"服务端唯一真源"）。
 */
const BASE = '/agent';

export const EP = {
  info: `${BASE}/info`,                    // GET  探针：登录态 / 绑定 / 协议 / 本机默认地址
  presence: `${BASE}/presence`,            // POST 单窗口占用（{cid, claim|leave}）
  store: `${BASE}/store`,                  // GET  一次拉全（settings/sessions/memory/prompts）
  settings: `${BASE}/store/settings`,      // POST 保存配置
  sessions: `${BASE}/store/sessions`,      // POST 新增/覆盖会话（单条或批量）
  sessionDelete: `${BASE}/store/session/delete`,
  memory: `${BASE}/store/memory`,          // POST 全局记忆整体覆盖
  prompts: `${BASE}/store/prompts`,        // POST 提示词登记表整体覆盖
  /* 项目（根目录 + 项目记忆文件夹）：项目记忆真源是服务端账号目录里的 Markdown 文件 */
  projects: `${BASE}/projects`,            // 基址（browse/memory 用 GET，动作走下面几条）
  projectsBrowse: `${BASE}/projects/browse`,   // GET  ?path=  列子目录（从"起点"开始，只能在起点内往下走）
  projectsMemory: `${BASE}/projects/memory`,   // GET  ?id= / POST { id, entries }
  projectCreate: `${BASE}/projects/create`,    // POST { root, name }
  projectRename: `${BASE}/projects/rename`,    // POST { id, name }
  projectCurrent: `${BASE}/projects/current`,  // POST { id }
  projectDelete: `${BASE}/projects/delete`,    // POST { id }（连记忆文件夹一起删，不可恢复）
  projectArchive: `${BASE}/projects/archive`,  // POST { id }（连它下面的会话一起归档，可恢复）
  /* 归档（存档）：侧栏的"归档"按钮与设置 → 存档 */
  archive: `${BASE}/archive`,              // GET  归档清单 { sessions, projects }
  archiveRestore: `${BASE}/archive/restore`,   // POST { kind:'session'|'project', id }
  archiveDelete: `${BASE}/archive/delete`,     // POST { kind, id }（彻底删除，不可恢复）
  sessionArchive: `${BASE}/store/session/archive`,  // POST { id }
  toolsStart: `${BASE}/tools/roots`,       // POST { action:'start', path }（项目起点，与可访问目录同一个端点）
  binding: `${BASE}/binding`,              // GET  绑定状态
  bind: `${BASE}/binding/bind`,            // POST { osUser, password }
  unbind: `${BASE}/binding/unbind`,        // POST
  unlock: `${BASE}/binding/unlock`,        // POST { password }
  lock: `${BASE}/binding/lock`,            // POST（丢掉内存里的解锁凭据）
  chat: `${BASE}/upstream/chat`,           // POST { provider|type,baseUrl,apiKey, body }
  models: `${BASE}/upstream/models`,       // POST { provider | type,baseUrl,apiKey }
  search: `${BASE}/search`,                // POST { query, max_results }
  skillsImport: `${BASE}/skills/import`,   // POST { path, auto?, dryRun? } 从 Markdown（SKILL.md）安装技能
  toolsStatus: `${BASE}/tools/status`,     // GET
  toolsRoots: `${BASE}/tools/roots`,       // POST { action, path|roots }
  toolsDenyCheck: `${BASE}/tools/deny-check`,  // POST { command }
  toolsCall: `${BASE}/tools/call`,         // POST { name, args, limits, grant }
  /* 托管运行：Agent 循环跑在服务端（关掉浏览器也不中断），界面只是观众。
     这些端点与其它 /agent/* 同一套登录与单窗口规则，但**运行本体不受窗口影响**。 */
  runStart: `${BASE}/run/start`,           // POST { sessionId, text, providerId?, history? } → { runId }
  runEvents: `${BASE}/run/events`,         // GET  ?id= → SSE（先回放，再续播）——单段运行用（诊断/兼容）
  runState: `${BASE}/run/state`,           // GET  ?sessionId= → { run|null, runs:[…] }
  runStop: `${BASE}/run/stop`,             // POST { id }
  runSteer: `${BASE}/run/steer`,           // POST { id, text }（生成中插话）
  runConfirm: `${BASE}/run/confirm`,       // POST { id, confirmId, ok, remember }
  runUndo: `${BASE}/run/undo`,             // POST { id: runId, sessionId?, paths? } → 撤销（缺 paths = 整轮；
                                           //        给了 paths 只恢复这几个文件 = "仅恢复这一个"）
  runUndoDiff: `${BASE}/run/undo/diff`,    // POST { id: runId, path, entry?, sessionId? } → 两侧内容（比对抽屉）
  todo: `${BASE}/todo`,                    // GET  ?sessionId= → { todo|null }（agent 用 todo_write 写它）
  runHub: `${BASE}/run/hub`,               // GET  → SSE：**本账号全部运行**的事件（统一口，前端只连这一条）
  /* 待下载目录（传输文件插件）：每个账号一个目录，界面菜单与会话卡片都从这里取 */
  files: `${BASE}/files`,                  // GET  → { dir, entries:[{name,size,mtime,exec,packaged,downloadName}] }
  filesDownload: `${BASE}/files/download`, // GET  ?name= → 文件字节（可执行文件自动改发 zip）
  filesDelete: `${BASE}/files/delete`,     // POST { name }
  runSubagent: `${BASE}/run/subagent`,     // GET  ?id=<runId>&sub=<subId> → 子智能体的完整转录
  // 文档站账号（登录/登出/会话）复用宿主既有端点，与文档编辑器同源
  login: '/api/login',
  logout: '/api/logout',
  session: '/api/session',
};

/** 单窗口互斥用的请求头（服务端按它识别"哪个窗口"） */
export const CLIENT_HEADER = 'X-Agent-Client';
/** 服务端标记：这个 401 是"要登录"，不是上游模型报错 */
export const AUTH_HEADER = 'x-agent-auth';
export const PROXY_HEADER = 'x-agent-proxy';
export const LOCK_HEADER = 'x-agent-client-lock';
