/* 提示词登记表：所有注入给模型的文本的唯一真源（可看可改可恢复默认；ESM 模块）
 *
 *  机械改动仅此三项：
 *    1) 去掉 IIFE 外壳（原有的 'use strict' 随之去掉：ESM 恒为严格模式），函数体整体减少 2 格缩进；
 *    2) 末尾原本对外暴露登记表的赋值语句改为 export const Prompts = {…}，并按需具名导出
 *       GROUP_TITLES（原文件里的分组标题常量）；
 *    3) 原文件没有 DOM 代码（只用 Math/Map/Set/JSON 等标准对象），也没有引用 S / Memory / Agent
 *       等外部全局——因此没有可删的 DOM 内容，也不需要 init(deps) 注入依赖。
 *  除以上三项外，下方原文件头注释与全部代码、中文文案、正则、默认值均逐字保留。
 */
/* 提示词登记表（Prompt Registry）—— 参照 Pi 的扩展系统（Skills / Prompt Templates）+ 动态 System Prompt
 *
 *  Pi（earendil-works/pi）把可注入模型的一切都当成**数据**而不是硬编码：
 *    · Skills：Markdown 片段，按 agentskills.io 规范包成
 *        <skill name="…" description="…">正文</skill> 注入 system prompt；
 *      LLM 依据 description 自行决定要不要用（常驻技能则总是注入）。
 *    · Prompt Templates：带 {{变量}} 的 Markdown，用户显式触发（本实现用输入框的 `/` 菜单）。
 *    · 动态 System Prompt / 压缩提示：上下文工程里由引擎调用的提示词，同样可替换。
 *
 *  本文件是这些内容的**唯一出处**：默认值写在这里，用户的改动按 id 存成覆盖项
 *  （settings.prompts.overrides，随会话一起存服务器端，按登录身份隔离）。
 *  界面上的「🧩 注入与提示词」面板逐条列出——**凡是会发给模型的文本，都能看到、都能改**。
 *
 *  条目结构：
 *    { id, group, name, desc, kind, text, editable }
 *    kind: 'system'（拼进 system 的区块）| 'skill' | 'tool'（会注入的工具使用说明）
 *        | 'schema'（只作为工具定义里的 description，**不单独注入**）
 *        | 'helper'（拼装片段：记忆/技能抬头等，由代码拼进对应区块，**不单独注入**）
 *        | 'loop'（循环内注入的短句）| 'compact'（压缩指令）| 'template'（提示词模板）
 *    group: 面板里的分组标题（= 注入顺序）
 */

/* ============================ 内置默认（全部可见可改） ============================ */

/** 主系统提示词（原先只此一条是"提示词"，现在它是登记表里的 system.base） */
const SYSTEM_DEFAULT = '你是 Qwen，一个乐于助人的中文助手。请用简洁、准确的语言回答问题。';

/** 预设（原「系统提示词」里的快选 chips；现在只是把一段文本填进 system.base 的快捷方式） */
const SYSTEM_PRESETS = [
  { id: 'b-general', name: '通用助手', text: SYSTEM_DEFAULT },
  { id: 'b-code', name: '代码专家',
    text: '你是一位资深软件工程师。回答代码问题时：给出可直接运行的代码，附必要注释，并说明关键设计取舍。优先使用现代惯用写法，避免过度设计。' },
  { id: 'b-translate', name: '翻译',
    text: '你是一位专业翻译。把用户输入翻译成自然地道的中文；若输入已是中文，则译为英文。只输出译文，不要解释、不要加引号。' },
  { id: 'b-write', name: '写作',
    text: '你是一位中文写作助手。文字要准确、流畅、有节奏感，避免空话套话与过度修饰。' },
  { id: 'b-analyst', name: '严谨分析',
    text: '你是一位严谨的分析师。先厘清问题的前提与边界，再给出推理过程，最后给结论。不确定之处要明确指出，不要编造依据。' },
  { id: 'b-terse', name: '极简回答',
    text: '回答务必极简：直接给结论，不铺垫、不总结、不重复问题。' },
  { id: 'b-extract', name: '结构化提取',
    text: '从用户提供的内容中提取信息，严格按要求格式（如 JSON、表格）输出。只使用原文中出现的信息，缺失字段填 null，不要推测。' },
];

