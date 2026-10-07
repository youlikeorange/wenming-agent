// DataSection.jsx —— 数据：导出全部、会话统计、清空/归档对话、上下文用量与压缩
import { useState } from 'react';
import { AlertTriangle, Archive, Download, Eraser, Minimize2 } from 'lucide-react';
import { useApp } from '../../state/store.js';
import { archiveSession, clearChat } from '../../state/session.js';
import { askConfirm } from '../../state/host.js';
import { fmtCount } from '../../lib/format.js';
import { exportAll, compactNow, uncompact } from '../../state/settings.js';
import { Badge } from '../../components/ui/badge.jsx';
import { Button } from '../../components/ui/button.jsx';
import { FieldRow, FieldValue, SectionTitle } from '../../components/ui/field.jsx';
import { Spinner } from '../../components/ui/spinner.jsx';
import { toast } from '../../components/ui/toast.jsx';
import { downloadText, GroupCard, NoteBox } from './parts.jsx';

/* ============================ 四块内容 ============================ */

function ExportCard() {
  const doExport = () => {
    downloadText(`agent-backup-${new Date().toISOString().slice(0, 10)}.json`, exportAll());
    toast('已导出全部数据 JSON', 'ok');
  };
  return (
    <>
      <SectionTitle>导出</SectionTitle>
      <div className="flex flex-wrap items-center gap-2 px-4">
        <Button size="sm" variant="outline" onClick={doExport}><Download />导出全部数据</Button>
        <span className="text-xs text-subtle">设置、全部对话、提示词登记表与全局记忆，一个 JSON 文件。</span>
      </div>
    </>
  );
}

function StatsCard({ sessions, msgTotal, cur, historyLen }) {
  return (
    <>
      <SectionTitle>会话统计</SectionTitle>
      <GroupCard className="mx-4">
        <FieldRow label="对话条数"><FieldValue>{fmtCount(sessions.length)}</FieldValue></FieldRow>
        <FieldRow label="消息总数"><FieldValue>{fmtCount(msgTotal)}</FieldValue></FieldRow>
        <FieldRow label="当前对话消息数"><FieldValue>{fmtCount(historyLen)}</FieldValue></FieldRow>
        <FieldRow label="当前对话">
          <FieldValue className="max-w-[16rem]">{cur ? cur.title || '新对话' : '（无）'}</FieldValue>
        </FieldRow>
      </GroupCard>
    </>
  );
}

function CleanupCard({ streaming, count, busy, onClear, onArchiveAll }) {
  return (
    <>
      <SectionTitle>清理</SectionTitle>
      <div className="space-y-2 px-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={onClear} disabled={streaming}>
            <Eraser />清空当前对话
          </Button>
          <Button size="sm" variant="outline"
            onClick={onArchiveAll} disabled={!count || streaming || busy}>
            {busy ? <Spinner size="sm" /> : <Archive />}归档所有对话
          </Button>
        </div>
        <NoteBox tone="warn" title="这里只有归档，没有删除">
          <span className="inline-flex items-start gap-1">
            <AlertTriangle className="mt-px size-3.5 shrink-0" />
            清空只影响当前对话；「归档所有对话」把它们整体收进存档（不丢内容，也不再进上下文），
            在「设置 → 存档」里可以逐个恢复或彻底删除——那一步才不可逆。
            想留个文件备份，用上面的「导出全部数据」。
          </span>
        </NoteBox>
      </div>
    </>
  );
}

