/** lib/userdata.js —— 按「文档站账号 × 平台」存用户数据（独立的用户数据层，零依赖）
 *
 *  为什么独立：登录校验（lib/auth.js 的账号/会话）与"各平台自己需要的数据"是两件事。
 *  这里只做后者——每个平台（platform 字符串）一个文件，存它自己的东西：
 *    pack-editor → { providers:[{id,name,baseUrl,apiKey,model}], activeId, perModel:{}, maxRounds, prompts:{} }
 *  登录之后各平台自行取用；换浏览器/换设备只要登录同一个账号，数据跟着走。
 *
 *  端点（都要求文档站登录，见 lib/api.js）：
 *    GET  /api/me/data?platform=xxx   → { ok, platform, data }        data 已脱敏
 *    POST /api/me/data {platform,data}→ { ok, platform, data }        覆盖保存后回脱敏结果
 *
 *  安全：
 *    · 密钥（apiKey/token/secret/password…）**只进不出**：读的时候一律换成 '' + hasKey:true；
 *      写的时候这类字段缺省或空串 = 保持原值（前端不持有密钥，也没法把它抹掉）；
 *    · 目录按账号名消毒，只允许 [A-Za-z0-9_.-]（规则在 lib/ids.js）；单平台数据上限 256 KB；
 *    · 只读当前登录用户自己的目录——路径里没有"用户名"这个可注入参数；
 *    · **写请求要同源**（lib/http 的 sameOrigin）；**服务端托管平台**（agent）整份数据
 *      只读不写——它的配置得走平台自己的端点（见 SERVER_MANAGED 的说明）。
 */
const fs = require('fs');
const path = require('path');
const { json, readJson, sameOrigin } = require('./http');
const { atomicWriteJson } = require('./state');
const { auditLog } = require('./auth');
/* 路径与命名规则的唯一真源：./paths（根目录）、./ids（账号名/平台名） */
const { USERDATA_ROOT, userdataFile } = require('./paths');
const { ACCOUNT_RE: USER_RE, PLATFORM_RE } = require('./ids');

const ROOT = USERDATA_ROOT;
const MAX_BYTES = 256 * 1024;
const SECRET_RE = /^(apikey|api_key|key|token|secret|password|passwd)$/i;

/** **服务端权威字段**：由服务端自己写、客户端只能读的键（按平台）。
 *  为什么要有这张表：本模块是"客户端可整份覆盖"的通用用户数据层，而 agent 平台把
 *  **本机账号绑定**也放在同一个文件里（lib/agent/settings.js）。绑定记录决定工具以什么
 *  身份执行文件与命令，属于授权凭据而不是用户偏好——如果客户端能经 /api/me/data 直接写它，
 *  就等于绕过了 lib/agent/session.js 的密码校验与 lib/agent/osaccess.js 的权限判定
 *  （实测：伪造 {uid:0} 会让 permits() 对 /etc/shadow 一路放行）。
 *  绑定的合法写入路径只有 session.bind/unbind/unlock → settings.setBinding/clearBinding。 */
const SERVER_OWNED = { agent: ['binding'] };

/** **服务端托管平台**：整份数据由平台自己的端点维护，通用通道**只读不写**。
 *  为什么：本通道是"客户端可整份覆盖"的语义——没有字段级净化（agent 的 sanitizeSettings
 *  含"改主机必须重录密钥"的 TOFU 检查）、不持平台自己的写锁、也不做参数 schema 收敛。
 *  留着写 = 在净化旁边常开一条绕过它的路（2026-10-02 审计）。agent 的配置请走
 *  /agent/store/settings；platform 之间互不共享，这里只列真正托管的那些。 */
const SERVER_MANAGED = { agent: true };

/** 客户端这次提交里有没有碰服务端权威字段 */
function forbiddenKeys(platform, data) {
  const owned = SERVER_OWNED[platform];
  if (!owned || !data || typeof data !== 'object' || Array.isArray(data)) return [];
  return owned.filter((k) => Object.prototype.hasOwnProperty.call(data, k));
}

const fileOf = (user, platform) => userdataFile(user, platform);

function readAll(user, platform) {
  if (!USER_RE.test(String(user || '')) || !PLATFORM_RE.test(String(platform || ''))) return {};
  try {
    const raw = fs.readFileSync(fileOf(user, platform), 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch { return {}; }
}

/** 读（带密钥）——只给服务端自己用 */
function load(user, platform) {
  return readAll(user, platform);
}

/** 脱敏：密钥换成空串 + hasKey:true；其余键原样（数组/对象递归） */
function mask(value) {
  if (Array.isArray(value)) return value.map(mask);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_RE.test(k)) {
        const has = typeof v === 'string' && v.length > 0;
        out[k] = '';
        out.hasKey = has;
        continue;
      }
      out[k] = mask(v);
    }
    return out;
  }
  return value;
}

