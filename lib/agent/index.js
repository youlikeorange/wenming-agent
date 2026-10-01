/** lib/agent/index.js —— Agent 子项目（/agent/*）的服务端路由总入口
 *
 *  一块子系统的边界都在这里：文档站登录 → 单窗口互斥 → 分派到各模块。
 *  模块划分（每个文件一件事，互不反向依赖）：
 *    session.js   文档站账号 → 绑定的本机账号 → 可执行身份（含解锁凭据，只在内存）
 *    settings.js  配置（模型/参数/外观/绑定/工具白名单）→ userdata/<账号>/agent.json
 *    store.js     大对象（会话/全局记忆/提示词登记表）→ STATE_DIR/agent/<账号>/
 *    projects.js  项目（根目录 + 项目记忆文件夹：每条记忆一个 .md）
 *    archive.js   归档（会话与项目搬进 archive/，可恢复；界面上侧栏的"归档"按钮）
 *    roots.js     可访问目录白名单      osaccess.js  绑定账号的 POSIX 权限判定
 *    deny.js      危险命令清单          grants.js    一次性授权票据
 *    upstream.js  标准 OpenAI / Anthropic 代转        search.js  联网搜索
 *    presence.js  单窗口占用            tools/*      文件与命令工具
 *
 *  路由表：
 *    GET  /agent/info                 探针（未登录也回；被顶掉的窗口也要能刷新提示）
 *    POST /agent/presence             单窗口占用登记/查询/让位
 *    GET  /agent/store                一次拉全（配置 + 会话 + 记忆 + 提示词 + 项目）
 *    POST /agent/store/settings       保存配置（密钥缺省保持不变）
 *    POST /agent/store/sessions       新增/覆盖会话（单条或批量）
 *    POST /agent/store/session/delete 删除单个会话
 *    POST /agent/store/memory         全局记忆整体覆盖
 *    POST /agent/store/prompts        提示词登记表整体覆盖
 *    POST /agent/store/session/archive 归档一个会话（删除按钮现在是归档，见 archive.js）
 *    GET  /agent/projects/browse      列子目录（选项目根目录用，只能在"起点"内往下走）
 *    GET  /agent/projects/memory      某个项目的记忆
 *    POST /agent/projects/create|rename|current|delete|archive|memory   项目增删改、归档、记忆覆盖
 *    GET  /agent/archive              归档清单（会话 + 项目）
 *    POST /agent/archive/restore|delete  恢复 / 彻底删除
 *    GET  /agent/binding              绑定状态（含是否已解锁）
 *    POST /agent/binding/bind|unbind|unlock|lock
 *    POST /agent/upstream/chat|models 模型代转
 *    POST /agent/search               联网搜索
 *    POST /agent/skills/import        从 Markdown（SKILL.md）安装技能（dryRun 预览 / 落盘）
 *    *    /agent/tools/*              工具（见 tools/index.js）
 */
const { json, readJson } = require('../http');
const { authUser, auditLog } = require('../auth');
const session = require('./session');
const settings = require('./settings');
const store = require('./store');
const presence = require('./presence');
const upstream = require('./upstream');
const search = require('./search');
const projects = require('./projects');
const archive = require('./archive');
const tools = require('./tools');
const runHttp = require('./run-http');

/** 未登录的统一出口：带上标记，前端据此区分"要登录"与"上游报错" */
function needLogin(res, what) {
  res.setHeader('X-Agent-Auth', 'need-login');
  return json(res, 401, { ok: false, needLogin: true, error: `需要登录：${what}` });
}

/** 请求体上限的默认值（小请求：绑定、工具、归档、技能安装） */
const DEFAULT_BODY_BYTES = 4 * 1024 * 1024;

/** 路由 → 请求体上限。**上限的真源在 lib/agent/store.js**（它由配额与每条上限推导出来），
 *  这里只做映射，不许再写死数字——审计发现这里曾一律用 4MB，而会话配额是 32MB，
 *  于是超过 4MB 的会话永远 413（配额成了空头承诺，lib/http.js 的注释警告过这个坑）。
 *  导出只为让回归测试盯住这条映射。 */
