// Header.jsx —— 顶栏：折叠侧栏、标题与连接状态、上下文用量环、最近一轮统计、访问级别徽章与操作按钮
import { FolderGit2, PackageOpen, PanelLeft, Settings, Trash2, Undo2, UserRound } from 'lucide-react';
import { AgentPolicy } from '../../core/policy.js';
import { activeProvider, accessOf, hooks, askConfirm } from '../state/host.js';
import { clearChat, openDrawer, undoLast } from '../state/session.js';
import { openDownloads } from '../state/downloads.js';
import { patch, useApp } from '../state/store.js';
import { cn } from '../lib/utils.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../components/ui/dropdown-menu.jsx';
import { MoreHorizontal } from 'lucide-react';
import ContextMeter from './ContextMeter.jsx';
import { statsParts } from '../lib/format.js';

function IconBtn({ title, onClick, disabled, className, children }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors',
        'hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40',
        className,
      )}
    >
      {children}
    </button>
  );
}

/** 访问级别徽章：完全访问档用醒目样式（模型不再逐条问你，必须一眼能看见） */
function AccessBadge() {
  const eff = accessOf();
  const m = AgentPolicy.meta(eff.mode);
  return (
    <span
      title={`访问级别：${m.label} —— ${AgentPolicy.summary(eff)}（在输入框左侧切换）`}
      className={cn(
        'hidden shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] sm:inline-flex',
        m.danger
          ? 'border-destructive/60 bg-destructive/10 font-semibold text-destructive ring-1 ring-destructive/30'
          : 'border-border text-muted-foreground',
      )}
    >
      {m.icon} {m.short}
    </span>
  );
}

/** 连接状态点 + 标题/当前模型（错误时 title 显示原因） */
function StatusLine({ status, provider }) {
  const text = status.connected ? '已连接' : status.checking ? '检测中…' : '未连接';
  const dot = status.connected ? 'bg-success' : status.checking ? 'bg-warning animate-pulse' : 'bg-destructive';
  const title = status.error
    ? `连接错误：${status.error}`
    : `模型：${status.model || (provider && provider.model) || '（未配置）'}`
      + (status.connected ? ` · ${(status.models || []).length} 个模型可用` : '');
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-subtle" title={title}>
      <span className={cn('size-2 shrink-0 rounded-full', dot)} />
      <span className="truncate">{text}</span>
      {provider ? <span className="hidden truncate sm:inline">· {provider.model || provider.name}</span> : null}
    </div>
  );
}

