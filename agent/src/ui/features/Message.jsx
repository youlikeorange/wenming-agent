// Message.jsx —— 单条消息：助手 ghost 气泡（无框、整行排版）/ 用户右侧气泡（按内容收缩，≤80% 宽）
// （思考折叠、追踪条 Marker、Markdown 正文、元信息、悬停操作；视觉规范见 styles.css 的 .marker/.shimmer）
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, ChevronRight, Copy, RefreshCw, Trash2 } from 'lucide-react';
import { deleteRound, regenerateLast } from '../state/session.js';
import { askConfirm } from '../state/host.js';
import { Button } from '../components/ui/button.jsx';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible.jsx';
import { toast } from '../components/ui/toast.jsx';
import { cn } from '../lib/utils.js';
import TraceStrip from './TraceStrip.jsx';
import { renderMarkdownHtml } from './chat-utils.js';
import { statsParts } from '../lib/format.js';

const ACT_CLS = 'h-6 gap-1 px-1.5 text-[11px] text-subtle hover:text-foreground';

/** 一条消息的操作行（悬停/聚焦出现；触屏由 .touch-visible 常显） */
function Actions({ children, alignRight }) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/msg:opacity-100 touch-visible',
        alignRight && 'justify-end',
      )}
    >
      {children}
    </div>
  );
}

/** 助手消息的思考过程：最低调的折叠行（无边框、无底色），流式时自动展开（结束时收回），标题带字数。
 *  正文只渲染一部分：思考动辄几万字，整段塞进 <pre> 会让每次重渲都要重新布局；
 *  流式期间更只画末尾（与正文同一个理由：每帧重排成本要恒定，见 STREAM_TAIL_AT）。 */
