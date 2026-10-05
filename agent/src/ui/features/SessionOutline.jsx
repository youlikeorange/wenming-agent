/* SessionOutline.jsx —— 会话大纲（按"第几个提问"跳转的导航）
 *
 *  桌面（≥768px）：右侧导航轨——静默态每个提问一条小横线（从上到下 = 提问的先后顺序），
 *    当前读到的那条略长、用主色；悬停某条浮出一张卡片显示那句话；点击滚过去并闪一下。
 *  手机（≤767px）：换成左下角一枚浮标（图标 + "3/8" 当前读到第几轮），点开是**底部列表**：
 *    一条提问一行原文，点一行跳过去。为什么手机上不直接用那根导轨：触屏没有 hover
 *    （Tailwind 的 hover: 包在 @media (hover:hover) 里），横线既说不出"这是哪句"，
 *    条与条也只隔 14px —— 手指按不准；列表每行 40px 高才是能点的目标。
 *
 *  为什么不做成"按内容比例定位的迷你地图"：那会让挨得近的几条线叠在一起、点击目标也随之变窄；
 *  等距列表既是"目录"，又保证每条线都有一样大的点击区（条数多时由 CSS 自动压缩间距）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ListTree } from 'lucide-react';
import { outlineLabel } from '../lib/format.js';
import { cn } from '../lib/utils.js';
import { useApp } from '../state/store.js';
import { useIsPhone } from '../lib/useMedia.js';
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../components/ui/sheet.jsx';

const PITCH = 14;          // 桌面轨：每条横线的正常垂直间距（px）；条数多到撑破 MAX_H 时自动压缩
const MAX_H = '62vh';      // 导航轨的最大高度：短会话居中一小簇，长会话不会顶到上下边缘
export const MIN_ITEMS = 2;   // 只有一个提问时不出大纲（桌面轨与手机浮标同一个门槛）
const REF_RATIO = 0.33;    // 视口上方这个比例处当"读到哪"的基准线
const JUMP_OFFSET = 12;    // 跳转后目标提问距顶部的留白（px）
const FLASH_MS = 1700;     // 目标闪烁时长，与 styles.css 的 ol-flash 动画对齐

/** 大纲条目：每条 user 消息一条（下标 mi 用来在 DOM 里找那条消息） */
export function buildItems(hist) {
  const out = [];
  for (let i = 0; i < hist.length; i++) {
    const m = hist[i];
    if (!m || m.role !== 'user') continue;
    const label = outlineLabel(m.content);
    if (label) out.push({ mi: i, n: out.length + 1, label });
  }
  return out;
}

/** 跳到某条提问：滚到它的位置并让它闪一下（.ol-target，见 styles.css） */
function jumpTo(scrollRef, mi) {
  const el = scrollRef.current;
  const node = el && el.querySelector(`[data-mi="${mi}"]`);
  if (!node) return;
  const top = node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - JUMP_OFFSET;
  el.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  node.classList.remove('ol-target');
  void node.offsetWidth;                       // 重排一次，让连续点同一条时动画重新播
  node.classList.add('ol-target');
  setTimeout(() => node.classList.remove('ol-target'), FLASH_MS);
}

/** "读到哪"：以视口上方 1/3 处为基准线，最后一条越过基准线的提问就是当前段。
 *  滚动 / 切会话 / 改窗口尺寸时重算，rAF 节流，量尺寸集中在一帧里。 */
function useCurrent(scrollRef, items, enabled) {
  const [cur, setCur] = useState(0);
  useEffect(() => {
    const el = enabled && scrollRef.current;
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
  }, [scrollRef, items, enabled]);
  return [cur, setCur];
}

/** 桌面轨的单条横线（+ 悬停卡片）：默认只是 12px 宽的小横线，悬停时线变长、卡片淡入 */
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

/** 桌面轨：贴消息区右缘的一列横线（等距，条数多时由 CSS 自动压缩间距）。
 *  定位在 styles.css 的 .ol-rail（列几乎占满面板时没地方放在列外，就还贴右缘）。 */
