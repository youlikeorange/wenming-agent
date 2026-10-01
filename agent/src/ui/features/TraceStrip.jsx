// TraceStrip.jsx —— 追踪条（Marker 风格）：进行中 shimmer 文字 + 小图标，完成 ✓/✕ + label + note + ms，可展开看参数与结果
import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible.jsx';
import { Spinner } from '../components/ui/spinner.jsx';
import { cn } from '../lib/utils.js';
import { traceKind, traceRunning } from '../lib/trace.js';

/* 判据全是结构化字段（state/kind），不再比对中文文案——旧会话数据由 ui/lib/trace.js
   的 normalizeTrace/traceRunning 按当时的文案回推一次（那一处兼容逻辑在纯函数里有单测）。 */
const isRunning = traceRunning;
const isSteer = (t) => traceKind(t) === 'steer';

const labelOf = (t) => t.label || t.name || '工具调用';

/** 状态图标：进行中转圈、失败 ✕、成功 ✓（装饰性的，语义由文字承担） */
function StateIcon({ running, failed }) {
  if (running) return <Spinner size="sm" />;
  return <span className={failed ? 'text-destructive' : 'text-success'}>{failed ? '✕' : '✓'}</span>;
}

/** 一行 Marker：状态图标 + 标题（进行中走 shimmer）+ 备注/耗时/字数（tabular-nums） */
function Head({ t }) {
  const running = isRunning(t);
  const failed = t.ok === false && !running;
  /* 进行中不重复写「进行中」——shimmer 文字本身就是状态；完成后才给 note/ms/字数 */
  const meta = [
    running ? '' : t.note || (failed ? '失败' : '完成'),
    t.ms != null ? `${t.ms}ms` : '',
    t.result ? `${String(t.result).length} 字` : '',
  ].filter(Boolean).join(' · ');
  return (
    <>
      <span className="shrink-0" aria-hidden="true">
        <StateIcon running={running} failed={failed} />
      </span>
      <span className={cn('min-w-0 flex-1 truncate text-left', running && 'shimmer', isSteer(t) && 'text-foreground')}>
        {isSteer(t) ? '💬 ' : ''}{labelOf(t)}
      </span>
      {meta ? (
        <span className={cn('shrink-0 text-[11px] tabular-nums', failed ? 'text-destructive' : 'text-subtle')}>{meta}</span>
      ) : null}
    </>
  );
}

export default function TraceStrip({ trace }) {
  const [open, setOpen] = useState(false);
  const t = trace || {};
  const running = isRunning(t);
  const hasArgs = !!(t.args && typeof t.args === 'object' && Object.keys(t.args).length);
  const hasDetail = hasArgs || !!t.result;

  if (!hasDetail) {
    return (
      <div className="marker" role={running ? 'status' : undefined}>
        <Head t={t} />
      </div>
    );
  }

  /* 根就是 Marker 行（相邻条之间由 .marker + .marker 自动加细分割线）；
     flex-wrap 让展开的详情占满下一行，而不是挤在同一行里 */
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="marker flex-wrap"
      role={running ? 'status' : undefined}
    >
      <CollapsibleTrigger
        title={open ? '收起详情' : '展开看参数与结果'}
        className="flex w-full min-w-0 items-center gap-2 text-left transition-colors hover:text-foreground"
      >
        <Head t={t} />
        <ChevronDown className={cn('size-3.5 shrink-0 text-subtle transition-transform', open && 'rotate-180')} />
      </CollapsibleTrigger>
      <CollapsibleContent className="w-full">
        <div className="space-y-1.5 rounded-md bg-muted/40 p-2 font-mono text-[11px]">
          {hasArgs ? (
            <div>
              <p className="text-subtle">参数</p>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all text-foreground">
                {JSON.stringify(t.args, null, 2)}
              </pre>
            </div>
          ) : null}
          {t.result ? (
            <div>
              <p className="text-subtle">结果</p>
              <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words text-foreground">
                {String(t.result)}
              </pre>
            </div>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