const DEFAULTS = [
  /* ---- 1. system：按顺序拼接成一条 system 消息 ---- */
  { id: 'system.base', group: 'system', kind: 'system', name: '主系统提示词',
    desc: '整个 system 消息的第一块，定义角色与总体要求。', text: SYSTEM_DEFAULT },

  { id: 'system.agent_rules', group: 'system', kind: 'system', name: 'Agent 行为准则',
    desc: '工具循环的通用约定（什么时候调用工具、怎么收尾）。参照 Pi 的 agent harness 约定，可整段改写或关掉。',
    text: '你可以调用工具来完成任务。工作方式：'
      + '① 需要事实、文件内容或实时信息时先调用工具，不要凭记忆猜测；'
      + '② 一次可以并行调用多个互不依赖的工具；'
      + '③ 工具返回错误或空结果时，先改变参数或换一个工具再试，不要重复同样的调用；'
      + '④ 拿到足够信息后直接给出结论，并说明依据（文件路径、来源链接）；'
      + '⑤ 如果确实拿不到需要的信息，如实说明缺什么，不要编造。' },

  { id: 'system.skills_memory', group: 'system', kind: 'system', name: '技能与记忆存在哪',
    desc: '告诉模型技能/记忆的存放位置、作用域（按文档站账号隔离）、四类数据的边界（技能记"怎么做"、记忆记"事实"，同一件事只写一处）与增删改查入口，以及装现成技能时常见的目录。',
    text: '技能与记忆都存在**服务端**，并按**文档站账号隔离**——换个账号就看不到，也不跨用户共享（别向用户承诺"装一次所有人可用"）。\n'
      + '【先分清四类：技能记"怎么做"，记忆记"事实"】\n'
      + '· 技能（Skill）= 可复用的**做法**：步骤、流程、检查清单、触发词（"以后遇到 X 就这么做"）。'
      + '它存在你这个账号的技能表里（服务端 STATE_DIR/agent/<账号>/prompts.json 的 skills[]），不是磁盘上的散文件；'
      + '新建/改写用 skill_write，装现成的 Markdown 用 skill_import，看清单/加载用 list_skills / use_skill，删除用 skill_delete。'
      + '技能正文默认**按需加载**（不占上下文，所以适合写长），清单每轮都注入——description 要写清"什么时候该用它"。\n'
      + '· 记忆（Memory）= **事实与结论**：用户偏好与习惯、定下来的结论、项目在哪、跑法与踩过的坑（"以后需要知道 X"）。'
      + '三类按作用域分：**全局记忆**（跨会话、跟人走）、**项目记忆**'
      + '（跟着"当前项目"走，存在 STATE_DIR/agent/<账号>/projects/<项目id>/memory/*.md —— '
      + '每条记忆一个 Markdown 文件，MEMORY.md 是索引）、**会话记忆**（只在本对话有效）；'
      + '增删改查用 memory_write / memory_search / memory_read / memory_forget（scope 取 global / project / session）。\n'
      + '· **同一件事只写一处**：装好一个工具、跑通一套流程 → 用 skill_write 写成技能（那是"怎么做"），'
      + '**不要在记忆里再抄一份**（技能清单与正文会按需注入，记忆不是技能的第二份备份）；'
      + '反过来，事实（谁、什么、在哪、结论）进记忆，不要塞进技能正文。'
      + '要记"本机装了某工具"这类事实时只写一句结论，正文留在技能里。\n'
      + '· 用户常见的技能目录（只在要装现成技能时用得上）：~/.agents/skills、~/.zcode/skills、~/.claude/skills——'
      + '它们默认**不在可访问目录里**，先请用户加进「设置 → 权限与工具 → 可访问目录」再装。\n'
      + '· 上面那两个服务端文件不必去读（多半在可访问目录之外）；用户问"技能/记忆存在哪"，用这几句回答即可。' },

  /* ---- 2. tools：工具说明（每个工具一条，与工具 schema 一起发给模型） ---- */
  /* 内置技能：联网搜索。技能化之后，这一能力的"何时用/不要用/怎么引用"就是一份可编辑的技能正文，
     启停也走技能的开关（关掉 = 不注册 web_search 工具，模型不知道有联网这回事）。 */
  { id: 'skill.web_search', group: 'skills', kind: 'skill', name: '联网搜索', auto: false, builtin: true,
    desc: '让模型能查实时信息的技能：需要外部事实时先检索再回答，并给出引用来源。关掉即停用联网能力。',
    text: '你可以调用 web_search 工具检索实时网络信息。何时使用：'
      + '① 问题涉及最新事件、实时数据（天气、股价、版本号、新闻）；'
      + '② 你不确定或知识可能过期的内容；'
      + '③ 用户明确要求查资料。'
      + '何时不要用：纯常识、数学计算、代码语法、翻译、创意写作等你能直接可靠回答的问题。'
      + '拿到结果后，请优先依据检索内容作答，并在末尾用 Markdown 列出引用来源链接；'
      + '若结果不足以回答，如实说明，不要编造。' },

  { id: 'tool.web_search.schema.desc', group: 'tools', kind: 'schema', name: 'web_search 的 schema 描述',
    desc: '工具定义（function.description）里的一句话描述——模型选工具时先看这句。',
    text: '联网搜索实时信息。当问题涉及最新事件、实时数据，或你不确定的内容时调用。' },
  { id: 'tool.web_search.param.query', group: 'tools', kind: 'schema', name: 'web_search 参数说明',
    desc: 'web_search 的 query 参数描述。', text: '搜索关键词（尽量具体，可含年份、专有名词）' },
  { id: 'tool.use_skill.schema.desc', group: 'tools', kind: 'schema', name: 'use_skill 的 schema 描述',
    desc: '按需技能工具的 schema 描述。', text: '加载一份技能（Skill）的正文，然后按它的步骤做事。先用 list_skills 看有哪些。' },
  { id: 'tool.use_skill.desc', group: 'tools', kind: 'tool', name: '技能加载 use_skill',
    desc: '按需技能工具的说明（Pi 的 progressive disclosure：技能正文不占上下文，模型要用时才加载）。',
    text: '你可以调用 use_skill 加载一份"技能"（别人写好的工作步骤或规范）。'
      + '系统提示里列出的技能只有名称与用途，正文需要用它时再加载——先加载再按它的步骤做事。' },
  { id: 'tool.list_skills.schema.desc', group: 'tools', kind: 'schema', name: 'list_skills 的 schema 描述',
    desc: '技能清单工具的 schema 描述。', text: '列出当前可用的技能（名称、用途、是否已加载）。' },
  { id: 'tool.list_skills.desc', group: 'tools', kind: 'tool', name: '技能清单 list_skills',
    desc: '查看当前可用技能清单的说明。', text: '列出当前可用的技能（名称 + 用途 + 是否已加载）。' },
  /* ---- 记忆（Memory）：会话记忆 + 全局记忆，替代原先的 MCP 文件工具 ---- */
  { id: 'tool.memory_write.desc', group: 'tools', kind: 'tool', name: '写记忆 memory_write',
    desc: 'memory_write 的注入说明——什么时候该记、记到哪里。这段文字直接决定模型会不会主动记忆。',
    text: '你可以把值得长期保留的**事实**写进记忆（记忆不是技能：可复用的做法用 skill_write，别写进记忆）：\n'
      + '· scope="global"（全局记忆，跨会话，跟着用户走）：用户的偏好与习惯、长期有效的事实、'
      + '他明确要求"记住"的内容；\n'
      + '· scope="project"（项目记忆，跟着**当前项目**走，换项目就换一份）：这个项目的结构、'
      + '怎么跑起来、约定与踩过的坑——凡是"下次做这个项目时还用得上"的都记这里；'
      + '当前项目的根目录与记忆位置在系统提示的「项目记忆」一段里；\n'
      + '· scope="session"（会话记忆，只在这次对话里有效）：当前任务的临时结论、待办与进度、'
      + '这次才成立的中间事实（比如刚查到的数据、定下的方案）。\n'
      + '写法：title 用一句能认出来的短标题（同标题会合并更新，不会重复堆积），content 写清事实本身'
      + '（必要的背景 + 结论），tags 可选。不要记录寒暄、过程性废话、可以从上下文直接看到的内容；'
      + '不确定是否长期有效时先用 session。**同一件事只写一处**：写成了技能就不要在这里再抄一遍。' },
  { id: 'tool.memory_read.schema.desc', group: 'tools', kind: 'schema', name: 'memory_read 的 schema 描述',
    desc: '按 id 或标题取回一条记忆的正文。', text: '按 id 或标题读取一条记忆的完整内容（系统提示里只给了索引与摘要）。' },
  { id: 'tool.memory_search.schema.desc', group: 'tools', kind: 'schema', name: 'memory_search 的 schema 描述',
    desc: '按关键词在记忆里检索。', text: '在记忆里按关键词检索，返回标题、标签与摘录；scope 可选 global / session。' },
  { id: 'tool.memory_forget.schema.desc', group: 'tools', kind: 'schema', name: 'memory_forget 的 schema 描述',
    desc: '删除一条记忆。', text: '删除一条记忆（按 id 或标题）。用户说"忘掉/不用记了"时用它，不要留着过期信息。' },
  { id: 'memory.index.intro', group: 'tools', kind: 'helper', name: '全局记忆索引抬头',
    desc: '全局记忆索引那一段的开头句（索引条目由记忆面板里的内容自动生成）。',
    text: '你的全局记忆（长期、跨会话；只有索引与摘要，需要正文时用 memory_read）：' },
  { id: 'memory.full.intro', group: 'tools', kind: 'helper', name: '全局记忆全文抬头',
    desc: '把全局记忆改成"全文注入"时用的开头句（默认是只注入索引，省上下文）。',
    text: '你的全局记忆（长期、跨会话，下面是全文）：' },
  { id: 'memory.session.intro', group: 'tools', kind: 'helper', name: '会话记忆抬头',
    desc: '本会话记忆那一段的开头句（正文整段注入，因为通常很短）。',
    text: '本会话的记忆（只在这次对话里有效，任务结束就作废）：' },
  { id: 'memory.project.intro', group: 'tools', kind: 'helper', name: '项目记忆抬头',
    desc: '项目记忆那一段的开头句（含项目名、根目录与记忆文件夹位置——这三行由界面按当前项目自动填）。',
    text: '当前项目（Project）——你的项目记忆与项目文件都在它下面：' },
  { id: 'memory.project.usage', group: 'tools', kind: 'helper', name: '项目记忆 · 有索引时的说明',
    desc: '项目记忆只注入索引时，结尾那句"怎么取正文/怎么写新的"。',
    text: '（上面是项目记忆的索引；需要正文用 memory_read，新知识用 memory_write 的 scope="project" 写进来。）' },
  { id: 'memory.project.empty', group: 'tools', kind: 'helper', name: '项目记忆 · 还没有条目时的说明',
    desc: '当前项目还没有任何记忆时注入的一句（引导模型把项目知识记在项目上，而不是全局记忆里）。',
    text: '（这个项目还没有记忆：值得下次还用的项目背景、约定、跑法与踩坑，用 memory_write 的 scope="project" 记下来。）' },

  /* ---- 技能自造（self-extensible，Pi 的做法） ---- */
  { id: 'tool.skill_write.desc', group: 'tools', kind: 'tool', name: '写技能 skill_write',
    desc: '自造技能工具的说明（新建/改写一份技能，正文不占上下文；与记忆是两套，不要两处都写）。',
    text: '你可以把攒下来的工作步骤或规范写成"技能"（skill_write，新建或同名改写）。'
      + 'description 要写清"什么时候该用它"（它决定你以后会不会想起来加载），正文写步骤与检查清单。'
      + 'auto=true（默认）= 按需加载，正文不占上下文；auto=false = 每轮都注入（只适合短而通用的约定）。'
      + '**技能与记忆是两套东西**：技能记"怎么做"，记忆记"事实"——写进技能就别再往记忆里抄一份'
      + '（技能清单与正文会按需注入，记忆不是它的备份）。'
      + '改动会先弹确认框，用户点头才写入。' },
  { id: 'tool.skill_write.schema.desc', group: 'tools', kind: 'schema', name: 'skill_write 的 schema 描述',
    desc: '新建或改写技能（需要用户确认，可在界面里关掉确认）。',
    text: '新建或改写一份技能（Skill）。用户同意后才会生效；已存在同名技能时是覆盖更新。' },
  { id: 'loop.skill_write.confirm', group: 'loop', kind: 'loop', name: '技能改动确认文案',
    desc: '模型要写技能时，弹出确认框的提示语（{action}/{name} 会被替换）。',
    text: '模型想{action}一份技能：{name}\n它会改变之后每一轮注入给模型的内容——确认它的写法正确再同意。' },
  { id: 'loop.skill_write.denied', group: 'loop', kind: 'loop', name: '技能改动被拒绝时的回话',
    desc: '用户拒绝后回给模型的话。', text: '用户没有同意这次技能改动（{name}）。不要重试，继续原来的任务；需要时可以说明你的建议让他自己改。' },
  { id: 'tool.skill_import.schema.desc', group: 'tools', kind: 'schema', name: 'skill_import 的 schema 描述',
    desc: '从 Markdown 安装技能工具的 schema 描述。',
    text: '从一个 Markdown 文件或目录安装技能（吃 SKILL.md 那套：YAML frontmatter 的 name/description + 正文）。'
      + 'path 指向 .md 文件，或装着 `<技能名>/SKILL.md` 的目录。' },
  { id: 'tool.skill_import.desc', group: 'tools', kind: 'tool', name: '技能安装 skill_import',
    desc: '从磁盘上的 Markdown 安装技能（主流 SKILL.md 结构）。',
    text: '你可以用 skill_import 把磁盘上现成的 Markdown 技能装进来（主流结构是'
      + '`<技能目录>/<技能名>/SKILL.md`，文件开头是 YAML frontmatter 的 name 与 description，'
      + '后面是正文）。用户提到"安装/导入技能""把这些 skill 装进来"时用它。'
      + '路径必须在用户允许的可访问目录里；同名技能会被改写。装完可以用 list_skills 核对。' },
  { id: 'tool.skill_delete.desc', group: 'tools', kind: 'tool', name: '删技能 skill_delete',
    desc: '删除技能的说明（不可逆、要过确认框）。',
    text: '删掉技能表里的一份技能（不可逆，会先弹确认框）。只在用户明确说"删掉这个技能/它没用了"时用；'
      + '不确定就先问一句。删之前用 list_skills 核对名字。' },
  { id: 'tool.skill_delete.schema.desc', group: 'tools', kind: 'schema', name: 'skill_delete 的 schema 描述',
    desc: '删除一份技能。', text: '删除一份技能（按名称）。用户同意后才会删。' },
  { id: 'system.skill_index.intro', group: 'tools', kind: 'helper', name: '技能清单抬头',
    desc: '按需技能清单那一段的开头句（清单本身由界面里配置的技能自动生成）。',
    text: '可用技能（需要时用 use_skill 加载正文）：' },

  /* ---- 插件：文件与目录（🔌 面板里开关；关掉即不注册这些工具、也不再注入本说明） ---- */
  { id: 'plugin.fs.usage', group: 'tools', kind: 'tool', name: '文件与目录工具的使用说明',
    desc: '插件「文件与目录」开启时注入。写清什么时候用哪个工具、路径限制怎么处理，模型才不会乱试。',
    text: '你可以读写用户机器上的文件（工作目录由用户配置的可访问目录限定）：\n'
      + '· 了解结构：先 directory_tree 或 list_directory 看目录，再决定读哪个文件；找文件名用 search_files。\n'
      + '· 读：read_file 带行号；文件很大时用 start_line / end_line 分段读，不要一次要整篇。\n'
      + '· 改：优先 edit_file（给唯一匹配的 old_text）只改动了那几行；整篇重写用 write_file，'
      + '但重写会丢掉你没看到的原有内容，除非确实要整篇替换。\n'
      + '· 路径必须在用户允许的目录内，超出范围会被服务端拒绝——遇到这种错误不要重复尝试，'
      + '告知用户需要在「🔌 插件 → 文件与目录」里放开该目录。\n'
      + '· 删除与覆盖不可逆：delete_path 只在用户明确要求删除时才用。' },
  { id: 'tool.read_file.schema.desc', group: 'tools', kind: 'schema', name: 'read_file 的 schema 描述',
    desc: '读文件（带行号，可分段）。', text: '读取文本文件内容（返回带行号，便于后续 edit_file 精确定位）。大文件用 start_line/end_line 分段读。' },
  { id: 'tool.write_file.schema.desc', group: 'tools', kind: 'schema', name: 'write_file 的 schema 描述',
    desc: '整篇写入/覆盖文件。', text: '把内容整篇写入文件（不存在则创建，已存在则覆盖；父目录会自动创建）。只在确实要整篇替换时用，小改动请用 edit_file。' },
  { id: 'tool.edit_file.schema.desc', group: 'tools', kind: 'schema', name: 'edit_file 的 schema 描述',
    desc: '按原文精确替换（推荐的小改动方式）。',
    text: '把文件里的 old_text 精确替换成 new_text（old_text 必须与文件内容逐字一致且唯一）。小改动首选它，不要整篇重写。' },
  { id: 'tool.list_directory.schema.desc', group: 'tools', kind: 'schema', name: 'list_directory 的 schema 描述',
    desc: '列一层目录。', text: '列出目录下的一层内容（子目录在前，附类型/大小/修改时间）。' },
  { id: 'tool.directory_tree.schema.desc', group: 'tools', kind: 'schema', name: 'directory_tree 的 schema 描述',
    desc: '看目录树（限深）。', text: '以树状展开目录结构（可指定深度，自动跳过 node_modules/.git），用来快速了解一个项目的布局。' },
  { id: 'tool.search_files.schema.desc', group: 'tools', kind: 'schema', name: 'search_files 的 schema 描述',
    desc: '按文件名/路径关键字找文件。', text: '在目录下按文件名（关键字或正则，忽略大小写）递归查找文件，用来定位"那个文件在哪"。' },
  { id: 'tool.get_file_info.schema.desc', group: 'tools', kind: 'schema', name: 'get_file_info 的 schema 描述',
    desc: '看单个文件/目录的属性。', text: '查看路径的类型、大小、权限、属主与时间戳。' },
  { id: 'tool.create_directory.schema.desc', group: 'tools', kind: 'schema', name: 'create_directory 的 schema 描述',
    desc: '新建目录（含父目录）。', text: '创建目录（父目录不存在也会一并创建）。' },
  { id: 'tool.move_file.schema.desc', group: 'tools', kind: 'schema', name: 'move_file 的 schema 描述',
    desc: '移动/重命名。', text: '移动或重命名文件/目录（跨磁盘会自动改为复制后删除；目标已存在时需显式 overwrite:true）。' },
  { id: 'tool.delete_path.schema.desc', group: 'tools', kind: 'schema', name: 'delete_path 的 schema 描述',
    desc: '删除文件/目录（默认不递归）。',
    text: '删除文件或目录。目录非空时必须显式 recursive:true 才会连内容一起删——这是不可逆操作，只在用户明确要求删除时使用。' },

  /* ---- 插件：命令行（默认关闭；开启后按界面的确认设置执行） ---- */
  { id: 'plugin.exec.usage', group: 'tools', kind: 'tool', name: '命令行工具的使用说明',
    desc: '插件「命令行」开启时注入。写清能用它做什么、有哪些限制（含超时硬上限与长任务做法），避免模型拿它去试探系统。',
    text: '你可以用 run_command 在用户机器上执行 shell 命令（以**用户绑定的本机账号**的权限、在允许的目录内运行）：\n'
      + '· 合适的用法：查看环境（uname -a、df -h、nvidia-smi）、统计与文本处理（wc、grep、sort）、'
      + '构建与测试（npm test、python -m pytest）、版本管理（git status/log/diff）、'
      + '跑一段用户明确要求的脚本。\n'
      + '· 不合适的用法：把命令当成绕过文件工具的手段去读写受限目录；安装/卸载软件包、改系统配置。\n'
      + '· **超时（重要）**：每次调用都有超时，到点会**杀掉整条命令的整个进程组**——它启动的所有子进程'
      + '一起被杀，不是"放弃等待、任务继续在后台跑"。实际生效的超时 = ① 用户在面板里设的「单条命令超时」'
      + '（出厂默认 60 秒；不传 timeout_sec 就用它）与 ② 你传的 timeout_sec 二者中更小的那个，'
      + '并且不超过服务端硬上限（默认 600 秒＝10 分钟）。需要一条命令跑得更久时，请用户把面板里的「单条命令超时」调大。\n'
      + '· 条数：这一轮里 run_command 的总条数有限（面板「单轮命令上限」，默认 6 条），省着用。\n'
      + '· **长任务**（生成视频/音频、训练、批量处理这类要跑几分钟以上的活）必须用「提交与等待分离」，'
      + '不要写成"一条命令在前台等到完成"——那样到超时点会被整组杀掉、任务半途中断：\n'
      + '  ① 提交：把任务放到后台并立刻返回，命令本体秒级结束：'
      + '`setsid nohup <命令> > /tmp/任务名.log 2>&1 < /dev/null & echo 已提交`。'
      + '三个细节缺一不可——setsid（脱离进程组）、`> 日志 2>&1`（释放输出管道；漏了这句的话，'
      + '即使加了 &，后台任务也会在超时点被整组杀掉）、`< /dev/null`。'
      + '让任务把进度与结果写进固定的日志或结果文件，否则之后查不到。\n'
      + '  ② 等待：用 wait 工具等一段时间再查进度（单次不超过面板「单次等待上限」，默认 300 秒；'
      + '这一轮能等的次数也有限，面板「单轮等待上限」）——等待与查询交替进行，直到任务完成或确认失败：'
      + 'wait → 查一次日志/结果文件 → 再 wait。不要用 run_command 跑 sleep（白占命令条数），'
      + '也不要 while 循环在前台等。等待期间用户随时可以插话或点「停止」（等待会被立即打断）。'
      + '任务比"单次上限 × 单轮次数"还要久时，提交完就告诉用户"已提交，稍后再来问我进度"'
      + '（下一次提问时各项预算会重新计算）。\n'
      + '· 长时间**常驻的服务**（网站、ComfyUI 服务器本身等）仍请用户自己在终端里起；'
      + '你负责的是提交任务、查进度、取结果。\n'
      + '· 输出有上限，被截断时改用更精确的命令（grep/head/tail）。\n'
      + '· 危险命令（删根、格式化磁盘、关机重启、写块设备等）不会直接执行：界面会弹授权窗口，用户点「授权执行」后才运行；被拒绝就换更安全的做法，不要原样重试。用户明确要求删文件时优先用 delete_path。\n'
      + '· 执行前把"要做什么、为什么"用一句话说清楚；失败时看 stderr 与退出码，不要重复同样的命令。' },
  { id: 'tool.run_command.schema.desc', group: 'tools', kind: 'schema', name: 'run_command 的 schema 描述',
    desc: '执行 shell 命令（cwd 必须在允许目录内；危险命令需用户授权）。',
    text: '执行一条 shell 命令（/bin/sh -c），返回退出码、stdout 与 stderr。以用户绑定的本机账号身份运行（能做到什么由那个账号在系统里的权限决定）；cwd 可选，默认是允许目录的第一个。'
      + '超时会**杀掉整条命令及其所有子进程**（默认 60 秒；可传 timeout_sec，但不超过面板设置，服务端硬上限默认 600 秒）；几分钟以上的任务要用「后台提交 + wait 等待 + 分次查询」，不要在前台等到完成（做法见命令行工具的使用说明）。'
      + '危险命令不会直接执行：界面会弹授权窗口，用户授权后才运行。' },
  { id: 'tool.wait.schema.desc', group: 'tools', kind: 'schema', name: 'wait 的 schema 描述',
    desc: '等待一段时间再继续（长任务轮询进度的中间步骤）。',
    text: '原地等待指定的秒数后返回（不占命令条数、不需要确认）。只用于长任务的「提交后台 → 等待 → 查进度」循环：'
      + '每次等待结束后用 run_command 查一次日志或结果文件，再决定继续等还是收尾。'
      + '单次不超过面板「单次等待上限」（默认 300 秒），传大了按上限算；这一轮等待次数也有限（面板「单轮等待上限」）。'
      + '不要用 wait 代替实际工作，也不要在等用户回复时使用它。' },
  /* ---- 任务清单（todo）：agent 自己决定要不要列，面板右上角悬浮显示给用户看 ---- */
  { id: 'tool.todo_write.desc', group: 'tools', kind: 'tool', name: '任务清单 todo_write',
    desc: '注入给模型的使用说明：什么时候该列 todo、怎么更新、什么时候丢弃。',
    text: '你有一个任务清单工具 `todo_write`（用户界面的右上角会显示这份清单）：\n'
      + '· **什么时候用**：一件事需要多步（大致 ≥3 步）、或用户会关心进度时，动手前先列一份。'
      + '一句话能答完的问题不要用——清单是给"一段有步骤的工作"准备的。\n'
      + '· **怎么写**：一次写全（**全量覆盖**，不是增量）：把要做的事一项一句话排好，状态填 pending；'
      + '每做完一项就再调一次 todo_write，把已完成项标成 completed（清单其余项原样带上）。\n'
      + '· **完成时间由系统记**（你只给 text 与 status，不要自己编时间）；'
      + '**整份清单全部完成时系统会自动丢弃它**——不需要你手动清空，界面上的浮层会随之消失。\n'
      + '· **计划有变**：直接重写整份清单（加项、删项、改措辞都行）——不要让清单和实际做的事对不上；'
      + '只剩下一两项还没做完时也可以把它精简掉。' },
  { id: 'tool.todo_write.schema.desc', group: 'tools', kind: 'schema', name: 'todo_write 的 schema 描述',
    desc: '写/更新任务清单（全量覆盖）的工具描述。',
    text: '写或更新你的任务清单（**全量覆盖**：每次都要给整份清单，不是只给变化的那几项），用户在界面右上角能看到它。'
      + '做多步任务前先列一份（每项一句话、状态 pending），做完一项就把对应项标成 completed；'
      + '全部完成时清单会被自动丢弃，不需要手动清空。简单的一次性问题不要用。' },
  { id: 'plugin.access.full.note', group: 'tools', kind: 'helper', name: '「完全访问」档位的附加说明',
    desc: '访问级别设为「完全访问」时追加注入的一句：让模型知道不必再逐条征求同意（其余档位不注入，由确认框负责）。',
    text: '用户已把访问级别设为「完全访问」：读写文件、执行命令、删除都不需要再逐条征求同意——直接把事做完并说明结果；'
      + '只有在这类操作明显超出当前任务、或用户明确要求先说一声时，才停下来问。'
      + '唯一例外：危险命令（删根、重启、写块设备等）执行前仍会弹授权窗口，等用户点头。' },
  { id: 'plugin.need_login.note', group: 'tools', kind: 'helper', name: '未登录时注入的说明',
    desc: '未登录时插件工具不注册给模型，同时追加这一句，让模型直接用语言回答，而不是空转或反复尝试。',
    text: '用户当前**没有登录**（本站用文档站账号登录），所以文件、目录、命令行这类插件工具本轮不可用'
      + '（它们以用户绑定的本机账号的权限执行，而绑定信息存在用户资料里、要先登录才能取到）。'
      + '不要尝试调用它们：直接用你的知识回答；需要读文件或跑命令时，告诉用户在页面右上角登录后再让你试。' },
  { id: 'plugin.need_login', group: 'loop', kind: 'loop', name: '未登录时被调用工具的回应',
    desc: '未登录却收到插件工具调用时的回话（正常情况下不会发生：未登录不注册这些工具）。',
    text: '文件与命令行工具需要用户先登录（用文档站账号）并绑定一个本机账号才能用——它们以那个绑定账号的权限执行。'
      + '不要重试：改用你已经能做的事直接回答，或请用户登录后在设置里绑定本机账号。' },
  { id: 'plugin.need_bind.note', group: 'tools', kind: 'helper', name: '未绑定本机账号时注入的说明',
    desc: '已登录但还没绑定本机账号时，插件工具不注册给模型，同时追加这一句——让模型直接用语言回答，而不是空转。',
    text: '用户还没有**绑定本机账号**，所以文件、目录、命令行这类工具本轮不可用：它们以绑定账号的权限执行，'
      + '没有绑定就没有可用的身份。不要尝试调用它们；需要读文件或跑命令时，请用户在「设置抽屉 → 本机账号」里绑定一个本机账号'
      + '（绑定时要填那个账号的系统密码来证明归属，密码不会落盘）。' },
  { id: 'plugin.need_bind', group: 'loop', kind: 'loop', name: '未绑定本机账号时被调用工具的回应',
    desc: '已登录但未绑定本机账号，却收到插件工具调用时的回话（正常情况下不会发生：未绑定不注册这些工具）。',
    text: '文件与命令行工具需要用户先在「设置抽屉 → 本机账号」里绑定一个本机账号——Agent 以那个账号的权限执行。'
      + '不要重试：改用你已经能做的事直接回答，或告诉用户去哪里绑定。' },
  { id: 'plugin.need_unlock', group: 'loop', kind: 'loop', name: '绑定账号未解锁时被调用工具的回应',
    desc: '绑定的本机账号与站点进程不是同一个用户时，需要用户在会话里输入一次该账号密码（解锁）；未解锁就调用命令工具时用这句话回应。',
    text: '要执行命令得先用绑定账号的密码解锁一次（密码只在服务端内存里保存、不落盘，站点重启后需要重新解锁）。'
      + '不要重试：请用户在界面上点「解锁」并输入该账号的系统密码，然后再让你继续。' },

  /* ---- 3. loop：循环内注入给模型的短句（原先写死在代码里，现在可改） ---- */
  { id: 'loop.no_content', group: 'loop', kind: 'loop', name: '空回答重试提醒',
    desc: '模型这一轮没写正文（只有思考、或直接停下）时，重试前追加的一句提醒；重试两次仍拿不到正文就报错。',
    text: '【系统提醒】你上一轮只思考或调用工具就停下了，没有写回答正文。请直接用正文回答用户；'
      + '如果确实还需要工具，就继续调用工具。' },
  { id: 'loop.truncated', group: 'loop', kind: 'loop', name: '输出被截断时的工具调用失败提示',
    desc: 'Pi 的截断保护：模型输出撞到 token 上限时，工具参数可能被截断，于是不执行、并要求重发。',
    text: '工具调用「{name}」没有执行：这一轮回答撞到了输出上限，参数可能被截断。请用完整参数重新发起这次调用。' },
  { id: 'loop.unknown_tool', group: 'loop', kind: 'loop', name: '调用了未注册的工具',
    desc: '模型调用了本轮没注册的工具名时的回话。', text: '未知工具 {name}：本轮未注册该工具，请改用已提供的工具或直接作答。' },
  { id: 'loop.budget_search', group: 'loop', kind: 'loop', name: '联网搜索次数用尽',
    desc: '单轮联网检索次数达到上限后回的文本。', text: '本轮联网检索次数已达上限，请基于已有信息直接作答。' },
  { id: 'loop.budget_aux', group: 'loop', kind: 'loop', name: '记忆/技能工具次数用尽',
    desc: '单轮记忆与技能类工具（memory_* / skill_*）调用次数达到上限后回的文本。',
    text: '本轮记忆与技能相关的调用次数已达上限，请基于已有信息直接作答。' },
  { id: 'loop.budget_fs', group: 'loop', kind: 'loop', name: '文件类工具次数用尽',
    desc: '单轮文件与目录调用（read_file/write_file/…）达到上限后回的文本。',
    text: '本轮文件操作次数已达上限，请基于已有信息直接作答，或让用户调大「单轮文件操作上限」。' },
  { id: 'loop.budget_exec', group: 'loop', kind: 'loop', name: '命令执行次数用尽',
    desc: '单轮 run_command 次数达到上限后回的文本。',
    text: '本轮命令执行次数已达上限，请基于已有结果作答，或让用户调大「单轮命令上限」。' },
  { id: 'loop.budget_wait', group: 'loop', kind: 'loop', name: '等待次数用尽',
    desc: '单轮 wait 次数达到上限后回的文本。',
    text: '本轮等待次数已达上限：先查一次进度；任务还没完成就告诉用户"已提交，稍后再来问我进度"（下一轮各项预算会重新计算），不要用 run_command 跑 sleep 绕开这个限制。' },
  { id: 'loop.budget_subagent', group: 'loop', kind: 'loop', name: '子智能体次数用尽',
    desc: '单轮 spawn_agent 次数达到上限后回的文本。',
    text: '本轮派出的子智能体已达上限，请基于已有结果自己继续，或让用户调大「单轮最多派几次」。' },
  { id: 'loop.subagent.intro', group: 'loop', kind: 'loop', name: '子智能体的角色说明',
    desc: 'spawn_agent 起一段子智能体时，加在它 system 提示最前面的角色说明。',
    text: '你是一个**子智能体**：被主对话派来完成一件独立的事，跑在你自己的上下文里。\n'
      + '要求：\n'
      + '1. 只做被派给你的事，不要扩大范围；用工具把事实查清楚再下结论。\n'
      + '2. 不要向用户提问——没有人会回答你。信息不足时按最合理的假设继续，并在结论里说明假设。\n'
      + '3. 最后用**一段话**交付结论：直接给结果与关键依据（路径、命令输出要点、数字），不要复述过程。\n'
      + '4. 结论会原样带回主对话，所以别写"如上所述"这类依赖上下文的说法。' },
  { id: 'loop.subagent.task', group: 'loop', kind: 'loop', name: '子智能体的任务包装',
    desc: '把主对话派下来的任务包成子智能体的第一条用户消息（{task} 是任务本身）。',
    text: '【子任务】{task}' },
  { id: 'loop.subagent.note', group: 'loop', kind: 'loop', name: '子智能体结果的抬头',
    desc: '子智能体返回结论时，主对话工具结果开头的说明（{label} 是标签或任务摘要，{rounds} 是它跑的轮数）。',
    text: '子智能体「{label}」已完成（{rounds} 轮）。结论：' },
  { id: 'loop.plugin_off', group: 'loop', kind: 'loop', name: '插件已停用时的回话',
    desc: '用户把某个插件关掉后，模型仍调用该工具时回的文本（{name} 是工具名）。',
    text: '工具 {name} 所属的插件已被用户关闭（或未登录），不要再用它：请改用已提供的工具，或直接告诉用户你需要它。' },
  { id: 'loop.plugin_denied', group: 'loop', kind: 'loop', name: '插件操作被拒绝时的回话',
    desc: '用户在确认框里点了「拒绝」后回给模型的文本（{name} 是工具名）。',
    text: '用户没有同意这次 {name} 操作。不要重试同样的动作；可以说明你为什么要这么做，或换一种方式完成目标。' },
  { id: 'loop.max_rounds', group: 'loop', kind: 'loop', name: '工具轮次用尽',
    desc: '达到最大工具轮次时停止循环，并在界面上打一条提示。', text: '已达本轮工具调用上限，停止继续调用' },
  { id: 'loop.steering', group: 'loop', kind: 'loop', name: '插话（Steering）包装',
    desc: '用户在生成过程中插话时，包在那条消息外的说明（{text} 是用户原话）。',
    text: '【用户在生成过程中插话】{text}\n请立刻把这条要求并入当前任务：需要改变方向就改变，不必道歉或重复已完成的部分。' },
  { id: 'loop.guard', group: 'loop', kind: 'loop', name: '重复调用保护',
    desc: '同一个工具用相同参数连续调用时，代替真正执行的提醒（避免空转烧 token）。',
    text: '你已经用完全相同的参数调用过 {name}，结果同上，不再重复执行。请换参数、换工具，或基于现有信息作答。' },
  { id: 'loop.text_tool_calls', group: 'loop', kind: 'loop', name: '工具调用被写成正文时的提示',
    desc: '有的上游不把工具调用放进结构化字段，而是写进正文（DSML 标记 / XML 形态）；'
      + '程序会自动认回来并执行，这条提示告诉用户发生了什么（界面上的追踪条）。',
    text: '模型把工具调用写成了正文（上游没有解析成结构化调用），已自动识别并执行。' },
  { id: 'loop.truncated_answer', group: 'loop', kind: 'loop', name: '回答被输出上限截断的提示',
    desc: '这一轮只有正文、又被 token 上限截断（没有工具调用可保护）时打的提示：'
      + '旧实现会把截断的回答当成完整回答静默收下。',
    text: '这一轮回答撞到了输出上限，内容被截断（不是完整回答）。可以说「继续」让它接着写完，或把输出上限调大。' },
  { id: 'loop.retry', group: 'loop', kind: 'loop', name: '上游出错后的重试提示',
    desc: '上游报错（网络类 / 429 / 5xx）时打的提示：暂停 30 秒再自动重试，最多 3 次；'
      + '认证、请求本身有问题（400/404/422）、出口策略挡住的自建地址不重试。'
      + '{err}=错误摘要 {sec}=等待秒数 {n}=第几次 {max}=最多几次。',
    text: '上游出错（{err}），{sec} 秒后自动重试（{n}/{max}）…' },
  { id: 'loop.interrupted', group: 'loop', kind: 'loop', name: '响应被上游掐断时的提醒',
    desc: '流式响应没有正常收尾（没拿到 finish_reason / [DONE]）就被掐断、且这一轮没有工具调用时，'
      + '追加给模型的提醒（最多 2 次，之后报错）；用于避免"半句话被当成最终回答"静默收尾。',
    text: '【系统提醒】你上一轮的输出被上游中断了，没有传完（工具调用可能没发出来）。'
      + '请重新给出完整的一步：直接调用工具继续，或给出最终回答。' },
  { id: 'loop.todo_pending', group: 'loop', kind: 'loop', name: '任务清单没做完就收尾时的提醒',
    desc: '模型要收尾、但自己写的任务清单还有未完成项时，追加给模型的提醒（最多 2 次）；'
      + '明确给出"确实要停就说明原因"的台阶，避免把它顶成死循环。{n}=未完成项数。',
    text: '【系统提醒】你的任务清单还有 {n} 项没完成。请继续做下一步（调用工具）；'
      + '如果确实要停下（例如在等用户确认、或清单本身已过时），就直接说明情况，不要再调用工具。' },

  /* ---- 4. compact：上下文压缩（Pi 的 compaction，提示词同样可改） ---- */
  { id: 'compact.prompt', group: 'compact', kind: 'compact', name: '压缩提示词',
    desc: '上下文接近上限时，用这段指令让模型把较早的对话压成摘要；摘要会代替原文继续发送（原文仍留在会话里可见）。',
    text: '请把下面这段对话压缩成一份可以继续工作的摘要。要求：\n'
      + '① 保留：用户的原始目标与约束、已达成的结论、关键事实与数据、涉及的文件路径/命令/代码要点、'
      + '尚未完成的事项与下一步；\n'
      + '② 丢弃：寒暄、重复的解释、已被推翻的中间过程；\n'
      + '③ 用条目化中文写，不超过 400 字；直接输出摘要正文，不要任何前言后语。' },
  { id: 'compact.header', group: 'compact', kind: 'compact', name: '摘要注入抬头',
    desc: '摘要作为一条消息插进上下文时的抬头（{n} 是被压缩的消息条数）。',
    text: '【较早对话的压缩摘要 · 覆盖前 {n} 条消息】' },

  /* ---- 5. templates：提示词模板（输入框打 / 触发，支持 {{变量}}） ---- */
  { id: 'tpl.explain', group: 'templates', kind: 'template', name: '/解释',
    desc: '解释一段内容：给出功能、输入输出与潜在问题。', text: '请解释下面这段内容的功能、输入输出、以及潜在问题：\n\n{{内容}}' },
  { id: 'tpl.review', group: 'templates', kind: 'template', name: '/审查',
    desc: '审阅一段文字或代码，按重要性列出问题与改法。', text: '请审阅下面的内容，按严重程度列出问题，并给出具体改法（指出依据，不要泛泛而谈）：\n\n{{内容}}' },
  { id: 'tpl.summarize', group: 'templates', kind: 'template', name: '/总结',
    desc: '把长文压成要点。', text: '把下面的内容总结成要点清单，保留关键数据与结论：\n\n{{内容}}' },
];

