// BindingSection.jsx —— 本机账号：绑定状态卡、绑定/解绑/解锁/锁定，以及"权限不超过该账号"的说明
import { useState } from 'react';
import { Lock, LockOpen, Unlink, UserRoundCheck } from 'lucide-react';
import { useApp } from '../../state/store.js';
import { bindOsAccount, unbindOsAccount, unlockOsAccount, lockOsAccount } from '../../state/settings.js';
import { Badge } from '../../components/ui/badge.jsx';
import { Button } from '../../components/ui/button.jsx';
import { FieldRow, FieldValue, SectionTitle } from '../../components/ui/field.jsx';
import { ImeInput } from '../../components/ui/ime-field.jsx';
import { Label } from '../../components/ui/label.jsx';
import { Spinner } from '../../components/ui/spinner.jsx';
import { toast } from '../../components/ui/toast.jsx';
import { GroupCard, NoteBox } from './parts.jsx';
import { askConfirm } from '../../state/host.js';

const METHOD_TEXT = { same: '与站点进程同一个用户（同样需要解锁）', su: '以 su 提权（需要解锁）' };

/* ============================ 状态卡 ============================ */

const phaseOf = (binding) => {
  if (!binding || !binding.bound) return ['未绑定', 'secondary'];
  return binding.unlocked ? ['已绑定 · 已解锁', 'success'] : ['已绑定 · 需解锁', 'warning'];
};

function bindRows(binding) {
  const b = binding || {};
  if (!b.bound) {
    return [
      ['本机账号', ''], ['UID / 家目录', ''], ['绑定方式', ''],
      ['站点进程用户', b.siteUser || ''], ['与站点同用户', ''],
    ];
  }
  return [
    ['本机账号', b.osUser || ''],
    ['UID / 家目录', `${b.uid} · ${b.home}`],
    ['绑定方式', METHOD_TEXT[b.method] || b.method || ''],
    ['站点进程用户', b.siteUser || ''],
    ['与站点同用户', b.sameAsSite ? '是' : '否'],
  ];
}

function InfoRow({ label, value }) {
  return (
    <FieldRow label={label}>
      <FieldValue className="max-w-[16rem]">{value || '—'}</FieldValue>
    </FieldRow>
  );
}

function StatusCard({ binding }) {
  const [label, variant] = phaseOf(binding);
  return (
    <section>
      <SectionTitle>绑定状态</SectionTitle>
      <GroupCard className="mx-4">
        <FieldRow label="状态"><Badge variant={variant}>{label}</Badge></FieldRow>
        {bindRows(binding).map(([k, v]) => <InfoRow key={k} label={k} value={v} />)}
      </GroupCard>
    </section>
  );
}

/* ============================ 绑定 / 解锁表单 ============================ */

function BindForm() {
  const [osUser, setOsUser] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!osUser.trim() || !password) { toast('本机账号名与系统密码都要填', 'err'); return; }
    setBusy(true);
    try {
      await bindOsAccount(osUser.trim(), password);
      setPassword('');
      setOsUser('');
    } catch (e) { toast('绑定失败：' + (e.message || e), 'err'); } finally { setBusy(false); }
  };
  return (
    <section>
      <SectionTitle>绑定本机账号</SectionTitle>
      <div className="space-y-3 px-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="b-user" className="mb-1.5 block text-xs text-muted-foreground">本机账号名</Label>
            <ImeInput id="b-user" value={osUser} autoComplete="off" className="font-mono text-xs"
              onChange={(e) => setOsUser(e.target.value)} placeholder="如 leo" />
          </div>
          <div>
            <Label htmlFor="b-pass" className="mb-1.5 block text-xs text-muted-foreground">该系统账号的密码</Label>
            <ImeInput id="b-pass" type="password" value={password} autoComplete="new-password" className="font-mono text-xs"
              onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
              placeholder="用来证明这个账号是你的" />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={submit} disabled={busy}>
            {busy ? <Spinner size="sm" /> : <UserRoundCheck />}绑定
          </Button>
          <span className="text-xs text-subtle">密码只用于服务端校验，不落盘。</span>
        </div>
      </div>
    </section>
  );
}

