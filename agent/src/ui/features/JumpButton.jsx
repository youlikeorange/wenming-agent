// JumpButton.jsx —— 回到底部浮动按钮（圆形图标）：生成中闪烁 ↓、结束后 ✓、滚到底自动隐藏（生成中绝不自动吸底）
import { useEffect, useState } from 'react';
import { ArrowDown, Check } from 'lucide-react';
import { cn } from '../lib/utils.js';
import { useApp } from '../state/store.js';

const nearBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 48;

export default function JumpButton({ scrollRef }) {
  const st = useApp();
  const [atBottom, setAtBottom] = useState(true);

  // 跟着滚动条走（被动监听，不干扰滚动）
  useEffect(() => {
    const el = scrollRef && scrollRef.current;
    if (!el) return undefined;
    const onScroll = () => setAtBottom(nearBottom(el));
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [scrollRef]);

  /* 每次渲染后再复核一次：内容长高/换会话后，"还在不在底部"可能变了。
     故意不写依赖数组（每次渲染后都量一次，同值 setState 会被 React 跳过，不会死循环）。 */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = scrollRef && scrollRef.current;
    if (el) setAtBottom(nearBottom(el));
  });

  const gen = !!st.streaming;
  const show = gen || !atBottom;                 // 生成中常显（提示下面还有内容）
  const jump = () => {
    const el = scrollRef && scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setAtBottom(true);
  };

  return (
    <button
      type="button"
      onClick={jump}
      title={gen ? 'AI 正在输出 · 点击回到底部' : '输出完毕 · 点击回到底部'}
      aria-hidden={!show}
      tabIndex={show ? 0 : -1}
      className={cn(
        'absolute bottom-4 right-5 z-20 grid size-9 place-items-center rounded-full border border-border bg-card shadow-md transition-all',
        gen ? 'animate-pulse text-foreground' : 'text-muted-foreground hover:text-foreground',
        show ? 'opacity-100' : 'pointer-events-none translate-y-2 opacity-0',
      )}
    >
      {gen ? <ArrowDown className="size-4" /> : <Check className="size-4 text-success" />}
    </button>
  );
}
