// PromptsSection.jsx —— 提示词登记表：分组条目（启停/编辑/重置，技能在 ② 组里增删改）、自定义条目、发送预览
import { useMemo, useState } from 'react';
import { ChevronDown, Eye, Plus, Trash2 } from 'lucide-react';
import { useApp } from '../../state/store.js';
import {
  setPromptDraft, applyPromptText, setPromptEnabled, resetPrompt,
  addPromptEntry, removePromptEntry, addSkill, removeSkill, clearPromptDraft, setSkillFields,
} from '../../state/settings.js';
import { Prompts } from '../../../core/prompts.js';
import { sendPreview, promptDraftCount, askConfirm, promptBlocks } from '../../state/host.js';
import { fmtNum } from '../../lib/format.js';
import { cn } from '../../lib/utils.js';
import { Badge } from '../../components/ui/badge.jsx';
import { Button } from '../../components/ui/button.jsx';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog.jsx';
import { FieldDesc, SectionTitle } from '../../components/ui/field.jsx';
import { ImeInput, ImeTextarea } from '../../components/ui/ime-field.jsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select.jsx';
import { Switch } from '../../components/ui/switch.jsx';
import { toast } from '../../components/ui/toast.jsx';
import { ChoiceGroup, EmptyHint, GroupCard, ListRow, NoteBox } from './parts.jsx';

const GROUP_ORDER = ['system', 'skills', 'tools', 'loop', 'compact', 'templates'];
/** 「用途」输入框的占位文案（SkillMetaFields 与 AddSkillForm 共用，原先两处逐字重复） */
const DESC_PLACEHOLDER = '用途（给模型看的一句话，决定它要不要加载）';
const KIND_LABEL = {
  system: '系统', skill: '技能', tool: '工具说明', schema: '参数描述',
  helper: '拼装片段', loop: '循环', compact: '压缩', template: '模板',
};
const KIND_VARIANT = {
  system: 'default', skill: 'success', tool: 'outline', schema: 'secondary',
  helper: 'secondary', loop: 'warning', compact: 'warning', template: 'outline',
};

/** 用户新增的条目（addEntry 生成的 id 以 px- 开头）；自定义技能另由 all() 标 custom */
const isExtra = (item) => typeof item.id === 'string' && item.id.startsWith('px-');
const isCustomSkill = (item) => item.custom === true;

/* 登记表的写入**不需要**这里手动落盘：core 的 register（set/reset/addSkill/updateSkill/…）
   都会 notify()，宿主的 Prompts.onChange 收到后 queuePrompts + 重绘（见 ui/state/host.js）。
   审计发现：此前这里另有一份 syncPrompts()（与 host.js 的同名函数重复），注释还停在
   "core 不发变更事件"的旧认知——那是 2026-09-30 修复之前的事，现在是多余的双写。 */

/* 注：这里原有独立的「技能（可增删改）」区（SkillEditor 一排输入框 + 「保存技能」按钮），
   与 ② 组的技能条目重复（同一份数据两个编辑器，改了一处另一处要刷新才对齐）。
   2026-10-01 合并：技能的增删改全部在 ② 组里做——展开条目即可改名称/用途/加载方式/正文，
   改动同样走"草稿 → 应用"；「新建技能」挂在 ② 组的列表下方。core 的读写入口一个没变。 */

/* ============================ 条目行 ============================ */

function KindBadges({ item }) {
  return (
    <>
      <Badge variant={KIND_VARIANT[item.kind] || 'secondary'}>{KIND_LABEL[item.kind] || item.kind}</Badge>
      <Badge variant="secondary">{String(item.text || '').length} 字</Badge>
      {item.overridden ? <Badge variant="warning">已改</Badge> : null}
      {item.custom || isExtra(item) ? <Badge variant="outline">自定义</Badge> : null}
    </>
  );
}

const removable = (item) => isExtra(item) || isCustomSkill(item);

