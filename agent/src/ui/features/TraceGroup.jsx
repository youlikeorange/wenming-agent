// TraceGroup.jsx —— 一轮里的全部 agent 操作折成一组：折叠时只有一行摘要，展开后是逐条追踪条
//
//  为什么要有它：一轮里工具调用动辄十几条，每条一行会把正文挤到屏幕外——用户要的是
//  "先看结论，需要时再看过程"。这里把**同一条助手消息**的全部追踪条收进一个折叠组：
//   · 折叠时一行摘要：步数 + 分类计数（读文件 ×3）+ 失败数（红字）+ ✎ 改动处数 + 累计耗时；
//   · 进行中自动展开（要看得到正在跑哪一步），跑完自动收起；
//   · 跑完发现失败**不自动收起**（失败要看得见，这是本项目反复强调的原则）；
//   · **不设例外**：失败的、有改动的、带文件的条目全在折叠里——摘要把"几步失败、几处改动"
//     如实报出来（用户 2026-10-04 明确要求"错误的有问题的操作不用单独列出来，都折叠"）；
//   · 只有一条时不折（折了反而多一次点击，摘要并不比那一行信息多）。
//  逐条怎么画、详情怎么开、行数卡片怎么点，仍然全在 TraceStrip.jsx —— 这里只管"分组"这一层。
import { useEffect, useState } from 'react';
import { ChevronRight, Wrench } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible.jsx';
import { Badge } from '../components/ui/badge.jsx';
import { Spinner } from '../components/ui/spinner.jsx';
import { cn } from '../lib/utils.js';
import { summarizeTraces } from '../lib/trace.js';
import { fmtCount, fmtDuration } from '../lib/format.js';
import TraceStrip from './TraceStrip.jsx';

/** 摘要里最多列几类；再多的写"等 N 类"，悬停看全部（一行摘要不该自己占满两行） */
const MAX_CHIPS = 4;

/** 一行摘要：图标 + 步数（进行中走 shimmer）+ 失败数 + 改动处数 + 分类计数 + 累计耗时。
 *  分类计数用 Badge 而不是纯文字：它们是"扫一眼"的信息，得有边界才数得清。
 *  字号与正文一致（.trace-group-head 在 styles.css 里定 1rem）——操作信息也是给人读的正文，
 *  比正文小一号的旧观感（0.78rem）在真机上看就是"一行小灰字"。 */
function Head({ s, running }) {
  const chips = s.groups.slice(0, MAX_CHIPS);
  const rest = s.groups.slice(MAX_CHIPS).map((g) => `${g.label} ×${g.count}`).join(' · ');
  return (
    <>
      <span className="grid size-5 shrink-0 place-items-center rounded-md border border-border bg-muted/50 text-muted-foreground">
        {running ? <Spinner size="sm" /> : <Wrench className="size-3" />}
      </span>
      <span className={cn('shrink-0', running && 'shimmer')}>
        {running ? `正在执行 ${s.count} 步操作…` : `${s.count} 步操作`}
      </span>
      {s.failed ? <span className="shrink-0 font-medium text-destructive">✕ {s.failed} 步失败</span> : null}
      {/* 改动明细折叠起来了，但"改了几处、多少行"必须在摘要里报出来（悬停看行数） */}
      {s.changed ? (
        <span
          className="shrink-0 tabular-nums"
          title={`这一轮改了 ${s.changed} 处文件：共写入 ${fmtCount(s.added)} 行、删除 ${fmtCount(s.removed)} 行`
            + '（展开可逐个看前后对比；收尾条的「撤销本轮文件改动」里也一直列着）'}
        >
          ✎ {s.changed} 处改动
        </span>
      ) : null}
      <span className="ml-auto flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-1 text-xs tabular-nums text-subtle">
        {chips.map((g) => (
          <Badge key={g.label} variant="secondary" className="h-5 px-1.5 py-0 text-xs font-normal">
            {g.label} ×{g.count}
          </Badge>
        ))}
        {rest ? <span title={rest}>等 {s.groups.length} 类</span> : null}
        {s.ms ? <span title="各步耗时之和（并行执行时会大于这一轮的实际用时）">累计 {fmtDuration(s.ms)}</span> : null}
      </span>
    </>
  );
}

export default function TraceGroup({ traces, streaming }) {
  const list = (Array.isArray(traces) ? traces : []).filter(Boolean);
  /* **不能 useMemo**：流式期间宿主是就地 push 进同一个数组（引用不变，见 Message.jsx 文件头
     那段"流式中的那条必须永远重渲"），记忆化会把摘要冻结在第一次渲染的计数上。
     每帧重算的代价是几十次加法，可以忽略。 */
  const s = summarizeTraces(list);

  /* 展开/收起：进行中展开，跑完收起。跑完那一刻用 setOpen 的函数形式读**当前值**——
     用户手动收起过就尊重他的选择（cur === false 时不再强行展开）。 */
  const [open, setOpen] = useState(!!streaming);
  useEffect(() => { setOpen((cur) => (streaming ? true : (cur && s.failed > 0))); }, [streaming, s.failed]);

  if (!list.length) return null;
  if (list.length === 1) return <TraceStrip trace={list[0]} />;   // 一条：不折

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="marker flex-wrap" role={s.running ? 'status' : undefined}>
      <CollapsibleTrigger
        title={open ? '收起这些操作，只看结论' : '展开看每一步的参数与结果'}
        className="trace-group-head flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-left"
      >
        <ChevronRight className={cn('size-4 shrink-0 text-subtle transition-transform', open && 'rotate-90')} />
        <Head s={s} running={s.running > 0} />
      </CollapsibleTrigger>
      <CollapsibleContent className="w-full">
        <div className="trace-rail">
          {list.map((t, i) => <TraceStrip key={`${i}-${t.label || t.name || ''}`} trace={t} />)}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
