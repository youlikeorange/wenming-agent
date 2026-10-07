/* 记忆（全局 + 项目 + 会话）：条目读写、注入区块、按作用域序列化（ESM 模块） */
/* 记忆（Memory）—— Agent 的长期与短期记忆，取代原先的 MCP 文件工具
 *
 *  三类记忆（2026-09-30 增加"项目"这一类）：
 *    · 全局记忆：跨会话、跟着**登录身份**走（存服务器端 settings.memory）。
 *      适合"这个人的偏好、常用约定"这类一直该知道的事。
 *    · 项目记忆：跟着**当前项目**（一个根目录）走，换项目就换一份（存服务器端
 *      STATE_DIR/agent/<账号>/projects/<项目id>/memory/*.md，每条记忆一个 Markdown 文件）。
 *      适合"这个代码库的结构、怎么跑、踩过什么坑"——换项目就不该再看见的事。
 *    · 会话记忆：只属于当前这一个对话（存该会话的 session.memory），随会话删除而消失。
 *      适合"这次任务的临时结论、待办、中间事实"。
 *
 *  注入策略（与技能一致的两层，避免上下文被塞满）：
 *    · 常驻：全局/项目记忆的**索引**（标题 + 标签 + 一句话）+ 项目事实（根目录在哪），
 *      会话记忆的**正文**（通常很短）；
 *    · 按需：正文用 memory_read 工具取，检索用 memory_search —— 模型觉得需要时自己拉。
 *  每一段注入文本都来自提示词登记表（可在「🧩 提示词登记表」里改或关掉）。
 *  一条记忆同时带 source 标记（user 手写 / model 由模型写下），界面上可分辨、可改可删。
 *
 *  **记忆 vs 技能（两套东西，别混）**：记忆记的是**事实**（偏好、结论、项目在哪、踩过什么坑），
 *  技能（core/prompts.js 的 skills[]，工具 skill_write / use_skill）记的是**做法**
 *  （可复用的步骤与检查清单，按需加载、不占上下文）。同一件事只写一处：
 *  写成了技能就别在记忆里再抄一份，反之亦然。注入区块也分开（技能清单在 system 的「技能」段，
 *  记忆在「全局/项目/会话记忆」段），模型侧的口径见提示词登记表 system.skills_memory。
 *
 *  **整份写回的纪律（2026-10-03 抖音热点项目被清空事故的结论）**：三类里只有项目记忆在服务端是
 *  **整份覆盖**（不在本次集合里的 .md 会被删掉），所以：
 *    · 事件必须带作用域（emit(['project'])），订阅方只写"真的变了的那一类"——
 *      旧实现任何一次变更（哪怕只写了一条全局记忆）都会把三类都整份写回；
 *    · 项目条目只认 setProject(meta, entries) 这一条来路，条目与项目 id 绑定；
 *      没取回来过（projectLoaded=false）或换了项目没带条目 → 一律**不许写回**，
 *      否则就是拿一份空的/陈旧的快照把服务端那份删光（本次事故就是这个）。
 *
 *  **可变状态在 createMemory() 的闭包里**（不用模块级变量）：
 *  浏览器与"服务端托管运行"各自持有一份实例，于是**多段运行可以并行**
 *  （原先模块级单例 = 同一时刻只允许一段运行，见 lib/agent/run-registry.js）。
 *  `export const Memory` 是给界面/单测用的默认实例，行为与改造前完全一致。
 */
const MAX_ENTRIES = 300;
const MAX_CONTENT = 200 * 1024;
/** 三类记忆的作用域名（模块级常量：事件、序列化、删除都按它遍历） */
const SCOPES = ['global', 'project', 'session'];

/** 造一份独立的记忆实例（每种作用域一组列表 + 一组订阅者）
 *  @returns 与旧模块级 Memory 同形：init/load/onChange/write/… */
