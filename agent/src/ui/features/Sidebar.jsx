// Sidebar.jsx —— 左侧会话栏：品牌头、当前项目卡、当前模型卡、会话列表（按项目/时间分组）与本机账号绑定状态
import { useState } from 'react';
import { Archive, Bot, Check, ChevronDown, ChevronRight, FolderGit2, Home, MessageSquarePlus, Pencil } from 'lucide-react';
import { Spinner } from '../components/ui/spinner.jsx';
import { activeProvider, askConfirm, hooks } from '../state/host.js';
import { archiveSession, newSession, openDrawer, renameSession, selectSession } from '../state/session.js';
import { archiveProject } from '../state/projects.js';
import { setUi } from '../state/settings.js';
import { useImeSafe } from '../components/ui/ime-field.jsx';
import { cn } from '../lib/utils.js';
import { fullTime, timeAgo } from '../lib/format.js';
import { BRAND } from '../lib/brand.js';
import { useApp } from '../state/store.js';

/* ============================ 品牌头 ============================ */

function Brand() {
  return (
    <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-foreground text-background">
        <Bot className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold leading-tight" title={`${BRAND.full} —— ${BRAND.tagline}`}>{BRAND.name}</span>
        <span className="block truncate text-[11px] text-subtle">记忆 · 技能 · 全参数</span>
      </span>
      <a
        href="../"
        title="返回门户首页"
        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Home className="size-4" />
      </a>
    </div>
  );
}

/* ============================ 当前模型卡片 ============================ */

function ModelCard({ provider, status, onOpenSettings }) {
  const dot = status.connected
    ? 'bg-success'
    : status.checking ? 'bg-warning animate-pulse' : 'bg-destructive';
  return (
    <button
      type="button"
      onClick={() => (onOpenSettings || (() => openDrawer('models')))()}
      title="当前模型（点击进入设置 → 模型）"
      className="mx-3 mt-3 rounded-xl border border-border bg-muted/40 px-3 py-2 text-left transition-colors hover:border-border-strong hover:bg-muted/70"
    >
      <span className="flex items-center gap-2">
        <span className="text-[11px] text-subtle">当前模型</span>
        <span className={cn('ml-auto size-2 shrink-0 rounded-full', dot)} />
      </span>
      <span className="mt-0.5 block truncate text-[13px] font-medium">
        {provider ? provider.model || provider.name : '未配置模型'}
      </span>
      <span className="mt-0.5 block truncate font-mono text-[11px] text-subtle">
        {provider ? `${provider.name || ''} · ${provider.type || ''} · ${provider.baseUrl || '默认地址'}` : '点这里添加一个模型'}
      </span>
    </button>
  );
}

/* ============================ 会话列表（按项目 / 按时间分组） ============================ */

/** 时间分组的桶（"最后处理时间"用会话的 ts——每次落盘都会刷新它） */
const DAY = 864e5;
function bucketOf(ts) {
  const d = new Date();
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const t = Number(ts) || 0;
  if (t >= today) return ['today', '今天'];
  if (t >= today - DAY) return ['yesterday', '昨天'];
  if (t >= today - 6 * DAY) return ['week', '近 7 天'];
  if (t >= today - 29 * DAY) return ['month', '近 30 天'];
  return ['older', '更早'];
}

/** 分组：按项目（项目文件夹 = 一个组，未归属的归"未归项目"）或按最后处理时间 */
function groupSessions(sessions, by, projects, currentProjectId) {
  const sorted = sessions.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const groups = new Map();                     // key → { key, label, hint, sessions }
  const push = (key, label, hint, s) => {
    if (!groups.has(key)) groups.set(key, { key, label, hint, sessions: [] });
    groups.get(key).sessions.push(s);
  };
  if (by === 'time') {
    for (const s of sorted) { const [k, label] = bucketOf(s.ts); push(k, label, '', s); }
    return [...groups.values()];
  }
  const byId = new Map((projects || []).map((p) => [p.id, p]));
  for (const s of sorted) {
    const p = byId.get(s.project || '');
    if (p) push('p:' + p.id, p.name, p.root, s);
    else push('none', '未归项目', '这些对话不属于任何项目（新建对话时选一个项目即可归进去）', s);
  }
  /* 组序：当前项目在最前，其次按组内最新时间，最后是"未归项目" */
  const out = [...groups.values()];
  out.sort((a, b) => {
    if (a.key === 'none') return 1;
    if (b.key === 'none') return -1;
    if (a.key === 'p:' + currentProjectId) return -1;
    if (b.key === 'p:' + currentProjectId) return 1;
    return (b.sessions[0].ts || 0) - (a.sessions[0].ts || 0);
  });
  return out;
}