const THINK_RENDER = 60000;
const THINK_TAIL_AT = 20000;
const THINK_TAIL = 3000;
function Thinking({ text, streaming }) {
  const [open, setOpen] = useState(!!streaming);
  useEffect(() => { setOpen(!!streaming); }, [streaming]);
  if (!text) return null;
  const tailMode = !!streaming && text.length > THINK_TAIL_AT;
  const shown = tailMode ? text.slice(-THINK_TAIL) : (text.length > THINK_RENDER ? text.slice(0, THINK_RENDER) : text);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        title="模型自己的推理过程（不是最终回答）"
        className="flex w-full items-center gap-1.5 py-0.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')} />
        思考过程（{text.length} 字）
        {streaming ? <span className="shimmer">· 正在思考</span> : null}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words border-l border-dashed border-border py-1 pl-3 font-sans text-xs leading-relaxed text-muted-foreground">
          {shown}
          {tailMode ? `\n…（生成中只显示末尾 ${THINK_TAIL} 字，共 ${text.length} 字）`
            : text.length > THINK_RENDER ? `\n…（只显示前 ${THINK_RENDER} 字，共 ${text.length} 字）` : ''}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** 元信息 + 未跑完 / 空回答的说明（元信息只用一行小字，不做徽章） */
function Meta({ msg, stale }) {
  const parts = statsParts(msg.stats, msg.wallMs, msg.content);
  const empty = !msg.streaming && !stale && !msg.content && !msg.thinking
    && !(msg.trace || []).length && !msg.error;
  return (
    <>
      {msg.error ? <p className="text-xs leading-relaxed text-destructive">{msg.error}</p> : null}
      {stale ? (
        <p className="text-[11px] leading-relaxed text-warning">
          {msg.content ? '这一轮没有跑完（生成被中断），下面是已经生成的部分。' : '这一轮没有跑完（生成被中断），没有内容保存下来，可以重新提问。'}
        </p>
      ) : null}
      {empty ? <p className="text-[11px] text-subtle">这一轮没有返回内容（模型空回答）。</p> : null}
      {parts.length ? (
        <p className="text-[11px] tabular-nums text-subtle" title="tok/s · tokens · 耗时（服务端返回 usage 时才有）">
          {parts.join(' · ')}
        </p>
      ) : null}
    </>
  );
}

/* 单条消息最多渲染多少字符：正常回答远小于它；真出现"把整个文件写进正文"这类极端内容时，
   只渲染前一段并在末尾注明（否则 Markdown 解析 + DOM 布局会把页面拖死）。
   这种消息的「复制」直接取原文，不会只复制到渲染出来的那一段。 */
const MAX_RENDER = 200000;

/* 流式期间正文很大时只渲染"尾巴"（2026-09-30 实测）：
   把整篇正文塞进 DOM 之后，**每一帧**都要为它重排/重绘；正文一大（几十万字的正文 = 上千个
   块级元素），流式的每 ~100ms 一次重绘就把主线程占满——页面点不动、打不了字，渲染进程 100% CPU。
   超过阈值后改成"纯文本尾巴"（几 KB、重绘成本恒定），这一轮结束时再整体渲染一次 Markdown。
   正常长度的回答（< 2 万字）不受影响，仍是实时 Markdown。 */
const STREAM_TAIL_AT = 20000;
const STREAM_TAIL = 3000;

function Message({ msg, index, stale, isLastRound, busy }) {
  const bodyRef = useRef(null);
  const isUser = msg.role === 'user';

  /* Markdown 渲染是整条消息最贵的一步，且结果只取决于正文：
     用 useMemo 把"工具条更新 / 状态变化引起的重渲"挡在渲染之外（否则每来一条追踪条
     就要把整篇正文重新解析一遍）。流式的正文变化仍会照常重算——频率由
     session.js 的 touchSoon 节流到 ~12fps。 */
  const raw = String(msg.content || '');
  const clipped = raw.length > MAX_RENDER;
  const shown = useMemo(() => (clipped ? raw.slice(0, MAX_RENDER) : raw), [raw, clipped]);
  const tailMode = !!msg.streaming && raw.length > STREAM_TAIL_AT;   // 流式中且正文很大：只画尾巴
  const html = useMemo(() => (tailMode ? '' : renderMarkdownHtml(shown)), [shown, tailMode]);
  const tail = tailMode ? raw.slice(-STREAM_TAIL) : '';

  const copy = () => {
    /* 超过渲染上限、或流式尾巴模式：DOM 里只有一部分，复制必须用原文（否则静默复制半截） */
    if (clipped || tailMode) {
      navigator.clipboard.writeText(raw)
        .then(() => toast('正文过长：已复制完整全文（' + raw.length + ' 字）', 'ok'))
        .catch(() => toast('复制失败：浏览器没有授权剪贴板', 'err'));
      return;
    }
    const el = bodyRef.current;
    if (!el) return;
    const clone = el.cloneNode(true);
    clone.querySelectorAll('button').forEach((b) => b.remove());   // 代码块的"复制"不混进正文
    const text = (clone.innerText || clone.textContent || '').trim();
    if (!text) { toast('这条消息没有正文', 'err'); return; }
    navigator.clipboard.writeText(text)
      .then(() => toast('已复制', 'ok'))
      .catch(() => toast('复制失败：浏览器没有授权剪贴板', 'err'));
  };

  /* 确认走全局的 askConfirm（队列化 + 与工具确认框同一外观）——不再各组件自带一份弹窗 */
  const askDeleteRound = async () => {
    const r = await askConfirm({
      title: '删除这一轮？', body: '这一轮的提问与回答都会从对话里移除，不可恢复。', okText: '删除', danger: true,
    });
    if (r.ok) deleteRound(index);
  };

  const actions = (
    <>
      <Button variant="ghost" size="sm" className={ACT_CLS} title="复制正文（代码块里的「复制」只复制代码）" onClick={copy}>
        <Copy className="size-3.5" />复制
      </Button>
      {!isUser && isLastRound ? (
        <Button
          variant="ghost" size="sm"
          className={cn(ACT_CLS, busy && 'opacity-50')}
          disabled={busy}
          title={busy ? '生成中不可重新生成：先点「停止」' : '按原提问重新生成回答（只对最后一轮开放）'}
          onClick={() => regenerateLast()}
        >
          <RefreshCw className="size-3.5" />重新生成
        </Button>
      ) : null}
      <Button
        variant="ghost" size="sm"
        className={cn(ACT_CLS, 'hover:text-destructive', busy && 'opacity-50')}
        disabled={busy}
        title={busy ? '生成中不可删除：先点「停止」' : (isUser ? '删除这条提问及其回答' : '删除这一轮问答')}
        onClick={askDeleteRound}
      >
        <Trash2 className="size-3.5" />删除这一轮
      </Button>
    </>
  );

  if (isUser) {
    return (
      <div className="group/msg flex flex-col items-end gap-1">
        <div
          ref={bodyRef}
          className="md w-fit max-w-[80%] rounded-2xl bg-user-bubble px-3.5 py-2.5 text-user-bubble-foreground [&_.codeblock]:text-foreground [&_.md-code]:text-foreground"
          dangerouslySetInnerHTML={{ __html: html }}
        />
        <Actions alignRight>{actions}</Actions>
      </div>
    );
  }

  /* 流式刚起步、还没有任何正文/推理时，用一行 shimmer 状态顶住空窗（Marker 的 status 用法） */
  const pending = !!msg.streaming && !msg.content && !msg.thinking;

  return (
    <div className="group/msg flex items-start gap-2.5">
      <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground" title="助手">
        <Bot className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Thinking text={msg.thinking} streaming={!!msg.streaming} />
        {(msg.trace || []).map((t, i) => <TraceStrip key={`${i}-${t.label || t.name || ''}`} trace={t} />)}
        {pending ? (
          <div className="marker" role="status">
            <span className="shimmer text-xs">正在思考…</span>
          </div>
        ) : null}
        {tailMode ? (
          /* 尾巴模式：纯文本（不做 Markdown 解析），DOM 恒定只有几 KB */
          <pre ref={bodyRef} className="md md-tail stream-cursor">{tail}</pre>
        ) : (
          <div
            ref={bodyRef}
            className={cn('md', msg.streaming && 'stream-cursor')}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
        {tailMode ? (
          <p className="text-[11px] leading-relaxed text-subtle">
            正文较长（{raw.length} 字）：这里只显示末尾 {STREAM_TAIL} 字（点「复制」取全文；这一轮结束时自动展开全文）。
          </p>
        ) : null}
        {clipped ? (
          <p className="text-[11px] leading-relaxed text-warning">
            正文过长（{raw.length} 字），界面只渲染了前 {MAX_RENDER} 字；点「复制」取完整全文。
          </p>
        ) : null}
        <Meta msg={msg} stale={stale} />
        <Actions>{actions}</Actions>
      </div>
    </div>
  );
}

/* **流式中的那条必须永远重渲**——这一条比"省开销"重要，别再删（2026-09-30 实测的坑）。
 *
 *  流式期间宿主是**就地改同一个消息对象**（`turn.live.content = …`、`msg.trace.push(…)`），
 *  每次改动只触发一次"快照重发"（store.js 重建浅拷贝），嵌套对象引用一律不变。
 *  于是 msg/index/stale/isLastRound/busy 这五个 props 在整轮流式里**一个都不变**——
 *  只按浅比较，正在生成的那条消息整轮都不会重绘：正文、思考计数、工具追踪条全部
 *  攒到收尾（busy 翻转）才一次性冒出来。实测证据：整轮只发生 3 次 DOM 更新，
 *  期间网络侧 112 个分片是**逐步到达**的（5.7s→28.1s），正文 593 字一次到位。
 *
 *  代价这件事由上游控制：session.js 的 `touchSoon()` 已把重绘节流到 ~12fps，
 *  流式消息跟着它走就是设计意图；历史消息（streaming 已清）照旧靠浅比较免渲。
 *  旧实现把 ChatView 传的 `tick` 当"死参数"删掉（审计 C10，理由是"Message 没解构它"），
 *  恰好抽掉了唯一能让流式那条重绘的开关 —— props 里没有它，memo 却看得见它。 */
export default memo(Message, (a, b) => (
  a.msg === b.msg && a.index === b.index && a.stale === b.stale
  && a.isLastRound === b.isLastRound && a.busy === b.busy
  && !(b.msg && b.msg.streaming)
));
