// ProjectsSection.jsx —— 项目：选根目录建项目、切换/改名/删除、看项目记忆文件夹位置
//
//  「项目」= 一个根目录。选定后服务端会为该账号生成一份**项目记忆文件夹**（每条记忆一个 .md，
//  外加 MEMORY.md 索引）——所以这一节只做"管理项目本身"，记忆条目的增删改在「记忆」那一节里。
import { useState } from 'react';
import { Archive, FolderGit2, Home, Pencil, Plus, RefreshCw } from 'lucide-react';
import { useApp, touch } from '../../state/store.js';
import { archiveProject, createProject, renameProject, selectProject, setStart, syncProjectMemory } from '../../state/projects.js';
import { shortPath } from '../../lib/format.js';
import { cn } from '../../lib/utils.js';
import { Badge } from '../../components/ui/badge.jsx';
import { Button } from '../../components/ui/button.jsx';
import { FieldDesc, SectionTitle } from '../../components/ui/field.jsx';
import { ImeInput } from '../../components/ui/ime-field.jsx';
import { toast } from '../../components/ui/toast.jsx';
import DirectoryPicker from '../DirectoryPicker.jsx';
import { EmptyHint, ListRow, NoteBox } from './parts.jsx';
import { askConfirm } from '../../state/host.js';


/* ============================ 一个项目 ============================ */

function ProjectRow({ p, active, onSelect, onArchive }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.name);
  const commit = () => { renameProject(p.id, name.trim() || p.name); setEditing(false); };
  return (
    <div className={cn('rounded-md border px-3 py-2', active ? 'border-primary/60 bg-accent/40' : 'border-border')}>
      <div className="flex items-center gap-2">
        <FolderGit2 className="size-4 shrink-0 text-subtle" />
        {editing ? (
          <ImeInput autoFocus value={name} onChange={(e) => setName(e.target.value)} className="h-7 flex-1 text-xs"
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key === 'Escape') setEditing(false); }}
            onBlur={commit} />
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{p.name}</span>
        )}
        {active ? <Badge variant="success">当前</Badge> : null}
        <Badge variant="secondary">{p.memoryCount || 0} 条记忆</Badge>
        <Button size="icon" variant="ghost" className="size-6" aria-label="改名"
          onClick={() => { setName(p.name); setEditing(true); }} title="改名"><Pencil /></Button>
        <Button size="icon" variant="ghost" className="size-6" aria-label="归档项目"
          onClick={() => onArchive(p)} title="归档这个项目：连同它下面的对话一起收进存档（设置 → 存档 里可恢复）">
          <Archive /></Button>
      </div>
      <button type="button" onClick={() => onSelect(p)} disabled={active}
        className={cn('mt-1 block max-w-full truncate text-left font-mono text-[11px]',
          active ? 'text-subtle' : 'text-muted-foreground hover:text-foreground')}
        title={active ? '已经是当前项目' : '切换到这个项目'}>
        {shortPath(p.root)}
      </button>
    </div>
  );
}

/* ============================ 分区 ============================ */

/** 起点：目录选择器从这里开始、项目必须落在它下面（不影响 agent 能读写哪些目录） */
function StartRow({ start }) {
  const [draft, setDraft] = useState('');
  return (
    <section>
      <SectionTitle>起点（项目都放这儿）</SectionTitle>
      <div className="space-y-2 px-4">
        <ListRow>
          <Home className="size-3.5 shrink-0 text-subtle" />
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground" title={start}>{start || '(未设置)'}</span>
        </ListRow>
        <div className="flex items-center gap-2">
          <ImeInput value={draft} onChange={(e) => setDraft(e.target.value)} className="h-8 font-mono text-xs"
            placeholder="换成别的目录，如 /media/leo/DATA/workspace"
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); setStart(draft.trim()).then((ok) => ok && setDraft('')); } }} />
          <Button size="sm" variant="outline" onClick={() => setStart(draft.trim()).then((ok) => ok && setDraft(''))}>设为起点</Button>
        </div>
        <FieldDesc>
          目录选择器从这里开始，也只能在起点内往下走；项目根目录必须落在起点内。
          <b>它不限制 agent 能读写哪些目录</b>——那个由「权限与工具 → 可访问目录」与绑定账号的系统权限决定。
        </FieldDesc>
      </div>
    </section>
  );
}

