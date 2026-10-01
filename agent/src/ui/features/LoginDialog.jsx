/* features/LoginDialog.jsx —— 登录 / 退出（走**文档站账号**，与文档编辑器同一套用户校验）
 *
 *  为什么不是"另建一套登录"：lib/auth.js 是全站唯一的用户校验（scrypt + 时序安全比较 +
 *  登录限流 + 审计日志），文档站与剧本编辑器都走它。Agent 沿用同一端点（/api/login、
 *  /api/session、/api/logout），所以"账号即身份"，模型配置、绑定信息、会话都按这个账号存。
 *
 *  登录之后：Agent 侧的数据才可用（配置/会话/记忆/绑定都按账号存在服务器端）。
 *  本机账号的绑定与解锁在设置抽屉的「本机账号」里（那是用户资料的一部分，不是登录方式）。
 */
import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../components/ui/dialog.jsx';
import { Button } from '../components/ui/button.jsx';
import { ImeInput } from '../components/ui/ime-field.jsx';
import { Label } from '../components/ui/label.jsx';
import { Spinner } from '../components/ui/spinner.jsx';
import { toast } from '../components/ui/toast.jsx';
import { post, get } from '../../core/http.js';
import { EP } from '../../core/endpoints.js';
import { Store as StoreApi } from '../../core/store.js';
import { Memory } from '../../core/memory.js';
import { patch, state, defaultSettings } from '../state/store.js';
import * as Run from '../state/run.js';
import {
  applyServerData, applyAppearance, checkStatus, loadAgentStatus, updateCtx, ensureSession, syncProjectWithSession,
} from '../state/session.js';

/** 换身份/登出时把"项目"也清干净：项目记忆与项目清单都属于上一个账号，绝不能留着 */
function clearProjects() {
  Memory.setProject(null);
  StoreApi.setProjectId('');
  patch({ projects: [], currentProjectId: '' });
}

export function LoginDialog({ open, onOpenChange, hint }) {
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMsg(''); setPass('');
    get(EP.session, { timeoutMs: 8000 })
      .then((d) => { setLoggedIn(!!d.username); setUser(d.username || ''); })
      .catch(() => setLoggedIn(false));
  }, [open]);

  async function doLogin() {
    if (!user.trim() || !pass) { setMsg('请填写用户名与密码'); return; }
    setBusy(true); setMsg('');
    try {
      await post(EP.login, { username: user.trim(), password: pass });
      setPass('');
      toast('已登录：数据开始按该账号保存', 'ok');
      await reload();
      onOpenChange(false);
    } catch (e) {
      setMsg(e.message || '登录失败');
    } finally { setBusy(false); }
  }

  async function doLogout() {
    setBusy(true);
    try {
      await post(EP.logout, {});
      Run.reset();                          // 断开观看流并清掉"生成中"标记（那是上一个账号的）
      StoreApi.user = null;                 // 清掉待写队列，别把上一个账号的数据写进下一个
      /* 登出：配置回**出厂默认**而不是 null —— 界面上仍有一堆控件会读 state.settings
         （外观/参数/侧栏分组），null 会让它们静默 TypeError（用户看到的是「点了没反应」）。 */
      patch({ info: null, settings: defaultSettings(), sessions: [], history: [], activeSessId: null, agentStatus: null });
      clearProjects();
      await reload();
      toast('已退出登录');
      onOpenChange(false);
    } catch (e) { setMsg(e.message || '退出失败'); } finally { setBusy(false); }
  }

  async function reload() {
    Run.reset();                            // 身份可能变了：先断开旧账号的观看流与"生成中"标记
    const r = await StoreApi.refreshInfo();
    patch({ info: r });
    if (r && r.loggedIn) {
      const d = await StoreApi.pull();
      if (d) applyServerData(d);
      StoreApi.user = StoreApi.user;         // 触发一次身份刷新（内部只在变化时清队列）
      checkStatus(); loadAgentStatus(); updateCtx();
      ensureSession();
      /* 换账号/重登之后同样要对齐：当前项目跟着当前会话，并接着看服务端在跑的那一轮
         （托管运行按账号存在服务端，换设备登录也可能有一轮正在跑）。 */
      syncProjectWithSession();
      Run.reattach(state.activeSessId).catch(() => {});
    } else {
      patch({ settings: defaultSettings(), sessions: [], history: [] });
      clearProjects();
    }
    applyAppearance();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{loggedIn ? '账号' : '登录'}</DialogTitle>
        </DialogHeader>
        {hint ? <p className="text-xs text-muted-foreground -mt-2">{hint}</p> : null}
        <p className="text-xs text-muted-foreground leading-relaxed">
          用<b className="text-foreground">文档站账号</b>登录（与文档编辑器同一套账号与校验）。登录后：
          模型配置、会话、记忆、提示词与本机账号绑定都按这个账号存在服务器端，换设备登录即可恢复；
          API Key 只存服务端、下发到浏览器时只显示末四位。
          <b className="text-foreground">本机账号的绑定与解锁在设置抽屉 →「本机账号」里</b>——
          登录决定"你是谁"，绑定决定"Agent 能以哪个本机账号的权限做事"。
        </p>
        {!loggedIn ? (
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="lg-user">用户名</Label>
              <ImeInput id="lg-user" value={user} autoComplete="username" onChange={(e) => setUser(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') doLogin(); }} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="lg-pass">密码</Label>
              <ImeInput id="lg-pass" type="password" value={pass} autoComplete="current-password"
                onChange={(e) => setPass(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') doLogin(); }} />
            </div>
          </div>
        ) : (
          <p className="text-sm">当前账号：<b>{user}</b></p>
        )}
        {msg ? <p className="text-xs text-destructive">{msg}</p> : null}
        <DialogFooter>
          {loggedIn
            ? <Button variant="outline" onClick={doLogout} disabled={busy}>退出登录</Button>
            : <Button onClick={doLogin} disabled={busy}>{busy ? <Spinner className="mr-2" /> : null}登录</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