/** 展开后的操作行：应用 / 恢复默认 / 删除 + 未应用提示 */
function PromptActions({ item, customSkill, dirty, onApply, onReset, onRemove }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" onClick={onApply} disabled={!dirty}>应用</Button>
      {customSkill ? null : (
        <Button size="sm" variant="outline" onClick={onReset} disabled={item.isDefault && !item.overridden}>
          恢复默认
        </Button>
      )}
      {removable(item) ? (
        <Button size="sm" variant="ghost" className="text-destructive" onClick={onRemove}><Trash2 />删除</Button>
      ) : null}
      <span className="text-xs text-subtle">
        {dirty ? '有未应用的修改：点「应用」才注入给模型' : '与已生效内容一致'}
      </span>
    </div>
  );
}

/** 自定义技能的名称 / 加载方式 / 用途（与正文同一套「草稿 → 应用」，见 setPromptDraft） */
function SkillMetaFields({ item, name, description, auto }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <ImeInput value={name} onChange={(e) => setPromptDraft(item.id, { name: e.target.value })}
          className="h-8 max-w-56 text-xs" placeholder="技能名称" />
        <ChoiceGroup
          options={[['on', '按需加载'], ['off', '常驻注入']]}
          value={auto ? 'on' : 'off'}
          onChange={(v) => setPromptDraft(item.id, { auto: v === 'on' })}
        />
        <span className="text-xs text-subtle">
          {auto ? '按需加载：只把名称与用途给模型，正文等它需要时再取。' : '常驻注入：正文每轮都进系统提示（只适合短而通用的约定）。'}
        </span>
      </div>
      <ImeInput value={description} onChange={(e) => setPromptDraft(item.id, { description: e.target.value })}
        className="h-8 text-xs" placeholder={DESC_PLACEHOLDER} />
    </>
  );
}

/* 草稿住在 state.promptDrafts（不是组件本地）：这样"有未应用的修改"在收起条目、切换条目、
   甚至关掉抽屉再回来时都还在，发送前也能提醒一句（见 settings.js 的 setPromptDraft）。
   草稿是**补丁对象**：普通条目只有 { text }；自定义技能另带 { name, description, auto }。
   下面几个模块级函数是"草稿 → 应用"的全部读写逻辑（放在组件外：进出组件只传值，判据只有一份）。 */

/** 一条目的最终值 = 当前值叠上草稿补丁；dirty 按**逐字段比较**判定——
 *  草稿在但值改回原样时不算（否则「应用」按钮一直亮着、顶栏徽章挂着一条点不掉的"未应用"）。 */
function draftView(item, drafts) {
  const custom = isCustomSkill(item);
  const base = { text: item.text, name: item.name, description: item.desc || '', auto: item.auto !== false };
  const draft = Object.prototype.hasOwnProperty.call(drafts || {}, item.id) ? drafts[item.id] : null;
  const view = Object.assign({}, base);
  if (draft) for (const k of Object.keys(view)) if (draft[k] !== undefined) view[k] = draft[k];
  const fields = custom ? Object.keys(base) : ['text'];
  view.dirty = !!draft && fields.some((k) => view[k] !== base[k]);
  return view;
}

/** 开关：对普通条目写覆盖表；自定义技能不走覆盖表，用 updateSkill 直接改（关掉 = 不注入/不可加载） */
const toggleItem = (item, on) => (isCustomSkill(item)
  ? setSkillFields(item.id, { enabled: on })
  : setPromptEnabled(item.id, on));

/** 应用一条草稿：自定义技能的名称/用途/加载方式/正文整份交给 updateSkill（登记表自己 notify → 落盘） */
function applyItem(item, view) {
  if (isCustomSkill(item)) setSkillFields(item.id, { name: view.name, description: view.description, auto: view.auto, text: view.text });
  else applyPromptText(item.id, view.text);
  clearPromptDraft(item.id);        // 两条路径都要丢掉草稿（技能不走覆盖表，得手动清）
}

