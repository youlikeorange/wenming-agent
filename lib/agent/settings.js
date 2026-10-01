/** lib/agent/settings.js —— Agent 的**配置**读写（模型 / 参数 / 外观 / 绑定 / 工具）
 *
 *  存在哪：lib/userdata.js 的 platform='agent'，即
 *      STATE_DIR/userdata/<文档站账号>/agent.json
 *  与剧本编辑器同一套「按文档站账号 × 平台」的用户数据层 —— 同一份用户校验（lib/auth.js 的
 *  scrypt + 会话）、同样按账号分目录、同样的密钥只进不出与原子写。换设备登录同一账号，配置跟着走。
 *
 *  为什么配置与大对象分家：本文件只放"小而定型"的配置（服务商、参数、外观、绑定、工具白名单），
 *  单文件上限 256KB；提示词登记表、记忆、会话放在 lib/agent/store.js 的按账号目录里，
 *  它们可能很大且条数多。绑定信息（本机账号）就存在这里，与模型配置同处一份用户资料。
 *
 *  写路径统一串行化（withLock）：设置抽屉的保存与"绑定/可访问目录"这类服务端直写会并发，
 *  读改写不加锁会互相覆盖（userdata.save 只保证不写坏文件，不保证语义不丢更新）。
 */
const userdata = require('../userdata');
const { makeLock } = require('../lock');
const S = require('./sanitize');

const PLATFORM = 'agent';
const MAX_PROVIDERS = 50;

/** 出厂默认。前端 core/params.js 里另有一份"参数的默认值与说明"（那份是展示用的真源），
 *  这里只放"没有它就跑不起来"的结构性默认。 */
const DEFAULTS = {
  version: 2,
  providers: [],
  activeId: '',
  params: {},
  paramsByModel: {},
  theme: { mode: 'dark', accent: 'blue', density: 'cozy', scale: 1 },
  ui: {},
  binding: null,
  /* tools.start：**项目起点**（目录选择器从这里开始、项目根目录必须落在它下面、命令默认 cwd）。
     与 tools.roots（文件工具的可访问范围）是两件事：起点只约束"项目在哪"，
     不限制 agent 能读写哪些目录（那个由 roots ∩ 绑定账号权限决定）。
     注：命令允许清单**不在**这里 —— 它是工具参数 exec_allow（前端 core/params.js），
     随 params 一起存，不要在这里再放一份（审计发现过两套并存的风险）。 */
  tools: { roots: [], start: '' },
  currentSess: null,
};

/* ============================ 读改写（按账号串行） ============================ */

/* 按账号串行化：实现只有一处（lib/agent/lock.js）；本模块自己持有一把，
   锁的是本模块读写的那些文件（跨模块共用一把会因"锁里调另一个加锁函数"而死锁，见 lock.js）。 */
const withLock = makeLock();

/** 读原始配置（含密钥）。只给服务端自己用；下发前端一律走 publicSettings。 */
function read(account) {
  const raw = userdata.load(account, PLATFORM);
  return normalize(raw);
}

/** 补齐结构：旧数据/缺字段一律回落到默认值（缺 providers 不能变成 undefined，否则一调用就炸） */
function normalize(raw) {
  const d = (raw && typeof raw === 'object') ? raw : {};
  const providers = Array.isArray(d.providers) ? d.providers.map((p) => S.provider(p)).filter(Boolean) : [];
  /* 密钥 → 主机 的 TOFU 锚点**在这里补**（读路径），不是写入路径。
     为什么：锚点必须反映"密钥当初是配给谁的"。如果只在保存时钉，那么攻击者抢先改一次
     baseUrl（带着旧密钥、keyHost 还是空）就会被当成"新的合法主机"，锚点被洗白。
     在读路径钉住，则**读到的那一刻**旧记录就被认定在旧主机上，之后任何改主机的保存都过不去。
     旧数据（2.0 之前没有 keyHost）因此自动获得锚点，不需要迁移脚本。 */
  for (const p of providers) {
    if (p.apiKey && !p.keyHost) p.keyHost = S.hostOfUrl(p.baseUrl);
  }
  const out = Object.assign({}, DEFAULTS, {
    providers,
    params: S.plain(d.params, 0) || {},
    paramsByModel: S.plain(d.paramsByModel, 0) || {},
    theme: S.theme(d.theme),
    ui: S.uiState(d.ui),
    binding: bindingOf(d.binding),
    tools: {
      roots: S.roots(d.tools && d.tools.roots),
      start: S.absPath(d.tools && d.tools.start),
    },
    currentSess: S.ID_RE.test(String(d.currentSess || '')) ? String(d.currentSess) : null,
  });
  out.activeId = S.ID_RE.test(String(d.activeId || '')) ? String(d.activeId)
    : (out.providers[0] ? out.providers[0].id : '');
  return out;
}

