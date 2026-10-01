// chat-utils.js —— 聊天区的行为类小工具：滚动意图、Markdown 渲染与代码复制
// （纯格式化函数一律在 ui/lib/format.js；状态订阅统一用 state/store.js 的 useApp）
import { MD } from '../../core/markdown.js';

/* 状态订阅统一走 state/store.js 的 useApp()（useSyncExternalStore + 快照语义）。
   审计：这里曾另有一份 useAppLive()，理由是"patch 就地改同一个对象、快照引用永不变化，所以
   useApp 不会重渲"——那条理由在 store.js 改成**每次 emit 前重建快照**之后就失效了
   （store.js 的 schedule() 里 snapshot = Object.assign({}, state)），两套订阅原语并存
   只会让"改哪一份生效"变成靠运气。现只保留 useApp，见 store.js。
   侧栏折叠也曾在这里存一份 localStorage 状态：桌面端 App 恒传 prop、手机端不传，
   于是那份状态只在手机分支被读到——一旦残留 `agent.sidebarCollapsed=1`，抽屉会直接
   渲染成空（Sidebar 折叠时 return null）。现在折叠状态**只有 App 的 useState 一个真源**，
   手机分支显式传 false，这里不再保留第二份。 */

/* ============================ 「滚到底」意图 ============================ */

/* 只有用户自己的动作（发送 / 插话）才滚到底；生成过程中绝不自动吸底。
   动作发生时置一个意图位，ChatView 在渲染后的 layout effect 里消费它——
   那时新消息已在 DOM 里，scrollHeight 才是对的（同步 patch 后立刻滚会量到旧高度）。 */
let scrollWanted = false;
export const requestScrollBottom = () => { scrollWanted = true; };
export const takeScrollBottom = () => { const v = scrollWanted; scrollWanted = false; return v; };

/* ============================ Markdown 与代码复制 ============================ */

/** 代码块 HTML：结构与 core 的 styles.css 约定一致（.codeblock / .codeblock-head）；
 *  复制按钮带 data-copy，由聊天区容器上的事件委托统一处理（流式每帧重绘不会堆积监听器）。 */
function codeRenderer(f) {
  const lang = MD.esc(f.lang || 'text');
  return `<div class="codeblock"><div class="codeblock-head"><span>${lang}</span>`
    + `<button type="button" class="md-copy" data-copy title="复制代码">复制</button></div>`
    + `<pre><code>${MD.esc(f.code)}${f.open ? '\n▌' : ''}</code></pre></div>`;
}

/** 渲染正文：MD.render 内部已转义，可安全 dangerouslySetInnerHTML */
export const renderMarkdownHtml = (text) => MD.render(String(text || ''), codeRenderer);

/** 事件委托：点在 [data-copy] 上就复制同一代码块里的 <pre><code>；
 *  流式未闭合代码块末尾的占位符 ▌ 不算内容。返回 true 表示这次点击已被处理。 */
export function handleCodeCopy(e) {
  const btn = e.target && e.target.closest ? e.target.closest('[data-copy]') : null;
  if (!btn) return false;
  const box = btn.closest('.codeblock');
  const codeEl = box && box.querySelector('pre code');
  const text = codeEl ? codeEl.textContent.replace(/\n?▌\s*$/, '') : '';
  const reset = () => { btn.textContent = '复制'; };
  navigator.clipboard.writeText(text)
    .then(() => { btn.textContent = '已复制'; setTimeout(reset, 1200); })
    .catch(() => { btn.textContent = '复制失败'; setTimeout(reset, 1200); });
  return true;
}