function OutlineRail({ items, cur, onJump }) {
  return (
    <nav
      aria-label="会话大纲：跳转到某一轮提问"
      data-ol-rail
      className="ol-rail pointer-events-none absolute top-1/2 z-10 -translate-y-1/2"
    >
      <div
        className="pointer-events-auto flex flex-col items-end"
        style={{ height: `min(${items.length * PITCH}px, ${MAX_H})` }}
      >
        {items.map((it, k) => (
          <OutlineLine key={it.mi} it={it} current={k === cur} onJump={onJump} />
        ))}
      </div>
    </nav>
  );
}

/** 手机列表：一条提问一行原文（点一行 = 跳过去）。自己就是滚动容器——
 *  打开时把"当前读到的"那条滚到中间，用户点开就是想看"我在哪、前后还有哪几轮"。 */
export function OutlineList({ items, cur, onJump, className }) {
  const boxRef = useRef(null);
  useEffect(() => {
    const box = boxRef.current;
    const row = box && box.querySelector('[aria-current="true"]');
    const first = box && box.querySelector('[data-ol-row]');
    if (!box || !row || !first) return;
    /* offsetTop 是布局坐标（不随滚动变），两条相减就是"行在内容里的位置"，
       与 offsetParent 是谁无关——比 scrollIntoView 稳（不会连带滚祖先容器）。 */
    box.scrollTop = Math.max(0, (row.offsetTop - first.offsetTop) - (box.clientHeight - row.clientHeight) / 2);
  }, []);
  return (
    <div ref={boxRef} data-ol-list className={cn('overflow-y-auto overscroll-contain', className)}>
      {items.map((it, k) => (
        <button
          key={it.mi}
          type="button"
          data-ol-row
          onClick={() => onJump(it)}
          aria-label={`跳到第 ${it.n} 个提问：${it.label}`}
          aria-current={k === cur ? 'true' : undefined}
          className={cn(
            'flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2.5 text-left transition-colors',
            k === cur ? 'bg-accent text-accent-foreground' : 'active:bg-muted',
          )}
        >
          <span className={cn('mt-0.5 w-4 shrink-0 text-right text-[11px] tabular-nums',
            k === cur ? 'font-semibold text-primary' : 'text-subtle')}>{it.n}</span>
          <span className="line-clamp-2 min-w-0 flex-1 break-words text-[13px] leading-snug">{it.label}</span>
        </button>
      ))}
    </div>
  );
}

/** 手机：左下角浮标（与右下角的"回到底部"JumpButton 左右对称）+ 底部列表 */
function PhoneOutline({ items, cur, onJump }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="会话大纲：跳转到某一轮提问"
        aria-label={`会话大纲：共 ${items.length} 轮提问，当前第 ${cur + 1} 轮，点开选择`}
        data-ol-fab
        className="absolute bottom-4 left-5 z-20 flex h-9 items-center gap-1.5 rounded-full border border-border bg-card pl-2.5 pr-3 text-[11px] tabular-nums text-muted-foreground shadow-md transition-colors hover:text-foreground"
      >
        <ListTree className="size-4" />
        <span>{cur + 1}/{items.length}</span>
      </button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="w-full sm:max-w-none">
          <SheetHeader>
            <SheetTitle>会话大纲</SheetTitle>
            <SheetDescription>
              共 {items.length} 轮提问，点一条跳过去（现在读到第 {cur + 1} 轮）。
            </SheetDescription>
          </SheetHeader>
          <SheetBody className="flex min-h-0 flex-col p-0">
            {/* 点一条就跳：先收起列表（跳过去的位置在下面，不收起来用户看不见落点） */}
            <OutlineList items={items} cur={cur} className="min-h-0 flex-1 px-2 pb-3"
              onJump={(it) => { setOpen(false); onJump(it); }} />
          </SheetBody>
        </SheetContent>
      </Sheet>
    </>
  );
}

export default function SessionOutline({ scrollRef }) {
  const st = useApp();
  const phone = useIsPhone();
  const items = useMemo(() => buildItems(st.history || []), [st.history]);
  const show = items.length >= MIN_ITEMS;
  const [cur, setCur] = useCurrent(scrollRef, items, show);

  if (!show) return null;
  const jump = (it) => {
    setCur(it.n - 1);                            // 先点亮：平滑滚动到位前就有反馈
    jumpTo(scrollRef, it.mi);
  };
  return phone
    ? <PhoneOutline items={items} cur={cur} onJump={jump} />
    : <OutlineRail items={items} cur={cur} onJump={jump} />;
}
