// MemorySection.jsx —— 记忆：全局/会话两栏的增删改、导出导入，以及记忆相关设定
import { useEffect, useRef, useState } from 'react';
import { Download, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { useApp, touch } from '../../state/store.js';
import { addMemory, removeMemory, memoryExport, memoryImport, setParam } from '../../state/settings.js';
import { refreshCurrentMemory } from '../../state/projects.js';
import { Memory } from '../../../core/memory.js';
import { fmtTime } from '../../lib/format.js';
import { TOOL_FIELDS, resolve } from '../../../core/params.js';
import { Badge } from '../../components/ui/badge.jsx';
import { Button } from '../../components/ui/button.jsx';
import { FieldDesc, SectionTitle } from '../../components/ui/field.jsx';
import { ImeInput, ImeTextarea } from '../../components/ui/ime-field.jsx';
import { toast } from '../../components/ui/toast.jsx';
import { downloadText, EmptyHint, NoteBox, ParamRow } from './parts.jsx';

const SETTING_KEYS = ['tool_mem_on', 'mem_auto', 'session_mem_on', 'mem_inject', 'project_mem_inject', 'tool_mem_max'];
const parseTags = (s) => String(s || '').split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean).slice(0, 8);

/* ============================ 单条记忆 ============================ */

function MemoryCard({ entry, scope }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(entry.title);
  const [content, setContent] = useState(entry.content);
  const [tags, setTags] = useState((entry.tags || []).join(', '));

  /* 没有单独的 updateMemory 动作：用 core 的 Memory.update（它会发变更事件 → 自动落盘） */
  const save = () => {
    Memory.update(entry.id, { title: title.trim() || entry.title, content, tags: parseTags(tags) }, scope);
    touch();
    setEditing(false);
    toast('记忆已更新', 'ok');
  };

  return (
    <div className="rounded-md border border-border px-3 py-2">
      {editing ? (
        <div className="space-y-2">
          <ImeInput value={title} onChange={(e) => setTitle(e.target.value)} className="h-8 text-xs" placeholder="标题" />
          <ImeTextarea rows={4} value={content} onChange={(e) => setContent(e.target.value)} placeholder="正文" />
          <ImeInput value={tags} onChange={(e) => setTags(e.target.value)} className="h-8 text-xs" placeholder="标签，逗号分隔" />
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={save}>保存</Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>取消</Button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-start gap-1.5">
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{entry.title}</span>
            <Badge variant={entry.source === 'model' ? 'outline' : 'secondary'}>
              {entry.source === 'model' ? '模型写' : '手写'}
            </Badge>
            <Button size="icon" variant="ghost" className="size-6" aria-label="编辑" onClick={() => setEditing(true)}>
              <Pencil />
            </Button>
            <Button size="icon" variant="ghost" className="size-6 text-destructive" aria-label="删除"
              onClick={() => { removeMemory(entry.id, scope); toast('已删除该条记忆'); }}>
              <Trash2 />
            </Button>
          </div>
          <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">
            {entry.content.length > 240 ? entry.content.slice(0, 240) + '…' : entry.content}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {(entry.tags || []).map((t) => <Badge key={t} variant="secondary">{t}</Badge>)}
            <span className="ml-auto text-[11px] text-subtle">{fmtTime(entry.updated)}</span>
          </div>
        </>
      )}
    </div>
  );
}

/* ============================ 新增表单 ============================ */

function MemoryComposer({ scope }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [tags, setTags] = useState('');
  const add = () => {
    if (!title.trim() || !content.trim()) { toast('标题与正文都要填', 'err'); return; }
    addMemory(scope, { title: title.trim(), content, tags: parseTags(tags) });
    setTitle(''); setContent(''); setTags('');
    setOpen(false);
    toast('已记住', 'ok');
  };
  if (!open) return <Button size="sm" variant="outline" onClick={() => setOpen(true)}><Plus />新增</Button>;
  return (
    <div className="space-y-2 rounded-md border border-border px-3 py-2">
      <ImeInput value={title} onChange={(e) => setTitle(e.target.value)} className="h-8 text-xs" placeholder="标题（同标题会合并更新）" />
      <ImeTextarea rows={4} value={content} onChange={(e) => setContent(e.target.value)} placeholder="要记住的事实" />
      <ImeInput value={tags} onChange={(e) => setTags(e.target.value)} className="h-8 text-xs" placeholder="标签，逗号分隔（可选）" />
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={add}>保存</Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>取消</Button>
      </div>
    </div>
  );
}

