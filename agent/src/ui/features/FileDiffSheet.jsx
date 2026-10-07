// FileDiffSheet.jsx —— 「比对修改」抽屉：一个文件 之前 / 之后 的逐行差异 + 「仅恢复这一个」
//
//  两个入口共用本组件（状态在 state/fileDiff.js）：追踪条的 +N/−M 卡片（这条命令的改动）、
//  撤销菜单里的一个文件（这个文件本轮的累计改动）。差异行由纯函数 ui/lib/diff.js 现算；
//  两侧内容来自 `POST /agent/run/undo/diff`（服务端截断、二进制/目录只回元信息）。
//  组件按"头 / 文件标签 / 差异主体 / 底栏"分块，各块只管画自己的那点东西。
import { useMemo } from 'react';
import { Undo2 } from 'lucide-react';
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from '../components/ui/sheet.jsx';
import { Button } from '../components/ui/button.jsx';
import { Spinner } from '../components/ui/spinner.jsx';
import { cn } from '../lib/utils.js';
import { fmtCount, shortPath } from '../lib/format.js';
import { diffLines } from '../lib/diff.js';
import { useApp } from '../state/store.js';
import { closeFileDiff, restoreFileDiff, selectFileDiff } from '../state/fileDiff.js';

/* 一次最多渲染多少行：diff 是给人看的，几万行的差异渲染出来既看不动也卡页面。
   超出时如实标注（服务端也会按 AGENT_UNDO_DIFF_CHARS 截断文本，两层都写清）。 */
const MAX_RENDER_ROWS = 2000;

const ACTION_LABEL = { create: '新建', delete: '删除', modify: '修改' };
const ROW_BG = { add: 'bg-success/10', del: 'bg-destructive/10' };
const SIGN = { add: '+', del: '−', ctx: ' ' };
const SIGN_CLS = { add: 'text-success', del: 'text-destructive' };

/** 一侧不能逐行比时的说明（目录/二进制/没备份/不存在）——别让用户对着一片空白猜 */
function sideNote(side, which) {
  if (!side) return `${which}：读不到`;
  if (side.unavailable) return `${which}：${side.unavailable}`;
  if (!side.exists) return which === '之前' ? '之前：文件不存在（这一轮新建的）' : '之后：文件已被删除';
  if (side.binary) return `${which}：二进制文件，不展示差异`;
  if (side.dir) return `${which}：目录${Number.isFinite(side.count) ? `（${side.count} 个条目）` : ''}，不逐行比较`;
  if (side.link) return `${which}：符号链接 → ${side.target}`;
  return '';
}

/** 一侧是"文件不存在"吗（当作空文件比：新建 = 全篇 +、删除 = 全篇 −） */
const absentSide = (s) => !!s && !s.exists && typeof s.text !== 'string';
/** 两侧都是可比的文本吗 */
const bothText = (B, A) => typeof B.text === 'string' && typeof A.text === 'string';

/** 两侧文本都在（或一侧是"文件不存在"）→ 现算差异；其余（目录/二进制/没备份/被闸门拦）→ null。
 *  "不存在"当作**空文件**比：新建的文件显示全篇 +、删掉的文件显示全篇 −——
 *  比"什么都不画"有用得多（用户要看的就是"这条命令写进去了什么"）。 */
const computeDiff = (data) => {
  const B = data && data.before;
  const A = data && data.after;
  if (!B || !A) return null;
  if (absentSide(B) && typeof A.text === 'string') return diffLines('', A.text, { context: 3 });
  if (absentSide(A) && typeof B.text === 'string') return diffLines(B.text, '', { context: 3 });
  if (!bothText(B, A)) return null;
  return diffLines(B.text, A.text, { context: 3 });
};

/** 一侧读不到时的兜底：把**能读到的那一侧**原样铺出来（比如没解锁时"之前"仍来自服务端备份）。
 *  不给的话用户只能看到一句"读不到"，连改了什么都无从判断。 */
function SidePreview({ side, label }) {
  if (!side || typeof side.text !== 'string') return null;
  const lines = side.text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (!lines.length) return null;
  const cut = lines.slice(0, 400);
  return (
    <div className="mt-1">
      <p className="px-4 py-1 text-xs text-muted-foreground">{label}</p>
      <div className="overflow-x-auto bg-muted/20 py-1 font-mono text-[11.5px] leading-relaxed">
        {cut.map((t, i) => (
          <div key={i} className="flex">
            <span className="w-10 shrink-0 select-none border-r border-border/50 pr-1 text-right text-[10.5px] tabular-nums text-subtle">{i + 1}</span>
            <span className="whitespace-pre pl-2 pr-3">{t === '' ? ' ' : t}</span>
          </div>
        ))}
        {lines.length > cut.length
          ? <p className="px-4 py-1 text-xs text-subtle">⋯ 还有 {lines.length - cut.length} 行（只预览前 400 行）</p>
          : null}
      </div>
    </div>
  );
}

