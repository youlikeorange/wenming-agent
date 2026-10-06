// TraceStrip.jsx —— 追踪条（Marker 风格）：进行中 shimmer 文字 + 小图标，完成 ✓/✕ + label + note + ms，可展开看参数与结果
import { useState } from 'react';
import { ChevronDown, Download } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible.jsx';
import { Spinner } from '../components/ui/spinner.jsx';
import { cn } from '../lib/utils.js';
import { linesOf, traceKind, traceRunning } from '../lib/trace.js';
import { subagentRecord } from '../state/run.js';
import { downloadUrl, inlineUrl } from '../state/downloads.js';
import { openFileDiff } from '../state/fileDiff.js';
import { fileKind } from '../lib/filekind.js';
import { fmtBytes, fmtCount } from '../lib/format.js';

/* 判据全是结构化字段（state/kind），不再比对中文文案——旧会话数据由 ui/lib/trace.js
   的 normalizeTrace/traceRunning 按当时的文案回推一次（那一处兼容逻辑在纯函数里有单测）。 */
const isRunning = traceRunning;
const isSteer = (t) => traceKind(t) === 'steer';
const isSub = (t) => traceKind(t) === 'sub';

const labelOf = (t) => t.label || t.name || '工具调用';

/** 状态图标：进行中转圈、失败 ✕、成功 ✓（装饰性的，语义由文字承担） */
function StateIcon({ running, failed }) {
  if (running) return <Spinner size="sm" />;
  return <span className={failed ? 'text-destructive' : 'text-success'}>{failed ? '✕' : '✓'}</span>;
}

/** 结果字数的两个数：**显示了 / 一共**（一共 = 模型实际收到的字数，记录上限截断前的）。
 *  旧数据没有 resultChars，就按"显示多少算多少"回推（宁可少说，不要编数）。 */
const charsOf = (t) => {
  const shown = t && t.result ? String(t.result).length : 0;
  const total = Number.isFinite(Number(t && t.resultChars)) ? Math.max(shown, Number(t.resultChars)) : shown;
  return { shown, total, truncated: total > shown };
};

/** 一行右侧的元信息：备注 / 耗时 / 字数（进行中不重复写「进行中」——shimmer 文字本身就是状态）。
 *  被记录上限截断时写成「显示了/一共 字」——**别只写显示量**：用户据此才知道文件到底读进来多少。 */
function metaText(t, running, failed) {
  const c = charsOf(t);
  return [
    running ? '' : t.note || (failed ? '失败' : '完成'),
    t.ms != null ? `${t.ms}ms` : '',
    c.truncated ? `${fmtCount(c.shown)}/${fmtCount(c.total)} 字` : (c.shown ? `${fmtCount(c.shown)} 字` : ''),
  ].filter(Boolean).join(' · ');
}

/** 标题前缀（插话与子智能体各有一个小标记，类型一目了然） */
const prefixOf = (t) => (isSteer(t) ? '💬 ' : isSub(t) ? '👥 ' : '');

/** 打开「比对修改」抽屉并带定位（点击与键盘两处共用一份载荷） */
const openDiffOf = (undoRef) => openFileDiff({
  runId: undoRef.runId, sessionId: undoRef.sessionId,
  files: undoRef.paths.map((p) => ({ path: p, entry: undoRef.entry })),
});

/** 写入 / 删除的行数（写文件、改文件、删文件、移动/建目录才有）：
 *  服务端在工具执行前后各拍一次快照比出来的（见 lib/agent/undo.js），随结果一路传到这条卡片上。
 *  绿色 +N = 写入的行、红色 −M = 删除的行；两个都是 0 就不画。
 *  **可点**（带 undoRef 时）：打开「比对修改」抽屉看这个文件 之前/之后 的逐行差异。
 *  点击要 stopPropagation：外层是展开/收起追踪条的触发器，点这里不该连带展开详情。
 *  行数的口径（负数当 0、非数字当 0）与折叠摘要的 ✎ 计数共用 lib/trace.js 的 linesOf。 */
function DiffChip({ lines, undoRef }) {
  const { added, removed } = linesOf(lines);
  if (!added && !removed) return null;
  const num = (v, cls, sign) => (v ? <span className={cls}>{sign}{fmtCount(v)}</span> : null);
  const body = (
    <>
      {num(added, 'text-success', '+')}
      {added && removed ? <span className="text-subtle">/</span> : null}
      {num(removed, 'text-destructive', '−')}
      <span className="text-subtle">行</span>
    </>
  );
  if (!undoRef) {
    return <span className="shrink-0 text-xs tabular-nums" title={`这次改动：写入 ${fmtCount(added)} 行、删除 ${fmtCount(removed)} 行`}>{body}</span>;
  }
  /* role=button 的 span（不是 <button>）：这一行外层就是 CollapsibleTrigger（本身是 button），
     嵌套 button 是非法 HTML。点击要 stopPropagation——否则会连带展开/收起追踪条。 */
  return (
    <span
      role="button"
      tabIndex={0}
      className="shrink-0 cursor-pointer rounded px-1 text-xs tabular-nums transition-colors hover:bg-muted"
      title={`这次改动：写入 ${fmtCount(added)} 行、删除 ${fmtCount(removed)} 行\n点击查看前后对比`}
      onClick={(e) => { e.stopPropagation(); openDiffOf(undoRef); }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();
        openDiffOf(undoRef);
      }}
    >
      {body}
    </span>
  );
}