/** 删除内置/技能条目（不可逆）：与全站约定一致先过 askConfirm（原先直接删 + toast，2026-10-06 补上） */
async function removeItem(item) {
  const r = await askConfirm({
    title: isCustomSkill(item) ? '删除技能？' : '删除条目？',
    body: isCustomSkill(item)
      ? `技能「${item.name}」与其正文将被删除，不可恢复（正文可先复制一份留底）。`
      : `条目「${item.name}」将被删除，不可恢复。`,
    okText: '删除', danger: true,
  });
  if (!r.ok) return;
  if (isCustomSkill(item)) removeSkill(item.id);
  else removePromptEntry(item.id);
  toast('已删除该条目', 'ok');
}

/** 主系统提示词的快选（core/prompts.js 的 presets）：填成草稿，点「应用」才生效 */
function PresetChips({ item }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-subtle">快选：</span>
      {Prompts.presets.map((preset) => (
        <Button key={preset.id} size="sm" variant="outline"
          onClick={() => setPromptDraft(item.id, { text: preset.text })}>{preset.name}</Button>
      ))}
    </div>
  );
}

/** 展开后的编辑器。输入即写草稿（不碰登记表）；点「应用」才生效——与上面那条 NoteBox 的说法一致。
    旧实现在 blur 时偷偷写进登记表，与「应用」按钮的语义打架（审计）。 */
function PromptEditor({ item, view }) {
  return (
    <div className="space-y-2 px-4 pb-3">
      {/* 自定义技能：名称 / 用途 / 加载方式与正文一样走「草稿 → 应用」
          （用途决定模型要不要加载它；常驻 = 正文每轮直接注入，按需 = 只给名字与用途） */}
      {isCustomSkill(item)
        ? <SkillMetaFields item={item} name={view.name} description={view.description} auto={view.auto} />
        : null}
      <ImeTextarea rows={8} value={view.text} spellCheck={false}
        onChange={(e) => setPromptDraft(item.id, { text: e.target.value })} />
      {item.id === 'system.base' ? <PresetChips item={item} /> : null}
      <PromptActions item={item} customSkill={isCustomSkill(item)} dirty={view.dirty}
        onApply={() => applyItem(item, view)} onReset={() => resetPrompt(item.id)}
        onRemove={() => removeItem(item)} />
    </div>
  );
}

function PromptItem({ item }) {
  const st = useApp();
  const [open, setOpen] = useState(false);
  const view = draftView(item, st.promptDrafts);
  return (
    <div className="border-b border-border/70 last:border-b-0">
      <div className="flex items-start gap-2 px-4 py-2">
        <Switch className="mt-0.5" checked={!!item.enabled} onCheckedChange={(on) => toggleItem(item, on)}
          aria-label={`启用 ${item.name}`} />
        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpen((v) => !v)}>
          <span className="flex flex-wrap items-center gap-1.5">
            <span className={cn('truncate text-sm', item.enabled ? 'text-foreground' : 'text-subtle line-through')}>
              {view.name}
            </span>
            <KindBadges item={item} />
          </span>
          {view.description ? <FieldDesc className="line-clamp-2">{view.description}</FieldDesc> : null}
        </button>
        <ChevronDown className={cn('mt-1.5 size-4 shrink-0 text-subtle transition-transform', open && 'rotate-180')} />
      </div>

      {open ? <PromptEditor item={item} view={view} /> : null}
    </div>
  );
}

/** 一个分组：标题 + 条目卡（footer 放"新建"这类挂在组尾的入口，见 ② 技能组） */
function PromptGroup({ id, items, footer }) {
  if (!items.length && !footer) return null;
  return (
    <section>
      <SectionTitle>{Prompts.groupTitles[id] || id}</SectionTitle>
      <GroupCard>
        {items.map((item) => <PromptItem key={item.id} item={item} />)}
      </GroupCard>
      {footer ? <div className="mt-2">{footer}</div> : null}
    </section>
  );
}

/* ============================ 新建技能（挂在 ② 技能组列表下方） ============================ */

