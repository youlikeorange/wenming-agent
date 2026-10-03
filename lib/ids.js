/** lib/ids.js —— **存储键的命名规则唯一真源**（账号名、各类 id、平台名）
 *
 *  为什么单独立一个零依赖的叶子模块：这些规则原先散在 4 个以上文件里各存一份字面量，
 *  而且已经走偏过（同一个项目 id，一个模块收 `.hidden`、另一个拒收；账号名规则在
 *  sanitize / userdata / packstore / archive 各一份）。谁要校验就 require 这里，
 *  改规则时不会再漏掉某个模块。
 *
 *  只放**跨模块共用**的规则；单模块专用的（包 id、二进制槽位名这类）留在各自模块里。
 *  模块不 require 任何东西（叶子），因此谁都能引用而不引入环。
 */

/** 文档站账号（= 每账号数据目录名）。不接受中文，避免目录名编码差异。
 *  与 OS 用户名规则刻意不同：账号名是"我们的键"，系统账号名是内核的规则。 */
const ACCOUNT_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** 站点账号名（lib/api.js 建/改用户时的规则）。**比 ACCOUNT_RE 严**：不允许点、上限 32。
 *  两套并存是有意的——放宽它会让已存在的账号名语义变化，收窄它会让旧账号登不进来；
 *  这里把差异写成一行注释，而不是继续散两份字面量。 */
const SITE_USER_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** 平台名（lib/userdata.js 的 platform，决定 `<平台>.json` 文件名） */
const PLATFORM_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** 会话 id / 包 id 之类"我们自己生成的键"（点开头也放行：历史数据里有 `.hidden` 这类） */
const ID_RE = /^[A-Za-z0-9._-]{1,48}$/;

/** 提示词登记表条目 id（允许 `:` 分段） */
const PROMPT_ID_RE = /^[A-Za-z0-9._:-]{1,80}$/;

/** 项目 id：允许中文（它是目录名与文件名），不允许路径分隔符、不以点开头 */
const PROJECT_RE = /^[A-Za-z0-9_\u4e00-\u9fa5-][A-Za-z0-9._\u4e00-\u9fa5-]{0,59}$/;

/** 项目记忆条目 id（= .md 文件名主干，比会话 id 宽） */
const ENTRY_ID_RE = /^[A-Za-z0-9._\u4e00-\u9fa5-]{1,48}$/;

/** 本机（系统）账号名：与 Linux 用户名的通行规则一致 */
const OS_USER_RE = /^[a-zA-Z_][a-zA-Z0-9_.-]{0,31}$/;

module.exports = {
  ACCOUNT_RE, SITE_USER_RE, PLATFORM_RE, ID_RE, PROMPT_ID_RE,
  PROJECT_RE, ENTRY_ID_RE, OS_USER_RE,
};
