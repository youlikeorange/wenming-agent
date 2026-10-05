// Message.jsx —— 单条消息：助手 ghost 气泡（无框、整行排版）/ 用户右侧气泡（按内容收缩，≤80% 宽）
// （思考折叠、操作折叠组 TraceGroup、Markdown 正文、元信息、悬停操作；视觉规范见 styles.css 的 .marker/.shimmer）
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, ChevronRight, Copy, RefreshCw, Trash2 } from 'lucide-react';
import { deleteRound, regenerateLast } from '../state/session.js';
import { undoRun } from '../state/run.js';
import { undoGateHelp } from '../state/undo-help.js';
import { askConfirm } from '../state/host.js';
import { Button } from '../components/ui/button.jsx';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible.jsx';
import { toast } from '../components/ui/toast.jsx';
import { cn } from '../lib/utils.js';
import TraceGroup from './TraceGroup.jsx';
import UndoMenu, { pendingOf } from './UndoMenu.jsx';
import { renderMarkdownHtml } from './chat-utils.js';
import { fmtDuration, shortPath, statsParts } from '../lib/format.js';

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

/** 元信息 + 未跑完 / 空回答的说明（元信息只用一行小字，不做徽章）
 *  **失败要看得见**（2026-10-01）：模型/上游出错时（401、429、断网、上下文超限…）服务端会把
 *  错误挂在这条消息上（msg.error），这里画成一个带边框的错误块并把「重试这一轮」放在手边——
 *  旧实现只有一行红字，用户最容易的反应是"它卡住了"而不是"它失败了"。 */
function Meta({ msg, stale, canRetry, busy }) {
  /* 耗时**不在这里**显示：`RunFooter` 用一句人话写「本轮用时 1 分 23 秒」，
     这里只留 tok/s 与 tokens（两处都写一遍时间，用户会以为是两个不同的数）。 */
  const parts = statsParts(msg.stats, null, msg.content);
  const empty = !msg.streaming && !stale && !msg.content && !msg.thinking
    && !(msg.trace || []).length && !msg.error;
  return (
    <>
      {msg.error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2">
          <p className="text-xs leading-relaxed text-destructive">{msg.error}</p>
          {canRetry ? (
            <Button
              variant="outline" size="sm" className="mt-1.5 h-6 gap-1 px-2 text-[11px]"
              disabled={busy}
              title={busy ? '生成中：先等这一轮结束' : '按原提问重新问一次'}
              onClick={() => regenerateLast()}
            >
              <RefreshCw className="size-3.5" />重试这一轮
            </Button>
          ) : null}
        </div>
      ) : null}
      {stale ? (
        <p className="text-[11px] leading-relaxed text-warning">
          {msg.content ? '这一轮没有跑完（生成被中断），下面是已经生成的部分。' : '这一轮没有跑完（生成被中断），没有内容保存下来，可以重新提问。'}
        </p>
      ) : null}
      {empty ? <p className="text-[11px] text-subtle">这一轮没有返回内容（模型空回答）。</p> : null}
      {parts.length ? (
        <p className="text-[11px] tabular-nums text-subtle" title="tok/s · tokens（服务端返回 usage 时才有）">
          {parts.join(' · ')}
        </p>
      ) : null}
    </>
  );
}

/** 撤销确认框与结果里的文件清单（最多列 8 个，其余写"等 N 个"） */
const filesText = (undo) => {
  const list = (undo.files || []).slice(0, 8).map((f) => shortPath(f));
  const rest = (undo.files || []).length + (undo.more || 0) - list.length;
  return list.join('\n') + (rest > 0 ? `\n…等共 ${undo.count} 个文件` : '');
};

/** 撤销确认框的正文：说清会发生什么、列出文件、记录不全时如实提醒 */
function undoBody(undo) {
  const warn = undo.skipped || undo.complete === false
    ? `\n\n注意：这一轮有 ${undo.skipped || '部分'} 处改动没能记录（文件过大或超过上限），撤销只能恢复其余部分。`
    : '';
  return '新建的文件会被删掉，改过的写回运行前的内容，删掉的补回来。'
    + '运行之后你再手动改过的内容也会被覆盖，这一步不可再撤销。\n\n'
    + filesText(undo) + warn;
}

/** 撤销结果 → 一句 toast；返回 true = 全部恢复（按钮可以收起来） */
function reportUndo(d) {
  const res = d.result || {};
  const ok = (res.restored || []).length + (res.removed || []).length;
  const failed = res.failed || [];
  if (failed.length) {
    toast(`已恢复 ${ok} 处；还有 ${failed.length} 处没恢复：${(failed[0] || {}).error || ''}`
      + '（可以再点一次「撤销本轮文件改动」重试）', 'err');
    return false;
  }
  toast(`已撤销 ${ok} 处文件改动，都恢复成运行前的样子了`, 'ok');
  return true;
}

/** 点「撤销」：确认 → 请求服务端 → 一句结果；返回组件该切到的状态。
 *  没解锁 / 没绑定时按工具那条路的老规矩把用户引到该去的地方（解锁框 / 绑定抽屉），
 *  而不是只给一句报错——撤销要过与工具**同一套闸门**，这是设计（见 lib/agent/tools/fs.js）。 */