function bodyLimitFor(pathname) {
  return (pathname.startsWith('/agent/store') || pathname.startsWith('/agent/projects')
    || pathname.startsWith('/agent/run'))       // 托管运行的 start 要带上整份历史，与会话同级
    ? store.MAX_BODY_BYTES
    : DEFAULT_BODY_BYTES;
}

/** 读 JSON 体（失败回 400，别让它冒到统一出口变成 500） */
async function body(req, res, url) {
  try { return await readJson(req, bodyLimitFor(url.pathname)); } catch (e) {
    json(res, e.status || 400, { ok: false, error: e.status === 413 ? '请求体过大' : 'invalid json' });
    return null;
  }
}

/** 探针：页面启动就要问它拿登录态与绑定状态 */
function infoPayload(session_) {
  const account = session_ ? session_.username : '';
  return {
    ok: true,
    loggedIn: !!session_,
    user: session_ ? { username: account, displayName: session_.displayName || account, admin: !!session_.admin } : null,
    binding: account ? session.bindingView(account) : null,
    protocols: upstream.PROTOCOLS,
    presence: { enforce: presence.ENABLED, staleMs: presence.STALE_MS },
    unlockTtlMs: session.UNLOCK_TTL_MS,
    siteUser: session.SITE_USER,
  };
}

/* ============================ 存储端点 ============================ */

async function handleStore(req, url, res, account) {
  const tail = url.pathname.slice('/agent/store'.length);
  const isWrite = req.method === 'POST';

  if (req.method === 'GET' && (tail === '' || tail === '/')) {
    const p = store.readPrompts(account);
    const pj = projects.list(account);
    /* ?light=1 = 只要"面板数据"（记忆/提示词/项目清单），**不带会话**。
       托管运行在服务端跑完一轮、或模型写了记忆之后，界面要刷新面板；
       整份 store（含全部会话）每次拉一遍没必要，生成中拉回来还会把正在流式写入的消息对象换掉。
       **项目记忆不在这份响应里**（2026-10-01 归口）：它的唯一取数路径是
       GET /agent/projects/memory?id= —— 项目是"跟着当前会话走"的，而这份响应只知道
       projects.json 的 current 指针，两处各带一份记忆正是"当前项目与会话对不上"的土壤。 */
    const light = url.searchParams.get('light') === '1';
    return json(res, 200, {
      ok: true,
      light,
      settings: light ? undefined : settings.publicSettings(account),
      sessions: light ? undefined : store.readSessions(account).sessions,
      memory: store.readMemory(account).entries,
      prompts: { overrides: p.overrides, skills: p.skills, extra: p.extra },
      // 项目：清单 + 当前项目指针（记忆本身走 /agent/projects/memory）
      projects: pj.projects,
      currentProject: pj.current,
      meta: { account, binding: session.bindingView(account) },
    });
  }
  if (!isWrite) return json(res, 405, { ok: false, error: 'method not allowed' });

  const b = await body(req, res, url);
  if (b === null) return;                  // body() 已经回过错误了

  if (tail === '/settings') {
    const out = await settings.save(account, b.settings || b);
    return json(res, 200, { ok: true, settings: out });
  }
  if (tail === '/sessions') {
    const list = Array.isArray(b.sessions) ? b.sessions : (b.session ? [b.session] : []);
    if (!list.length) return json(res, 400, { ok: false, error: '缺少 session(s)' });
    const r = list.length === 1 ? await store.putSession(account, list[0]) : await store.putSessions(account, list);
    return json(res, 200, Object.assign({ ok: true }, r));
  }
  if (tail === '/session/delete') {
    try {
      const r = await store.deleteSession(account, String(b.id || ''));
      return json(res, 200, Object.assign({ ok: true }, r));
    } catch (e) { return json(res, e.status || 500, { ok: false, error: e.message }); }
  }
  // 归档（界面上侧栏的按钮走这条；删除是不可逆的，归档随时能恢复，见 lib/agent/archive.js）
  if (tail === '/session/archive') {
    try {
      const r = await archive.archiveSession(account, String(b.id || ''));
      return json(res, 200, Object.assign({ ok: true }, r));
    } catch (e) { return json(res, e.status || 500, { ok: false, error: e.message }); }
  }
  if (tail === '/memory') {
    const r = await store.putMemory(account, b.entries);
    return json(res, 200, { ok: true, entries: r.entries.length });
  }
  if (tail === '/prompts') {
    const r = await store.putPrompts(account, b.prompts || b);
    return json(res, 200, { ok: true, prompts: { overrides: r.overrides, skills: r.skills, extra: r.extra } });
  }
  return json(res, 404, { ok: false, error: 'unknown store endpoint' });
}