/* ============================ 实例 ============================ */

/** 造一份独立的提示词登记表实例（覆盖项 / 技能 / 自定义条目 / 订阅者都在闭包里）。
 *  一份实例 = 一轮运行看到的提示词，于是多段运行可以并行：原先模块级单例会被后一轮的
 *  load() 整份换掉（A 运行的 system 区块里混进 B 账号的提示词与技能），
 *  见 lib/agent/run-registry.js 与 lib/agent/run-loop.js。
 *  静态的 DEFAULTS / GROUP_TITLES / SYSTEM_PRESETS 不含状态，仍在模块级共用。 */
/* eslint-disable-next-line max-lines-per-function -- 工厂函数装的是**整个模块体的实例**（内部结构一格没动，只是从模块级单例改成按需现造）：拆开反而让"一份实例的全部代码"散掉，见文件头的说明。 */
export function createPrompts() {
  const byId = new Map(DEFAULTS.map(d => [d.id, d]));
  /** 用户覆盖：{ id: { text?, enabled? } }；技能与模板是用户新增的条目（可删） */
  let overrides = {};
  let skills = [];        // { id, name, description, text, enabled, auto }  auto=true 表示模型可按需加载
  let extra = [];         // 用户新增的其它条目 { id, group, kind, name, desc, text }

  const emitChange = [];

  /** 通知订阅者（宿主据此落盘 + 重绘）。**凡是会改数据的入口都必须调它**：
   *  漏调的后果是"改了没保存"——技能那条就踩过：skill_write 只调了宿主的 save（存的是**设置**），
   *  登记表自己没通知任何人，于是模型建的技能只活在内存里，刷新即丢。
   *  审计：原先旁边还有一个 `onDirty/markDirty` 回调链（全靠调用方自觉触发），全项目**从无订阅者**，
   *  已删除——落盘一律走 notify，只有这一条路。 */
  const notify = (id) => { emitChange.forEach(fn => { try { fn(id); } catch { /* 界面回调异常不影响数据 */ } }); };

  /* ============================ 取值 / 写入 ============================ */

  const isOff = (id) => overrides[id] && overrides[id].enabled === false;

  /** 某条目的最终文本：用户覆盖 > 内置默认（空串 = 用户明确要求为空） */
  function text(id) {
    const o = overrides[id];
    if (o && typeof o.text === 'string') return o.text;
    const d = byId.get(id);
    return d ? d.text : '';
  }
  /** 条目的"用途/描述"：内置条目允许用 <id>.desc 覆盖（技能清单与 <skill> 标签都用它） */
  function descText(id, fallback) {
    const o = overrides[id + '.desc'];
    if (o && typeof o.text === 'string') return o.text;
    return fallback || '';
  }

  const isDefault = (id) => {
    const o = overrides[id]; const d = byId.get(id);
    return !o || (o.text === undefined || o.text === d.text);
  };
  const enabled = (id) => !isOff(id);

  /** 写入覆盖（空串也表示"用户改过"，与默认不同就是 dirty） */
  function set(id, value, on) {
    const o = overrides[id] || (overrides[id] = {});
    if (value !== undefined) o.text = String(value);
    if (on !== undefined) o.enabled = !!on;
    if (o.text === undefined && o.enabled === undefined) delete overrides[id];
    notify(id);
  }
  const setEnabled = (id, on) => set(id, undefined, on);
  const reset = (id) => {
    const d = byId.get(id);
    if (d) overrides[id] = { text: d.text, enabled: true };   // 恢复默认 = 与默认一致
    else delete overrides[id];
    notify(id);
  };

  /* ============================ 条目清单（面板与注入都从这里取） ============================ */

  const GROUP_TITLES = {
    system: '① 系统区块（按顺序拼成 system）',
    skills: '② 技能（Skills：常驻直接注入，按需由模型 use_skill 加载；联网搜索也是一份内置技能）',
    tools: '③ 工具说明',
    loop: '④ 循环内提示（工具结果 / 插话 / 截断保护）',
    compact: '⑤ 上下文压缩',
    templates: '⑥ 提示词模板（输入框打 / 触发，不注入系统提示）',
  };

  /** 全部条目（内置 + 用户新增 + 技能），按注入顺序分组 */
  function all() {
    const list = DEFAULTS.concat(extra).map(d => Object.assign({}, d, {
      desc: descText(d.id, d.desc),
      text: text(d.id), enabled: enabled(d.id), isDefault: isDefault(d.id),
      overridden: !!overrides[d.id] && overrides[d.id].text !== undefined && overrides[d.id].text !== d.text,
      auto: d.auto,                       // 内置技能（如联网搜索）的常驻/按需
      builtin: !!d.builtin,
    }));
    const skillItems = skills.map(s => ({
      id: s.id, group: 'skills', kind: 'skill', name: s.name, desc: s.description,
      text: s.text, enabled: s.enabled !== false, isDefault: false, overridden: false,
      auto: s.auto !== false, custom: true,
    }));
    return list.concat(skillItems);
  }

  /** 系统区块（真正发给模型的 system 拼接顺序） */
  function systemBlocks() {
    const blocks = [];
    all().forEach(e => {
      if (!e.enabled) return;
      if (e.kind === 'system') { if (String(e.text).trim()) blocks.push({ id: e.id, title: e.name, text: e.text }); return; }
      if (e.kind === 'tool') { if (String(e.text).trim()) blocks.push({ id: e.id, title: '工具说明 · ' + e.name, text: e.text }); return; }
      if (e.kind === 'skill' && e.auto === false) {          // 常驻技能：正文直接注入
        if (String(e.text).trim()) blocks.push({ id: e.id, title: '技能 · ' + e.name, text: skillTag(e) });
      }
    });
    return blocks;
  }

  /** 按 agentskills.io 规范包技能：<skill name="…" description="…">正文</skill>
   *  description 优先取用户覆盖（<id>.desc），所以内置技能的"用途"也能在界面上改。 */
  const skillTag = (s) => {
    const d = descText(s.id, s.desc || s.description || '');
    return `<skill name="${String(s.name || '').replace(/"/g, "'")}" description="${String(d).replace(/"/g, "'")}">\n${s.text}\n</skill>`;
  };

  /** 按需技能的清单（只给名字与用途，正文等模型 use_skill 时才给）。
   *  注意别写成 `s.auto !== true === false`：=== 与 !== 同优先级、左结合，
   *  实际算的是 `(s.auto !== true) === false` —— auto 一旦不是严格布尔就语义反转。 */
  const onDemandSkills = () => skills.filter(s => s.enabled !== false && s.auto !== false && String(s.text).trim());

  /** 技能清单区块（有按需技能时追加到 system 末尾） */
  function skillIndexBlock() {
    const list = onDemandSkills();          // 判据与 use_skill 的可加载集合同源（不写第二份）
    if (!list.length || !enabled('system.skill_index.intro')) return null;
    const lines = list.map(s => `- ${s.name}：${s.description || '(未写用途)'}` + (loadedSkills.has(s.id) ? '（本轮已加载）' : ''));
    return { id: 'system.skill_index', title: '可用技能清单', text: text('system.skill_index.intro') + '\n' + lines.join('\n') };
  }

  /* ============================ 技能：按需加载（Pi 的 progressive disclosure） ============================ */

  const loadedSkills = new Set();          // 本次会话里已加载的技能 id
  const markLoaded = (id) => loadedSkills.add(id);
  /** 清空「本轮已加载」标记。换会话 / 清空对话 / 重新登录后必须调：
   *  技能正文只存在于当次 use_skill 的工具结果里，新会话根本没给过——标记不清的话
   *  技能清单会一直显示「（本轮已加载）」，模型据此以为正文还在上下文里，可能凭名字编步骤。
   *  （此前 clearLoaded 是"定义了、导出了、全项目零调用"的死代码，本函数即为此补的接线。） */
  const clearLoaded = () => loadedSkills.clear();
  const loadedList = () => [...loadedSkills];

  function findSkill(ref) {
    const key = String(ref || '').trim().toLowerCase();
    return skills.find(s => s.enabled !== false && (s.name.toLowerCase() === key || s.id.toLowerCase() === key)) || null;
  }

  /* ============================ 提示词模板（{{变量}} 插值） ============================ */

  const templates = () => all().filter(e => e.kind === 'template' && e.enabled && String(e.text).trim());
  const TEMPLATE_VAR = /\{\{\s*([^}]+?)\s*\}\}/g;
  /** 模板里出现过哪些变量名（去重，保持出现顺序）。
   *  参数不叫 text：本模块有个模块级 `text(id)`，同名遮蔽会让读者以为这里在调它。 */
  const templateVars = (tplText) => {
    const out = [];
    String(tplText || '').replace(TEMPLATE_VAR, (m, k) => { if (!out.includes(k)) out.push(k); return m; });
    return out;
  };
  /** 变量填值；返回 { text, missing:[未填的变量] }。
   *  局部变量**不叫 text**：本模块另有一个模块级 `text(id)`（取某条提示词的最终文本），
   *  同名遮蔽会让读者以为这里在调它（eslint no-shadow 也这么判）。 */
  function applyTemplate(tpl, args) {
    const missing = [];
    const filled = String(tpl.text).replace(TEMPLATE_VAR, (m, k) => {
      const v = args && args[k];
      if (v === undefined || v === '') { missing.push(k); return m; }
      return v;
    });
    return { text: filled, missing };
  }

  /* 注：这里原有 adoptLegacy()——把 2.0 之前存在 S.params 里的提示词搬进登记表的一次性迁移。
    界面上的「恢复默认」早已覆盖了它的作用，函数全项目零调用（审计时删除）。
    旧装机若还有 params.systemPrompt 等字段，它们会留在 settings.params 里不影响使用。 */

  /** 序列化进 settings.prompts（存服务器端，按身份隔离） */
  const serialize = () => ({
    overrides: JSON.parse(JSON.stringify(overrides)),
    skills: skills.map(s => ({ id: s.id, name: s.name, description: s.description, text: s.text, enabled: s.enabled !== false, auto: s.auto !== false })),
    extra: extra.map(e => ({ id: e.id, group: e.group, kind: e.kind, name: e.name, desc: e.desc, text: e.text })),
  });

  function load(data) {
    overrides = {};
    skills = [];
    extra = [];
    if (!data || typeof data !== 'object') return;
    if (data.overrides && typeof data.overrides === 'object') {
      for (const [id, o] of Object.entries(data.overrides)) {
        if (!o || typeof o !== 'object') continue;
        const rec = {};
        if (typeof o.text === 'string') rec.text = o.text;
        if (typeof o.enabled === 'boolean') rec.enabled = o.enabled;
        if (Object.keys(rec).length) overrides[id] = rec;
      }
    }
    if (Array.isArray(data.skills)) {
      skills = data.skills.filter(s => s && s.id && s.name).map(s => ({
        id: String(s.id), name: String(s.name), description: String(s.description || ''),
        text: String(s.text || ''), enabled: s.enabled !== false, auto: s.auto !== false,
      }));
      skills.forEach(s => byId.set(s.id, { id: s.id, group: 'skills', kind: 'skill', name: s.name, desc: s.description, text: s.text }));
    }
    if (Array.isArray(data.extra)) {
      extra = data.extra.filter(e => e && e.id && e.name).map(e => ({
        id: String(e.id), group: ['system', 'tools', 'loop', 'compact'].includes(e.group) ? e.group : 'system',
        kind: ['system', 'tool', 'loop', 'compact', 'template'].includes(e.kind) ? e.kind : 'system',
        name: String(e.name), desc: String(e.desc || ''), text: String(e.text || ''),
      }));
      extra.forEach(e => byId.set(e.id, e));
    }
  }

  /* ============================ 技能 / 条目的增删 ============================ */

  const newId = (p) => p + '-' + Math.random().toString(36).slice(2, 8);

  function addSkill(s) {
    const item = {
      id: newId('sk'), name: String(s.name || '新技能').slice(0, 60),
      description: String(s.description || '').slice(0, 300),
      text: String(s.text || ''), enabled: s.enabled !== false, auto: s.auto !== false,
    };
    skills.push(item);
    byId.set(item.id, { id: item.id, group: 'skills', kind: 'skill', name: item.name, desc: item.description, text: item.text });
    notify(item.id);
    return item;
  }
  function updateSkill(id, patch) {
    const s = skills.find(x => x.id === id); if (!s) return null;
    Object.assign(s, {
      name: patch.name !== undefined ? String(patch.name).slice(0, 60) : s.name,
      description: patch.description !== undefined ? String(patch.description).slice(0, 300) : s.description,
      text: patch.text !== undefined ? String(patch.text) : s.text,
      enabled: patch.enabled !== undefined ? !!patch.enabled : s.enabled,
      auto: patch.auto !== undefined ? !!patch.auto : s.auto,
    });
    const d = byId.get(id); if (d) { d.name = s.name; d.desc = s.description; d.text = s.text; }
    notify(id);
    return s;
  }
  function removeSkill(id) {
    skills = skills.filter(s => s.id !== id);
    byId.delete(id);
    delete overrides[id];
    notify(id);
  }

  function addEntry(e) {
    const item = {
      id: newId('px'), group: ['system', 'tools', 'loop', 'compact'].includes(e.group) ? e.group : 'system',
      kind: ['system', 'tool', 'loop', 'compact', 'template'].includes(e.kind) ? e.kind : 'system',
      name: String(e.name || '新条目').slice(0, 60), desc: String(e.desc || ''), text: String(e.text || ''),
    };
    extra.push(item);
    byId.set(item.id, item);
    notify(item.id);
    return item;
  }
  const removeEntry = (id) => {
    extra = extra.filter(e => e.id !== id);
    byId.delete(id);
    delete overrides[id];
    notify(id);
  };

