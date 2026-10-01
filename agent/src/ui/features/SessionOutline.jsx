/* SessionOutline.jsx —— 右侧的会话大纲（导航轨）
 *
 *  静默态：每个提问一条小横线（从上到下 = 会话里提问的先后顺序），当前读到的那条略长、用主色；
 *  悬停某条：线变长，左侧浮出一张卡片显示那句话（Markdown 记号已剥掉、超长截断）；
 *  点击：平滑滚到那条提问，并让目标消息闪一下（.ol-target，见 styles.css）。
 *
 *  为什么不做成"按内容比例定位的迷你地图"：那会让挨得近的几条线叠在一起、点击目标也随之变窄；
 *  等距列表既是"目录"，又保证每条线都有一样大的点击区（条数多时由 CSS 自动压缩间距）。
 */
import { useEffect, useMemo, useState } from 'react';
import { outlineLabel } from '../lib/format.js';
import { cn } from '../lib/utils.js';
import { useApp } from '../state/store.js';
import { useIsPhone } from '../lib/useMedia.js';

const PITCH = 14;          // 每条横线的正常垂直间距（px）；条数多到撑破 MAX_H 时自动压缩
const MAX_H = '62vh';      // 导航轨的最大高度：短会话居中一小簇，长会话不会顶到上下边缘
const MIN_ITEMS = 2;       // 只有一个提问时不出大纲
const REF_RATIO = 0.33;    // 视口上方这个比例处当"读到哪"的基准线
const JUMP_OFFSET = 12;    // 跳转后目标提问距顶部的留白（px）
const FLASH_MS = 1700;     // 目标闪烁时长，与 styles.css 的 ol-flash 动画对齐

/** 大纲条目：每条 user 消息一条（下标 mi 用来在 DOM 里找那条消息） */
function buildItems(hist) {
  const out = [];
  for (let i = 0; i < hist.length; i++) {
    const m = hist[i];
    if (!m || m.role !== 'user') continue;
    const label = outlineLabel(m.content);
    if (label) out.push({ mi: i, n: out.length + 1, label });
  }
  return out;
}

/** 单条横线（+ 悬停卡片）：默认只是 12px 宽的小横线，悬停时线变长、卡片淡入 */
function OutlineLine({ it, current, onJump }) {
  const shown = 'group-hover/ol:scale-100 group-hover/ol:opacity-100 group-focus-visible/ol:scale-100 group-focus-visible/ol:opacity-100';
  return (
    <button
      type="button"
      onClick={() => onJump(it)}
      aria-label={`跳到第 ${it.n} 个提问：${it.label}`}
      aria-current={current ? 'true' : undefined}
      className="group/ol relative flex w-7 min-h-0 flex-1 items-center justify-end outline-none"
    >
      <span
        className={cn(
          'h-[2.5px] rounded-full transition-all duration-150',
          current ? 'w-5 bg-primary' : 'w-3 bg-subtle/80',
          'group-hover/ol:w-6 group-hover/ol:bg-foreground group-focus-visible/ol:w-6 group-focus-visible/ol:bg-foreground',
        )}
      />
      <span
        className={cn(
          'pointer-events-none absolute right-full top-1/2 mr-2 w-max max-w-[15rem] -translate-y-1/2 scale-95',
          'rounded-lg border border-border bg-card px-2.5 py-1.5 text-left opacity-0 shadow-lg transition-all duration-150',
          shown,
        )}
      >
        <span className="flex items-start gap-1.5">
          <span className="mt-px shrink-0 text-[10px] tabular-nums text-subtle">{it.n}</span>
          <span className="line-clamp-2 min-w-0 break-words text-xs leading-snug text-foreground">{it.label}</span>
        </span>
      </span>
    </button>
  );
}

export default function SessionOutline({ scrollRef }) {
  const st = useApp();
  const phone = useIsPhone();
  const items = useMemo(() => buildItems(st.history || []), [st.history]);
  const [cur, setCur] = useState(0);            // 当前读到第几条（0 基）
  const show = !phone && items.length >= MIN_ITEMS;

  /* 滚动 / 切会话 / 改窗口尺寸时量一次"读到哪"：以视口上方 1/3 处为基准线，
     最后一条越过基准线的提问就是当前段。rAF 节流，量尺寸集中在一帧里。 */
  useEffect(() => {
    const el = show && scrollRef.current;
    if (!el) return undefined;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const base = el.getBoundingClientRect().top + el.clientHeight * REF_RATIO;
      let idx = 0;
      for (let k = 0; k < items.length; k++) {
        const node = el.querySelector(`[data-mi="${items[k].mi}"]`);
        if (node && node.getBoundingClientRect().top <= base) idx = k;
      }
      setCur(idx);
    };
    const soon = () => { if (!raf) raf = requestAnimationFrame(measure); };
    measure();
    el.addEventListener('scroll', soon, { passive: true });
    window.addEventListener('resize', soon);
    return () => {
      el.removeEventListener('scroll', soon);
      window.removeEventListener('resize', soon);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scrollRef, items, show]);

  const jump = (it) => {
    const el = scrollRef.current;
    const node = el && el.querySelector(`[data-mi="${it.mi}"]`);
    if (!node) return;
    const top = node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - JUMP_OFFSET;
    el.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    setCur(it.n - 1);                            // 先点亮：平滑滚动到位前就有反馈
    node.classList.remove('ol-target');
    void node.offsetWidth;                       // 重排一次，让连续点同一条时动画重新播
    node.classList.add('ol-target');
    setTimeout(() => node.classList.remove('ol-target'), FLASH_MS);
  };

  if (!show) return null;
  return (
    <nav
      aria-label="会话大纲：跳转到某一轮提问"
      className="pointer-events-none absolute right-2.5 top-1/2 z-10 -translate-y-1/2"
    >
      <div
        className="pointer-events-auto flex flex-col items-end"
        style={{ height: `min(${items.length * PITCH}px, ${MAX_H})` }}
      >
        {items.map((it, k) => (
          <OutlineLine key={it.mi} it={it} current={k === cur} onJump={jump} />
        ))}
      </div>
    </nav>
  );
}
