// UndoMenu.jsx —— 「撤销本轮文件改动」的下拉菜单：逐文件明细（点击看对比 / 单独恢复）+ 全部恢复
//
//  用户要的两件事都从这里进：
//    · 点某个文件 → 打开「比对修改」抽屉（openFileDiff，file 维度），抽屉里可"仅恢复这一个"；
//    · 底部的"全部恢复" → 回落到原来的整轮撤销（Message.jsx 的 confirmUndo，带确认框）。
//  数据来自 msg.undo（服务端落盘）：新会话有 fileList（每个文件的 action 与 +N/−M、是否已恢复）；
//  旧会话只有 files 路径数组——照旧能点开对比，只是不显示每文件行数（不编数）。
import { Undo2 } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '../components/ui/dropdown-menu.jsx';
import { Button } from '../components/ui/button.jsx';
import { cn } from '../lib/utils.js';
import { fmtCount, shortPath } from '../lib/format.js';
import { openFileDiff } from '../state/fileDiff.js';

const ACTION_LABEL = { create: '新建', delete: '删除', modify: '修改' };

/** 还剩几个没恢复（新数据看 pendingCount；旧数据回退到 undone 标记） */
export const pendingOf = (undo) => {
  if (!undo) return 0;
  if (Number.isFinite(undo.pendingCount)) return undo.pendingCount;
  return undo.undone ? 0 : (undo.count || 0);
};

/** 菜单里的文件清单：优先 fileList（有行数与动作），旧数据回退成路径列表 */
export function filesOf(undo) {
  if (Array.isArray(undo.fileList) && undo.fileList.length) return undo.fileList;
  return (undo.files || []).map((p) => ({ path: p, action: 'modify', added: 0, removed: 0, undone: !!undo.undone }));
}

function Counts({ f }) {
  if (!f.added && !f.removed) return null;
  return (
    <span className="shrink-0 text-[10.5px] tabular-nums">
      {f.added ? <span className="text-success">+{fmtCount(f.added)}</span> : null}
      {f.added && f.removed ? <span className="text-subtle">/</span> : null}
      {f.removed ? <span className="text-destructive">−{fmtCount(f.removed)}</span> : null}
    </span>
  );
}

/** 触发器文案：整轮都没恢复过 → "（N 处）"；部分恢复过 → "（还剩 K 处）" */
const triggerText = (pending, total) => (pending === total ? `${pending} 处` : `还剩 ${pending} 处`);

/** 菜单里的一行文件：动作 + 路径 + 行数 + 状态；点击打开比对抽屉 */
function FileRow({ f, undo }) {
  return (
    <DropdownMenuItem
      onSelect={() => openFileDiff({ runId: undo.runId, sessionId: undo.sessionId, files: [{ path: f.path }] })}
      title={`${f.path}\n点击查看前后对比（可仅恢复这一个）`}
      className={cn('gap-2 py-1.5', f.undone && 'opacity-55')}
    >
      <span className="shrink-0 rounded border border-border px-1 py-px text-[10px] text-muted-foreground">
        {ACTION_LABEL[f.action] || '修改'}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{shortPath(f.path)}</span>
      <Counts f={f} />
      {f.undone
        ? <span className="shrink-0 text-[10.5px] text-success">✓ 已恢复</span>
        : <span className="shrink-0 text-[10.5px] text-subtle">看对比</span>}
    </DropdownMenuItem>
  );
}

/**
 * @param {object} p.undo        msg.undo（服务端摘要）
 * @param {string} p.phase       idle | working（整轮撤销进行中禁用）
 * @param {() => void} p.onUndoAll  底部"全部恢复"（Message.jsx 的确认框流程）
 */
export default function UndoMenu({ undo, phase, onUndoAll }) {
  const files = filesOf(undo);
  const total = undo.count || files.length;
  const pending = pendingOf(undo);
  const doneCount = Math.max(0, total - pending);
  const retry = undo.lastFailed ? `；上次有 ${undo.lastFailed} 处没恢复（解锁绑定账号后可重试）` : '';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline" size="sm"
          className="h-6 gap-1 px-2 text-[11px]"
          disabled={phase === 'working'}
          title={`这一轮改过 ${total} 个文件：点开列表逐一看差异 / 单独恢复${retry}`}
        >
          <Undo2 className="size-3.5" />
          {phase === 'working' ? '正在撤销…' : `撤销本轮文件改动（${triggerText(pending, total)}）`}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[min(560px,92vw)]">
        <DropdownMenuLabel className="flex items-center gap-2">
          <span>这一轮改过的文件</span>
          <span className="font-normal text-subtle">
            共 {total} 处{doneCount ? ` · 已恢复 ${doneCount}` : ''}
            {undo.skipped ? ` · 有 ${undo.skipped} 处没能记录` : ''}
          </span>
        </DropdownMenuLabel>
        <div className="max-h-72 overflow-y-auto">
          {files.map((f) => <FileRow key={f.path} f={f} undo={undo} />)}
          {undo.more ? <p className="px-2 py-1 text-[10.5px] text-subtle">…另有 {undo.more} 个文件（只列前 20 个）</p> : null}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onUndoAll()} disabled={phase === 'working' || pending === 0}>
          <Undo2 className="size-3.5" />
          {pending ? `全部恢复（还剩 ${pending} 处）` : '全部已恢复'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