export default function Header({ sidebarCollapsed, onToggleSidebar, phone }) {
  const st = useApp();
  /* 两个 prop 都由 App 恒定传入（桌面：折叠状态；手机：抽屉开关）。
     不再留"未传时回落到本地 store"的分支——那份 store 已删，见 chat-utils.js 的头注。 */
  const collapsed = !!sidebarCollapsed;
  const toggle = onToggleSidebar || (() => {});

  const status = st.status || {};
  const provider = activeProvider();

  /* 最近一轮的 tok/s 与 tokens：取最后一条带 stats 的回答（stats 缺失时不显示） */
  let last = null;
  for (let k = (st.history || []).length - 1; k >= 0; k--) {
    const m = st.history[k];
    if (m.role === 'assistant' && m.stats) { last = m; break; }
  }
  const stats = last ? statsParts(last.stats, last.wallMs, null).slice(0, 2) : [];

  const undo = async () => {
    const text = await undoLast();
    if (text) patch({ draft: text });            // 回撤的提问放回输入框
  };

  /* 清空当前对话的确认：走全局 askConfirm（原先这里各挂一份局部弹窗，同一个动作两套外观） */
  const askClearChat = async () => {
    const r = await askConfirm({
      title: '清空当前对话？', body: '当前会话的全部消息会被删除，不可恢复（不影响其它对话）。', okText: '清空', danger: true,
    });
    if (r.ok) clearChat();
  };

  const dlCount = ((st.downloads || {}).entries || []).length;
  const user = st.info && st.info.user;
  const userName = user ? (user.name || user.username || user.osUser || '已登录') : '';
  const project = (st.projects || []).find((p) => p.id === st.currentProjectId) || null;

  return (
    <header className="z-20 flex h-14 shrink-0 items-center gap-1.5 border-b border-border bg-background/80 px-2 backdrop-blur-md sm:gap-2 sm:px-3">
      <IconBtn title={phone ? (collapsed ? '打开侧栏' : '收起侧栏') : (collapsed ? '展开侧栏' : '折叠侧栏')}
        onClick={toggle} className={phone ? 'size-10' : undefined}>
        <PanelLeft className="size-4" />
      </IconBtn>

      <div className="min-w-0">
        <div className="truncate text-[13px] font-semibold leading-tight">智能体 Agent</div>
        <StatusLine status={status} provider={provider} />
      </div>

      {/* 当前项目：一眼看出"现在这轮对话属于哪个项目"（点它进设置 → 项目） */}
      {project ? (
        <button
          type="button"
          onClick={() => openDrawer('projects')}
          title={`当前项目：${project.name}\n根目录：${project.root}\n（点击进入设置 → 项目）`}
          className="hidden min-w-0 shrink items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:flex"
        >
          <FolderGit2 className="size-3.5 shrink-0" />
          <span className="max-w-[10rem] truncate">{project.name}</span>
        </button>
      ) : null}

      <span className="flex-1" />

      {stats.length ? (
        <span className="hidden shrink-0 font-mono text-[11px] tabular-nums text-subtle md:inline" title="最近一轮：tok/s · tokens">
          {stats.join(' · ')}
        </span>
      ) : null}
      <ContextMeter />
      <AccessBadge />
      {/* 📥 待下载：模型交给用户的文件都在这儿（带数量小标；点开就是下载链接） */}
      <IconBtn
        title="待下载文件（模型用 deliver_file 放进来的产出物；可执行文件已打包成 zip）"
        onClick={() => openDownloads()}
        className={cn('relative', phone ? 'size-10' : undefined)}
      >
        <PackageOpen className="size-4" />
        {dlCount > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full bg-primary px-1 text-[9px] font-semibold leading-4 text-primary-foreground">
            {dlCount > 99 ? '99+' : dlCount}
          </span>
        ) : null}
      </IconBtn>

      <IconBtn
        title={user ? `已登录：${userName}（点击可切换账号）` : '登录（记忆、技能、会话按登录身份存服务器端）'}
        onClick={() => hooks.openLogin('')}
        className={cn(user ? 'text-success' : undefined, phone ? 'size-10' : undefined)}
      >
        <UserRound className="size-4" />
      </IconBtn>
      <IconBtn title="设置（模型 / 参数 / 权限 / 提示词 / 记忆）" onClick={() => openDrawer()} className={phone ? 'size-10' : undefined}>
        <Settings className="size-4" />
      </IconBtn>
      {phone ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" title="更多（回撤 / 清空）"
              className="grid size-10 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
              <MoreHorizontal className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem disabled={!!st.streaming} onSelect={undo}>
              <Undo2 className="mr-2 size-4" />回撤最后一轮
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" disabled={!!st.streaming} onSelect={askClearChat}>
              <Trash2 className="mr-2 size-4" />清空当前对话
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <>
          <IconBtn
            title={st.streaming ? '生成中不可回撤：先点「停止」' : '回撤最后一轮问答（提问放回输入框）'}
            disabled={!!st.streaming}
            onClick={undo}
          >
            <Undo2 className="size-4" />
          </IconBtn>
          <IconBtn
            title={st.streaming ? '生成中不可清空：先点「停止」' : '清空当前对话'}
            disabled={!!st.streaming}
            onClick={askClearChat}
          >
            <Trash2 className="size-4" />
          </IconBtn>
        </>
      )}

    </header>
  );
}
