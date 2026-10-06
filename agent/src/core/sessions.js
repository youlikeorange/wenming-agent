/* core/sessions.js —— 会话形状的**共用规则**（浏览器与服务端托管运行同一份实现）
 *
 *  为什么在 core：这几条规则两端都要用，各写一份就会出现"两边对同一条会话的看法不一样"。
 *  已经真实发生过两回：
 *    · 标题规则一份在 ui/state/host.js、一份在 lib/agent/run.js —— 谁落盘谁的标题；
 *    · "本轮提问不要追加两遍"只在服务端靠 trimTrailingQuestion 打补丁，
 *      而服务端自己又把提问交给 buildMessages 追加了一次（2026-10-01 实测：发两遍）。
 *  所以收敛到这里：**纯函数、不碰 DOM、不认识存储**，谁都能 import。
 */

/** 标题：第一条有内容的用户消息的前 26 字（没有就返回空串，交给调用方保留原值） */
export function titleFrom(msgs) {
  const first = (Array.isArray(msgs) ? msgs : []).find((m) => m && m.role === 'user' && m.content);
  if (!first) return '';
  return String(first.content).slice(0, 26).replace(/\s+/g, ' ').trim();
}

/** 消息 id：界面拿它当 React key（**下标当 key 会在删除/回撤后错位**：展开的思考/工具详情
 *  会粘到下一条消息上）。持久化时随消息一起走，跨刷新保持稳定。 */
export const newMsgId = () => 'm-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/** 防御性兜底：老客户端可能把"本条提问"也放进 history 末尾（服务端会再追加一次）——
 *  末条与本次提问**逐字相同**就摘掉（空提问不动）。 */
export function trimTrailingQuestion(history, text) {
  const out = Array.isArray(history) ? history.slice() : [];
  const t = String(text || '');
  const last = out[out.length - 1];
  if (t && last && last.role === 'user' && String(last.content || '') === t) out.pop();
  return out;
}

/** 服务端该采用哪一份历史：**客户端交上来的**，还是**自己落盘的那份**。
 *
 *  客户端每次发送都会把"本地那份完整历史"交上来（含未落盘的本地编辑），正常情况它就是最新的。
 *  但它可能**落后一轮**：一轮结束后 1.5 秒内切走会话（重拉被跳过）、或那次重拉失败时，
 *  客户端会话对象还停在运行前的快照。此时若以它为准，服务端刚跑完的那一轮会被整份覆盖
 *  （2026-10-01 审计：实测的数据丢失路径）。
 *
 *  判据：客户端那份是服务端那份的**严格前缀**（逐条 role + content 相同）→ 客户端落后，用服务端的。
 *  其余情况一律以客户端为准——用户在本地的显式编辑（回撤/删除/改标题）优先于服务端快照。
 *  调用方在"本地还有没落盘的改动"时直接传 localEdits=true 跳过这段判断（那时前缀相同也可能是
 *  "用户刚删掉了最后一轮"，不能拿服务端的把它变回来）。
 */
export function reconcileHistory(serverMsgs, clientHistory, { localEdits } = {}) {
  const sv = Array.isArray(serverMsgs) ? serverMsgs : [];
  const cl = Array.isArray(clientHistory) ? clientHistory : [];
  /* **本地显式编辑永远以客户端为准（含"剔空"）**。旧写法 `if (localEdits || !cl.length)
     return cl.length ? cl : sv` 里，空客户端历史会短路 localEdits——「重新生成第一轮」
     恰好把历史剔成空数组（slice(0,0)），防线被绕过，服务端那份（含要剔除的旧回复）
     被整份采用，旧回答就留在了上下文里（2026-10-06 用户报的"重新生成没剔除"）。
     现在：localEdits=true 一律用客户端（空就是空）；只有"客户端没给历史且不是编辑"
     （非编辑场景的保守兜底）才用服务端的。 */
  if (localEdits) return cl;
  if (!cl.length) return sv;
  if (sv.length <= cl.length) return cl;
  for (let i = 0; i < cl.length; i++) {
    const a = sv[i] || {}, b = cl[i] || {};
    if (String(a.role) !== String(b.role)) return cl;
    if (String(a.content == null ? '' : a.content) !== String(b.content == null ? '' : b.content)) return cl;
  }
  return sv;                       // 客户端那份是严格前缀：它落后了，用服务端的（更完整）
}

export const Sessions = { titleFrom, newMsgId, trimTrailingQuestion, reconcileHistory };
