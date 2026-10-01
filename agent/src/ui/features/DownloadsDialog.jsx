// DownloadsDialog.jsx —— 「📥 待下载」：模型交给用户的文件都在这儿，点一下就下载
//
//  为什么是"链接"而不是 fetch+blob：下载该由浏览器自己做——Cookie 由它带、大文件不占 JS 内存、
//  进度与断点续传也是它的事。这里只提供 `<a href download>`（见 ui/state/downloads.js 的 downloadUrl）。
//  可执行文件在服务端已经打包成 zip（目录里根本不出现裸的可执行文件，见 lib/agent/files.js），
//  列表上给一个"已打包"的标记，免得用户以为拿不到原文件。
import { useEffect } from 'react';
import { Download, FolderOpen, RefreshCw, Trash2 } from 'lucide-react';
import { useApp } from '../state/store.js';
import { askConfirm } from '../state/host.js';
import { closeDownloads, downloadUrl, loadDownloads, removeDownload } from '../state/downloads.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog.jsx';
import { Button } from '../components/ui/button.jsx';
import { Badge } from '../components/ui/badge.jsx';
import { EmptyHint } from './settings/parts.jsx';
import { fmtBytes, timeAgo } from '../lib/format.js';

/** 一行：名字（链接）+ 大小/时间 + 标记 + 下载/删除 */
function Row({ e, onRemove }) {
  const size = fmtBytes(e.size || 0);
  return (
    <div className="flex items-center gap-2 rounded-md border border-border px-2.5 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 truncate text-sm text-foreground" title={e.name}>{e.name}</span>
          {e.exec ? <Badge variant="warning">可执行 · 已打包</Badge> : null}
          {!e.exec && e.packaged ? <Badge variant="secondary">zip</Badge> : null}
        </div>
        <p className="text-[11px] tabular-nums text-subtle">
          {size}{e.mtime ? ` · ${timeAgo(e.mtime)}` : ''}
          {e.exec ? ` · 下载得到 ${e.downloadName || e.name}` : ''}
        </p>
      </div>
      <a
        href={downloadUrl(e.name)}
        download={e.downloadName || e.name}
        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border px-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        title="下载（浏览器直接下载，不经 JS 中转）"
      >
        <Download className="size-3.5" />下载
      </a>
      <Button
        variant="ghost" size="sm" className="h-7 shrink-0 gap-1 px-1.5 text-[11px] text-subtle hover:text-destructive"
        title="从待下载目录里删掉" onClick={() => onRemove(e)}
      >
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  );
}

/** 列表体（含空态/错误态）：单独一个组件，让对话框本身只做编排 */
function Body({ d, entries, onRemove }) {
  if (d.error) return <EmptyHint>{d.error}</EmptyHint>;
  if (!entries.length) {
    return (
      <EmptyHint>
        还没有文件。让模型把产出物交给你（例如"把生成的报告放进待下载"），
        它调用 <code>deliver_file</code> 之后这里就会出现。
      </EmptyHint>
    );
  }
  return entries.map((e) => <Row key={e.name} e={e} onRemove={onRemove} />);
}

export function DownloadsDialog() {
  const st = useApp();
  const d = st.downloads || {};
  const open = !!d.open;
  const loading = !!d.loading;
  const count = (d.entries || []).length;
  /* 打开时若列表还是空的（或从没拉过），补一次——打开动作本身也会拉，这里兜"状态被清空" */
  useEffect(() => { if (open && !count && !loading) loadDownloads(); }, [open, count, loading]);

  if (!open) return null;
  const entries = d.entries || [];

  const onRemove = async (e) => {
    const r = await askConfirm({
      title: '从待下载目录删除？',
      body: `${e.name}\n\n只删服务端"待下载"目录里的这一份，模型生成它的源文件不受影响。`,
      okText: '删除', danger: true,
    });
    if (r.ok) removeDownload(e.name);
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!next) closeDownloads(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>📥 待下载文件</DialogTitle>
          <p className="text-xs leading-relaxed text-muted-foreground">
            模型用 <code>deliver_file</code> 放进来的文件都在这里，点「下载」即可（链接直连服务端）。
            可执行文件会被自动打包成 zip——目录里不会出现裸的可执行文件。
          </p>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[11px] text-subtle" title={d.dir || ''}>
            {d.dir ? `目录：${d.dir}` : ''}
          </span>
          <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-[11px]"
            disabled={!!d.loading} onClick={() => loadDownloads()}>
            <RefreshCw className={d.loading ? 'size-3.5 animate-spin' : 'size-3.5'} />刷新
          </Button>
        </div>

        <div className="max-h-[52vh] space-y-1.5 overflow-y-auto pr-0.5">
          <Body d={d} entries={entries} onRemove={onRemove} />
        </div>

        {entries.length ? (
          <p className="text-[11px] text-subtle">
            <FolderOpen className="mr-1 inline size-3.5" />
            共 {entries.length} 个文件。删除只是清掉这里的副本，不影响源文件。
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
