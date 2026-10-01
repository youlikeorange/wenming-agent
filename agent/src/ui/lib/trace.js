/* ui/lib/trace.js —— 追踪条条目的**纯函数**：规范化、分类、收尾合并（可在 Node 下单测）
 *
 *  为什么单独一个模块：追踪条条目的字段语义原先靠**中文文案**当判据——
 *  TraceStrip 用 `t.note === '进行中'` 判断在跑、用 `t.note === '插话'` 判断插话，
 *  session.js 收尾合并时又用 `t.note === '插话'` 过滤一遍。改一句界面文案就会悄悄改掉逻辑
 *  （而"进行中"恰恰是会被 onToolEnd 覆写成真实备注的字段），审计把它收敛成结构化字段：
 *
 *    kind  : 'tool'   工具调用（默认）
 *            'sub'    子智能体（spawn_agent 起的那一段：过程实时显示，结论回到主对话）
 *            'notice' 提示条（内核 onNotice 打的：正文里的调用已识别 / 回答被截断 / 轮次用尽…）
 *            'steer'  插话（用户在生成中输入）
 *            'compact' 压缩（上下文压缩的中间态）
 *    state : 'running' | 'done'（缺省 = done）
 *
 *  旧会话（磁盘上的历史消息）没有这两个字段，normalizeTrace 会按文案**回推一次**，
 *  这样界面代码里再也不需要出现 `note === '进行中'` 这种判断。
 */

const KINDS = new Set(['tool', 'sub', 'notice', 'steer', 'compact']);

/** 条目的类别（缺省 tool；旧数据没有 kind 字段） */
export const traceKind = (t) => (t && KINDS.has(t.kind) ? t.kind : 'tool');

/** 是否还在进行中：优先看 state；旧数据（没有 state）按当时的文案回推 */
export const traceRunning = (t) => !!(t && (t.state ? t.state === 'running' : t.note === '进行中'));

/** 规范化一条目：补上 kind/state 两个字段（不动其它字段，返回新对象） */
export function normalizeTrace(t) {
  const src = t || {};
  return Object.assign({}, src, {
    kind: traceKind(src),
    state: traceRunning(src) ? 'running' : 'done',
  });
}

/**
 * 收尾时把"实时列表"与"内核记录"合并成最终要落盘的那一份。
 *
 *  · live：界面上实时长出来的条目（工具条 + 提示条 + 插话条，顺序即当时看到的顺序）
 *  · core：内核 trace（只有工具记录，但结果/耗时口径与落盘一致）
 *  · steering：本次插话（统一放到最前面，与 live 里的重复条目只留一份）
 *
 *  规则：插话条跳过（由 steering 统一给）；提示条原样保留在它出现的位置；
 *  工具条换成内核那份（按 label 对齐，保持先后顺序）。
 *  （原实现内联在 session.js 的 send() 里，用 note === '插话' 过滤，见文件头注释。）
 */
export function mergeTrace(live, core, steering) {
  const l = (Array.isArray(live) ? live : []).map(normalizeTrace);
  const c = (Array.isArray(core) ? core : []).map(normalizeTrace);
  const s = (Array.isArray(steering) ? steering : []).map(normalizeTrace);
  const out = [];
  let ti = 0;
  for (const t of l) {
    if (t.kind === 'steer') continue;
    if (t.kind === 'notice') { out.push(t); continue; }
    const hit = c.findIndex((k, i) => i >= ti && k.label === t.label);
    if (hit >= 0) { out.push(c[hit]); ti = hit + 1; } else out.push(t);
  }
  out.push(...c.slice(ti));
  return [...s, ...out];
}
