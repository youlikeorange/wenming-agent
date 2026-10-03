// ContextMeter.jsx —— 上下文用量环：conic-gradient 百分比 + 已用/上限 + 细进度条，点开看明细与压缩操作
import { useEffect, useRef, useState } from 'react';
import { AgentContext } from '../../core/context.js';
import { FIELDS } from '../../core/params.js';   // 兜底分母 = schema 的 ctxLimit 默认（唯一真源）
import { compactNow, uncompact } from '../state/settings.js';
import { Button } from '../components/ui/button.jsx';
import { cn } from '../lib/utils.js';
import { fmtTokens } from '../lib/format.js';
import { useApp } from '../state/store.js';

const RING_COLOR = { ok: 'var(--primary)', warn: 'var(--warning)', danger: 'var(--destructive)' };

/** 明细里的一行 */
function Row({ k, v, strong }) {
  return (
    <div className="flex items-center justify-between gap-3 py-0.5">
      <span className="text-subtle">{k}</span>
      <span className={cn('font-mono tabular-nums', strong ? 'font-semibold text-foreground' : 'text-muted-foreground')}>{v}</span>
    </div>
  );
}

export default function ContextMeter() {
  const st = useApp();
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);

  const ctx = st.ctx || { used: 0, limit: FIELDS.ctxLimit.def, pct: 0, state: 'ok', sysTok: 0, histTok: 0 };
  const pct = Math.max(0, Math.min(100, Math.round(ctx.pct || 0)));
  const color = RING_COLOR[ctx.state] || RING_COLOR.ok;

  const sess = (st.sessions || []).find((s) => s.id === st.activeSessId) || null;
  const compaction = sess && sess.compaction;
  const draftTok = AgentContext.estTokens(st.draft || '');
  const histCount = (st.history || []).length;
  const autoOn = AgentContext.autoCompactOn();

  // 点外面 / Escape 关闭
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  /* 压缩动作走 ui/state/settings.js 的唯一入口（带流式守卫；原先这里不拦流式，审计） */
  const runCompact = () => { setOpen(false); compactNow(); };
  const runUncompact = () => { setOpen(false); uncompact(); };

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="上下文用量（点击查看明细）"
        aria-expanded={open}
        className={cn('flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-muted', open && 'bg-muted')}
      >
        <span
          className="grid size-8 shrink-0 place-items-center rounded-full"
          style={{ background: `conic-gradient(${color} ${pct * 3.6}deg, var(--muted) 0)` }}
        >
          <span className="grid size-[22px] place-items-center rounded-full bg-card font-mono text-[9px] tabular-nums text-foreground">
            {pct}%
          </span>
        </span>
        <span className="hidden flex-col items-start gap-1 sm:flex">
          <span className="font-mono text-[11px] leading-none tabular-nums text-muted-foreground">
            {fmtTokens(ctx.used)} / {fmtTokens(ctx.limit)}
          </span>
          <span className="h-1 w-20 overflow-hidden rounded-full bg-muted">
            <span className="block h-full rounded-full transition-[width]" style={{ width: `${pct}%`, background: color }} />
          </span>
        </span>
      </button>

      {open ? (
        <div className="absolute right-0 top-full z-50 mt-2 w-72 rounded-lg border border-border bg-card p-3 text-xs shadow-md">
          <p className="mb-1.5 flex items-center justify-between font-medium text-foreground">
            上下文用量
            <span className={cn('font-mono tabular-nums', ctx.state === 'danger' ? 'text-destructive' : ctx.state === 'warn' ? 'text-warning' : 'text-muted-foreground')}>
              {pct}%
            </span>
          </p>
          <Row k="系统提示词 + 工具" v={`${ctx.sysTok || 0} tok`} />
          <Row k={`对话历史（${histCount} 条）`} v={`${ctx.histTok || 0} tok`} />
          <Row k="待发输入" v={`${draftTok} tok`} />
          <Row k="窗口上限" v={`${ctx.limit} tok`} strong />
          <p className="mt-1.5 rounded-md bg-muted px-2 py-1.5 leading-relaxed text-subtle">
            {autoOn
              ? `超过 ${Math.round(AgentContext.COMPACT_AT * 100)}% 时自动压缩：较早的对话压成摘要，原文保留`
              : `压缩提示词已关：超过 ${Math.round(AgentContext.CTX_TRIM_AT * 100)}% 时自动裁剪最老的对话（不再保留）`}
            <br />token 数为估算值（中文按字计）
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={runCompact} title="让模型把较早的对话总结成摘要，摘要代替原文进入后续请求（原文仍保留）">
              压缩现在
            </Button>
            <Button size="sm" variant="ghost" disabled={!compaction} onClick={runUncompact} title={compaction ? '取消压缩：原文重新进入上下文' : '当前没有压缩摘要'}>
              取消压缩
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