export default function ProjectsSection() {
  const st = useApp();
  const [pickerOpen, setPickerOpen] = useState(false);
  const projects = st.projects || [];
  const current = projects.find((p) => p.id === st.currentProjectId) || null;
  const start = (st.agentStatus && st.agentStatus.start) || (st.settings && st.settings.tools && st.settings.tools.start) || '';

  const pick = async (root) => {
    const p = await createProject(root, '');
    if (p) touch();
  };

  /* 归档确认走全局 askConfirm：与侧栏那条归档路径**同一个弹窗**——
     原先侧栏走 askConfirm、设置页走局部弹窗，同一个动作两种外观（审计）。 */
  const askArchive = async (p) => {
    const n = (st.sessions || []).filter((x) => (x.project || '') === p.id).length;
    const r = await askConfirm({
      title: '归档这个项目？',
      body: `「${p.name}」会连同它下面的对话一起收进存档（${p.memoryCount || 0} 条项目记忆、${n} 个对话）。\n`
        + '归档**不丢内容**：项目记忆文件夹与对话都原样搬进账号目录的 archive/，在「设置 → 存档」里可以随时恢复。\n'
        + '项目根目录里的文件不受影响。',
      okText: '归档',
    });
    if (r.ok) { await archiveProject(p.id); touch(); }
  };

  return (
    <div className="space-y-4 pb-6">
      <StartRow start={start} />
      <section>
        <SectionTitle>当前项目</SectionTitle>
        <div className="space-y-2 px-4">
          {current ? (
            <div className="rounded-lg border border-border px-3 py-2.5">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{current.name}</span>
                <Button size="sm" variant="ghost" onClick={() => selectProject('')} title="退出项目：之后的对话不再归属任何项目">
                  退出项目
                </Button>
              </div>
              <dl className="mt-2 space-y-1">
                <div className="flex gap-2 text-[11px]">
                  <dt className="shrink-0 text-subtle">根目录</dt>
                  <dd className="min-w-0 flex-1 truncate font-mono text-muted-foreground" title={current.root}>{current.root}</dd>
                </div>
                <div className="flex gap-2 text-[11px]">
                  <dt className="shrink-0 text-subtle">项目记忆文件夹</dt>
                  <dd className="min-w-0 flex-1 truncate font-mono text-muted-foreground" title={current.memoryDir}>{current.memoryDir}</dd>
                </div>
              </dl>
              <FieldDesc>
                这份文件夹在服务端的账号目录里：每条记忆一个 Markdown 文件，MEMORY.md 是索引——可以直接看、也可以整份拷走。
                条目在「设置 → 记忆 → 项目记忆」里增删改；模型也会把它认为该长期保留的项目知识写进来。
              </FieldDesc>
            </div>
          ) : (
            <EmptyHint>还没有选中项目：对话不归属任何项目，模型也不会收到"项目记忆"这一段。</EmptyHint>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setPickerOpen(true)}><Plus />选择目录建项目</Button>
            {current ? (
              <Button size="sm" variant="ghost" onClick={async () => {
                const r = await syncProjectMemory();
                if (r) { touch(); toast('项目记忆已同步到服务端', 'ok'); }
              }}><RefreshCw />同步项目记忆</Button>
            ) : null}
          </div>
        </div>
      </section>

      <section>
        <SectionTitle>全部项目（{projects.length}）</SectionTitle>
        <div className="space-y-2 px-4">
          {projects.length ? projects.map((p) => (
            <ProjectRow key={p.id} p={p} active={p.id === st.currentProjectId}
              onSelect={() => selectProject(p.id)}
              onArchive={askArchive} />
          )) : <EmptyHint>还没有项目。选一个目录，就能为它攒一份只属于这个项目的记忆。</EmptyHint>}
        </div>
      </section>

      <div className="px-4">
        <NoteBox>
          项目记忆与全局记忆的区别：全局记忆跨会话、跟着你走（"我的偏好"），项目记忆跟着**当前项目**走
          （"这个代码库怎么跑、踩过什么坑"）。换项目就换一份，互不干扰。
          项目根目录必须在**起点**内（见上方）；起点只管"项目放哪"，agent 能读写哪些目录由
          「权限与工具 → 可访问目录」与绑定账号的系统权限决定。
          侧栏与这里的「归档」按钮把项目（连同它的对话）收进存档，不会丢内容。
        </NoteBox>
      </div>

      <DirectoryPicker open={pickerOpen} onOpenChange={setPickerOpen} onPick={pick} />
    </div>
  );
}
