/* core/presence.js —— 单窗口占用的客户端（被顶掉的窗口冻结，点一下夺回）
 *
 *  服务端每 75 秒内没收到某个窗口的任何请求就算它"已离开"（见 lib/agent/presence.js），
 *  所以这里按 5 秒心跳续期（后台标签页会被浏览器节流，放慢到 20 秒）。
 *  窗口标识（cid）由 core/http.js 统一注入到每个请求头上——本模块不再劫持 window.fetch
 *  （旧实现这么做，换掉请求层就会静默失效）。
 */
import { EP } from './endpoints.js';
import { cid } from './http.js';

const HEARTBEAT_MS = 5000;
const HEARTBEAT_HIDDEN_MS = 20000;

const listeners = [];
export const onChange = (fn) => { if (typeof fn === 'function') listeners.push(fn); };
const emit = () => { for (const fn of listeners) { try { fn(); } catch { /* 回调异常不影响主流程 */ } } };

let active = true;      // 本窗口是否在用（false = 已被别的窗口顶掉）
let owner = null;       // 顶掉我们的一方：{ ip, ua, since, at }
let enforce = true;     // 服务端是否启用单窗口互斥（AGENT_SINGLE_CLIENT=0 时关闭）
let started = false;
let timer = null;

export const isActive = () => active;
export const ownerOf = () => owner;
export const enforced = () => enforce;

/** 主动查询/上位：claim=true 表示夺回（顶掉对方） */
export async function claim(takeover) {
  return call({ cid: cid(), claim: !!takeover });
}

/** 让位（关页/跳转时说一声）；让位不算"被顶掉"，之后照常放行 */
export async function leave() {
  try { return await call({ cid: cid(), leave: true }); } catch { return null; }
}

async function call(body) {
  const r = await fetch(EP.presence, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Client': cid() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const d = await r.json().catch(() => ({}));
  if (r.status === 409 || d.kicked) { setActive(false, d.owner); return d; }
  if (!d.ok) return d;
  enforce = d.enforce !== false;
  if (d.active === false) setActive(false, d.owner);
  else setActive(true, null);
  return d;
}

function setActive(next, who) {
  const changed = active !== next || owner !== who;
  active = next;
  owner = next ? null : who;
  if (changed) emit();
}

/* 任何请求收到"被顶掉"的标记时，也立刻切到冻结态（不必等下一次心跳） */
export function noteKicked(who) { setActive(false, who || null); }

export function start() {
  if (started) return;
  started = true;
  claim(true).catch(() => { /* 服务端不可用时静默：不影响正常使用 */ });
  const tick = () => {
    if (timer) clearTimeout(timer);
    const wait = document.visibilityState === 'hidden' ? HEARTBEAT_HIDDEN_MS : HEARTBEAT_MS;
    timer = setTimeout(async () => {
      try { if (active) await call({ cid: cid() }); } catch { /* 网络抖动：下一次心跳再试 */ }
      tick();
    }, wait);
  };
  tick();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tick(); });
  window.addEventListener('pagehide', () => { leave(); });
}

/* myCid / LOCK_HEADER 原本也挂在这个对象上，全项目零引用（审计时删掉）：
   窗口标识由 core/http.js 统一注入请求头，使用方不需要自己拼。 */
export const Presence = { start, claim, leave, isActive, ownerOf, enforced, onChange, noteKicked };