/** 一行 Marker：状态图标 + 标题（进行中走 shimmer）+ 改动行数 + 备注/耗时/字数（tabular-nums） */
function Head({ t }) {
  const running = isRunning(t);
  const failed = t.ok === false && !running;
  const meta = metaText(t, running, failed);
  return (
    <>
      <span className="shrink-0" aria-hidden="true">
        <StateIcon running={running} failed={failed} />
      </span>
      <span className={cn('min-w-0 flex-1 truncate text-left', running && 'shimmer', isSteer(t) && 'text-foreground')}>
        {prefixOf(t)}{labelOf(t)}
      </span>
      {running ? null : <DiffChip lines={t.lines} undoRef={t.undoRef} />}
      {meta ? (
        <span title={charsOf(t).truncated ? `只显示前 ${fmtCount(charsOf(t).shown)} 字，模型实际收到 ${fmtCount(charsOf(t).total)} 字` : undefined}
          className={cn('shrink-0 text-xs tabular-nums', failed ? 'text-destructive' : 'text-subtle')}>{meta}</span>
      ) : null}
    </>
  );
}

/** 媒体预览（图片 / 视频 / 音频）：deliver_file 交付的"能显示的文件"直接画在卡片里，
 *  不用先下载到本地才能看。点击图片在新页看原图；音视频用浏览器原生控件（服务端支持 Range，
 *  进度条能拖）。文件被删除 / 加载失败时整个预览消失，只留下面的下载行——不挂破图。
 *  预览链接是 inlineUrl（服务端只对白名单内的类型按 inline 发出，见 ui/lib/filekind.js）。 */
function MediaPreview({ f, kind }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  const url = inlineUrl(f.name);
  if (kind === 'image') {
    return (
      <a href={url} target="_blank" rel="noreferrer" title="点击在新页查看原图" className="block border-b border-border">
        <img src={url} alt={f.name} loading="lazy" onError={() => setFailed(true)}
          className="max-h-72 w-auto max-w-full object-contain" />
      </a>
    );
  }
  if (kind === 'video') {
    return (
      <video controls preload="metadata" src={url} onError={() => setFailed(true)}
        className="max-h-72 w-full border-b border-border bg-black" />
    );
  }
  return (
    <div className="border-b border-border px-2 pt-2">
      <audio controls preload="metadata" src={url} onError={() => setFailed(true)} className="w-full" />
    </div>
  );
}

/** 可下载文件卡（deliver_file 那张）：图片/视频/音频（且不是打包产物）直接带预览（MediaPreview），
 *  其余只有下载行。**渲染在折叠组外面**（TraceGroup 收集整轮 files 统一画在这层）——
 *  交付物是"产出"不是"过程"：操作组跑完会收起，交付的文件必须始终可见、能直接看/下载。
 *  旧版挂在每条追踪条下面，被折叠组藏住（2026-10-06 用户实测：交付了图片却"什么都没有"）。 */
