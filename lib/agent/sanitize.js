/** lib/agent/sanitize.js —— Agent 数据的白名单重建（纯函数，无 IO）
 *
 *  服务端只信任白名单字段：客户端发来的对象一律**重建**，丢弃 __proto__ 之类的危险键、
 *  未知键、超长字符串与超量条目。所有"能落盘的形状"都在这里定义，是唯一入口。
 *
 *  密钥约定（与 lib/userdata.js 的合并语义配套）：
 *    · apiKey **缺省或空串** = 保持不变（前端不持有密钥，自然无法回传）；
 *    · apiKey **null** = 显式清除；
 *    · apiKey **非空字符串** = 覆盖。
 *  所以重建时必须**保留 null**、且**不写 undefined 键**，否则"清除"会静默失效。
 *
 *  keyHost：密钥**录入时的主机名**（TOFU，首次信任即钉住）。用途是防"改写 Base URL 把密钥
 *  送去别处"——服务端保存的密钥会作为 Authorization 头发往 baseUrl 指向的主机，
 *  而 baseUrl 是可改字段，于是"改地址 + 留空密钥"就能把用户的密钥寄给任意主机（审计 S5）。
 *  钉住之后，改主机必须重新录入密钥；**钉住动作发生在读路径**（normalize），
 *  所以攻击者抢先改一次也没用：读到的那一次就把旧主机写死了，之后每次请求都判为"主机变了"。
 */

const MAX_LONG = 200 * 1024;
/* 标识符规则的**定义**已收到 lib/ids.js（零依赖叶子模块）：原先这里的字面量在
   userdata / packstore / archive 里还各有一份副本。这里按老名字转出去，
   既有引用（store / projects / files / session 都 require 本模块）保持不变。 */
const {
  ID_RE, PROMPT_ID_RE, ACCOUNT_RE, PROJECT_RE, ENTRY_ID_RE, OS_USER_RE,
} = require('../ids');
/** 协议类型：只认标准两家。旧数据的 'ollama' 在 normalizeProvider 里升级为 openai 兼容 */
const PROVIDER_TYPES = new Set(['openai', 'anthropic']);
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined);

/** 递归净化普通 JSON 值：限深、限键数、限长度，丢弃危险键名 */
function plain(v, depth) {
  if (depth > 6) return undefined;
  if (typeof v === 'string') return v.slice(0, MAX_LONG);
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'boolean' || v === null) return v;
  if (Array.isArray(v)) {
    const out = [];
    for (const it of v.slice(0, 500)) { const s = plain(it, depth + 1); if (s !== undefined) out.push(s); }
    return out;
  }
  if (v && typeof v === 'object') {
    const out = {};
    let n = 0;
    for (const [k, val] of Object.entries(v)) {
      if (BAD_KEYS.has(k) || n++ > 200) continue;
      const s = plain(val, depth + 1);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }
  return undefined;
}

/** 从 Base URL 取主机名（小写，含端口）；取不到返回 '' */
function hostOfUrl(u) {
  try { return String(new URL(String(u || '')).host || '').toLowerCase(); } catch { return ''; }
}
/** keyHost 的白名单：小写主机名（可含端口），长度受限 */
function hostOf(h) {
  const s = String(h || '').trim().toLowerCase();
  return /^[a-z0-9.-]{1,253}(:\d{1,5})?$/.test(s) ? s : '';
}

/** 服务商（模型配置）。apiKey 的三态语义见文件头注释。 */
function provider(p) {
  if (!p || typeof p !== 'object') return null;
  const id = ID_RE.test(String(p.id || '')) ? String(p.id) : '';
  if (!id) return null;
  const out = {
    id,
    name: str(p.name, 80) || '未命名',
    type: PROVIDER_TYPES.has(p.type) ? p.type : 'openai',
  };
  /* 标准协议的 Base URL：必须绝对 http(s)（相对路径没法解析，存下来只会变成"静默不生效"）。
     空/非法一律清空 —— 请求侧会回一句明确的"未填写 Base URL"。
     注：旧 ollama 记录（2.0 之前的数据）**不再补本机默认地址**：本应用不支持本机模型，
     补一个必然被出站策略拒掉的地址只会让人困惑。用户填什么就是什么。 */
  const rawBase = str(p.baseUrl, 500).trim();
  out.baseUrl = /^https?:\/\//i.test(rawBase) ? rawBase : '';
  out.model = str(p.model, 200).trim();
  // apiKey 恒有键：null 表示"清除"，'' 表示"保持原值/没有"——键在不在本身就是信号，
  // 不能省（省了 null 的清除语义就会随 JSON.stringify 一起消失，读回来的形状也不稳定）
  if (p.apiKey === null) out.apiKey = null;
  else out.apiKey = (typeof p.apiKey === 'string' && p.apiKey.trim()) ? p.apiKey.trim().slice(0, 400) : '';
  // 密钥录入时的主机（TOFU 锚点）。只在**当时确实带着密钥**才有意义，见 hostOf 的说明。
  out.keyHost = hostOf(p.keyHost);
  // 可选：模型清单缓存、上下文上限（用量环的分母）、额外请求体/请求头（标准协议的通用逃生口）
  if (Array.isArray(p.models)) out.models = p.models.slice(0, 500).map((m) => str(m, 200)).filter(Boolean);
  const ctx = num(p.ctxLimit);
  if (ctx && ctx >= 512) out.ctxLimit = Math.min(2 ** 24, Math.floor(ctx));
  if (typeof p.extraBody === 'string' && p.extraBody.trim()) out.extraBody = p.extraBody.slice(0, 8000);
  if (p.headers && typeof p.headers === 'object') out.headers = plain(p.headers, 2);
  // 会话标识头的**头名**（值不在配置里：它是"这次对话的 id"，由前端随每次请求带上）。
  // 留空 = 按 Base URL 自动判定（opencode 的 Go 网关就靠这个头路由，见 upstream.js）。
  const sh = str(p.sessionHeader, 64).trim().toLowerCase();
  if (/^[a-z0-9-]{1,64}$/.test(sh)) out.sessionHeader = sh;
  return out;
}