/* ============================ 对外接口 ============================ */

return {
  // 读取
  text, enabled, all, systemBlocks, skillIndexBlock, templates, templateVars, applyTemplate,
  groupTitles: GROUP_TITLES, onDemandSkills, loadedList, findSkill,
  // 写入（每一处都会 notify → 宿主落盘；不要在调用方再补一次保存）
  /* onChange 返回**退订函数**（必须清掉自己注册的那一个）。
     托管运行（lib/agent/run.js）是"一次运行 = 注册一次"的用法，不退订就会：
       · 回调越积越多 → 每改一次数据写 N 遍磁盘；
       · 更严重的是回调闭包捕获了**注册那次运行的账号**，于是 A 跑完、B 再跑时，
         B 的数据会被 A 那个回调写进 A 的账号文件（跨账号覆盖写，2026-10-01 实测复现）。
     实例本身也按运行隔离（一份实例一组订阅者），这道退订纪律依旧是第二道保险。 */
  set, setEnabled, reset, serialize, load,
  onChange: (fn) => {
    emitChange.push(fn);
    return () => { const i = emitChange.indexOf(fn); if (i >= 0) emitChange.splice(i, 1); };
  },
  // 技能与自定义条目
  addSkill, updateSkill, removeSkill, addEntry, removeEntry,
  skills: () => skills.map(s => Object.assign({}, s)),
  markLoaded, clearLoaded,
  presets: SYSTEM_PRESETS,
};
}

/** 默认实例：界面与单测用的那一份（生命周期与页面/进程同长） */
export const Prompts = createPrompts();

