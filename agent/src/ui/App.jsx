/* ui/App.jsx —— 外壳：侧栏 + 顶栏 + 对话区 + 输入区 + 设置抽屉 + 各类弹层
 *
 *  这里只做"装与接线"：布局、弹层的开关、以及把 core 需要的界面动作回填进 hooks
 *  （core 层不认识 React，所有界面能力都是注入进去的）。
 */
import { useEffect, useState } from 'react';
import { useApp } from './state/store.js';
import { hooks } from './state/host.js';
import { openDrawer, ensureSession, updateCtx } from './state/session.js';
import { loadTodo } from './state/todo.js';
import Sidebar from './features/Sidebar.jsx';
import Header from './features/Header.jsx';
import ChatView from './features/ChatView.jsx';
import Composer from './features/Composer.jsx';
import SettingsDrawer from './features/settings/SettingsDrawer.jsx';
import { ConfirmDialog } from './features/ConfirmDialog.jsx';
import { DownloadsDialog } from './features/DownloadsDialog.jsx';
import { AboutAgentDialog } from './features/AboutAgent.jsx';
import FileDiffSheet from './features/FileDiffSheet.jsx';
import TodoPanel from './features/TodoPanel.jsx';
import { LoginDialog } from './features/LoginDialog.jsx';
import { KickedOverlay } from './features/KickedOverlay.jsx';
import { Toaster, toast } from './components/ui/toast.jsx';
import { AlertTriangle } from 'lucide-react';
import { requestScrollBottom } from './features/chat-utils.js';
import { useIsPhone } from './lib/useMedia.js';

export default function App() {
  const st = useApp();
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginHint, setLoginHint] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const [navOpen, setNavOpen] = useState(false);      // 手机上侧栏抽屉的开关（桌面端常驻，不用它）
  const phone = useIsPhone();

  /* core 层的界面动作回填（openLogin / 需要绑定 / 需要解锁 / 滚动） */
  useEffect(() => {
    hooks.openLogin = (hint) => { setLoginHint(hint || ''); setLoginOpen(true); };
    hooks.onNeedBind = () => { openDrawer('binding'); toast('先在设置里绑定一个本机账号：Agent 以它的权限做事', 'info'); };
    hooks.onNeedUnlock = (osUser) => { openDrawer('binding'); toast(`解锁 ${osUser || '绑定账号'} 后才能执行命令`, 'info'); };
    hooks.scrollBottom = () => requestScrollBottom();
  }, []);

  /* 首次进入：确保有一个会话对象（空状态也是"在某个会话里"） */
  useEffect(() => { if (st.ready && !st.sessions.length) ensureSession(); }, [st.ready, st.sessions.length]);
  /* 换会话 / 改设置后重算一次用量环。流式期间涨的是"草稿 token"那一块，由 ContextMeter
     自己按 state.draft 现算；整轮结束再由 send() 的 finally 刷一次（不靠这个 effect）。 */
  useEffect(() => { if (st.ready) updateCtx(); }, [st.ready, st.activeSessId, st.settings]);

  /* 任务清单（右上角浮层）：首次载入/换会话时向服务端要当前会话那一份
     （运行中的实时更新走 tool_end 事件，见 state/todo.js）。 */
  useEffect(() => { if (st.ready) loadTodo(st.activeSessId); }, [st.ready, st.activeSessId]);

  if (!st.ready) return <BootScreen error={st.bootError} />;

  return (
    <div className="flex h-full w-full overflow-hidden bg-background text-foreground">
      {phone ? (
        /* 手机：侧栏收成左侧抽屉（带遮罩，点遮罩或选中会话即收起）——
           否则 19rem 的侧栏会直接盖住半个屏幕且关不掉。 */
        <>
          {navOpen ? (
            <div className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px]" role="presentation"
              onClick={() => setNavOpen(false)} />
          ) : null}
          <div className={phone ? `fixed inset-y-0 left-0 z-50 transition-transform duration-200 ${navOpen ? 'translate-x-0' : '-translate-x-full'}` : ''}>
            {/* 手机抽屉靠外层位移开关，恒传 collapsed={false}：曾有第二份 localStorage
                折叠状态只被这一支读到，残留值会让整个抽屉渲染成空（Sidebar 折叠时 return null） */}
            <Sidebar collapsed={false}
              onNavigate={() => setNavOpen(false)}
              onOpenSettings={() => { setNavOpen(false); openDrawer(); }}
              onLogin={() => { setNavOpen(false); setLoginHint(''); setLoginOpen(true); }} />
          </div>
        </>
      ) : (
        <Sidebar collapsed={collapsed}
          onOpenSettings={() => openDrawer()}
          onLogin={() => { setLoginHint(''); setLoginOpen(true); }} />
      )}
      <main className="flex min-w-0 flex-1 flex-col">
        {/* Header 的登录入口走 hooks.openLogin（见上）；别再传一个它签名里没有的 onLogin prop */}
        <Header phone={phone} sidebarCollapsed={phone ? !navOpen : collapsed}
          onToggleSidebar={() => (phone ? setNavOpen((v) => !v) : setCollapsed((v) => !v))} />
        <ChatView />
        <Composer />
      </main>

      <SettingsDrawer />
      <ConfirmDialog />
      <DownloadsDialog />
      <AboutAgentDialog />
      <FileDiffSheet />
      <TodoPanel />
      <LoginDialog open={loginOpen} onOpenChange={setLoginOpen} hint={loginHint} />
      <KickedOverlay />
      <Toaster />

      {/* 未登录横幅：一条就把"为什么数据不保存"说清楚（数据按账号存服务端） */}
      {st.info && !st.info.loggedIn ? (
        <div className="fixed bottom-4 left-1/2 z-40 -translate-x-1/2">
          <button type="button" onClick={() => { setLoginHint(''); setLoginOpen(true); }}
            className="rounded-full border border-border-strong bg-card px-4 py-2 text-xs shadow-md hover:border-primary">
            未登录：模型配置、会话与绑定都按文档站账号保存 —— <span className="text-primary">点这里登录</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

/* 启动期的兜底屏：init 失败（服务端不可达、脚本报错…）时给出可读原因，
   而不是让页面停在"正在连接服务端…"或白屏——bootError 由 main.jsx 的 catch 写入。 */
function BootScreen({ error }) {
  if (!error) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        正在连接服务端…
      </div>
    );
  }
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-lg space-y-2 rounded-lg border border-destructive/40 bg-card p-4">
        <div className="flex items-center gap-2 text-sm font-medium text-destructive">
          <AlertTriangle className="size-4" />初始化失败
        </div>
        <p className="text-xs text-muted-foreground">{error}</p>
        <p className="text-xs text-subtle">刷新页面重试；若一直失败，检查站点进程与登录状态。</p>
      </div>
    </div>
  );
}