async function confirmUndo(undo) {
  const r = await askConfirm({
    title: `把这一轮的 ${undo.count} 处文件改动恢复原状？`,
    body: undoBody(undo), okText: '撤销这些改动', danger: true,
  });
  if (!r.ok) return 'idle';
  try {
    const d = await undoRun(undo.runId);
    return reportUndo(d) ? 'done' : 'idle';      // 部分失败：按钮留着，用户能重试
  } catch (e) {
    undoGateHelp(e);
    return 'idle';
  }
}

/** 撤销被闸门拦下（没解锁 / 没绑定）的引导：抽到 state/undo-help.js —— 整轮撤销、逐文件恢复、
 *  比对抽屉三个入口共用一份（各写一份必然漂移），这里只保留调用。 */

/** 运行时长（一句话，tabular-nums 让数字对齐） */
function WallTime({ ms }) {
  return (
    <span className="tabular-nums" title="这一轮从开始到结束的总时长（服务端计，落盘在消息上）">
      本轮用时 <span className="text-muted-foreground">{fmtDuration(ms)}</span>
    </span>
  );
}

/**
 * 本轮收尾条：**运行时长** + 「撤销本轮文件改动」。
 *
 *  两样都由服务端给，界面不存任何东西：
 *   · 时长 = `msg.wallMs`（服务端从这一轮开始到结束算的，落盘在消息上）；
 *   · 撤销 = `msg.undo`（服务端按账号/会话/运行记的改动日志摘要；原内容备份在账号目录里，
 *     见 lib/agent/undo.js）。所以刷新、关掉浏览器、换窗口回来，这一行还在。
 *
 *  撤销是**恢复原状**：新建的删掉、改过的写回运行前的内容、删掉的补回来、移动的回滚；
 *  只覆盖文件工具（write_file/edit_file/create_directory/move_file/delete_path）——
 *  run_command 对文件做了什么，进程外无从知晓，文案里如实写着。
 */
function RunFooter({ msg }) {
  const [phase, setPhase] = useState('idle');            // idle | working | done
  const view = footerView(msg, phase);
  if (!view) return null;
  const click = async () => { setPhase('working'); setPhase(await confirmUndo(view.undo)); };
  return <FooterBody view={view} phase={phase} onClick={click} />;
}

/** 这一条消息该不该有收尾条、里面各块显示不显示（判据集中在这里，组件只管画） */
function footerView(msg, phase) {
  const undo = msg.undo;
  const wall = Number(msg.wallMs) || 0;
  if (msg.streaming || (!wall && !undo)) return null;
  /* "已撤销"的判据 = **没有待恢复的了**（逐文件撤销之后可能还剩几个，按钮要留着） */
  return { wall, undo, undone: pendingOf(undo) === 0 || phase === 'done' };
}

function FooterBody({ view, phase, onClick }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-subtle">
      {view.wall ? <WallTime ms={view.wall} /> : null}
      {view.undo && !view.undone ? <UndoButton undo={view.undo} phase={phase} onClick={onClick} /> : null}
      {view.undo && view.undone ? <UndoneNote undo={view.undo} /> : null}
    </div>
  );
}

/** 撤销按钮 = 一个下拉菜单（UndoMenu）：逐文件明细 + "点开看对比" + 底部"全部恢复"。
 *  **常显**（不是悬停才出现）——用户要的是"点一下就撤"，多一步都嫌多。 */
function UndoButton({ undo, phase, onClick }) {
  return <UndoMenu undo={undo} phase={phase} onUndoAll={onClick} />;
}

/** 撤销过之后的痕迹：留在原位（刷新后也知道"这一轮已经撤过了"） */
function UndoneNote({ undo }) {
  const done = Number.isFinite(undo.undoneCount) ? undo.undoneCount : undo.count;
  const lines = undo.added || undo.removed ? `（原本 +${undo.added} / −${undo.removed} 行）` : '';
  return (
    <span className="tabular-nums" title={`已恢复成这一轮开始前的样子：\n${filesText(undo)}`}>
      ↩ 已撤销 {done} 处文件改动{lines}
    </span>
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
      <div className="group/msg flex flex-col items-end gap-1" data-mi={index}>
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
    <div className="group/msg flex items-start gap-2.5" data-mi={index}>
      <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground" title="助手">
        <Bot className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Thinking text={msg.thinking} streaming={!!msg.streaming} />
        {/* 这一轮的全部操作收成一组（折叠时一行摘要；进行中自动展开、失败不收起，见 TraceGroup.jsx） */}
        <TraceGroup traces={msg.trace} streaming={!!msg.streaming} />
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
        <Meta msg={msg} stale={stale} canRetry={isLastRound} busy={busy} />
        <RunFooter msg={msg} />
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
/** 撤销进度的指纹（ChatView 计算后当 prop 传进来）。为什么必须这样：
 *  msg 是**同一个对象**（applyUndoSummary 就地换掉 msg.undo），memo 的引用比较拦不住——
 *  逐文件恢复之后收尾条与撤销菜单的状态会停在旧值上（真机实测：点了恢复，菜单里那行还写着"看对比"）。
 *  指纹是最小实现：它一变，这条消息重渲染一次。 */
export const undoRevOf = (m) => {
  const u = m && m.undo;
  if (!u) return '';
  return [u.undone, u.pendingCount, u.undoneCount, u.undoneAt, u.lastFailed].join('|');
};

export default memo(Message, (a, b) => (
  a.msg === b.msg && a.index === b.index && a.stale === b.stale
  && a.isLastRound === b.isLastRound && a.busy === b.busy && a.canRetry === b.canRetry
  && a.undoRev === b.undoRev
  && !(b.msg && b.msg.streaming)
));