function AddSkillForm() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [text, setText] = useState('');
  const add = () => {
    if (!name.trim()) { toast('给技能起个名字', 'err'); return; }
    addSkill({ name: name.trim(), description: description.trim(), text, auto: true });
    setName(''); setDescription(''); setText('');
    setOpen(false);
    toast('已新建技能', 'ok');
  };
  if (!open) return <Button size="sm" variant="outline" onClick={() => setOpen(true)}><Plus />新建技能</Button>;
  return (
    <div className="space-y-2 rounded-md border border-border px-3 py-2">
      <ImeInput value={name} onChange={(e) => setName(e.target.value)} className="h-8 text-xs" placeholder="技能名称" />
      <ImeInput value={description} onChange={(e) => setDescription(e.target.value)} className="h-8 text-xs" placeholder={DESC_PLACEHOLDER} />
      <ImeTextarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="技能正文" />
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={add}>添加</Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>取消</Button>
      </div>
      <FieldDesc>新技能默认「按需加载」；建好后在上面的条目里展开，可改名称、用途、加载方式与正文。</FieldDesc>
    </div>
  );
}

/* ============================ 自定义条目 ============================ */

const ENTRY_GROUPS = [['system', '系统区块'], ['tools', '工具说明'], ['loop', '循环提示'], ['compact', '压缩']];
const ENTRY_KINDS = [['system', '系统'], ['tool', '工具说明'], ['loop', '循环'], ['compact', '压缩'], ['template', '模板']];
const GROUP_LABEL = { system: '系统', skills: '技能', tools: '工具说明', loop: '循环', compact: '压缩', templates: '模板' };