/* ============================ 绑定端点 ============================ */

async function handleBinding(req, url, res, account, ip) {
  const tail = url.pathname.slice('/agent/binding'.length);
  if (req.method === 'GET' && (tail === '' || tail === '/')) {
    return json(res, 200, { ok: true, binding: session.bindingView(account) });
  }
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' });
  const b = await body(req, res, url);
  if (b === null) return;
  try {
    if (tail === '/bind') {
      const rec = await session.bind(account, b.osUser, b.password, ip);
      return json(res, 200, { ok: true, binding: session.bindingView(account), bound: rec });
    }
    if (tail === '/unbind') {
      await session.unbind(account);
      return json(res, 200, { ok: true, binding: session.bindingView(account) });
    }
    if (tail === '/unlock') {
      const r = await session.unlock(account, b.password, ip);
      return json(res, 200, { ok: true, unlock: r, binding: session.bindingView(account) });
    }
    if (tail === '/lock') {
      session.dropUnlock(account);
      auditLog(`agent-lock account=${account}`);
      return json(res, 200, { ok: true, binding: session.bindingView(account) });
    }
  } catch (e) {
    return json(res, e.status || 500, {
      ok: false, error: e.message, needBind: !!e.needBind, verifyDisabled: session.OS_VERIFY_DISABLED,
    });
  }
  return json(res, 404, { ok: false, error: 'unknown binding endpoint' });
}

/* ============================ 项目（根目录 + 项目记忆文件夹） ============================ */

/** /agent/projects/* —— 项目清单与项目记忆。
 *  项目记忆存在**服务端账号目录**里（不受"绑定本机账号"限制），
 *  但"项目根目录"必须是可访问目录白名单内的真实目录，所以建项目要过 roots 那道闸门。
 *    GET  /agent/projects/browse?path=  列子目录（选择器用；path 省略 = 从白名单根起步）
 *    GET  /agent/projects/memory?id=    某个项目的记忆条目
 *    POST /agent/projects/create        { root, name } → 建项目 + 生成项目记忆文件夹
 *    POST /agent/projects/rename        { id, name }
 *    POST /agent/projects/current       { id }（'' = 不归属任何项目）
 *    POST /agent/projects/delete        { id }（连记忆文件夹一起删）
 *    POST /agent/projects/memory        { id, entries } 全量覆盖该项目记忆 */
