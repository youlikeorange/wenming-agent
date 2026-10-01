// ArchiveSection.jsx —— 存档：归档的会话与项目（连它们的会话）在这里恢复或彻底删除
//
//  侧栏的「归档」按钮把对话（或整个项目 + 它下面的对话）搬进账号目录下的 archive/：
//      STATE_DIR/agent/<文档站账号>/archive/
//          sessions.json       归档的会话（原样 + archivedAt）
//          projects.json       归档的项目元信息
//          projects/<项目id>/   归档的项目记忆文件夹（整份搬过来）
//  归档不丢内容、也不进上下文（"收起来"就是不再注入）；**彻底删除只在这里**，那一步才不可逆。
import { useCallback, useEffect, useState } from 'react';
import { Archive, FolderGit2, RefreshCw, Undo2, X } from 'lucide-react';
import { useApp } from '../../state/store.js';
import { loadArchive, purgeArchived, restoreArchived } from '../../state/projects.js';
import { shortPath, fmtTime } from '../../lib/format.js';
import { Badge } from '../../components/ui/badge.jsx';
import { Button } from '../../components/ui/button.jsx';
import { FieldDesc, SectionTitle } from '../../components/ui/field.jsx';
import { EmptyHint, NoteBox } from './parts.jsx';
import { askConfirm } from '../../state/host.js';


export default function ArchiveSection() {
  const st = useApp();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try { setData(await loadArchive()); } finally { setBusy(false); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const projectName = (id) => ((st.projects || []).find((p) => p.id === id) || {}).name || '';
  const sessions = (data && data.sessions) || [];
  const projects = (data && data.projects) || [];

  const doRestore = async (kind, id) => {
    const ok = await restoreArchived(kind, id);
    if (ok) refresh();
  };
  /* 不可逆的"彻底删除"走全局 askConfirm（安全动作只有一套确认实现，审计） */
  const askPurge = async (item) => {
    const r = await askConfirm({
      title: '彻底删除？',
      body: `${item.label} 将从存档里永久删除，不可恢复。\n`
        + '（如果只是想让它不占地方，什么都不用做——归档本来就不进上下文。）',
      okText: '彻底删除', danger: true,
    });
    if (!r.ok) return;
    if (await purgeArchived(item.kind, item.id)) refresh();
  };

  return (
    <div className="space-y-4 pb-6">
      <section>
        <SectionTitle>归档的项目（{projects.length}）</SectionTitle>
        <div className="space-y-2 px-4">
          {projects.length ? projects.map((p) => (
            <div key={p.id} className="rounded-md border border-border px-3 py-2">
              <div className="flex items-center gap-2">
                <FolderGit2 className="size-4 shrink-0 text-subtle" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{p.name}</span>
                <Badge variant="secondary">{p.memoryCount} 条记忆</Badge>
                <Badge variant="secondary">{p.sessions} 个对话</Badge>
                <Button size="sm" variant="outline" onClick={() => doRestore('project', p.id)}><Undo2 />恢复</Button>
                <Button size="icon" variant="ghost" className="size-7 text-destructive" aria-label="彻底删除"
                  onClick={() => askPurge({ kind: 'project', id: p.id, label: `项目「${p.name}」` })} title="彻底删除（不可恢复）">
                  <X />
                </Button>
              </div>
              <FieldDesc className="font-mono">{shortPath(p.root)} · 归档于 {fmtTime(p.archivedAt)}</FieldDesc>
            </div>
          )) : <EmptyHint>没有归档的项目</EmptyHint>}
        </div>
      </section>

      <section>
        <SectionTitle>归档的对话（{sessions.length}）</SectionTitle>
        <div className="space-y-2 px-4">
          {sessions.length ? sessions.map((s) => (
            <div key={s.id} className="flex items-center gap-2 rounded-md border border-border px-3 py-2">
              <Archive className="size-4 shrink-0 text-subtle" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-foreground">{s.title}</span>
                <span className="block truncate text-[11px] text-subtle">
                  {s.rounds} 轮{s.project ? ` · ${projectName(s.project) || '（项目已不在）'}` : ''} · 归档于 {fmtTime(s.archivedAt)}
                </span>
              </span>
              <Button size="sm" variant="outline" onClick={() => doRestore('session', s.id)}><Undo2 />恢复</Button>
              <Button size="icon" variant="ghost" className="size-7 text-destructive" aria-label="彻底删除"
                onClick={() => askPurge({ kind: 'session', id: s.id, label: `对话「${s.title}」` })} title="彻底删除（不可恢复）">
                <X />
              </Button>
            </div>
          )) : <EmptyHint>没有归档的对话</EmptyHint>}
        </div>
      </section>

      <div className="flex items-center gap-2 px-4">
        <Button size="sm" variant="ghost" disabled={busy} onClick={refresh}><RefreshCw />刷新</Button>
        <FieldDesc>归档存在该账号自己的目录里：<span className="font-mono">STATE_DIR/agent/&lt;账号&gt;/archive/</span></FieldDesc>
      </div>

      <div className="px-4">
        <NoteBox>
          侧栏每个对话右边的图标是「归档」：搬进存档、不再出现在会话列表里，也不再进上下文。
          恢复后对话与它的记忆原样回来；恢复项目会把该项目**连同它下面的对话**一起恢复。
          只有这里的「✕ 彻底删除」是不可逆的。
        </NoteBox>
      </div>

    </div>
  );
}