function ContextCard({ ctx, streaming, historyLen, busy, compacted, count, onCompact, onUncompact }) {
  const pct = Math.max(0, Math.min(100, Number(ctx.pct) || 0));
  const tone = ctx.state === 'danger' ? 'bg-destructive' : ctx.state === 'warn' ? 'bg-warning' : 'bg-primary';
  return (
    <>
      <SectionTitle>上下文</SectionTitle>
      <div className="space-y-2 px-4">
        <GroupCard>
          <div className="px-4 pt-3">
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-medium text-foreground">上下文用量</span>
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {fmtCount(ctx.used)} / {fmtCount(ctx.limit)} token（{pct}%）
              </span>
            </div>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-border-strong/60">
              <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
            </div>
          </div>
          <div className="mt-2">
            <FieldRow label="系统提示与注入区块"><FieldValue>{fmtCount(ctx.sysTok)} token</FieldValue></FieldRow>
            <FieldRow label="历史消息"><FieldValue>{fmtCount(ctx.histTok)} token</FieldValue></FieldRow>
          </div>
          {streaming ? <p className="px-4 pb-2 text-xs text-subtle">正在生成：压缩要等这一轮结束后再做。</p> : null}
        </GroupCard>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={onCompact} disabled={busy || streaming || !historyLen}>
            {busy ? <Spinner size="sm" /> : <Minimize2 />}压缩现在
          </Button>
          <Button size="sm" variant="outline" onClick={onUncompact} disabled={!compacted}>取消压缩</Button>
          {compacted ? <Badge variant="secondary">已压缩（{count} 条被摘要替代）</Badge> : null}
        </div>
        <p className="text-xs text-subtle">
          压缩只影响发给模型的上下文：原始消息仍留在对话里可见，摘要代替原文发送。
        </p>
      </div>
    </>
  );
}

/* ============================ 动作 ============================ */

function useDataActions(sessions) {
  const [busy, setBusy] = useState(false);
  const guard = async (fn) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };
  return {
    busy,
    compact: () => guard(compactNow),        // 提示与守卫都在 settings.js 的 compactNow 里（唯一入口）
    undoCompact: () => { uncompact(); toast('已取消压缩，恢复全文上下文'); },
    archiveAll: () => guard(async () => { for (const s of sessions.slice()) await archiveSession(s.id); }),
  };
}

/* ============================ 分区 ============================ */

export default function DataSection() {
  const st = useApp();
  const sessions = st.sessions || [];
  const msgTotal = sessions.reduce((n, s) => n + ((s.msgs && s.msgs.length) || 0), 0);
  const cur = sessions.find((s) => s.id === st.activeSessId) || null;
  const compaction = cur && cur.compaction;
  const compacted = !!(compaction && compaction.text);
  const { busy, compact, undoCompact, archiveAll } = useDataActions(sessions);
  /* 两个不可逆/批量动作都走全局 askConfirm：队列化、外观与工具确认框一致，
     不再各自维护一份 open 状态 + 局部弹窗（审计：同一个动作两套实现）。 */
  const askClearChat = async () => {
    const r = await askConfirm({
      title: '清空当前对话？',
      body: '当前对话的全部消息、会话记忆与压缩摘要都会被清掉（对话本身保留），不可恢复。',
      okText: '清空', danger: true,
    });
    if (r.ok) clearChat();
  };
  const askArchiveAll = async () => {
    const r = await askConfirm({
      title: `删除全部 ${sessions.length} 个对话？`,
      body: '所有对话会被收进存档（含各自的会话记忆），不再出现在会话列表里，也不进上下文。\n'
        + '归档不丢内容：在「设置 → 存档」里可以逐个恢复，或在那里彻底删除。',
      okText: '归档',
    });
    if (r.ok) archiveAll();
  };

  return (
    <div className="space-y-4 pb-6">
      <ExportCard />
      <StatsCard sessions={sessions} msgTotal={msgTotal} cur={cur} historyLen={st.history.length} />
      <CleanupCard
        streaming={!!st.streaming}
        count={sessions.length}
        busy={busy}
        onClear={askClearChat}
        onArchiveAll={askArchiveAll}
      />
      <ContextCard
        ctx={st.ctx || {}}
        streaming={!!st.streaming}
        historyLen={st.history.length}
        busy={busy}
        compacted={compacted}
        count={(compaction && compaction.count) || 0}
        onCompact={compact}
        onUncompact={undoCompact}
      />

    </div>
  );
}