/** 绑定记录的白名单（**绝不包含密码**：绑定只记"是谁"，解锁凭据只活在内存，见 session.js） */
function bindingOf(b) {
  if (!b || typeof b !== 'object') return null;
  const osUser = String(b.osUser || '').trim();
  if (!S.OS_USER_RE.test(osUser)) return null;      // 规则的真源在 sanitize.js
  const uid = Number(b.uid), gid = Number(b.gid);
  /* uid/gid 本该来自 session.bind 时的 getent（lib/agent/session.js 的 lookupUser），
     但这里是**读**路径，无法确认这条记录出自那次校验；而 uid 0 在 osaccess.permits 里是
     "读写一律放行"的短路（与内核一致）。所以加一条纯数据的一致性前提：
     只有账号名本身就是 root 时，uid 0 才被接受 —— 伪造的 {osUser:'leo', uid:0} 到此为止。 */
  if (uid === 0 && osUser !== 'root') return null;
  return {
    osUser,
    uid: Number.isFinite(uid) ? uid : -1,
    gid: Number.isFinite(gid) ? gid : -1,
    home: String(b.home || '').slice(0, 400),
    shell: String(b.shell || '').slice(0, 200),
    method: b.method === 'same' ? 'same' : 'su',
    boundAt: Number(b.boundAt) || Date.now(),
  };
}

/** 整体覆盖保存（客户端把整份配置发回来；密钥靠 userdata 的合并语义保持）
 *  读 + 净化 + 写**全在锁内**：原先 read/sanitize 在锁外，与"绑定/改可访问目录"这类
 *  patch 并发时会用旧快照整体覆盖，把对方刚写的字段丢掉（丢更新，审计发现）。
 *  @returns 脱敏后的配置 */
async function save(account, incoming) {
  return withLock(account, async () => {
    const prev = read(account);
    const next = sanitizeSettings(incoming, prev);
    await userdata.save(account, PLATFORM, next);
    return publicSettings(account);
  });
}

/** 只改服务端自己关心的某一小块（绑定、可访问目录、当前会话指针）；其余字段原样保留 */
async function patch(account, mutate) {
  return withLock(account, async () => {
    const cur = read(account);
    const next = mutate(Object.assign({}, cur)) || cur;
    next.version = 2;
    await userdata.save(account, PLATFORM, next);
    return next;
  });
}

/* ============================ 净化（客户端提交） ============================ */

/** 字段**没出现**（undefined）= 沿用 prev，出现了 = 按提交的来（空数组 = 显式清空）。
 *  旧实现把缺字段当空数组：POST 不带 providers 就把全部服务商连同密钥清掉。 */
