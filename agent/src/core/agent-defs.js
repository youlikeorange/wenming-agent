/* 工具登记表：决定「给模型看哪些工具」（ESM 模块）。
 *   · 去掉 IIFE 外壳（原 `(function (global) { 'use strict'; ... })(浏览器全局对象 || globalThis)`）；
 *   · `global.AgentDefs = ...` → `export const AgentDefs = ...`；
 *   · 原宿主对象 C 的取值改为 init(deps) 注入的同名局部依赖（C.Prompts → Prompts，C.val2 → val2，
 *     C.me → me，C.AGENT_API → AGENT_API），不再有任何全局/宿主对象引用。
 *
 *  ⚠ 移植期**唯一允许的行为变化**：插件工具（文件与目录 / 命令行）的登录闸门，
 *  由原「已登录（me() 非空）就注册」改成「已登录 **且** 已绑定本机账号（bound() 为真）才注册」。
 *  未绑定时不注册文件/命令工具；说明文案上：未登录沿用原 plugin.need_login.note（逐字不动），
 *  已登录但未绑定则另加一条 note（见 pluginGateNote()），告诉模型「需要在设置里绑定本机账号」。
 *  其余闸门逐条保留（联网搜索的登录+技能开关、技能开关、记忆开关、各插件开关与 AGENT_API
 *  判空等，均见各函数上的原注释）。
 *
 * AgentDefs —— 工具登记表层：把"这一轮给模型注册哪些工具、schema 长什么样"从 app.js 拆出来
 *
 *  参照标准 agent 的分层（Pi：agent-core 只管 LLM+Tools+Loop，工具定义属于宿主的"登记表"；
 *  Claude Code：工具清单与 schema 独立成 definition，执行另在 tool runner）：
 *
 *    agent.js      内核    —— 循环、五步生命周期、截断/重复保护（不认识任何具体工具）
 *    agent-defs.js 登记表  —— 工具 schema 与开关（本文件：纯数据 + 少量判定，不发请求）
 *    tool-runner.js 执行层 —— runTool 分发、预算、调服务端（发请求）
 *
 *  schema 的 description/参数说明全部取自 js/prompts.js 的提示词登记表——
 *  界面上改提示词 = 改这里发给模型的东西，两处永远同源。
 *
 *  纯逻辑、不碰 DOM：init({ Prompts, val2, me, bound, AGENT_API }) 注入宿主依赖后，
 *  可在控制台或 Node 里直接调用验算（me 是函数：返回当前登录用户或 null；
 *  bound 是函数：返回本机账号是否已绑定；bound 未注入时按未绑定处理，插件工具不注册）。
 *
 *  注：「完全访问」档追加的 plugin.access.full.note 与未登录时的 plugin.need_login.note，
 *  这两段文案的**实际注入**在宿主的提示词组装里（原文 app.js 的 injectedBlocks()），不在本文件；
 *  本文件只提供判定（pluginsAllowed）与给模型的闸门说明（pluginGateNote）。
 *
 *  **注入的依赖在 createAgentDefs() 的闭包里**：一份实例 = 一轮运行看到的工具清单，
 *  于是多段运行可以并行（原先模块级单例会被后一轮的 init 覆盖，见 lib/agent/run-registry.js）。
 *  `export const AgentDefs` 是给界面/单测用的默认实例，行为与改造前完全一致。
 */

/* ======================= 名册（执行层 / 界面共用，纯常量） ======================= */
const FS_READ_NAMES = ['read_file', 'list_directory', 'directory_tree', 'search_files', 'get_file_info'];
const FS_WRITE_NAMES = ['write_file', 'edit_file', 'create_directory', 'move_file'];
const FS_DELETE_NAMES = ['delete_path'];
/* 传输文件：把文件放进用户的「待下载」目录。归在插件族里（要登录 + 要绑定），
   但它**不是**写文件工具（不改用户磁盘上的东西，只往账号自己的下载目录拷一份），
   所以不进 FS_WRITE_NAMES（不弹"写文件"确认框），也不进 FS_READ_NAMES（它确实创建了文件，扣 fs 预算）。 */