/** 合并保存（三种约定，写进 README）：
 *    · 键**省略** = 保持原值（客户端不必回传密钥，也不会因此丢数据——实测踩过：undefined 会被
 *      JSON.stringify 整个丢掉，密钥文件就这么被写没了）；
 *    · 键为 **null** = 清除该键；
 *    · 密钥类字段给**空串** = 保持原值（前端拿不到密钥，也没法把它抹掉）。 */
function mergeSecrets(prev, next) {
  if (Array.isArray(next)) {
    const prevArr = Array.isArray(prev) ? prev : [];
    // 对象数组里带 id 的（服务商列表就是）**按 id 配对**：否则删/调顺序会把密钥串到别人身上
    const byId = new Map(prevArr.filter((x) => x && typeof x === 'object' && x.id).map((x) => [String(x.id), x]));
    const bothHaveIds = byId.size > 0 && next.some((x) => x && typeof x === 'object' && x.id);
    return next.map((v, i) => {
      const matched = bothHaveIds
        ? (v && typeof v === 'object' && v.id ? byId.get(String(v.id)) : undefined)   // 新项不从别处继承
        : prevArr[i];
      return mergeSecrets(matched, v);
    });
  }
  if (next && typeof next === 'object') {
    const prevObj = prev && typeof prev === 'object' && !Array.isArray(prev) ? prev : {};
    const out = {};
    const keys = new Set([...Object.keys(prevObj), ...Object.keys(next)]);
    for (const k of keys) {
      const pv = prevObj[k];
      const nv = next[k];
      if (nv === undefined) { out[k] = pv; continue; }                  // 省略 = 保持原值
      if (SECRET_RE.test(k)) {
        if (nv === null) { out[k] = ''; continue; }                     // null = 明确清除
        out[k] = (typeof nv === 'string' && nv) ? nv : (typeof pv === 'string' ? pv : '');
        continue;
      }
      out[k] = mergeSecrets(pv, nv);
    }
    return out;
  }
  return next;
}

/** 保存整个平台数据（写前按 prev 补齐密钥），返回脱敏结果 */
async function save(user, platform, data) {
  if (!USER_RE.test(String(user || ''))) throw Object.assign(new Error('账号名不合法'), { status: 400 });
  if (!PLATFORM_RE.test(String(platform || ''))) throw Object.assign(new Error('platform 不合法（小写字母开头，可含数字与 -）'), { status: 400 });
  const merged = mergeSecrets(readAll(user, platform), data && typeof data === 'object' ? data : {});
  const text = JSON.stringify(merged);
  if (Buffer.byteLength(text) > MAX_BYTES) throw Object.assign(new Error(`数据过大（上限 ${Math.round(MAX_BYTES / 1024)} KB）`), { status: 413 });
  fs.mkdirSync(path.dirname(fileOf(user, platform)), { recursive: true, mode: 0o700 });
  await atomicWriteJson(fileOf(user, platform), merged, 2);
  return mask(merged);
}

/** 路由：/api/me/data（GET 取 / POST 存）；session 为 null 时 401 */
async function handleUserData(req, res, url, session) {
  if (!session) return json(res, 401, { ok: false, needLogin: true, error: '需要登录：用户数据按文档站账号保存' });
  if (req.method === 'GET') {
    const platform = String(url.searchParams.get('platform') || '');
    if (!PLATFORM_RE.test(platform)) return json(res, 400, { ok: false, error: 'platform 不合法' });
    return json(res, 200, { ok: true, platform, data: mask(readAll(session.username, platform)) });
  }
  if (req.method === 'POST') {
    if (!sameOrigin(req)) return json(res, 403, { ok: false, error: '跨站请求被拒绝' });
    let body;
    try { body = await readJson(req); } catch (e) { return json(res, e.status || 400, { ok: false, error: 'invalid json' }); }
    const platform = String((body && body.platform) || '');
    // 服务端托管平台：整份数据只读，写入请走平台自己的端点（见 SERVER_MANAGED 的说明）
    if (SERVER_MANAGED[platform]) {
      auditLog(`userdata-save-denied user=${session.username} platform=${platform} reason=server-managed`);
      return json(res, 403, { ok: false, error: `「${platform}」的配置由平台的专用端点维护，这个通用通道不接受它的写入` });
    }
    // 服务端权威字段（agent 的 binding）不接受客户端写入，见 SERVER_OWNED 的说明
    const bad = forbiddenKeys(platform, body && body.data);
    if (bad.length) {
      auditLog(`userdata-save-denied user=${session.username} platform=${platform} keys=${bad.join(',')}`);
      return json(res, 403, { ok: false, error: `这些字段由服务端维护，不能直接保存：${bad.join('、')}` });
    }
    try {
      const data = await save(session.username, platform, body && body.data);
      auditLog(`userdata-save user=${session.username} platform=${platform}`);
      return json(res, 200, { ok: true, platform, data });
    } catch (e) {
      return json(res, e.status || 500, { ok: false, error: e.message });
    }
  }
  return json(res, 405, { ok: false, error: 'method not allowed' });
}

module.exports = {
  handleUserData, load, save, mask, mergeSecrets, forbiddenKeys,
  SERVER_OWNED, SERVER_MANAGED, PLATFORM_RE, ROOT,
};