function UnlockForm({ osUser }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!password) { toast('请输入该账号的系统密码', 'err'); return; }
    setBusy(true);
    try { await unlockOsAccount(password); setPassword(''); }
    catch (e) { toast('解锁失败：' + (e.message || e), 'err'); } finally { setBusy(false); }
  };
  return (
    <section>
      <SectionTitle>解锁</SectionTitle>
      <div className="space-y-3 px-4">
        <NoteBox>
          以绑定账号 {osUser ? `（${osUser}）` : ''} 执行命令或读写文件前，服务端需要一次该账号的系统密码来确认归属。
          密码只留在服务端内存里一段时间，站点重启或登出后要重新解锁。
        </NoteBox>
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Label htmlFor="u-pass" className="mb-1.5 block text-xs text-muted-foreground">系统密码</Label>
            <ImeInput id="u-pass" type="password" autoComplete="new-password" className="font-mono text-xs"
              value={password} onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
          </div>
          <Button size="sm" onClick={submit} disabled={busy}>
            {busy ? <Spinner size="sm" /> : <LockOpen />}解锁
          </Button>
        </div>
      </div>
    </section>
  );
}

/* ============================ 已绑定后的管理动作 ============================ */

function ManageActions({ unlocked, busy, onLock, onUnbind }) {
  return (
    <section>
      <SectionTitle>管理与退出</SectionTitle>
      <div className="flex flex-wrap items-center gap-2 px-4">
        {unlocked ? (
          <Button size="sm" variant="outline" onClick={onLock} disabled={busy}>
            {busy ? <Spinner size="sm" /> : <Lock />}锁定（丢弃解锁凭据）
          </Button>
        ) : null}
        <Button size="sm" variant="outline" className="text-destructive" onClick={onUnbind} disabled={busy}>
          <Unlink />解除绑定
        </Button>
      </div>
    </section>
  );
}

/** 已绑定/未绑定走完全不同的入口；不可校验的部署只留一句说明 */
function BindingBody({ binding, busy, onLock, onUnbind }) {
  if (!binding || binding.canVerify === false) {
    return (
      <div className="px-4">
        <NoteBox>当前部署下绑定不可用，文件与命令行工具不会注册给模型。</NoteBox>
      </div>
    );
  }
  if (!binding.bound) return <BindForm />;
  return (
    <>
      {binding.unlocked ? null : <UnlockForm osUser={binding.osUser} />}
      <ManageActions unlocked={!!binding.unlocked} busy={busy} onLock={onLock} onUnbind={onUnbind} />
    </>
  );
}

/** 绑定相关的动作都包一层 busy + 失败提示 */
function useBindingActions() {
  const [busy, setBusy] = useState(false);
  const run = async (fn, failText) => {
    setBusy(true);
    try { await fn(); } catch (e) { toast(failText + (e.message || e), 'err'); } finally { setBusy(false); }
  };
  return {
    busy,
    lock: () => run(lockOsAccount, '锁定失败：'),
    unbind: () => run(unbindOsAccount, '解绑失败：'),
  };
}

/* ============================ 分区 ============================ */

export default function BindingSection() {
  const st = useApp();
  const binding = (st.info && st.info.binding) || (st.agentStatus && st.agentStatus.binding) || null;
  const verifyNote = (binding && binding.verifyNote) || '';
  const { busy, unbind, lock } = useBindingActions();

  /* 解绑确认走全局 askConfirm（与工具确认框同一套队列与外观） */
  const askUnbind = async () => {
    const r = await askConfirm({
      title: '解除本机账号绑定？',
      body: '解绑后文件与命令行工具会立即停用（模型那边不再注册这些工具），解锁凭据同时作废。'
        + '模型配置与对话不受影响，随时可以重新绑定。',
      okText: '解绑', danger: true,
    });
    if (r.ok) unbind();
  };

  return (
    <div className="space-y-4 pb-6">
      <StatusCard binding={binding} />

      {verifyNote ? (
        <div className="px-4">
          <NoteBox tone="danger" title="此部署已停用绑定">{verifyNote}</NoteBox>
        </div>
      ) : null}

      <BindingBody binding={binding} busy={busy} onLock={lock} onUnbind={askUnbind} />

      <div className="px-4">
        <NoteBox title="权限边界">
          Agent 不会超过这个账号在系统里的权限：文件工具受该账号的权限位与可访问目录双重限制，
          命令行工具直接以该账号身份运行（不是 root，也不是站点进程用户）。
          未绑定或未解锁时，文件与命令类工具对模型完全不注册。
        </NoteBox>
      </div>

    </div>
  );
}