const DELIVER_NAMES = ['deliver_file'];
const PLUGIN_TOOL_NAMES = new Set(FS_READ_NAMES.concat(FS_WRITE_NAMES, FS_DELETE_NAMES, ['run_command'], DELIVER_NAMES));
/* 会弹确认框、且会改动东西的工具：串行执行（agent.js 里"写类工具宜 sequential"）。
   一来它们都要过同一个确认框（并行会抢同一个弹框），
   二来两条命令/一次写入本来也不该同时动同一份东西。只读类照旧并行。 */
const CONFIRM_SEQUENTIAL = new Set(FS_WRITE_NAMES.concat(FS_DELETE_NAMES, ['run_command', 'skill_write', 'skill_delete']));
const FS_LABEL = {
  read_file: '读文件', list_directory: '列目录', directory_tree: '目录树', search_files: '找文件',
  get_file_info: '文件属性', write_file: '写文件', edit_file: '改文件', create_directory: '建目录',
  move_file: '移动', delete_path: '删除',
};
/* 子智能体默认（只读模式）能用的工具名：读文件 / 找文件 / 联网搜索 / 查记忆 / 列与读技能。
   **只读集合**而不是"黑名单"：新增工具忘了归类时，子智能体默认拿不到（保守方向）。 */
const SUBAGENT_READ_NAMES = FS_READ_NAMES.concat(['web_search', 'memory_search', 'memory_read', 'list_skills', 'use_skill']);
const SUBAGENT_ALLOWED_NAMES = new Set(SUBAGENT_READ_NAMES);

/* 未绑定本机账号说明的兜底文案：真源是提示词登记表的 plugin.need_bind.note（用户可在
   「设置 → 提示词登记表」里改），这里只在 Prompts 尚未注入时兜底（Node 单测场景）。 */
const NEED_BIND_NOTE_FALLBACK = '用户还没有绑定本机账号，所以文件、目录、命令行这类工具本轮不可用。';

/* ======================= schema 工厂 ======================= */
const p = (props, required) => ({ type: 'object', properties: props, required });

/** 造一份独立的工具登记表实例（依赖 + 判定都在闭包里）
 *  @returns 与旧模块级 AgentDefs 同形 */
