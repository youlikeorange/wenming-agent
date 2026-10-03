/** lib/paths.js —— **STATE_DIR 下存储布局的唯一真源**
 *
 *  为什么要有它：路径拼接原先散在六个模块里各自 `path.join(STATE_DIR, …)`，
 *  "账号目录"这个函数也各写一遍（store / archive / projects / files / packstore / userdata），
 *  改一次布局要同步六处，漏一处就是"写 A 读 B"。
 *
 *  这里只做两件事：**拼路径**与**账号名校验**——原子写、锁、净化仍在各自模块里，
 *  所以本模块是零副作用的叶子（只 require 纯常量模块）。
 *
 *  调用约定：`accountDir` 系列在账号名不合法时返回 **null**（调用方必须处理）。
 *  把"校验"和"拼路径"合成一步，就不会出现"校验漏了但路径照拼"。
 *  模块内部的子目录（如 packstore 的 `packs/<id>/b`）留在各自模块里拼——那是它自己的布局。
 */
const path = require('path');
const { STATE_DIR } = require('./config');
const { ACCOUNT_RE, PLATFORM_RE } = require('./ids');

/* ---------- 站点级（不分账号） ---------- */
const PERM_FILE = path.join(STATE_DIR, 'permissions.json');
const SESSIONS_FILE = path.join(STATE_DIR, 'sessions.json');
const UPLOADS_FILE = path.join(STATE_DIR, 'uploads.json');
const AUTH_LOG = path.join(STATE_DIR, 'auth.log');
/** 文档保存留档：`STATE_DIR/history/<相对路径>/<时间戳>.md`（见 lib/docs.js） */
const HISTORY_ROOT = path.join(STATE_DIR, 'history');

/* ---------- 账号级根目录 ---------- */
/** `<账号>/<平台>.json`（lib/userdata.js） */
const USERDATA_ROOT = path.join(STATE_DIR, 'userdata');
/** `<账号>/packs/<包id>/…`（lib/packstore.js） */
const PACKSTORE_ROOT = path.join(STATE_DIR, 'packstore');
/** `<账号>/{sessions,memory,prompts,projects,archive,downloads}`（lib/agent/*） */
const AGENT_ROOT = path.join(STATE_DIR, 'agent');

const validAccount = (account) => ACCOUNT_RE.test(String(account || ''));

/** 账号目录；账号名不合法 → null。root 用上面导出的三个根之一 */
const accountDir = (root, account) => (validAccount(account) ? path.join(root, String(account)) : null);

const userdataDir = (account) => accountDir(USERDATA_ROOT, account);

/** `<userdata>/<账号>/<平台>.json`；账号名或平台名不合法 → null */
const userdataFile = (account, platform) => {
  const d = userdataDir(account);
  return d && PLATFORM_RE.test(String(platform || '')) ? path.join(d, `${platform}.json`) : null;
};

/** `<agent>/<账号>`（会话/记忆/提示词/项目/归档/待下载都在它下面） */
const agentDir = (account) => accountDir(AGENT_ROOT, account);

/** `<packstore>/<账号>` */
const packstoreDir = (account) => accountDir(PACKSTORE_ROOT, account);

module.exports = {
  STATE_DIR,
  PERM_FILE, SESSIONS_FILE, UPLOADS_FILE, AUTH_LOG, HISTORY_ROOT,
  USERDATA_ROOT, PACKSTORE_ROOT, AGENT_ROOT,
  validAccount, accountDir, userdataDir, userdataFile, agentDir, packstoreDir,
};