/* eslint-disable-next-line max-lines-per-function -- 工厂函数装的是**整个模块体的实例**（内部结构一格没动，只是从模块级单例改成按需现造）：拆开反而让"一份实例的全部代码"散掉，见文件头的说明。 */
export function createMemory() {
  let globalList = [];     // 全局记忆
  let projectList = [];    // 项目记忆（当前项目）
  let sessionList = [];    // 会话记忆
  let projectMeta = null;  // 当前项目的元信息 { id, name, root, memoryDir }（由宿主在切换项目时灌入）

  /* 项目记忆的两个"来源"标记（2026-10-03）——项目记忆在服务端是**整份覆盖**（不在本次集合里的
     .md 会被删），所以"写回去"这件事必须只拿**有权威来源**的列表做：
       · projectListFor：这份条目属于哪个项目 id（换了项目就必须换条目，绝不沿用上一个项目的）；
       · projectLoaded ：这份条目是不是**从服务端取回来的**（或在其之上做的本地修改）。
     没有这两道标记时，浏览器只要手里是"空/陈旧的"快照（取数被跳过、取数失败、刚进项目还没取），
     任何一次 emit 都会把它整份写回 → 项目记忆被清空（2026-10-03 抖音热点项目实测的根因）。
       · projectBaseCount：上一次从服务端取回时的条数。整份覆盖时随写请求一起发给服务端做
         "空列表覆盖保护"的基准（见 lib/agent/projects.js 的 writeMemoryLocked）。 */
  let projectListFor = '';
  let projectLoaded = false;
  let projectBaseCount = 0;

  /** 依赖注入：Prompts（提示词登记表）原来是浏览器全局对象，移植后由外部注入。
   *  未注入时 Prompts 为 null，各 *Block 会退回到写死的兜底文案（与原先无 Prompts 时一致）。 */
  let Prompts = null;
  function init(d) { Prompts = (d && d.Prompts) || null; }

  const listeners = [];
  /** 广播变更，**带上"哪一类变了"**（2026-10-03）：订阅方原先只知道"记忆变了"，于是
   *  任何一次变更（写一条全局记忆、清一次会话记忆）都会把**三类都整份写回**——
   *  项目记忆那条尤其危险（整份覆盖 + 快照可能陈旧）。现在订阅方按作用域各写各的。 */
  const emit = (scopes) => {
    const list = Array.isArray(scopes) && scopes.length ? scopes : SCOPES.slice();
    listeners.forEach(fn => { try { fn(list.slice()); } catch { /* 界面回调异常不影响数据 */ } });
  };
  /** 订阅变更，返回**退订函数**。回调参数 = 变了的**作用域名数组**（'global'|'project'|'session'）。
   *  托管运行是"一次运行注册一次"的用法：
   *  不退订会让回调跨运行累积，而回调闭包捕获的是注册那次运行的账号 —— B 载入数据触发 emit 时，
   *  A 的回调会把 **B 的记忆写进 A 的账号文件**（全量覆盖，2026-10-01 实测复现）；
   *  每个回调还会一直持有那一轮的 run 对象（含事件日志），运行结束也回收不了。
   *  现在实例本身也按运行隔离（一份实例一组监听者），这道退订纪律依旧是第二道保险。 */
  const onChange = (fn) => {
    listeners.push(fn);
    return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
  };

  const newId = (p) => p + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const now = () => Date.now();
  const norm = (s) => String(s || '').trim();

  /** 项目记忆的 id 直接当 Markdown 文件名（可读、可拷），所以由标题生成 slug。
   *  中文保留（文件名允许），只把路径分隔符与危险字符换成短横线。 */
  const slugify = (s) => String(s || '').trim().toLowerCase()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 48);
  const newIdFor = (scope, title) => (scope === 'project' ? (slugify(title) || newId('m')) : newId('m'));

  const listSig = (l) => JSON.stringify(l.map(e => [e.id, e.title, e.content, e.tags, e.updated]));

  function sanitizeList(arr) {
    return (Array.isArray(arr) ? arr : []).slice(0, MAX_ENTRIES).map(e => {
      if (!e || typeof e !== 'object') return null;
      const title = norm(e.title).slice(0, 80);
      const content = String(e.content || '').slice(0, MAX_CONTENT);
      if (!title && !content) return null;
      return {
        id: String(e.id || newId('m')), title: title || content.slice(0, 24),
        content, tags: (Array.isArray(e.tags) ? e.tags : []).slice(0, 8).map(t => String(t).slice(0, 24)),
        ts: Number(e.ts) || now(), source: e.source === 'model' ? 'model' : 'user',
        /* updated 是**条目内容的一部分**（它进了 listSig()），不能在这里"补"一个新时间戳：
           每次载入都盖一个新的 now()，就等于"每次载入内容都变了"→ 订阅方据此写盘一次，
           正是下面 load 的注释警告的"误写盘"。实测两处表现：
             · 单测「★ load 内容没变不发变更事件」约 1/6 概率失败（跨毫秒时触发）；
             · 线上每次登录/刷新都白写一遍记忆与会话。
           既没有 updated 也没有 ts 的条目（老数据、外部写入）给一个**稳定值** 0。 */
        updated: Number(e.updated) || Number(e.ts) || 0,
      };
    }).filter(Boolean);
  }

  /** 载入：全局来自 settings.memory，会话来自当前会话对象；项目条目**不从这里进**
   *  （它只有一条来路：setProject(meta, entries)，条目必须与项目 id 一起给，见下）。
   *  **内容没变就不发变更事件**：载入只是把服务端/会话里的数据装进内存，不该被当成"用户改了记忆"——
   *  否则订阅方（app.js 里会顺手 persistSession）每次载入都写一遍会话，
   *  载入时机一早于"历史装载"，就会把当前会话的消息覆盖成空的（2026-09-17 实测的丢会话事故）。
   *  事件只报**真的变了的那几类**（订阅方据此只写该类，不再"一变全写"）。 */
  function load(globalArr, sessionArr) {
    const before = [listSig(globalList), listSig(sessionList)];
    globalList = sanitizeList(globalArr);
    sessionList = sanitizeList(sessionArr);
    const changed = [];
    if (listSig(globalList) !== before[0]) changed.push('global');
    if (listSig(sessionList) !== before[1]) changed.push('session');
    if (changed.length) emit(changed);
  }

  /** 换当前项目（宿主在"设当前项目 / 登录拉数据 / 切换项目"时调用）。
   *  · entries 给了 = 这个项目的记忆（**唯一**把它标成"有权威来源"的入口）；
   *  · entries 没给且**还是同一个项目** = 只换项目事实、条目保持（登录拉数据那条路）；
   *  · entries 没给且**换了项目** = 条目清空并标记"还没取回来"（绝不沿用上一个项目的条目——
   *    否则它会被整份写进新项目的文件夹）；调用方紧接着用 refreshCurrentMemory 取回来。
   *  · meta 为空 = 没有当前项目：条目清空、projectBlock() 不再注入。 */
  function setProject(meta, entries) {
    const before = listSig(projectList);
    const id = meta && meta.id ? String(meta.id) : '';
    projectMeta = id ? meta : null;
    if (!id) {
      projectList = []; projectListFor = ''; projectLoaded = false; projectBaseCount = 0;
    } else if (entries !== undefined) {
      projectList = sanitizeList(entries);
      projectListFor = id; projectLoaded = true; projectBaseCount = projectList.length;
    } else if (id !== projectListFor) {
      projectList = []; projectListFor = id; projectLoaded = false; projectBaseCount = 0;
    }
    if (listSig(projectList) !== before) emit(['project']);
  }

  const listOf = (scope) => (scope === 'session' ? sessionList : scope === 'project' ? projectList : globalList);
  const serialize = (scope) => listOf(scope).map(e => Object.assign({}, e));
  /** 本地改动落在项目条目上：这份列表从此"知道自己在说什么"（可写回），但**基准条数不变**——
   *  它是服务端那边"我取回来时是几条"的记录，只由 setProject(entries) 更新。 */
  const touchProject = () => { if (projectMeta) projectLoaded = true; };

  /** 新增或按标题合并（同标题视为同一条记忆，避免模型反复写同一条） */
  function write({ scope = 'global', title, content, tags, source = 'model' }) {
    const arr = listOf(scope);
    if (scope === 'project') touchProject();      // 本地改动落在项目条目上：这份列表从此可写回
    const t = norm(title) || norm(content).slice(0, 24);
    const hit = arr.find(e => e.title.toLowerCase() === t.toLowerCase());
    if (hit) {
      hit.content = String(content || hit.content).slice(0, MAX_CONTENT);
      if (Array.isArray(tags) && tags.length) hit.tags = tags.slice(0, 8).map(x => String(x).slice(0, 24));
      hit.updated = now();
      if (source === 'user') hit.source = 'user';
      emit([scope]);
      return { entry: hit, updated: true };
    }
    const entry = {
      id: newIdFor(scope, t), title: t, content: String(content || '').slice(0, MAX_CONTENT),
      tags: (Array.isArray(tags) ? tags : []).slice(0, 8).map(x => String(x).slice(0, 24)),
      ts: now(), updated: now(), source: source === 'user' ? 'user' : 'model',
    };
    arr.unshift(entry);
    if (arr.length > MAX_ENTRIES) arr.length = MAX_ENTRIES;
    emit([scope]);
    return { entry, updated: false };
  }

  const find = (ref, scope) => {
    const key = norm(ref).toLowerCase();
    const arr = scope ? listOf(scope) : projectList.concat(globalList, sessionList);
    return arr.find(e => e.id.toLowerCase() === key || e.title.toLowerCase() === key) || null;
  };
  /** 这条条目属于哪一类（update/remove 广播用；三条列表里第一个命中的算） */
  const scopeOf = (e) => (projectList.includes(e) ? 'project' : globalList.includes(e) ? 'global' : 'session');

  function update(id, patch, scope) {
    const e = find(id, scope); if (!e) return null;
    if (patch.title !== undefined) e.title = norm(patch.title).slice(0, 80) || e.title;
    if (patch.content !== undefined) e.content = String(patch.content).slice(0, MAX_CONTENT);
    if (patch.tags !== undefined) e.tags = (Array.isArray(patch.tags) ? patch.tags : []).slice(0, 8);
    e.updated = now();
    if (e.source === 'model') e.source = 'user';       // 人改过就标成用户的
    const s = scopeOf(e);
    if (s === 'project') touchProject();
    emit([s]);
    return e;
  }

  function remove(id, scope) {
    const targets = scope ? [scope] : SCOPES;
    for (const s of targets) {
      const a = listOf(s);
      const i = a.findIndex(e => e.id === id);
      if (i >= 0) {
        const [gone] = a.splice(i, 1);
        if (s === 'project') touchProject();
        emit([s]);
        return gone;
      }
    }
    return null;
  }

  /** 清空会话记忆（新建对话 / 清空对话时调用）。本来就是空的就不广播——
   *  一次无意义的 emit 会让订阅方白排一条写请求（旧实现无条件 emit，见文件头的"一变全写"）。 */
  const clearSession = () => {
    if (!sessionList.length) return;
    sessionList = [];
    emit(['session']);
  };

  /** 检索：标题/标签/正文里找关键词（大小写不敏感），返回摘要片段 */
  function search(query, scope) {
    const q = norm(query).toLowerCase();
    const where = (e) => (projectList.includes(e) ? 'project' : globalList.includes(e) ? 'global' : 'session');
    const pool = (scope ? listOf(scope) : projectList.concat(globalList, sessionList)).map(e => ({ e, where: where(e) }));
    if (!q) return pool.map(({ e, where: w }) => ({ ...brief(e), scope: w }));
    return pool.filter(({ e }) => (e.title + ' ' + e.tags.join(' ') + ' ' + e.content).toLowerCase().includes(q))
      .map(({ e, where: w }) => ({ ...brief(e), scope: w }));
  }

  const brief = (e) => ({
    id: e.id, title: e.title, tags: e.tags, source: e.source, updated: e.updated,
    excerpt: e.content.replace(/\s+/g, ' ').slice(0, 160),
  });

  /** 索引行（全局与项目共用一套排版） */
  const indexLines = (list) => list.map(e => `- [${e.id}] ${e.title}${e.tags.length ? '（' + e.tags.join('/') + '）' : ''}：${e.content.replace(/\s+/g, ' ').slice(0, 90)}${e.content.length > 90 ? '…' : ''}`);

  /** 全局记忆索引（常驻注入，只给标题/标签/摘要，正文按需 memory_read） */
  function indexBlock() {
    if (!globalList.length) return null;
    const head = (Prompts && Prompts.text('memory.index.intro')) || '你的全局记忆（长期，跨会话；需要正文时用 memory_read）：';
    return { id: 'memory.index', title: '全局记忆索引', text: head + '\n' + indexLines(globalList).join('\n') };
  }

  /** 全局记忆全文（另一种注入方式：条目少时可以把正文全带上，省掉 memory_read 往返） */
  function fullBlock() {
    if (!globalList.length) return null;
    const head = (Prompts && Prompts.text('memory.full.intro')) || '你的全局记忆（长期、跨会话，下面是全文）：';
    const lines = globalList.map(e => `- ${e.title}${e.tags.length ? '（' + e.tags.join('/') + '）' : ''}：${e.content}`);
    return { id: 'memory.full', title: '全局记忆全文', text: head + '\n' + lines.join('\n') };
  }

  /** 项目记忆（含"这个项目在哪"的事实 + 记忆索引/全文）。
   *  没有当前项目时返回 null —— 没项目就没有项目记忆这回事，不注入空壳。
   *  mode: 'index'（默认，只给索引）| 'full'（整段注入）| 'off'（不注入） */
  function projectBlock(mode) {
    if (!projectMeta || mode === 'off') return null;
    const head = (Prompts && Prompts.text('memory.project.intro')) || '当前项目（Project）：';
    const facts = [
      `- 项目名：${projectMeta.name || projectMeta.id}`,
      `- 项目根目录：${projectMeta.root}`,
    ];
    if (projectMeta.memoryDir) facts.push(`- 项目记忆文件夹：${projectMeta.memoryDir}（每条记忆一个 Markdown，由服务端维护，不必去读）`);
    const body = mode === 'full'
      ? projectList.map(e => `- ${e.title}${e.tags.length ? '（' + e.tags.join('/') + '）' : ''}：${e.content}`)
      : indexLines(projectList);
    const tail = projectList.length
      ? (mode === 'full' ? '' : '\n' + ((Prompts && Prompts.text('memory.project.usage')) || '（上面是索引；需要正文用 memory_read，新知识用 memory_write 的 scope="project" 写进来。）'))
      : '\n' + ((Prompts && Prompts.text('memory.project.empty')) || '（这个项目还没有记忆：值得长期保留的项目背景/约定/踩坑，用 memory_write 的 scope="project" 写进来。）');
    return {
      id: 'memory.project', title: '项目记忆',
      text: head + '\n' + facts.join('\n') + '\n' + (body.length ? body.join('\n') : '') + tail,
    };
  }

  /** 会话记忆正文（通常很短，整段常驻注入） */
  function sessionBlock() {
    if (!sessionList.length) return null;
    const head = (Prompts && Prompts.text('memory.session.intro')) || '本会话的记忆（只在这次对话里有效）：';
    const lines = sessionList.map(e => `- ${e.title}：${e.content}`.replace(/\s+/g, ' '));
    return { id: 'memory.session', title: '会话记忆', text: head + '\n' + lines.join('\n') };
  }

  const SCOPE_CN = { global: '全局', project: '项目', session: '会话' };
  const scopeCn = (scope) => SCOPE_CN[scope] || '全局';

  return {
    init, load, onChange, write, update, remove, clearSession, search, find, scopeCn,
    setProject, indexBlock, fullBlock, projectBlock, sessionBlock, serialize, listOf,
    get project() { return projectList; },
    get projectMeta() { return projectMeta; },
    /* 项目记忆的"来源"三件套（订阅方据此决定能不能整份写回、写回时带什么基准）：
       条目是不是这个项目的、是不是从服务端取回来的、取回时是几条。 */
    get projectListFor() { return projectListFor; },
    get projectLoaded() { return projectLoaded; },
    get projectBaseCount() { return projectBaseCount; },
  };
}

/** 默认实例：界面与单测用的那一份（生命周期与页面/进程同长） */
export const Memory = createMemory();