function sanitizeSettings(s, prev) {
  if (!s || typeof s !== 'object') s = {};
  const prevProviders = new Map((prev.providers || []).map((p) => [p.id, p]));
  const src = Array.isArray(s.providers) ? s.providers.slice(0, MAX_PROVIDERS)
    : (Array.isArray(prev.providers) ? prev.providers : []);
  const providers = [];
  for (const p of src) {
    const clean = S.provider(p);
    if (!clean) continue;
    const old = prevProviders.get(clean.id);
    const oldKey = (old && typeof old.apiKey === 'string') ? old.apiKey : '';
    const typedKey = clean.apiKey;                       // 本次请求里带来的密钥（'' = 没改）
    // apiKey 为空串（含"没给"）时，在**返回对象**里补上旧值，让本函数的结果自洽；
    // 落盘那一侧的"保持原值"由 lib/userdata.js 的 mergeSecrets 保证（空串 = 保持）。
    if (typedKey === '') clean.apiKey = oldKey;
    /* 密钥与主机**绑定**（TOFU）：密钥属于"录入它的那台主机"，之后改主机必须重录密钥。
       否则"改 baseUrl + 密钥留空"就能把服务端保存的密钥寄给任意主机（审计 S5）。
       两条分支：
         · 这次**录了密钥** → 它就是配给当前主机的，把锚点重新钉到这里（这就是"换服务商"的正路）；
         · 这次没录密钥 → 锚点沿用旧值，地址与锚点不一致就拒绝保存（密钥不被送走）。
       注意"钉住"也在**读路径**做（normalize）：否则攻击者抢先改一次、锚点还空着，
       就会被当成"新的合法主机"。详见 sanitize.js 的 keyHost 说明。 */
    if (typedKey) {
      clean.keyHost = S.hostOfUrl(clean.baseUrl);
    } else {
      clean.keyHost = (old && old.keyHost) || clean.keyHost || '';
      if (clean.apiKey && clean.keyHost && S.hostOfUrl(clean.baseUrl) !== clean.keyHost) {
        const e = new Error(`服务商「${clean.name}」的 Base URL 主机从 ${clean.keyHost} 改成了 `
          + `${S.hostOfUrl(clean.baseUrl) || '(空)'}：为防密钥被发往新主机，请重新填写一次密钥再保存。`);
        e.status = 400;
        throw e;
      }
    }
    providers.push(clean);
  }
  const wantActive = s.activeId === undefined ? prev.activeId : String(s.activeId || '');
  return Object.assign({}, prev, {
    version: 2,
    providers,
    activeId: S.ID_RE.test(wantActive) ? wantActive : (providers[0] ? providers[0].id : ''),
    params: s.params === undefined ? prev.params : (S.plain(s.params, 0) || {}),
    paramsByModel: s.paramsByModel === undefined ? prev.paramsByModel : (S.plain(s.paramsByModel, 0) || {}),
    theme: s.theme === undefined ? prev.theme : S.theme(s.theme),
    ui: s.ui === undefined ? prev.ui : S.uiState(s.ui),
    tools: s.tools === undefined ? prev.tools : {
      roots: S.roots(s.tools && s.tools.roots),
      // 起点没给 = 沿用旧值（空串 = 回落默认起点，见 roots.startFor）
      start: s.tools.start === undefined ? (prev.tools ? prev.tools.start : '') : S.absPath(s.tools.start),
    },
    currentSess: s.currentSess === undefined ? prev.currentSess
      : (S.ID_RE.test(String(s.currentSess || '')) ? String(s.currentSess) : null),
  });
}

/* ============================ 下发前脱敏 ============================ */

const keyHint = (k) => (k ? '…' + String(k).slice(-4) : '');

function publicProvider(p) {
  const out = Object.assign({}, p, { hasKey: !!p.apiKey, keyHint: keyHint(p.apiKey) });
  delete out.apiKey;
  return out;
}

function publicSettings(account) {
  const s = read(account);
  return Object.assign({}, s, { providers: s.providers.map(publicProvider) });
}

/** 取某个服务商（含密钥）——只给服务端代转用，绝不走 HTTP 输出 */
function providerFor(account, id) {
  const s = read(account);
  return s.providers.find((p) => p.id === String(id || '')) || null;
}

/* ============================ 绑定信息 ============================ */

const getBinding = (account) => read(account).binding;
const hasBinding = (account) => !!read(account).binding;

async function setBinding(account, rec) {
  const binding = bindingOf(rec);
  if (!binding) throw Object.assign(new Error('绑定信息不合法'), { status: 400 });
  await patch(account, (s) => { s.binding = binding; return s; });
  return binding;
}

async function clearBinding(account) {
  await patch(account, (s) => { s.binding = null; return s; });
}

/* ============================ 可访问目录 ============================ */

/* 注：这里原有 AGENT_ROOTS_ENV / defaultRootsFor / rootsFor / settingsFile 与 hasBinding()，
   是"可访问目录"的**旧默认策略**（默认 [docRoot, webRoot] 或绑定账号家目录）。
   2026-09-30 起默认范围放开成 `/`，活正本就是 lib/agent/roots.js（defaultsFor/startFor/list），
   这几个函数全项目零调用（审计时删除），settings 这里只留"存"的原语 setRoots()。 */

/** 写可访问目录（校验/默认值都在 roots.js，这里只落盘） */
async function setRoots(account, list) {
  const clean = S.roots(list);
  await patch(account, (s) => { s.tools.roots = clean; return s; });
  return clean;
}

module.exports = {
  PLATFORM, DEFAULTS, read, save, patch, sanitizeSettings, publicSettings, providerFor,
  getBinding, setBinding, clearBinding,
  setRoots, withLock, normalize, bindingOf,
};
