/* features/ConfirmDialog.jsx —— 人工闸门（工具确认 / 危险命令授权 / 技能改动）
 *
 *  串行队列：同一时刻只显示一个确认框，后面排队的在正文里注明"还有 N 个在等"——
 *  并发工具调用一次弹好几个框会让人以为同一条被问了两次。
 *  "总是允许"只在**既同意又勾选**时生效（拒绝不记豁免）；危险命令不给"总是允许"，
 *  每次都要人点头（票据一次性，见 lib/agent/grants.js）。
 */
import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../components/ui/dialog.jsx';
import { Button } from '../components/ui/button.jsx';
import { useApp } from '../state/store.js';
import { resolveConfirm } from '../state/host.js';

export function ConfirmDialog() {
  const st = useApp();
  const c = st.confirm;
  const [remember, setRemember] = useState(false);

  useEffect(() => { setRemember(false); }, [c]);

  if (!c) return null;
  const queued = (st.confirmQueue || []).length;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) resolveConfirm(false, false); }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className={c.danger ? 'text-destructive' : ''}>{c.title || '确认'}</DialogTitle>
        </DialogHeader>
        <pre className="max-h-[46vh] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
          {c.body}
        </pre>
        {queued > 0 ? <p className="text-xs text-muted-foreground">后面还有 {queued} 个确认在排队。</p> : null}
        {c.remember ? (
          <label className="flex items-start gap-2 text-xs leading-relaxed">
            <input type="checkbox" className="mt-0.5 size-4 accent-[var(--primary)]"
              checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            <span>{c.remember.label}</span>
          </label>
        ) : (
          <p className="text-xs text-muted-foreground">这条操作每次都会问你（不提供"总是允许"）。</p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => resolveConfirm(false, false)}>{c.cancelText || '拒绝'}</Button>
          <Button variant={c.danger ? 'destructive' : 'default'} onClick={() => resolveConfirm(true, remember)}>
            {c.okText || '同意'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