/** 提示词登记表：覆盖项 + 技能 + 自定义条目（会原样注入给模型，属用户数据而非秘密） */
function prompts(p) {
  const out = { overrides: {}, skills: [], extra: [] };
  if (!p || typeof p !== 'object') return out;
  if (p.overrides && typeof p.overrides === 'object') {
    let n = 0;
    for (const [id, o] of Object.entries(p.overrides)) {
      if (n++ > 500 || !PROMPT_ID_RE.test(id) || !o || typeof o !== 'object') continue;
      const rec = {};
      if (typeof o.text === 'string') rec.text = o.text.slice(0, MAX_LONG);
      if (typeof o.enabled === 'boolean') rec.enabled = o.enabled;
      if (Object.keys(rec).length) out.overrides[id] = rec;
    }
  }
  for (const s of Array.isArray(p.skills) ? p.skills.slice(0, 100) : []) {
    if (!s || typeof s !== 'object') continue;
    const text = str(s.text, MAX_LONG);
    if (!text.trim()) continue;
    out.skills.push({
      id: ID_RE.test(String(s.id || '')) ? String(s.id) : 'sk-' + out.skills.length,
      name: str(s.name, 60) || '未命名技能', description: str(s.description, 300), text,
      enabled: s.enabled !== false, auto: s.auto !== false,
    });
  }
  for (const e of Array.isArray(p.extra) ? p.extra.slice(0, 200) : []) {
    if (!e || typeof e !== 'object' || !PROMPT_ID_RE.test(String(e.id || ''))) continue;
    const text = str(e.text, MAX_LONG);
    if (!text.trim()) continue;
    out.extra.push({
      id: String(e.id), group: str(e.group, 20) || 'system', kind: str(e.kind, 20) || 'system',
      name: str(e.name, 60) || '自定义条目', desc: str(e.desc, 300), text,
    });
  }
  return out;
}

/** 记忆条目：白名单重建 + 限长限量 */
function memory(list, max) {
  const out = [];
  for (const e of Array.isArray(list) ? list.slice(0, max || 300) : []) {
    if (!e || typeof e !== 'object') continue;
    const title = str(e.title, 80).trim();
    const content = str(e.content, MAX_LONG);
    if (!title && !content) continue;
    out.push({
      id: ID_RE.test(String(e.id || '')) ? String(e.id) : 'm-' + out.length + '-' + Date.now().toString(36),
      title: title || content.slice(0, 24),
      content,
      tags: (Array.isArray(e.tags) ? e.tags.slice(0, 8) : []).map((t) => str(t, 24)).filter(Boolean),
      ts: num(e.ts) || Date.now(),
      updated: num(e.updated) || num(e.ts) || Date.now(),
      source: e.source === 'model' ? 'model' : 'user',
    });
  }
  return out;
}

/** 可访问目录：只接受绝对路径数组（调用方负责 resolve 与存在性校验） */
function roots(list) {
  return (Array.isArray(list) ? list.slice(0, 64) : [])
    .map((p) => str(p, 500).trim()).filter((p) => p.startsWith('/'));
}

/** 单个绝对路径（项目起点用）：不是绝对路径就当没填（空串 = 回落默认） */
function absPath(p) {
  const s = str(p, 500).trim();
  return s.startsWith('/') && !s.includes('\0') ? s : '';
}

/** 外观：主题模式 / 强调色 / 字号 / 密度 / 消息宽度 */
function theme(t) {
  const o = (t && typeof t === 'object') ? t : {};
  const mode = ['dark', 'light', 'system'].includes(o.mode) ? o.mode : 'dark';
  const accent = ['blue', 'violet', 'emerald', 'amber', 'rose', 'cyan'].includes(o.accent) ? o.accent : 'blue';
  const density = ['compact', 'cozy', 'comfortable'].includes(o.density) ? o.density : 'cozy';
  const scale = num(o.scale);
  return { mode, accent, density, scale: scale ? Math.max(0.8, Math.min(1.3, scale)) : 1 };
}

/** 界面状态（谁在哪、侧栏收没收、抽屉上次开到哪一节）——纯客户端偏好，限长即可 */
function uiState(u) {
  const o = (u && typeof u === 'object') ? u : {};
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (BAD_KEYS.has(k)) continue;
    if (typeof v === 'string') out[k] = v.slice(0, 200);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

module.exports = {
  plain, provider, prompts, memory, roots, absPath, theme, uiState, str, num, hostOf, hostOfUrl,
  ID_RE, PROMPT_ID_RE, ACCOUNT_RE, PROJECT_RE, ENTRY_ID_RE, OS_USER_RE, PROVIDER_TYPES, MAX_LONG,
};
