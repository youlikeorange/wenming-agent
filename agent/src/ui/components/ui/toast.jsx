// ui/components/ui/toast.jsx —— 极简 toast：模块级单例 store + toast(msg, opts) + 右下角堆叠的 <Toaster/>，2 秒自动消失
import * as React from 'react';
import { CircleAlert, CircleCheck, Info } from 'lucide-react';
import { cn } from '../../lib/utils.js';

const MAX_VISIBLE = 4;
const DEFAULT_DURATION = 2000;

let seq = 0;
let items = [];
const listeners = new Set();

/** 通知所有订阅者（<Toaster/> 用 useSyncExternalStore 订阅） */
function emit() {
  for (const fn of listeners) fn();
}

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function getSnapshot() {
  return items;
}

/** 移除一条（点掉或到点自动消失）；重复调用无副作用 */
export function dismissToast(id) {
  const next = items.filter((item) => item.id !== id);
  if (next.length === items.length) return;
  items = next;
  emit();
}

/**
 * 弹一条提示。
 *   toast('已保存')                        → info
 *   toast('保存失败', 'err')                → 也可传第二参为类型字符串
 *   toast('已复制', { type: 'ok', duration: 1200 })
 */
export function toast(msg, opts) {
  const { type = 'info', duration = DEFAULT_DURATION } = typeof opts === 'string' ? { type: opts } : opts || {};
  const id = ++seq;
  items = [...items, { id, msg, type }].slice(-MAX_VISIBLE);
  emit();
  setTimeout(() => dismissToast(id), duration);
  return id;
}

toast.ok = (msg, opts) => toast(msg, { type: 'ok', ...(typeof opts === 'object' ? opts : null) });
toast.err = (msg, opts) => toast(msg, { type: 'err', ...(typeof opts === 'object' ? opts : null) });
toast.info = (msg, opts) => toast(msg, { type: 'info', ...(typeof opts === 'object' ? opts : null) });

const TONE = {
  ok: { Icon: CircleCheck, cls: 'text-success' },
  err: { Icon: CircleAlert, cls: 'text-destructive' },
  info: { Icon: Info, cls: 'text-primary' },
};

function ToastItem({ item }) {
  const { Icon, cls } = TONE[item.type] || TONE.info;
  return (
    <div
      role="status"
      onClick={() => dismissToast(item.id)}
      className={cn(
        'rise pointer-events-auto flex cursor-pointer items-start gap-2 rounded-md border border-border bg-card px-3 py-2',
        'text-sm text-card-foreground shadow-lg transition-colors hover:bg-muted'
      )}
    >
      <Icon className={cn('mt-px size-4 shrink-0', cls)} />
      <span className="min-w-0 break-words">{item.msg}</span>
    </div>
  );
}

/** 挂一次即可（放在应用根节点）：右下角从下往上堆叠 */
export function Toaster({ className }) {
  const list = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (list.length === 0) return null;

  return (
    <div
      className={cn(
        'pointer-events-none fixed bottom-4 right-4 z-[100] flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-2',
        className
      )}
    >
      {list.map((item) => (
        <ToastItem key={item.id} item={item} />
      ))}
    </div>
  );
}