async function handleProjects(req, url, res, account, actor) {
  const tail = url.pathname.slice('/agent/projects'.length) || '/';

  if (req.method === 'GET' && tail === '/browse') {
    try {
      const r = await projects.browse(actor, url.searchParams.get('path') || '');
      return json(res, 200, Object.assign({ ok: true }, r));
    } catch (e) {
      return json(res, e.status || 500, { ok: false, error: e.message, needRoots: !!e.needRoots, needStart: !!e.needStart });
    }
  }
  if (req.method === 'GET' && tail === '/memory') {
    const id = url.searchParams.get('id') || '';
    if (!projects.find(account, id)) return json(res, 404, { ok: false, error: '没有这个项目' });
    return json(res, 200, { ok: true, id, entries: projects.readMemory(account, id) });
  }
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' });

  const b = await body(req, res, url);
  if (b === null) return;
  try {
    if (tail === '/create') {
      const real = projects.resolveRoot(actor, b.root);
      const p = await projects.create(account, { root: real, name: b.name });
      // 新建时服务端会种下"项目根目录"那条记忆，所以这里把真实条目一起回给界面
      return json(res, 200, { ok: true, project: p, current: p.id, entries: projects.readMemory(account, p.id) });
    }
    if (tail === '/rename') {
      return json(res, 200, { ok: true, project: await projects.rename(account, b.id, b.name) });
    }
    if (tail === '/current') {
      const r = await projects.setCurrent(account, b.id);
      return json(res, 200, { ok: true, current: r.current, entries: r.current ? projects.readMemory(account, r.current) : [] });
    }
    if (tail === '/delete') {
      const r = await projects.remove(account, b.id);
      return json(res, 200, { ok: true, current: r.current, count: r.projects });
    }
    if (tail === '/archive') {
      const r = await archive.archiveProject(account, b.id);
      return json(res, 200, { ok: true, project: r.project, current: r.current, sessions: r.sessions });
    }
    if (tail === '/memory') {
      const entries = await projects.writeMemory(account, b.id, b.entries);
      return json(res, 200, { ok: true, id: b.id, entries });
    }
  } catch (e) {
    return json(res, e.status || 500, { ok: false, error: e.message, needRoots: !!e.needRoots, needStart: !!e.needStart });
  }
  return json(res, 404, { ok: false, error: 'unknown projects endpoint' });
}

/* ============================ 归档（存档） ============================ */

/** /agent/archive/* —— 归档区：会话与项目（连会话）搬进来，可恢复、可彻底删除。
 *  界面上侧栏的按钮是"归档"，"彻底删除"只在设置 → 存档 里（那一步才不可逆）。 */
async function handleArchive(req, url, res, account) {
  const tail = url.pathname.slice('/agent/archive'.length) || '/';
  if (req.method === 'GET' && (tail === '' || tail === '/')) {
    return json(res, 200, Object.assign({ ok: true }, archive.list(account)));
  }
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' });
  const b = await body(req, res, url);
  if (b === null) return;
  try {
    if (tail === '/restore') {
      const r = b.kind === 'project'
        ? await archive.restoreProject(account, b.id)
        : await archive.restoreSession(account, b.id);
      return json(res, 200, Object.assign({ ok: true, kind: b.kind || 'session' }, r));
    }
    if (tail === '/delete') {
      const r = await archive.remove(account, b.kind === 'project' ? 'project' : 'session', b.id);
      return json(res, 200, Object.assign({ ok: true }, r));
    }
  } catch (e) {
    return json(res, e.status || 500, { ok: false, error: e.message });
  }
  return json(res, 404, { ok: false, error: 'unknown archive endpoint' });
}

/* ============================ 技能：从 Markdown 安装 ============================ */

/** POST /agent/skills/import —— 把磁盘上的 SKILL.md 装进该账号的技能表。
 *  体：{ path, auto?, dryRun? }；dryRun 只解析预览（界面据此弹确认框），不落盘。
 *  路径走 fs 工具那套闸门（可访问目录 + 绑定账号权限），所以要先绑定本机账号。 */
async function handleSkillsImport(req, url, res, account, actor) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' });
  const b = await body(req, res, url);
  if (b === null) return;
  if (!actor || !actor.bound) {
    return json(res, 403, { ok: false, needBind: true, error: '先绑定本机账号：读技能文件要以它的权限进行' });
  }
  const skills = require('./skills');
  try {
    const plan = await skills.planImport(actor, { path: b.path, auto: b.auto });
    if (b.dryRun) {
      return json(res, 200, {
        ok: true, dryRun: true, path: plan.path, errors: plan.errors,
        items: plan.items.map((it) => ({ name: it.name, description: it.description, auto: it.auto, file: it.file, chars: it.text.length })),
      });
    }
    const done = await skills.applyImport(account, plan.items);
    return json(res, 200, { ok: true, path: plan.path, errors: plan.errors, imported: done, count: done.length });
  } catch (e) {
    return json(res, e.status || 500, {
      ok: false, error: e.message,
      needPermission: !!e.needPermission, needRoots: !!e.needRoots, needBind: !!e.needBind,
    });
  }
}