export function FileCards({ files }) {
  const list = (files || []).filter((f) => f && f.name);
  if (!list.length) return null;
  return (
    <div className="mt-1 w-full space-y-1">
      {list.map((f) => {
        const kind = (f.exec || f.packaged) ? null : fileKind(f.name);
        return (
          <div key={f.name} className="w-full overflow-hidden rounded-md border border-border bg-muted/30">
            {kind ? <MediaPreview f={f} kind={kind} /> : null}
            <div className="flex items-center gap-2 px-2 py-1.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-sans text-sm text-foreground" title={f.name}>{f.name}</span>
                <span className="block text-xs tabular-nums text-subtle">
                  {fmtBytes(f.size || 0)}
                  {f.exec ? ' · 可执行文件：已打包成 zip' : f.packaged ? ' · zip 包' : ''}
                </span>
              </span>
              <a
                href={downloadUrl(f.name)}
                download={f.exec && !/\.zip$/i.test(f.name) ? `${f.name}.zip` : f.name}
                className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-border px-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title="下载（浏览器直接下载）"
              >
                <Download className="size-3.5" />下载
              </a>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 详情里的一块（参数 / 结果）：没有内容就什么都不画 */
function Block({ title, text, ban, hint }) {
  if (!text) return null;
  return (
    <div>
      <p className="text-subtle">{title}</p>
      {hint ? <p className="mb-0.5 text-subtle">{hint}</p> : null}
      <pre className={cn('overflow-auto whitespace-pre-wrap text-foreground', ban ? 'max-h-40 break-all' : 'max-h-56 break-words')}>
        {text}
      </pre>
    </div>
  );
}

/** 被记录上限截断时的说明：说清"这里少显示的只是记录，模型收到的是完整的"，
 *  并指出调大它的位置——否则用户会以为 agent 只读了这么多（原先是静默截断，只说"4000 字"）。 */
const truncHint = (c) => (c.truncated
  ? `结果共 ${fmtCount(c.total)} 字，这里只显示前 ${fmtCount(c.shown)} 字——截断的是「记录」，`
    + '发给模型的内容不受它影响。上限在「设置 → 权限与工具 → 结果与记录 → 追踪条单条结果上限」。'
  : '');

/** 子智能体那张卡的详情：任务/模型 + 「查看记录」（完整转录按 runId+subId 现取）。
 *  过程（调了什么工具）由 sub_* 事件写在 result 里，转录只是"更全的那一份"。 */
function SubCard({ t }) {
  const [rec, setRec] = useState(null);
  const [loading, setLoading] = useState(false);
  const load = async () => {
    if (rec || loading) return;
    setLoading(true);
    setRec(await subagentRecord(t.runId, t.subId));
    setLoading(false);
  };
  return (
    <div className="space-y-1.5">
      {t.task ? <p className="font-sans text-subtle">任务：{t.task}</p> : null}
      {t.model ? <p className="font-sans text-subtle">模型：{t.model}{t.tools && t.tools.length ? ` · 可用工具 ${t.tools.length} 个` : ''}</p> : null}
      {t.subId ? (
        <div className="font-sans">
          <button
            type="button"
            className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={(e) => { e.stopPropagation(); load(); }}
          >
            {loading ? '正在取记录…' : (rec ? '已取到记录' : '查看子智能体记录')}
          </button>
          {rec ? <RecordList rec={rec} /> : null}
        </div>
      ) : null}
    </div>
  );
}

/** 子智能体转录：每一步（工具/参数/结果）一张小卡；服务端保留最近一段时间的记录 */
function RecordList({ rec }) {
  const steps = rec.steps || [];
  return (
    <div className="mt-1.5 space-y-1">
      {rec.error ? <p className="text-destructive">失败：{rec.error}</p> : null}
      {steps.map((x, i) => (
        <div key={i} className="rounded border border-border/60 p-1.5">
          <p className="text-subtle">{x.label || x.name}{x.ms ? ` · ${x.ms}ms` : ''}{x.ok === false ? ' · 失败' : ''}{(() => {
            const c = charsOf(x);
            return c.truncated ? ` · ${fmtCount(c.shown)}/${fmtCount(c.total)} 字` : (c.shown ? ` · ${fmtCount(c.shown)} 字` : '');
          })()}</p>
          {x.args ? <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(x.args, null, 2)}</pre> : null}
          {x.result ? <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words">{x.result}</pre> : null}
        </div>
      ))}
      {!steps.length ? <p className="text-subtle">这段子任务没有调用工具（直接给了结论）。</p> : null}
    </div>
  );
}

export default function TraceStrip({ trace }) {
  const [open, setOpen] = useState(false);
  const t = trace || {};
  const running = isRunning(t);
  const hasArgs = !!(t.args && typeof t.args === 'object' && Object.keys(t.args).length);
  const hasFiles = Array.isArray(t.files) && t.files.length > 0;
  /* 子智能体卡：没结论时也要能展开（「查看记录」在里面）；只有文件清单的条目也要能展开看详情 */
  const hasDetail = hasArgs || !!t.result || (isSub(t) && !!t.subId) || hasFiles;

  if (!hasDetail) {
    return (
      <div className="marker trace-row" role={running ? 'status' : undefined}>
        <Head t={t} />
      </div>
    );
  }

  /* 根就是 Marker 行（相邻条之间由 .marker + .marker 自动加细分割线）；
     flex-wrap 让展开的详情占满下一行，而不是挤在同一行里。
     文件卡不在这里渲染：它由 TraceGroup 收集整轮的 files 统一画在折叠组外面（始终可见）。 */
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="marker trace-row flex-wrap"
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
          {isSub(t) ? <SubCard t={t} /> : null}
          <Block title="参数" text={hasArgs ? JSON.stringify(t.args, null, 2) : ''} ban />
          <Block title="结果" text={t.result ? String(t.result) : ''} hint={truncHint(charsOf(t))} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