/* ============================ 一栏（全局 / 项目 / 会话） ============================ */

function MemoryColumn({ scope, title, hint, extra }) {
  const list = Memory.listOf(scope);
  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="truncate text-xs font-semibold uppercase tracking-wider text-subtle">{title}</span>
        <Badge variant="secondary">{list.length}</Badge>
      </div>
      <FieldDesc className="mb-2">{hint}</FieldDesc>
      {extra}
      <MemoryComposer scope={scope} />
      <div className="mt-2 space-y-2">
        {list.length ? list.map((e) => <MemoryCard key={e.id} entry={e} scope={scope} />)
          : <EmptyHint>还没有{title}</EmptyHint>}
      </div>
    </div>
  );
}

/** 项目记忆那一栏的头顶：没项目时先说清"为什么这里是空的、去哪建项目" */
function ProjectHint() {
  const meta = Memory.projectMeta;
  if (!meta) {
    return (
      <NoteBox tone="warn" title="还没有当前项目">
        项目记忆跟着「当前项目」走。去「设置 → 项目」里选一个目录建项目，这里就会出现它的记忆——
        存在服务端的项目记忆文件夹里（每条一个 Markdown）。
      </NoteBox>
    );
  }
  return (
    <div className="mb-2 space-y-0.5 font-mono text-[11px] text-muted-foreground">
      <span className="block truncate" title={meta.root}>根目录 {meta.root}</span>
      {meta.memoryDir ? <span className="block truncate" title={meta.memoryDir}>记忆文件夹 {meta.memoryDir}</span> : null}
    </div>
  );
}

/* ============================ 导入 / 导出 ============================ */

function TransferBar() {
  const fileRef = useRef(null);
  const onExport = () => {
    downloadText(`agent-memory-${new Date().toISOString().slice(0, 10)}.json`, memoryExport());
    toast('已导出记忆 JSON', 'ok');
  };
  const onFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const added = memoryImport(await file.text());
      toast(`已导入 ${added} 条记忆`, 'ok');
    } catch (err) { toast('导入失败：' + (err.message || err), 'err'); }
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" onClick={onExport}><Download />导出 JSON</Button>
      <Button size="sm" variant="outline" onClick={() => fileRef.current && fileRef.current.click()}>
        <Upload />导入 JSON
      </Button>
      <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={onFile} />
      <FieldDesc>导入按标题合并：同名条目会被覆盖更新，不会重复堆积。</FieldDesc>
    </div>
  );
}

/* ============================ 分区 ============================ */

export default function MemorySection() {
  const st = useApp();
  const all = resolve(st.settings || {}, '', '');
  /* 打开这一节（或当前项目变了）就把**当前项目的记忆**从服务端重拉一份：
     记忆的真源在服务端账号目录的 Markdown 文件夹里，模型（托管运行）也可能刚改过它——
     界面只负责显示服务端那份，不拿内存里的旧副本凑合。 */
  useEffect(() => {
    refreshCurrentMemory().then(() => touch()).catch(() => {});
  }, [st.currentProjectId]);
  return (
    <div className="space-y-4 pb-6">
      <div className="px-4 pt-3">
        <TransferBar />
      </div>
      <div className="grid gap-3 px-4 sm:grid-cols-2 lg:grid-cols-3">
        <MemoryColumn scope="global" title="全局记忆" hint="跨会话，跟着登录身份走" />
        <MemoryColumn scope="project" title="项目记忆"
          hint="跟着当前项目走：换项目就换一份，存在服务端的项目记忆文件夹里" extra={<ProjectHint />} />
        <MemoryColumn scope="session" title="会话记忆" hint="只属于当前这个对话，删对话即消失" />
      </div>

      <section>
        <SectionTitle>记忆设定</SectionTitle>
        <div className="overflow-hidden rounded-lg border border-border">
          {SETTING_KEYS.map((key) => (
            <ParamRow key={key} field={TOOL_FIELDS[key]} value={all[key]} onChange={(v) => setParam(key, v, '')} />
          ))}
        </div>
      </section>

      <div className="px-4">
        <NoteBox>
          模型能不能"自己记"、记忆要不要进上下文，都由上面的开关决定；条目本身随时可以手改手删。
          记忆面板里的改动会立刻生效并保存。
        </NoteBox>
      </div>
    </div>
  );
}
