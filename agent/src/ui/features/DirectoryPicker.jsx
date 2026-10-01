// DirectoryPicker.jsx —— 目录选择器：从可访问目录起步，逐级进入，选中一个目录作为"项目根目录"
//
//  为什么不让人直接敲路径：项目根目录要落在**可访问目录白名单**内（否则模型既看不到也改不了它），
//  敲错一个字符就得到一个"看起来对、其实不可用"的项目。所以给一个浏览器：只能在你允许的范围里点，
//  选到的路径一定是可用的（服务端每一层都重新校验一次，前端不自己判）。
import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, CornerLeftUp, Folder, FolderCheck, Home, Loader2 } from 'lucide-react';
import { browseDir } from '../state/projects.js';
import { shortPath } from '../lib/format.js';
import { cn } from '../lib/utils.js';
import { Button } from '../components/ui/button.jsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog.jsx';
import { FieldDesc } from '../components/ui/field.jsx';
import { ImeInput } from '../components/ui/ime-field.jsx';
import { toast } from '../components/ui/toast.jsx';


export default function DirectoryPicker({ open, onOpenChange, onPick, title = '选择项目根目录', hint }) {
  const [data, setData] = useState(null);
  const [path, setPath] = useState('');
  const [loading, setLoading] = useState(false);
  const [manual, setManual] = useState('');
  const start = (data && data.start) || '';

  const go = useCallback(async (p) => {
    setLoading(true);
    try {
      const d = await browseDir(p);
      setData(d);
      setPath(d.path || '');
      setManual(d.path || '');
    } catch (e) {
      toast('打不开这个目录：' + (e.message || e), 'err');
    } finally { setLoading(false); }
  }, []);

  /* 每次打开都从"可访问目录"重新起步：上一次停留在哪不重要，重要的是当前白名单 */
  useEffect(() => { if (open) go(''); }, [open, go]);

  const pick = () => {
    const p = (path || manual).trim();
    if (!p) { toast('先进入一个目录再选它', 'err'); return; }
    onPick(p);
    onOpenChange(false);
  };

  const entries = (data && data.entries) || [];
  const atStart = !!(data && data.atStart);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {hint || '从「起点」开始逐级进入，选中一个目录作为项目根目录；选定后会为它生成一份项目记忆文件夹。'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={!start || loading} onClick={() => go(start)} title="回到起点">
              <Home />起点
            </Button>
            <Button size="sm" variant="outline" disabled={!data || !data.parent || loading}
              onClick={() => go(data.parent)} title={atStart ? '已经在起点（起点之上不浏览）' : '上一级'}>
              <CornerLeftUp />上一级
            </Button>
            <ImeInput value={manual} onChange={(e) => setManual(e.target.value)} className="h-8 flex-1 font-mono text-xs"
              placeholder="绝对路径（必须在起点内）"
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); go(manual.trim()); } }} />
            <Button size="sm" variant="ghost" disabled={loading} onClick={() => go(manual.trim())}>前往</Button>
          </div>

          <div className="flex min-h-[16rem] flex-col rounded-md border border-border">
            <div className="flex items-center gap-1.5 border-b border-border bg-muted/30 px-3 py-1.5 text-[11px] text-subtle">
              {loading ? <Loader2 className="size-3.5 animate-spin" /> : <Folder className="size-3.5" />}
              <span className="min-w-0 flex-1 truncate font-mono" title={path || start}>
                {path ? shortPath(path) : '（起点）'}
              </span>
              {atStart ? <span className="shrink-0">起点 · 共 {entries.length} 个</span> : null}
            </div>
            <div className="max-h-64 min-h-0 flex-1 overflow-y-auto p-1">
              {entries.length ? entries.map((e) => (
                <button key={e.path} type="button" onClick={() => go(e.path)}
                  className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                    'text-muted-foreground hover:bg-muted hover:text-foreground')}>
                  <Folder className="size-3.5 shrink-0 text-subtle" />
                  <span className="min-w-0 flex-1 truncate">{e.name}</span>
                  <ChevronRight className="size-3.5 shrink-0 text-subtle" />
                </button>
              )) : <div className="px-2 py-6 text-center text-xs text-subtle">这里没有子目录（可以直接选它）</div>}
            </div>
          </div>

          <FieldDesc>
            起点是「项目都放在这儿」的那个目录（默认 /media/leo/DATA/workspace，在「设置 → 项目 → 起点」里改）：
            只能在起点内往下走。起点只决定项目放哪，**不影响 agent 能读写哪些目录**。
          </FieldDesc>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={pick} disabled={!path || loading}><FolderCheck />选这个目录</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
