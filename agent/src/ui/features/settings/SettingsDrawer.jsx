// SettingsDrawer.jsx —— 设置抽屉外壳：左侧分区导航（点击切换），右侧内容区可滚动
import { Archive, Brain, Cpu, Database, FolderGit2, MessageSquareText, Palette, ShieldCheck, SlidersHorizontal, UserCog } from 'lucide-react';
import { useApp } from '../../state/store.js';
import { openDrawer, closeDrawer } from '../../state/session.js';
import { cn } from '../../lib/utils.js';
import { useIsPhone } from '../../lib/useMedia.js';
import { Badge } from '../../components/ui/badge.jsx';
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../../components/ui/sheet.jsx';
import AppearanceSection from './AppearanceSection.jsx';
import ModelsSection from './ModelsSection.jsx';
import ParamsSection from './ParamsSection.jsx';
import ToolsSection from './ToolsSection.jsx';
import BindingSection from './BindingSection.jsx';
import PromptsSection from './PromptsSection.jsx';
import MemorySection from './MemorySection.jsx';
import ProjectsSection from './ProjectsSection.jsx';
import ArchiveSection from './ArchiveSection.jsx';
import DataSection from './DataSection.jsx';

/** 分区顺序即导航顺序（id 与 state.drawer.section 对应） */
const SECTIONS = [
  { id: 'appearance', label: '外观', icon: Palette, Comp: AppearanceSection },
  { id: 'models', label: '模型', icon: Cpu, Comp: ModelsSection },
  { id: 'params', label: '参数', icon: SlidersHorizontal, Comp: ParamsSection },
  { id: 'projects', label: '项目', icon: FolderGit2, Comp: ProjectsSection },
  { id: 'tools', label: '权限与工具', icon: ShieldCheck, Comp: ToolsSection },
  { id: 'binding', label: '本机账号', icon: UserCog, Comp: BindingSection },
  { id: 'prompts', label: '提示词', icon: MessageSquareText, Comp: PromptsSection },
  { id: 'memory', label: '记忆', icon: Brain, Comp: MemorySection },
  { id: 'archive', label: '存档', icon: Archive, Comp: ArchiveSection },
  { id: 'data', label: '数据', icon: Database, Comp: DataSection },
];

function NavItem({ item, active, compact }) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      onClick={() => openDrawer(item.id)}
      className={cn(
        'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors',
        compact && 'shrink-0 flex-col gap-1 px-3 py-2 text-[11px]',
        active
          ? 'bg-accent font-medium text-accent-foreground'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="truncate">{item.label}</span>
    </button>
  );
}

/** 底部一行状态：当前模型与连接情况（抽屉里改完模型能立刻看到结果） */
function DrawerFooter() {
  const st = useApp();
  const status = st.status || {};
  const ok = !!status.connected;
  return (
    <div className="flex items-center gap-2 border-t border-border px-4 py-2">
      <span className="text-xs text-subtle">当前模型</span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
        {status.model || '（未配置）'}
      </span>
      {status.checking
        ? <Badge variant="secondary">检查中…</Badge>
        : <Badge variant={ok ? 'success' : 'warning'}>{ok ? `已连接（${status.models.length} 个模型）` : '未连通'}</Badge>}
    </div>
  );
}

export default function SettingsDrawer() {
  const st = useApp();
  const phone = useIsPhone();
  const section = st.drawer.section || 'appearance';
  const active = SECTIONS.find((s) => s.id === section) || SECTIONS[0];
  const Body = active.Comp;

  return (
    <Sheet open={!!st.drawer.open} onOpenChange={(v) => (v ? openDrawer(section) : closeDrawer())}>
      {/* 宽度：本站根字号 14px，组件基类的 sm:max-w-md（28rem）在这里只剩 392px ——
          Base URL、模型名、密钥提示全被折断。所以显式 sm:max-w-none 顶掉基类上限，
          宽度按屏宽分档（窄屏铺满，桌面给足正文）。 */}
      <SheetContent
        side="right"
        className="w-full gap-0 p-0 sm:max-w-none sm:w-[min(900px,96vw)] lg:w-[min(1060px,94vw)] 2xl:w-[min(1180px,88vw)]"
      >
        <SheetHeader>
          <SheetTitle>设置</SheetTitle>
          <SheetDescription>模型、生成参数、权限与工具、提示词与记忆；改动会自动保存。</SheetDescription>
        </SheetHeader>

        <SheetBody className={cn('flex', phone && 'flex-col')}>
          {/* 手机：分区导航变成顶部一排可横向滑动的标签（左边栏会挤掉正文宽度）；
              桌面：左侧竖排导航（抽屉宽了之后 10rem 足够放下"权限与工具"这样的长标签）。 */}
          <nav aria-label="设置分区"
            className={cn('flex gap-0.5 border-border bg-muted/30',
              phone
                ? 'shrink-0 flex-row overflow-x-auto border-b p-2 [scrollbar-width:none]'
                : 'w-40 shrink-0 flex-col overflow-y-auto border-r p-2')}>
            {SECTIONS.map((item) => (
              <NavItem key={item.id} item={item} active={item.id === active.id} compact={phone} />
            ))}
          </nav>
          <div key={active.id} className="min-w-0 flex-1 overflow-y-auto">
            <Body />
          </div>
        </SheetBody>

        <DrawerFooter />
      </SheetContent>
    </Sheet>
  );
}