/* eslint-disable-next-line max-lines-per-function -- 工厂函数装的是**整个模块体的实例**（内部结构一格没动，只是从模块级单例改成按需现造）：拆开反而让"一份实例的全部代码"散掉，见文件头的说明。 */
export function createAgentDefs() {
  /* 原为 `let C = { Prompts: null, val2: () => undefined, me: () => null, AGENT_API: '' }` +
   * `init(ctx) { C = Object.assign(C, ctx || {}) }`。移植后拆成同名局部变量，语义不变：
   * 只覆盖传进来的键，可增量多次调用。
   * bound 是新增的第 5 个依赖：宿主传入「本机账号是否已绑定」的判定函数。
   * 默认 () => false —— 拿不准就是未绑定（与 policy.js「拿不准就问」同向的失败方向）。 */
  let Prompts = null;
  let val2 = () => undefined;
  let me = () => null;
  let bound = () => false;
  let AGENT_API = '';

  function init(ctx) {
    const d = ctx || {};
    if ('Prompts' in d) Prompts = d.Prompts;
    if ('val2' in d) val2 = d.val2;
    if ('me' in d) me = d.me;
    if ('bound' in d) bound = d.bound;
    if ('AGENT_API' in d) AGENT_API = d.AGENT_API;
  }

  const fn = (name, id, parameters) => ({ type: 'function', function: { name, description: Prompts.text(id), parameters } });

  const searchToolDef = () => fn('web_search', 'tool.web_search.schema.desc',
    p({ query: { type: 'string', description: Prompts.text('tool.web_search.param.query') } }, ['query']));

  /** 联网搜索是否可用：由内置技能「联网搜索」的开关决定（关掉 = 连工具都不注册）。
   *  2026-09-19 起服务端 /agent/search 要求登录（搜索消耗服务端 AnySearch 配额），
   *  未登录时同样不注册——与插件工具同一道登录闸门，别让模型空转去试一个必然 401 的工具。 */
  const searchOn = () => !!me() && Prompts.enabled('skill.web_search') && Prompts.text('skill.web_search').trim() !== '';

  const skillsActive = () => !!val2('skill_tools_on');

  /** 技能工具（Pi 的 progressive disclosure：清单里只有名字与用途，正文由模型按需加载）
   *  注意：skill_write 始终注册——否则一份技能都没有时，模型连"攒第一份技能"的入口都没有（鸡生蛋）。 */
  function SKILL_TOOL_SPECS() {
    return {
      list_skills: { type: 'function', function: {
        name: 'list_skills',
        description: Prompts.text('tool.list_skills.schema.desc'),
        parameters: { type: 'object', properties: {} },
      } },
      use_skill: { type: 'function', function: {
        name: 'use_skill',
        description: Prompts.text('tool.use_skill.schema.desc'),
        parameters: { type: 'object', properties: {
          name: { type: 'string', description: '技能名称（见系统提示里的技能清单）' },
        }, required: ['name'] },
      } },
      skill_import: { type: 'function', function: {
        name: 'skill_import',
        description: Prompts.text('tool.skill_import.schema.desc'),
        parameters: { type: 'object', properties: {
          path: { type: 'string', description: '技能 .md 文件的路径，或装着 `<技能名>/SKILL.md` 的目录' },
          auto: { type: 'boolean', description: 'true=按需加载（默认）；false=每轮都注入。frontmatter 里写了 auto 就以它为准' },
        }, required: ['path'] },
      } },
      skill_write: { type: 'function', function: {
        name: 'skill_write',
        description: Prompts.text('tool.skill_write.schema.desc'),
        parameters: { type: 'object', properties: {
          name: { type: 'string', description: '技能名（英文短横线，如 code-review）' },
          description: { type: 'string', description: '什么时候该用这个技能（模型据此判断要不要加载）' },
          content: { type: 'string', description: '技能正文：步骤、规范、检查清单' },
          auto: { type: 'boolean', description: 'true=按需加载（推荐，不占上下文）；false=每轮都注入' },
        }, required: ['name', 'description', 'content'] },
      } },
      skill_delete: { type: 'function', function: {
        name: 'skill_delete',
        description: Prompts.text('tool.skill_delete.schema.desc'),
        parameters: { type: 'object', properties: {
          name: { type: 'string', description: '要删除的技能名' },
        }, required: ['name'] },
      } },
    };
  }

  /** 本轮注册的技能工具：skill_write 始终有（否则攒不出第一份技能）；
   *  list / use 也**始终**给（只要技能功能开着）——曾经只在"已有按需技能"时才注册，
   *  后果是零技能时模型会说"我这边并没有 use_skill 这个工具"（2026-09-30 用户实际遇到的困惑），
   *  连"当前没有配置技能"都答不出来。零技能时 list_skills 会明确回一句"当前没有配置技能。"，
   *  比让模型猜自己有没有这个工具诚实得多（代价只是两条 schema 的 token）。
   *  delete 仍只在真有技能时给（没东西可删，省 token）。 */
  function skillsToolDefs() {
    if (!skillsActive()) return [];
    const T = SKILL_TOOL_SPECS();
    const outs = [T.list_skills, T.use_skill, T.skill_write, T.skill_import];
    if (Prompts.skills().length) outs.push(T.skill_delete);
    return outs;
  }

  /** 文件与目录的 schema */
  function FS_TOOL_SPECS() {
    return {
      read_file: fn('read_file', 'tool.read_file.schema.desc', p({
        path: { type: 'string', description: '文件路径（绝对路径，或允许目录内的相对路径）' },
        start_line: { type: 'number', description: '起始行，从 1 开始（可选）' },
        end_line: { type: 'number', description: '结束行（可选）' },
      }, ['path'])),
      list_directory: fn('list_directory', 'tool.list_directory.schema.desc', p({
        path: { type: 'string', description: '目录路径' },
      }, ['path'])),
      directory_tree: fn('directory_tree', 'tool.directory_tree.schema.desc', p({
        path: { type: 'string', description: '目录路径' },
        depth: { type: 'number', description: '展开深度，默认 3（最大 8）' },
      }, ['path'])),
      search_files: fn('search_files', 'tool.search_files.schema.desc', p({
        path: { type: 'string', description: '从哪个目录开始找' },
        pattern: { type: 'string', description: '文件名关键字或正则（忽略大小写）' },
        max_results: { type: 'number', description: '最多返回多少条，默认 200' },
      }, ['path', 'pattern'])),
      get_file_info: fn('get_file_info', 'tool.get_file_info.schema.desc', p({
        path: { type: 'string', description: '文件或目录路径' },
      }, ['path'])),
      write_file: fn('write_file', 'tool.write_file.schema.desc', p({
        path: { type: 'string', description: '文件路径（不存在则创建）' },
        content: { type: 'string', description: '完整的新内容' },
        if_exists: { type: 'string', enum: ['overwrite', 'fail'], description: '文件已存在时怎么办，默认 overwrite' },
      }, ['path', 'content'])),
      edit_file: fn('edit_file', 'tool.edit_file.schema.desc', p({
        path: { type: 'string', description: '文件路径' },
        old_text: { type: 'string', description: '要被替换的原文（必须与文件里逐字一致、且唯一）' },
        new_text: { type: 'string', description: '替换成什么（空串 = 删掉这一段）' },
        replace_all: { type: 'boolean', description: 'old_text 出现多次时是否全部替换，默认 false（多次则报错）' },
      }, ['path', 'old_text', 'new_text'])),
      create_directory: fn('create_directory', 'tool.create_directory.schema.desc', p({
        path: { type: 'string', description: '要创建的目录（含父目录）' },
      }, ['path'])),
      move_file: fn('move_file', 'tool.move_file.schema.desc', p({
        source: { type: 'string', description: '原路径' },
        destination: { type: 'string', description: '新路径' },
        overwrite: { type: 'boolean', description: '目标已存在时是否覆盖，默认 false' },
      }, ['source', 'destination'])),
      delete_path: fn('delete_path', 'tool.delete_path.schema.desc', p({
        path: { type: 'string', description: '要删除的文件或目录' },
        recursive: { type: 'boolean', description: '目录非空时是否连内容一起删，默认 false' },
      }, ['path'])),
    };
  }

  /** 传输文件（交付产出物给用户）：路径走与读文件同一套闸门 */
  function DELIVER_TOOL_SPEC() {
    return fn('deliver_file', 'tool.deliver_file.schema.desc', p({
      path: { type: 'string', description: '要交给用户的文件的路径（必须在可访问目录内，且绑定账号读得到）' },
      name: { type: 'string', description: '放进待下载目录时叫什么（可选，默认用原文件名）' },
    }, ['path']));
  }

  function EXEC_TOOL_SPEC() {
    return fn('run_command', 'tool.run_command.schema.desc', p({
      command: { type: 'string', description: '要执行的 shell 命令（不支持交互式命令）' },
      cwd: { type: 'string', description: '工作目录（可选，默认允许目录的第一个）' },
      timeout_sec: { type: 'number', description: '超时秒数（可选，默认取面板里的设置）' },
      max_kb: { type: 'number', description: '输出上限 KB（可选）' },
    }, ['command']));
  }

  /** 本轮插件闸门：要**已登录**（文件与命令行都以"登录的那个系统账号"身份执行，没登录就没有身份，
   *  服务端本来也会 401）**且已绑定本机账号**（bound() 为真；登录只说明"是谁"，绑定才说明
   *  "这台机器上的哪个账号可以代他执行"）。两者差一个都不给插件工具。 */
  const pluginsAllowed = () => !!me() && !!bound();

  /** 插件工具被上面那道闸门挡下时，宿主该注入给模型的一句说明；闸门放行时返回 null。
   *  · 未登录：沿用原 plugin.need_login.note 文案（逐字不动，仍受登记表开关控制）；
   *  · 已登录但未绑定本机账号：注入 plugin.need_bind.note（登记表条目，可编辑）。 */
  function pluginGateNote() {
    if (pluginsAllowed()) return null;
    if (!me()) {
      if (!Prompts.enabled('plugin.need_login.note')) return null;
      return { id: 'plugin.need_login.note', title: '未登录 · 插件工具不可用',
        text: Prompts.text('plugin.need_login.note') };
    }
    const text = (Prompts && typeof Prompts.text === 'function')
      ? Prompts.text('plugin.need_bind.note') : NEED_BIND_NOTE_FALLBACK;
    return { id: 'plugin.need_bind.note', title: '未绑定本机账号 · 插件工具不可用', text };
  }

  /** 本轮注册的插件工具：开关在侧栏「🔌 插件」里，关掉即不注册、也不注入它的说明。 */
  function pluginToolDefs() {
    if (!AGENT_API || !pluginsAllowed()) return [];
    const out = [];
    if (val2('plugin_fs_on')) {
      const T = FS_TOOL_SPECS();
      FS_READ_NAMES.forEach((n) => out.push(T[n]));
      if (val2('plugin_fs_write')) FS_WRITE_NAMES.forEach((n) => out.push(T[n]));
      if (val2('plugin_fs_delete')) FS_DELETE_NAMES.forEach((n) => out.push(T[n]));
    }
    if (val2('plugin_exec_on')) out.push(EXEC_TOOL_SPEC());
    if (val2('plugin_deliver_on')) out.push(DELIVER_TOOL_SPEC());
    return out;
  }

  /* ---------- 子智能体（spawn_agent）：把一件独立的事交给另一段上下文 ---------- */

  /** 子智能体开关（参数面板 → 子智能体）。关掉 = 连工具都不注册，模型不会念念不忘。 */
  const subagentOn = () => !!val2('subagent_on');

  /** 本轮注册的子智能体工具：参数由模型按任务定（模型可覆盖的只有这几个，
   *  上限与"能不能写"的兜底在服务端 runner 里再夹一次——工具参数不可信）。 */
  function subagentToolDefs() {
    if (!subagentOn()) return [];
    return [{ type: 'function', function: {
      name: 'spawn_agent',
      description: Prompts.text('tool.spawn_agent.schema.desc'),
      parameters: p({
        task: { type: 'string', description: '要子智能体完成的事：一两句话写清"做什么、要什么结果"，它看不到你这段对话' },
        label: { type: 'string', description: '给这个子任务起个短名（显示在追踪条上，便于你与用户分辨）' },
        max_rounds: { type: 'number', description: '它最多跑几轮（可选，默认取面板里的「每个最多几轮」）' },
        allow_write: { type: 'boolean', description: '是否允许它改文件/执行命令/写记忆（默认 false=只读；面板允许时才有效）' },
        provider: { type: 'string', description: '用哪个服务商跑它（可选，如 "deepseek"；默认跟当前对话同一个模型）' },
      }, ['task']),
    } }];
  }

  /** 记忆类工具 */
  function memoryToolDefs() {    if (!val2('tool_mem_on')) return [];
    const T = (k) => Prompts.text(k);
    return [
      { type: 'function', function: { name: 'memory_write', description: T('tool.memory_write.schema.desc'),
        parameters: { type: 'object', properties: {
          scope: { type: 'string', enum: ['session', 'global', 'project'], description: 'session=只记在这次对话里；global=长期记住（跨会话、跟人走）；project=记在这个项目上（换项目就换一份）' },
          title: { type: 'string', description: '短标题（同标题会合并更新）' },
          content: { type: 'string', description: '要记住的内容本身' },
          tags: { type: 'array', items: { type: 'string' }, description: '可选标签' },
        }, required: ['scope', 'title', 'content'] } } },
      { type: 'function', function: { name: 'memory_search', description: T('tool.memory_search.schema.desc'),
        parameters: { type: 'object', properties: {
          query: { type: 'string', description: '关键词' },
          scope: { type: 'string', enum: ['session', 'global', 'project'], description: '可选：只搜某一类' },
        }, required: ['query'] } } },
      { type: 'function', function: { name: 'memory_read', description: T('tool.memory_read.schema.desc'),
        parameters: { type: 'object', properties: {
          id: { type: 'string', description: '记忆的 id 或标题' },
        }, required: ['id'] } } },
      { type: 'function', function: { name: 'memory_forget', description: T('tool.memory_forget.schema.desc'),
        parameters: { type: 'object', properties: {
          id: { type: 'string', description: '记忆的 id 或标题' },
        }, required: ['id'] } } },
    ];
  }

  /** 本轮注册给模型的全部工具定义（联网搜索 + 技能 + 记忆 + 插件 + 子智能体），上下文统计与实际请求共用 */
  function activeToolDefs() {
    const defs = [];
    if (searchOn()) defs.push(searchToolDef());
    defs.push(...skillsToolDefs());
    defs.push(...memoryToolDefs());
    defs.push(...pluginToolDefs());
    defs.push(...subagentToolDefs());
    return defs;
  }

  /** 子智能体**能用**的工具（默认只读）：主对话的工具清单按名字过滤。
   *  · 一律不给 spawn_agent（不许递归派子智能体）；
   *  · allowWrite=false 时去掉写/删/命令与一切会改数据的工具（含 memory_write / skill_* 的写侧）。
   *  判据用"名字是否属于只读集合"，新增工具忘了归类时**默认不给**（保守方向）。 */
  function subagentToolDefsFor(all, allowWrite) {
    if (allowWrite) return all.filter((d) => d.function.name !== 'spawn_agent');
    return all.filter((d) => SUBAGENT_ALLOWED_NAMES.has(d.function.name));
  }

  /** 工具卡片的标题（追踪条与落盘的 trace 都用它）。
   *  放在 core 而不是界面层：托管运行（lib/agent/run.js）落盘的那份会话也要带同样的标题，
   *  两份实现分叉就会出现"浏览器里跑的是「命令：ls」、服务端落盘的是 run_command"。 */
  function labelOf(call) {
    const a = (call && call.args) || {};
    const shorten = (s, n) => (String(s || '').length > n ? String(s).slice(0, n) + '…' : String(s || ''));
    const TITLE_OF = {
      web_search: () => `检索：${shorten(a.query || a.q || '(未提供关键词)', 40)}`,
      deliver_file: () => `传给用户：${shorten(a.name || a.path || '(未指定文件)', 48)}`,
      use_skill: () => `加载技能：${a.name || '(未指定)'}`,
      run_command: () => `命令：${shorten(a.command, 60)}`,
      spawn_agent: () => `子智能体：${shorten(a.label || a.task || '(未给任务)', 44)}`,
    };
    const name = (call && call.name) || '';
    if (TITLE_OF[name]) return TITLE_OF[name]();
    if (FS_LABEL[name]) {
      return `${FS_LABEL[name]}：${shorten(a.path || a.source, 56)}`
        + (a.destination ? ` → ${shorten(a.destination, 40)}` : '');
    }
    return name;
  }

  return {
    init,
    FS_READ_NAMES, FS_WRITE_NAMES, FS_DELETE_NAMES, PLUGIN_TOOL_NAMES, DELIVER_NAMES,
    CONFIRM_SEQUENTIAL, FS_LABEL, labelOf,
    searchToolDef, searchOn, skillsActive, skillsToolDefs, memoryToolDefs,
    pluginToolDefs, pluginsAllowed, activeToolDefs,
    subagentOn, subagentToolDefs, subagentToolDefsFor,
    pluginGateNote,   // 插件闸门被挡下时给模型的说明（见文件头「唯一的行为变化」）
  };
}

/** 默认实例：界面与单测用的那一份（生命周期与页面/进程同长） */
export const AgentDefs = createAgentDefs();