const LineNo = ({ v }) => (
  <span className="w-10 shrink-0 select-none border-r border-border/50 pr-1 text-right text-[10.5px] tabular-nums text-subtle">{v ?? ''}</span>
);

function Row({ r }) {
  if (r.type === 'gap') {
    return (
      <div className="flex bg-muted/30 text-[11px] text-subtle">
        <span className="w-24 shrink-0" />
        <span className="px-2 py-0.5">⋯ 省略 {fmtCount(r.count)} 行未变内容</span>
      </div>
    );
  }
  return (
    <div className={cn('flex', ROW_BG[r.type])}>
      <LineNo v={r.a} />
      <LineNo v={r.b} />
      <span className={cn('w-4 shrink-0 select-none text-center', SIGN_CLS[r.type])}>{SIGN[r.type] || ' '}</span>
      <span className="whitespace-pre pr-3">{r.text === '' ? ' ' : r.text}</span>
    </div>
  );
}

/** 差异上方的概览行：+N/−M + "之后"的来源说明 */
function DiffSummary({ diff, after }) {
  if (diff.unchanged) {
    return (
      <p className="border-b border-border/60 bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
        ✓ 两侧内容一致（这个文件当前就是你选的那个状态）
      </p>
    );
  }
  const fromDisk = after && after.source === 'disk';
  return (
    <p className="flex flex-wrap items-center gap-x-2 border-b border-border/60 bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
      <span className="text-success">+{fmtCount(diff.added)}</span>
      <span className="text-destructive">−{fmtCount(diff.removed)}</span>
      <span>
        · 之后 = {fromDisk
          ? <b className="font-normal text-foreground">当前文件</b>
          : '改动完成时的快照'}
      </span>
      {diff.limited ? <span className="text-subtle">· 差异过大，按整段替换展示（不逐行对齐）</span> : null}
    </p>
  );
}

function DiffRows({ diff }) {
  return (
    <div className="overflow-x-auto py-1 font-mono text-[11.5px] leading-relaxed">
      {diff.rows.slice(0, MAX_RENDER_ROWS).map((r, i) => <Row key={i} r={r} />)}
      {diff.rows.length > MAX_RENDER_ROWS
        ? <p className="px-4 py-2 text-xs text-subtle">⋯ 差异超过 {fmtCount(MAX_RENDER_ROWS)} 行，只显示到这里（共 {fmtCount(diff.rows.length)} 行）</p>
        : null}
    </div>
  );
}

/** 差异主体：加载中 / 读不到 / 不可比（说明块）/ 有差异（概览 + 逐行）。
 *  导出是为了单测：Sheet 走 radix Portal，SSR 下不渲染内容，测差异渲染只能直接渲染这一层。 */
/* 导出是有意的：undo-ui.test.mjs 直接渲染它（上面那条审计注记有误，2026-10-06 复核后保留导出）。 */
export function DiffBody({ data, loading, error }) {
  const diff = useMemo(() => computeDiff(data), [data]);
  if (loading) {
    return <div className="flex items-center gap-2 p-6 text-sm text-subtle"><Spinner size="sm" />正在读取两侧内容…</div>;
  }
  if (error) return <div className="p-6 text-sm text-destructive">{error}</div>;
  if (!data) return null;
  if (!diff) {
    const notes = [sideNote(data.before, '之前'), sideNote(data.after, '之后')].filter(Boolean);
    /* 有一侧读不到时（最常见的形态：没解锁，读当前文件被闸门拦下）：把能读的一侧铺出来。
       "之前"来自服务端备份（不依赖绑定账号权限），所以未解锁也能看到改之前长什么样。 */
    return (
      <div className="space-y-2 p-6 text-sm">
        {notes.length
          ? notes.map((n) => <p key={n} className="text-muted-foreground">{n}</p>)
          : <p className="text-subtle">这个文件没有可展示的文本差异。</p>}
        {typeof data.before.text === 'string' ? <SidePreview side={data.before} label="以下是「之前」的内容（服务端备份）" /> : null}
        {typeof data.before.text !== 'string' && typeof data.after.text === 'string'
          ? <SidePreview side={data.after} label="以下是「之后」的内容" /> : null}
      </div>
    );
  }
  const notes = [sideNote(data.before, '之前'), sideNote(data.after, '之后')].filter(Boolean);
  return (
    <div className="min-w-0">
      <DiffSummary diff={diff} after={data.after} />
      {notes.map((n) => <p key={n} className="px-4 py-1 text-xs text-muted-foreground">{n}</p>)}
      <DiffRows diff={diff} />
    </div>
  );
}

