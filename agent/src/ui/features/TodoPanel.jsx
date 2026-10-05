// TodoPanel.jsx —— 右上角悬浮的任务清单（agent 用 todo_write 维护；全部完成后保留显示）
//
//  两块形态共用一个组件：折叠 = 一枚小胶囊（进度 2/5，点开）；展开 = 清单卡片
//  （每项 ✓/○ + 文本 + 完成时间；进度条；收起按钮）。数据在 state/todo.js。
//  位置固定在右上角、顶栏之下（z-40：低于设置抽屉/对话框的 z-50，不挡它们）。
//  宽屏（≥1024px）下消息区在右侧留了与侧栏等宽的清单区（styles.css 的 --todo-zone），
//  卡片用 .todo-card 收进那块留白里；窄屏照旧悬浮（w ≤ 320px）。
import { Check, ChevronUp, ListChecks, Minus } from 'lucide-react';
import { cn } from '../lib/utils.js';
import { fmtTime } from '../lib/format.js';
import { useApp } from '../state/store.js';
import { setTodoOpen } from '../state/todo.js';

const pct = (done, total) => (total ? Math.round((done / total) * 100) : 0);

function Bar({ done, total }) {
  return (
    <span className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <span className="block h-full rounded-full bg-success transition-[width] duration-300"
        style={{ width: `${pct(done, total)}%` }} />
    </span>
  );
}

function Item({ it }) {
  const done = it.status === 'completed';
  return (
    <li className="flex items-start gap-1.5 py-1">
      <span className={cn('mt-0.5 shrink-0', done ? 'text-success' : 'text-subtle')} aria-hidden="true">
        {done ? <Check className="size-3.5" /> : <Minus className="size-3.5" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn('block text-[12px] leading-snug', done ? 'text-subtle line-through' : 'text-foreground')}>
          {it.text}
        </span>
        {done && it.completedAt ? (
          <span className="block text-[10.5px] tabular-nums text-subtle">完成于 {fmtTime(it.completedAt)}</span>
        ) : null}
      </span>
    </li>
  );
}

export default function TodoPanel() {
  const st = useApp();
  const t = st.todo || {};
  const data = t.data;
  if (!data || !Array.isArray(data.items) || !data.items.length) return null;
  const done = Number(data.done) || 0;
  const total = Number(data.total) || data.items.length;

  if (!t.open) {
    return (
      <button
        type="button"
        onClick={() => setTodoOpen(true)}
        title="展开任务清单"
        className="fixed right-3 top-14 z-40 inline-flex items-center gap-1.5 rounded-full border border-border bg-card/95 px-2.5 py-1 text-[11px] tabular-nums text-muted-foreground shadow-md backdrop-blur transition-colors hover:text-foreground"
      >
        <ListChecks className="size-3.5" />
        任务 {done}/{total}
      </button>
    );
  }
  return (
    <div className="todo-card fixed right-3 top-14 z-40 rounded-lg border border-border bg-card/95 shadow-lg backdrop-blur">
      <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2">
        <ListChecks className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs text-foreground">任务清单</span>
        <span className="shrink-0 text-[11px] tabular-nums text-subtle">{done}/{total} 完成</span>
        <button type="button" onClick={() => setTodoOpen(false)} title="收起"
          className="shrink-0 rounded p-0.5 text-subtle transition-colors hover:bg-muted hover:text-foreground">
          <ChevronUp className="size-3.5" />
        </button>
      </div>
      <div className="px-3 pt-2"><Bar done={done} total={total} /></div>
      <ul className="max-h-[46vh] overflow-y-auto px-3 pb-2 pt-1">
        {data.items.map((it, i) => <Item key={`${i}:${it.text}`} it={it} />)}
      </ul>
      <p className="border-t border-border/70 px-3 py-1.5 text-[10.5px] text-subtle">
        agent 自己维护；全部完成后留在这里，下一份清单会覆盖它
      </p>
    </div>
  );
}
