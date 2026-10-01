/* features/KickedOverlay.jsx —— 被顶掉时的全屏冻结层（同一账号同时只允许一个窗口在用）
 *
 *  为什么要冻结而不是"各自都能用"：会话/参数/模型配置都是整份写回服务端的，
 *  两个窗口同开就是"后写的把先写的抹掉"。所以约定后到的窗口顶掉先到的，被顶掉的一方界面冻结，
 *  点一下就能夺回来（见 lib/agent/presence.js 与 core/presence.js）。
 */
import { Button } from '../components/ui/button.jsx';
import { useApp } from '../state/store.js';
import { Presence } from '../../core/presence.js';
import { toast } from '../components/ui/toast.jsx';

export function KickedOverlay() {
  const st = useApp();
  if (st.presence.enforce === false || st.presence.active) return null;
  const o = st.presence.owner || {};
  const who = [o.user ? `账号 ${o.user}` : '', o.ip || '', o.ua || ''].filter(Boolean).join(' · ');
  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-5 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-lg border border-border-strong bg-card p-6 text-center shadow-lg">
        <div className="text-3xl">🚪</div>
        <h3 className="mt-3 text-base font-semibold">这个窗口已被顶掉</h3>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {who ? <>对方：{who}<br /></> : null}
          同一时间只允许一个窗口使用（会话、参数、模型配置都按账号存在服务器端，多开必互相覆盖）。
          数据没有任何丢失——点下面的按钮就能夺回来，对方会收到同样的提示。
        </p>
        <Button className="mt-4" onClick={async () => {
          const d = await Presence.claim(true).catch(() => null);
          if (d && d.active) toast('已夺回这个窗口', 'ok');
          else toast('夺回失败：请刷新页面重试', 'err');
        }}>在此窗口继续</Button>
      </div>
    </div>
  );
}