/** 头部里的一句话：这条命令的改动 还是 这个文件本轮的累计改动（同轮改过多次要说清） */
const scopeTextOf = (data) => (data && data.scope === 'entry'
  ? `这条命令的改动${data.changes > 1 ? `（这个文件本轮被改过 ${data.changes} 次，这里看的是其中一次）` : ''}`
  : '这个文件在本轮的改动');

function LineCounts({ lines }) {
  if (!lines.added && !lines.removed) return null;
  return (
    <span className="shrink-0 text-[11px] font-normal tabular-nums">
      <span className="text-success">+{fmtCount(lines.added)}</span>
      <span className="text-subtle">/</span>
      <span className="text-destructive">−{fmtCount(lines.removed)}</span>
      <span className="text-subtle">行</span>
    </span>
  );
}

/** 头部：路径 + 动作 + 行数 + 已恢复标记 + 一句话说明改动的维度 */
function HeadBar({ cur, data }) {
  const act = ACTION_LABEL[(data && data.action) || 'modify'] || '修改';
  return (
    <SheetHeader>
      <SheetTitle className="flex flex-wrap items-center gap-2 text-sm">
        <span className="min-w-0 truncate font-mono" title={cur.path}>{shortPath(cur.path || '')}</span>
        <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10.5px] font-normal text-muted-foreground">{act}</span>
        <LineCounts lines={(data && data.lines) || {}} />
        {data && data.undone ? <span className="shrink-0 text-[11px] font-normal text-success">已恢复</span> : null}
      </SheetTitle>
      <p className="text-xs text-subtle">
        {scopeTextOf(data)}{' · '}恢复会把它写回**这一轮开始前**的样子（同轮改过多次就一起回退）
      </p>
    </SheetHeader>
  );
}

/** 一条命令动了多个路径时的文件标签（其余情况不画） */
function FileTabs({ files, index, onPick }) {
  if (files.length <= 1) return null;
  return (
    <div className="flex flex-wrap gap-1 border-b border-border px-5 py-2">
      {files.map((f, i) => (
        <button key={f.path} type="button" onClick={() => onPick(i)} title={f.path}
          className={cn('max-w-56 truncate rounded-md border px-2 py-0.5 font-mono text-[11px] transition-colors',
            i === index ? 'border-foreground/40 text-foreground' : 'border-border text-subtle hover:text-foreground')}>
          {shortPath(f.path)}
        </button>
      ))}
    </div>
  );
}

/** 底栏：只恢复这一个的说明 + 按钮（走与工具同一套权限闸门） */
function FootBar({ data, restoring, onRestore }) {
  const canRestore = !!data && !data.undone && !restoring;
  return (
    <div className="flex items-center gap-3 border-t border-border px-5 py-3">
      <span className="min-w-0 flex-1 text-xs text-subtle">
        {data && data.undone ? '这个文件已经恢复过了' : '只恢复这一个文件，其余文件的改动不动'}
      </span>
      <Button size="sm" disabled={!canRestore} onClick={onRestore}
        title="把这一个文件写回这一轮开始前的内容（走与工具同一套权限闸门）">
        <Undo2 className="size-3.5" />
        {restoring ? '正在恢复…' : '恢复这个文件'}
      </Button>
    </div>
  );
}

export default function FileDiffSheet() {
  const st = useApp();
  const s = st.fileDiff;
  if (!s.open) return null;
  return (
    <Sheet open onOpenChange={(v) => { if (!v) closeFileDiff(); }}>
      <SheetContent side="right" className="w-[min(860px,96vw)] sm:max-w-none">
        <HeadBar cur={s.files[s.index] || {}} data={s.data} />
        <FileTabs files={s.files} index={s.index} onPick={selectFileDiff} />
        <SheetBody>
          <DiffBody data={s.data} loading={s.loading} error={s.error} />
        </SheetBody>
        <FootBar data={s.data} restoring={s.restoring} onRestore={restoreFileDiff} />
      </SheetContent>
    </Sheet>
  );
}
