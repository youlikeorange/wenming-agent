// ChatView.jsx —— 消息列表容器：空状态、压缩摘要与自动裁剪提示条（Marker 风格）、滚动策略、代码复制事件委托
import { useEffect, useLayoutEffect, useRef } from 'react';
import { Bot, Brain, FolderTree, Globe } from 'lucide-react';
import { AgentContext } from '../../core/context.js';
import { openDrawer } from '../state/session.js';
import { compactNow, uncompact } from '../state/settings.js';
import { hooks } from '../state/host.js';
import { patch, useApp } from '../state/store.js';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible.jsx';
import JumpButton from './JumpButton.jsx';
import Message from './Message.jsx';
import SessionOutline from './SessionOutline.jsx';
import { handleCodeCopy, requestScrollBottom, takeScrollBottom } from './chat-utils.js';

/* 欢迎页的建议 chips：点一下把整句填进输入框（不直接发送，用户还能改） */
const SUGGESTIONS = [
  { icon: FolderTree, text: '看看当前项目：列一下目录结构，说说它是做什么的' },
  { icon: Globe, text: '联网搜一下最近值得关注的 AI 动态，给我三条要点' },
  { icon: Brain, text: '记住：我的时区是 Asia/Shanghai，涉及时间时按这个算' },
];

/** 空状态：品牌标记 + 一句话 + 三个可点的建议 chips（底下保留「打 / 用模板」与「生成中回车 = 插话」两条提示） */
function EmptyState() {
  return (
    <div className="rise flex flex-col items-center gap-4 px-6 py-16 text-center">
      <span className="grid size-12 place-items-center rounded-2xl bg-muted text-muted-foreground">
        <Bot className="size-6" />
      </span>
      <div className="space-y-1.5">
        <p className="text-base font-medium">开始对话</p>
        <p className="mx-auto max-w-md text-xs leading-relaxed text-muted-foreground">
          这是一个 Agent：模型会自己决定要不要查文件、联网搜索、记事情、加载技能。
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.text}
            type="button"
            title={s.text}
            onClick={() => patch({ draft: s.text })}
            className="flex max-w-full items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-border-strong hover:bg-muted hover:text-foreground"
          >
            <s.icon className="size-3.5 shrink-0" />
            <span className="truncate">{s.text}</span>
          </button>
        ))}
      </div>
      <p className="text-[11px] leading-relaxed text-subtle">
        输入框打 <code className="rounded bg-muted px-1 font-mono">/</code> 用提示词模板 · 生成中回车 = 插话（下一轮生效）
        <br />
        第一次用：
        <button type="button" className="text-primary underline decoration-dotted" title="打开设置抽屉的模型分区" onClick={() => openDrawer('models')}>
          先在设置里加一个模型
        </button>
      </p>
    </div>
  );
}

/** 压缩摘要：.marker-sep 分隔标签 + .marker 行（展开看摘要，可重新压缩 / 取消压缩） */
function CompactionNotice({ sess }) {
  const cp = sess && sess.compaction;
  if (!cp || !cp.text) return null;
  return (
    <div className="flex flex-col">
      <div className="marker-sep">
        <span>
          上下文已压缩 · 前 <b className="font-semibold text-foreground">{cp.count || 0}</b> 条已压成摘要
          （约 {AgentContext.estTokens(cp.text)} tok）
        </span>
      </div>
      <Collapsible className="marker flex-wrap">
        <div className="flex w-full min-w-0 items-center gap-2">
          <CollapsibleTrigger className="text-[11px] underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground">
            查看摘要
          </CollapsibleTrigger>
          <span className="ml-auto flex shrink-0 items-center gap-3 text-[11px]">
            <button
              type="button"
              className="transition-colors hover:text-foreground"
              title="把较早的对话重新总结成摘要"
              onClick={() => compactNow()}
            >
              重新压缩
            </button>
            <button
              type="button"
              className="transition-colors hover:text-foreground"
              title="取消压缩：原文重新进入上下文"
              onClick={() => uncompact()}
            >
              取消压缩
            </button>
          </span>
        </div>
        <CollapsibleContent className="w-full">
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 font-mono text-[11px] text-foreground">
            {cp.text}
          </pre>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

export default function ChatView() {
  const st = useApp();
  const scrollRef = useRef(null);

  const hist = st.history || [];
  const sess = (st.sessions || []).find((s) => s.id === st.activeSessId) || null;

  /* 滚动策略：只有"用户发送 / 插话"才滚到底。
     session.js 的 send() 会调 hooks.scrollBottom()，Composer 插话时直接调用 chat-utils 的
     requestScrollBottom()——两者都只是置一个意图位；这里在 DOM 更新后的 layout effect 里消费它。
     生成中的每个 chunk 只改内容、不置位，所以绝不自动吸底（用户往上翻不会被拽回来）。 */
  useEffect(() => {
    hooks.scrollBottom = requestScrollBottom;
    return () => { hooks.scrollBottom = () => {}; };
  }, []);
  useLayoutEffect(() => {
    if (!takeScrollBottom()) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  /* 最后一轮：最后一个提问之后（且没有更新的提问）的那条回答——重新生成只挂它 */
  let lastUser = -1;
  for (let k = hist.length - 1; k >= 0; k--) if (hist[k].role === 'user') { lastUser = k; break; }
  let lastAssistant = -1;
  for (let k = hist.length - 1; k > lastUser; k--) if (hist[k].role === 'assistant') { lastAssistant = k; break; }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} onClick={handleCodeCopy} className="scroll-fade-y min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {/* 与输入框同一套内边距、同样拉满主区：两者左右边界严格对齐。
            旧的 max-w-3xl / 52rem 居中列在宽屏下和输入框错开十几个像素，看着就是"没对齐"。 */}
        <div className="flex w-full flex-col px-3 py-4 sm:px-4" style={{ gap: 'var(--msg-gap)' }}>
          {hist.length ? (
            <>
              <CompactionNotice sess={sess} />
              {hist.map((m, i) => (
                <Message
                  /* **稳定 id 优先**：下标当 key 时，删除/回撤一轮会让后面每条消息整体前移，
                     同 key 的组件实例被复用给另一条消息 —— 展开的思考/工具详情"粘"到下一条上
                     （2026-10-01 审计）。id 由发送时生成并随会话落盘（core/sessions.js）。 */
                  key={m.id || `${st.activeSessId || 'mem'}:${i}`}
                  msg={m}
                  index={i}
                  stale={!!(m.streaming && !st.streaming)}
                  isLastRound={i === lastAssistant}
                  busy={!!st.streaming}
                />
              ))}
            </>
          ) : <EmptyState />}
        </div>
      </div>
      <SessionOutline scrollRef={scrollRef} />
      <JumpButton scrollRef={scrollRef} />
    </div>
  );
}