function AddEntryForm() {
  const [name, setName] = useState('');
  const [group, setGroup] = useState('system');
  const [kind, setKind] = useState('system');
  const [text, setText] = useState('');
  const add = () => {
    if (!name.trim() || !text.trim()) { toast('名称与正文都要填', 'err'); return; }
    addPromptEntry({ name: name.trim(), group, kind, text });
    setName(''); setText('');
    toast('已添加自定义条目', 'ok');
  };
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-2">
        <ImeInput value={name} onChange={(e) => setName(e.target.value)} className="h-8 text-xs" placeholder="条目名称" />
        <Select value={group} onValueChange={setGroup}>
          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {ENTRY_GROUPS.map(([id, label]) => <SelectItem key={id} value={id} className="text-xs">{label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={kind} onValueChange={setKind}>
          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {ENTRY_KINDS.map(([id, label]) => <SelectItem key={id} value={id} className="text-xs">{label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <ImeTextarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="正文（启用后按分组顺序注入）" />
      <Button size="sm" variant="outline" onClick={add}><Plus />添加条目</Button>
    </div>
  );
}

/* ============================ 发送预览 ============================ */

function PreviewDialog({ open, onOpenChange }) {
  const st = useApp();
  /* 预览在 open 且"登记表/草稿变了"时才重组装（原先每次 store 重渲都重算一遍，浪费但不致错）。
     依赖是**有意**列的：sendPreview 不直接读它们（它在 host.js 里现读 state），但预览内容
     确实随登记表与草稿变化——这是数据依赖，不是遗留依赖。 */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const data = useMemo(() => (open ? sendPreview() : null), [open, st.revision, st.promptDrafts]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>本轮发送预览</DialogTitle>
        </DialogHeader>
        {data ? (
          <div className="space-y-3">
            <FieldDesc>
              注入 {data.blocks.length} 个区块、{data.defs.length} 个工具、共 {data.messages.length} 条 messages。
            </FieldDesc>
            <div className="max-h-32 overflow-y-auto rounded-md border border-border p-2">
              {data.blocks.map((b, i) => (
                <div key={b.id || i} className="truncate text-xs text-muted-foreground">#{i + 1} {b.title || b.id}</div>
              ))}
              {data.blocks.length ? null : <span className="text-xs text-subtle">（没有注入任何区块）</span>}
            </div>
            <pre className="max-h-72 overflow-auto rounded-md border border-border bg-code p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
              {JSON.stringify(data.messages, null, 2)}
            </pre>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/* ============================ 分区 ============================ */

export default function PromptsSection() {
  const { revision } = useApp();
  /* Prompts 是 core 层对象：登记表改动只会 bump revision，这里按它重算清单 */
  const items = useMemo(() => { void revision; return Prompts.all(); }, [revision]);
  const extras = items.filter(isExtra);
  const [previewOpen, setPreviewOpen] = useState(false);
  /* 徽章的两个数都要**如实**（2026-10-06 用户问"111854 字是否属实"后修正口径）：
     · 条数 = 登记表条目数（内置 + 用户技能/条目），属实；
     · 旧文案"启用后共 N 字"是**登记正文的合计**，不是每轮发给模型的量——按需技能的正文
       根本不注入（每轮只给名字与用途的目录，正文要 use_skill 才加载）、loop/模板/压缩类
       只在特定时刻发一条、schema 进的是工具定义而不是 system。真实每轮进 system 的字数
       用 promptBlocks() 现算——它与实际发送走同一份实现（core/assemble.js）。 */
  const onCount = items.filter((it) => it.enabled).length;
  const injected = promptBlocks().blocks.reduce((n, b) => n + String(b.text || '').length, 0);
  /* 未应用的草稿数（真源在 state.promptDrafts）：旧实现调的是一个**从未存在**的 Prompts.isDirty()，
     于是这个徽章永远不显示、草稿也没人提醒（审计发现）。
     响应性靠"任何 store 变化本组件都会重渲"这个事实——若改成细粒度订阅（只认 revision），
     草稿的徽章会静默失灵（草稿不 bump revision）。 */
  const pending = promptDraftCount();

  return (
    <div className="space-y-4 pb-6">
      <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
        <Badge variant="secondary" title="条数 = 登记表条目；「本轮注入」按当前开关现算（按需技能只发目录，正文要用时才加载）">
          {items.length} 条登记（启用 {onCount}）· 本轮注入约 {fmtNum(injected)} 字
        </Badge>
        {pending ? <Badge variant="warning">有 {pending} 处未应用的修改</Badge> : null}
        <span className="flex-1" />
        <Button size="sm" variant="outline" onClick={() => setPreviewOpen(true)}><Eye />本轮发送预览</Button>
      </div>

      <NoteBox>
        这里列出**所有**会发给模型的文本——工具使用说明、每个工具定义里的描述（「参数描述」）、
        循环提示与拼装片段都在列。**你对它们有完整权限**：查看、改写、恢复默认、启停，
        没有任何"藏在代码里改不了"的提示词。改动先落在草稿上，点「应用」才注入；
        关掉开关 = 该条永不注入，空白正文会被跳过。
        技能在 ② 组里增删改：展开条目可改名称/用途/加载方式/正文，组尾可新建技能。
      </NoteBox>

      {GROUP_ORDER.map((gid) => (
        <PromptGroup key={gid} id={gid} items={items.filter((it) => it.group === gid)}
          footer={gid === 'skills' ? <AddSkillForm /> : null} />
      ))}

      <section>
        <SectionTitle>自定义条目</SectionTitle>
        <div className="space-y-2 px-4">
          {extras.length ? extras.map((e) => (
            <ListRow key={e.id}>
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">{e.name}</span>
              <Badge variant="secondary">{GROUP_LABEL[e.group] || e.group}</Badge>
              <Button size="icon" variant="ghost" className="size-7 text-destructive" aria-label={`删除 ${e.name}`}
                onClick={async () => {
                  const r = await askConfirm({ title: '删除条目？',
                    body: `自定义条目「${e.name}」将被删除，不可恢复。`, okText: '删除', danger: true });
                  if (!r.ok) return;
                  removePromptEntry(e.id);
                  toast('已删除该条目', 'ok');
                }}>
                <Trash2 />
              </Button>
            </ListRow>
          )) : <EmptyHint>还没有自定义条目。</EmptyHint>}
          <AddEntryForm />
        </div>
      </section>

      <PreviewDialog open={previewOpen} onOpenChange={setPreviewOpen} />
    </div>
  );
}