/** 会话的"轮数" = 用户消息条数（侧栏副标题里那个 N 轮） */
const rounds = (s) => (s.msgs || []).filter((m) => m.role === 'user').length;

function SessionItem({ s, activeId, projectName, editingId, title, setTitle, startRename, commit, onNavigate, running }) {
  /* 改名框也走 IME 安全绑定（见 ime-field.jsx）：这里直接用 hook 保留原生 <input> 的样式 */
  const bind = useImeSafe(editingId === s.id ? title : '', (e) => setTitle(e.target.value));
  if (editingId === s.id) {
    return (
      <input
        autoFocus
        {...bind}
        onKeyDown={(e) => {
          /* 输入法组合中敲回车 = 确认候选词，不是提交改名 */
          if ((e.nativeEvent && e.nativeEvent.isComposing) || e.keyCode === 229) return;
          if (e.key === 'Enter') { e.preventDefault(); commit(s.id); }
          else if (e.key === 'Escape') { setTitle(null); }
        }}
        onBlur={() => commit(s.id)}
        className="w-full rounded-md border border-ring/60 bg-card px-2 py-1.5 text-xs text-foreground outline-none"
      />
    );
  }
  return (
    <div
      role="button"
      tabIndex={0}
      title="点击切换 · 双击重命名"
      onClick={() => { selectSession(s.id); if (onNavigate) onNavigate(); }}
      onDoubleClick={() => startRename(s)}
      onKeyDown={(e) => { if (e.key === 'Enter') { selectSession(s.id); if (onNavigate) onNavigate(); } }}
      className={cn(
        'group/sess flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-xs transition-colors',
        s.id === activeId
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {/* 正在生成的小标：多会话并行时，一眼看出"哪几条在跑"（切过去就能接着看） */}
      {running ? <Spinner size="sm" title="正在生成回答" /> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{s.title || '新对话'}</span>
        <span className="block truncate text-[10.5px] text-subtle" title={fullTime(s.ts)}>
          {running ? '正在生成…' : timeAgo(s.ts)}{!running && rounds(s) ? ` · ${rounds(s)} 轮` : ''}{projectName ? ` · ${projectName}` : ''}
        </span>
      </span>
      <button
        type="button"
        title="重命名（双击会话也能改）"
        onClick={(e) => { e.stopPropagation(); startRename(s); }}
        className="rounded p-0.5 opacity-0 transition-opacity hover:text-foreground group-hover/sess:opacity-100 touch-visible"
      >
        <Pencil className="size-3.5" />
      </button>
      <button
        type="button"
        title={running ? '正在生成：先「停止」或等它跑完再归档' : '归档这个对话（搬进存档，随时可在设置 → 存档里恢复）'}
        onClick={(e) => { e.stopPropagation(); archiveSession(s.id); }}
        className="rounded p-0.5 opacity-0 transition-opacity hover:text-foreground group-hover/sess:opacity-100 touch-visible"
      >
        <Archive className="size-3.5" />
      </button>
    </div>
  );
}

function SessionList({ sessions, activeId, projects, currentProjectId, groupBy, onGroupBy, onNavigate, runs }) {
  const [editingId, setEditingId] = useState(null);
  const [title, setTitle] = useState('');
  const [collapsed, setCollapsed] = useState(() => new Set());

  const startRename = (s) => { setEditingId(s.id); setTitle(s.title || ''); };
  const commit = (id) => {
    if (title !== null) renameSession(id, title);
    setEditingId(null); setTitle('');
  };
  const toggle = (key) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const groups = groupSessions(sessions, groupBy, projects, currentProjectId);
  const byId = new Map((projects || []).map((p) => [p.id, p]));

  return (
    <div className="mt-3 flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1.5 px-3">
        <span className="text-[11px] text-subtle">{sessions.length ? `${sessions.length} 个对话` : '暂无历史对话'}</span>
        {/* 分组口径：按项目文件夹 / 按最后处理时间 */}
        <span className="ml-auto flex items-center gap-0.5 rounded-md border border-border bg-muted p-0.5">
          {[['project', '项目'], ['time', '时间']].map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={groupBy === id}
              title={id === 'project' ? '按项目文件夹分组' : '按最后处理时间分组'}
              onClick={() => onGroupBy(id)}
              className={cn('rounded-sm px-1.5 py-0.5 text-[10.5px] font-medium transition-colors',
                groupBy === id ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground')}
            >
              {label}
            </button>
          ))}
        </span>
        <button
          type="button"
          title="新建对话（归属当前项目）"
          onClick={() => { newSession(); if (onNavigate) onNavigate(); }}
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <MessageSquarePlus className="size-3.5" />新建
        </button>
      </div>

      <div className="mt-1.5 min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-2">
        {groups.map((g) => (
          <div key={g.key}>
            <button
              type="button"
              onClick={() => toggle(g.key)}
              title={g.hint || g.label}
              className="flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-subtle transition-colors hover:bg-muted/60 hover:text-muted-foreground"
            >
              {collapsed.has(g.key) ? <ChevronRight className="size-3.5 shrink-0" /> : <ChevronDown className="size-3.5 shrink-0" />}
              {g.key.startsWith('p:') ? <FolderGit2 className="size-3.5 shrink-0" /> : null}
              <span className="min-w-0 flex-1 truncate text-left">{g.label}</span>
              <span className="shrink-0 tabular-nums">{g.sessions.length}</span>
            </button>
            {collapsed.has(g.key) ? null : (
              <div className="space-y-0.5">
                {g.sessions.map((s) => (
                  <SessionItem
                    key={s.id}
                    s={s}
                    activeId={activeId}
                    /* 项目分组下组头已经写了项目名，条目里就不重复；时间分组下才带项目名 */
                    projectName={groupBy === 'time' ? ((byId.get(s.project || '') || {}).name || '') : ''}
                    editingId={editingId} title={title} setTitle={setTitle}
                    startRename={startRename} commit={commit} onNavigate={onNavigate}
                    running={!!(runs && runs[s.id] && !runs[s.id].settled)}
                  />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ============================ 当前项目卡 ============================ */

/** 当前项目卡：点进去管理项目；右边一个归档按钮——**连它下面的会话一起**收进存档 */
function ProjectCard({ project }) {
  if (!project) {
    return (
      <button
        type="button"
        onClick={() => openDrawer('projects')}
        title="还没有项目：点这里选一个目录，为它攒一份项目记忆"
        className="mx-3 mt-3 flex items-center gap-2 rounded-xl border border-border bg-muted/40 px-3 py-2 text-left transition-colors hover:border-border-strong hover:bg-muted/70"
      >
        <FolderGit2 className="size-4 shrink-0 text-subtle" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium">未选择项目</span>
          <span className="block truncate font-mono text-[11px] text-subtle">点这里选一个目录作为项目根</span>
        </span>
      </button>
    );
  }
  return (
    <div className="mx-3 mt-3 flex items-center gap-2 rounded-xl border border-border bg-muted/40 px-3 py-2 transition-colors hover:border-border-strong hover:bg-muted/70">
      <button
        type="button"
        onClick={() => openDrawer('projects')}
        title={`当前项目：${project.name}\n根目录：${project.root}\n（点击进入设置 → 项目）`}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <FolderGit2 className="size-4 shrink-0 text-subtle" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium">{project.name}</span>
          <span className="block truncate font-mono text-[11px] text-subtle">{project.root}</span>
        </span>
        <span className="shrink-0 text-[11px] text-subtle">{project.memoryCount || 0} 条记忆</span>
      </button>
      <button
        type="button"
        title={`归档这个项目：连同它下面的对话一起收进存档（设置 → 存档 里可恢复）`}
        onClick={async () => {
          // 项目归档会带走它下面**全部**对话，问一句再动手（可逆，但动静大）
          const r = await askConfirm({
            title: '归档这个项目？',
            body: `「${project.name}」会连同它下面的对话一起收进存档，会话列表里将不再出现它们。\n`
              + '归档不丢内容：项目记忆文件夹与对话都原样搬进账号目录的 archive/，在「设置 → 存档」里可随时恢复。',
            okText: '归档',
          });
          if (r.ok) archiveProject(project.id);
        }}
        className="shrink-0 rounded p-0.5 text-subtle transition-colors hover:text-foreground"
      >
        <Archive className="size-3.5" />
      </button>
    </div>
  );
}

/* ============================ 本机账号绑定状态 ============================ */

const BIND_BTN = 'shrink-0 rounded-md border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground';

function BindRow({ info, onLogin }) {
  const binding = (info && info.binding) || null;
  if (!(info && info.loggedIn)) {
    return (
      <div className="flex items-center gap-2 border-t border-border px-3 py-2 text-[11px] text-subtle">
        <span className="min-w-0 flex-1 truncate">未登录：本机账号绑定登录后可用</span>
        <button type="button" className={BIND_BTN} title="登录（用站点账号）" onClick={() => (onLogin || (() => hooks.openLogin('')))()}>登录</button>
      </div>
    );
  }
  if (!binding || !binding.bound) {
    return (
      <div className="flex items-center gap-2 border-t border-border px-3 py-2 text-[11px] text-subtle">
        <span className="min-w-0 flex-1 truncate">本机账号未绑定（文件与命令工具不可用）</span>
        <button type="button" className={BIND_BTN} title="绑定本机操作系统账号" onClick={() => openDrawer('binding')}>去绑定</button>
      </div>
    );
  }
  if (!binding.unlocked) {
    return (
      <div className="flex items-center gap-2 border-t border-border px-3 py-2 text-[11px] text-warning">
        <span className="min-w-0 flex-1 truncate">已绑定 {binding.osUser || ''} · 未解锁</span>
        <button type="button" className={BIND_BTN} title="输入系统密码解锁（解锁前工具不可用）" onClick={() => openDrawer('binding')}>解锁</button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5 border-t border-border px-3 py-2 text-[11px] text-success">
      <Check className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate" title={`本机账号 ${binding.osUser || ''} 已绑定并解锁`}>
        {binding.osUser || '已绑定'}
      </span>
      <span className="shrink-0 text-subtle">已解锁</span>
    </div>
  );
}

/* ============================ 侧栏 ============================ */

export default function Sidebar({ collapsed: collapsedProp, onNavigate, onOpenSettings, onLogin }) {
  const st = useApp();
  /* 折叠状态只有 App 一个真源（手机抽屉靠外层位移控制，恒传 false）——
     这里不再读第二份本地 store：残留的 localStorage 值会让抽屉整个渲染成空。 */
  if (collapsedProp) return null;

  const projects = st.projects || [];
  const current = projects.find((p) => p.id === st.currentProjectId) || null;
  const groupBy = (st.settings && st.settings.ui && st.settings.ui.sessionGroup) === 'time' ? 'time' : 'project';

  return (
    <aside className="flex h-full w-[19rem] shrink-0 flex-col border-r border-border bg-card shadow-xl md:shadow-none">
      <Brand />
      <ProjectCard project={current} />
      <ModelCard provider={activeProvider()} status={st.status || {}} onOpenSettings={onOpenSettings} />
      <SessionList
        sessions={st.sessions || []}
        activeId={st.activeSessId}
        projects={projects}
        currentProjectId={st.currentProjectId}
        groupBy={groupBy}
        onGroupBy={(v) => setUi('sessionGroup', v)}
        onNavigate={onNavigate}
        runs={st.runs}
      />
      <BindRow info={st.info} onLogin={onLogin} />
    </aside>
  );
}