/* ============================ 总入口 ============================ */

async function handleAgent(req, url, res) {
  const ip = presence.clientIp(req);

  // 探针与占用登记：不要求登录，也不受占用校验（被顶掉的窗口要靠它们刷新提示）
  if (url.pathname === '/agent/info' && req.method === 'GET') {
    return json(res, 200, infoPayload(await authUser(req)));
  }
  if (url.pathname === '/agent/presence') {
    return presence.handlePresence(req, res, await authUser(req), url.pathname);
  }

  const user = await authUser(req);
  const account = user ? user.username : '';
  if (!account) {
    if (url.pathname.startsWith('/agent/upstream/')) return needLogin(res, '模型配置与密钥按文档站账号保存在服务端');
    if (url.pathname.startsWith('/agent/store')) return needLogin(res, '会话与配置按文档站账号保存在服务端');
    if (url.pathname.startsWith('/agent/binding')) return needLogin(res, '本机账号绑定属于用户资料');
    if (url.pathname.startsWith('/agent/tools')) return needLogin(res, '文件与命令操作以绑定的本机账号权限执行');
    if (url.pathname.startsWith('/agent/projects')) return needLogin(res, '项目与项目记忆按文档站账号保存在服务端');
    if (url.pathname.startsWith('/agent/archive')) return needLogin(res, '归档按文档站账号保存在服务端');
    if (url.pathname.startsWith('/agent/skills')) return needLogin(res, '技能按文档站账号保存');
    if (url.pathname.startsWith('/agent/search')) return needLogin(res, '联网搜索消耗服务端配额');
    if (url.pathname.startsWith('/agent/run')) return needLogin(res, '托管运行按文档站账号保存在服务端');
    return json(res, 404, { ok: false, error: 'unknown agent endpoint' });
  }
  // 单窗口互斥：被顶掉的窗口不许再让模型干活，也不许写数据（见 lib/agent/presence.js）
  if (!presence.guard(req, res, account)) return;

  const actor = session.actorOf(account);

  if (url.pathname.startsWith('/agent/store')) return handleStore(req, url, res, account);
  /* 托管运行：循环跑在服务端，界面只是观众（关掉浏览器它照样跑完，见 lib/agent/run.js） */
  if (url.pathname.startsWith('/agent/run')) return runHttp.handleRun(req, url, res, account, actor);
  if (url.pathname.startsWith('/agent/binding')) return handleBinding(req, url, res, account, ip);
  if (url.pathname.startsWith('/agent/upstream/')) return upstream.handleUpstream(req, url, res, user, actor);
  if (url.pathname.startsWith('/agent/projects')) return handleProjects(req, url, res, account, actor);
  if (url.pathname.startsWith('/agent/archive')) return handleArchive(req, url, res, account);
  if (url.pathname.startsWith('/agent/tools/')) return tools.handleTools(req, url, res, actor);
  if (url.pathname.startsWith('/agent/skills/')) {
    /* 注意把 url 传进去：本函数签名里少一个参数就会在 body() 里抛 ReferenceError，
       被站点兜底成 500 —— 界面上"安装技能"这条入口会 100% 失败（2026-10-01 审计实测）。 */
    if (url.pathname.slice('/agent/skills'.length) === '/import') return handleSkillsImport(req, url, res, account, actor);
    return json(res, 404, { ok: false, error: 'unknown skills endpoint' });
  }
  if (url.pathname === '/agent/search') {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' });
    return search.handleSearch(req, res, account);
  }
  return json(res, 404, { ok: false, error: 'unknown agent endpoint' });
}

module.exports = { handleAgent, infoPayload, bodyLimitFor };
