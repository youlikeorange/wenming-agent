// parts.jsx —— 设置抽屉各分区共用的零件：设置行（问号说明）、草稿输入、参数控件、chips、二次确认、下载
import { useState } from 'react';
import { CircleHelp, Plus, X } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { fmtNum } from '../../lib/format.js';
import { Badge } from '../../components/ui/badge.jsx';
import { Button } from '../../components/ui/button.jsx';
import { FieldDesc, FieldLabel } from '../../components/ui/field.jsx';
import { ImeInput, ImeTextarea } from '../../components/ui/ime-field.jsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select.jsx';
import { Slider } from '../../components/ui/slider.jsx';
import { Switch } from '../../components/ui/switch.jsx';
import { toast } from '../../components/ui/toast.jsx';
import { normalizeValue, parseExtraBody } from '../../../core/params.js';

/* ============================ 版式小件 ============================ */

/** 设置行：左标签（带问号说明）+ 右控件；below 放需要整行宽度的内容（chips、清单） */
export function SettingRow({ label, tip, desc, children, below, controlClassName, className }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cn('border-b border-border/70 px-4 py-2.5 last:border-b-0', className)}>
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <FieldLabel className="min-w-0 truncate">{label}</FieldLabel>
          {tip ? (
            <button
              type="button"
              aria-label="参数说明"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              className={cn(
                'shrink-0 rounded-full p-0.5 text-subtle transition-colors hover:bg-muted hover:text-foreground',
                open && 'bg-muted text-foreground'
              )}
            >
              <CircleHelp className="size-3.5" />
            </button>
          ) : null}
        </div>
        {children == null ? null : (
          <div className={cn('flex shrink-0 items-center justify-end gap-2', controlClassName)}>{children}</div>
        )}
      </div>
      {desc ? <FieldDesc>{desc}</FieldDesc> : null}
      {open && tip ? (
        <p className="mt-1.5 rounded-md bg-muted px-2.5 py-1.5 text-xs leading-relaxed text-muted-foreground">{tip}</p>
      ) : null}
      {below ? <div className="mt-2">{below}</div> : null}
    </div>
  );
}

/** 说明块（危险清单、安全提醒这类成段文字） */
export function NoteBox({ tone = 'muted', title, children }) {
  const tones = {
    muted: 'border-border bg-muted/50 text-muted-foreground',
    warn: 'border-warning/40 bg-warning/10 text-warning',
    danger: 'border-destructive/40 bg-destructive/10 text-destructive',
  };
  return (
    <div className={cn('rounded-md border px-3 py-2 text-xs leading-relaxed', tones[tone] || tones.muted)}>
      {title ? <p className="mb-1 font-medium">{title}</p> : null}
      {children}
    </div>
  );
}

/** 空列表提示 */
export function EmptyHint({ children, className }) {
  return (
    <p className={cn('rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-subtle', className)}>
      {children}
    </p>
  );
}

/** 分段选择（外观的模式/字号/密度、技能的加载方式） */
export function ChoiceGroup({ options, value, onChange, className }) {
  return (
    <div className={cn('inline-flex items-center gap-0.5 rounded-md border border-border bg-muted p-0.5', className)}>
      {options.map(([id, label]) => (
        <button
          key={id}
          type="button"
          aria-pressed={id === value}
          onClick={() => onChange(id)}
          className={cn(
            'rounded-sm px-2.5 py-1 text-xs font-medium transition-colors',
            id === value ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** 二次确认：不可逆操作（删除 / 解绑 / 清空）一律先过这一关 */
/* 注：这里原有 ConfirmDialog（局部受控弹窗）。审计发现全站有 3 套确认机制（全局 askConfirm、
   这个局部弹窗、以及各组件自己 useStiate 的第三种），同一个"归档项目"在侧栏与设置页外观都不同。
   现在统一走 askConfirm（ui/state/host.js + features/ConfirmDialog.jsx，队列化、带"总是允许"语义），
   组件侧一句 `const r = await askConfirm({title, body, okText, danger}); if (r.ok) …` 即可。 */

/* ============================ 受控输入（本地草稿，失焦/回车才提交） ============================ */

const textOf = (v) => (v === undefined || v === null ? '' : String(v));

/** 数字输入：草稿态只在本组件里，提交时夹回 min/max */
export function NumberInput({ value, onCommit, min, max, step = 1, className, placeholder }) {
  const [draft, setDraft] = useState(null);
  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    const s = draft.trim();
    if (!s) { onCommit(''); return; }
    const n = Number(s);
    if (!Number.isFinite(n)) { toast('请输入数字', 'err'); return; }
    const lo = min === undefined ? -Infinity : min;
    const hi = max === undefined ? Infinity : max;
    onCommit(Math.max(lo, Math.min(hi, n)));
  };
  return (
    <ImeInput
      type="number"
      inputMode="decimal"
      value={draft ?? textOf(value)}
      min={min}
      max={max}
      step={step}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
      className={cn('w-24 text-right font-mono tabular-nums', className)}
    />
  );
}

/** 草稿态：null = 跟随外部值，非 null = 用户正在编辑；settle() 一次性结算（失焦时调） */
function useDraft(value) {
  const [draft, setDraft] = useState(null);
  const settle = (onCommit, parse) => {
    if (draft === null) return;
    const next = parse ? parse(draft) : draft;
    if (next === null) return;                  // parse 返回 null = 输入不合法：保留草稿继续改
    setDraft(null);
    if (next !== textOf(value)) onCommit(next);
  };
  return { text: draft ?? textOf(value), set: setDraft, settle };
}

/** 多行文本域：草稿 + 失焦提交 */
function DraftTextarea({ value, onCommit, className, ...props }) {
  const d = useDraft(value);
  return (
    <ImeTextarea
      value={d.text}
      onChange={(e) => d.set(e.target.value)}
      onBlur={() => d.settle(onCommit)}
      className={cn('font-mono text-xs', className)}
      {...props}
    />
  );
}

/** JSON 文本域：失焦时先解析，解析失败保留草稿并提示（不写坏设置） */
export function JsonTextarea({ value, onCommit, className, ...props }) {
  const d = useDraft(value);
  const parse = (raw) => {
    const s = raw.trim();
    if (s && parseExtraBody(s) === null) { toast('JSON 格式不合法，没有保存', 'err'); return null; }
    return s;
  };
  return (
    <ImeTextarea
      value={d.text}
      onChange={(e) => d.set(e.target.value)}
      onBlur={() => d.settle(onCommit, parse)}
      spellCheck={false}
      className={cn('font-mono text-xs', className)}
      {...props}
    />
  );
}

/** 数值徽章（滑块右侧的当前值） */
function NumBadge({ children, className }) {
  return (
    <Badge variant="secondary" className={cn('min-w-12 justify-center font-mono tabular-nums', className)}>
      {children}
    </Badge>
  );
}

/* ============================ 参数控件（按 kind 分发） ============================ */

/** 滑块：拖动中只改本地草稿，松手（onValueCommit）才写设置 */
function RangeControl({ field, value, onChange }) {
  const [draft, setDraft] = useState(null);
  const v = draft === null ? Number(value) : draft;
  return (
    <>
      <Slider
        className="w-36"
        min={field.min ?? 0}
        max={field.max ?? 1}
        step={field.step ?? 0.01}
        value={[Number.isFinite(v) ? v : Number(field.def)]}
        onValueChange={([n]) => setDraft(n)}
        onValueCommit={([n]) => { setDraft(null); onChange(normalizeValue(field, n)); }}
      />
      <NumBadge>{fmtNum(Number.isFinite(v) ? v : field.def)}</NumBadge>
    </>
  );
}

function SelectControl({ field, value, onChange }) {
  return (
    <Select value={String(value ?? field.def)} onValueChange={(v) => onChange(normalizeValue(field, v))}>
      <SelectTrigger className="h-8 w-44 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {(field.options || []).map(([id, label]) => (
          <SelectItem key={id} value={id} className="text-xs">{label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** 按 kind 渲染一项参数的控件；list 型（chips）由调用方用 below 渲染 */
function ParamControl({ field, value, onChange }) {
  const commit = (v) => onChange(normalizeValue(field, v));
  if (field.kind === 'range') return <RangeControl field={field} value={value} onChange={onChange} />;
  if (field.kind === 'number') {
    return <NumberInput value={value} min={field.min} max={field.max} step={field.step} onCommit={commit} />;
  }
  if (field.kind === 'select') return <SelectControl field={field} value={value} onChange={onChange} />;
  if (field.kind === 'switch') return <Switch checked={!!value} onCheckedChange={commit} />;
  if (field.kind === 'lines') {
    return <DraftTextarea rows={3} className="w-60" value={value} onCommit={commit} placeholder="每行一条" />;
  }
  if (field.kind === 'json') return <JsonTextarea rows={4} className="w-60" value={value} onCommit={commit} />;
  return <span className="text-xs text-subtle">（{field.kind} 控件待实现）</span>;
}

/** 参数行：标签 + 问号说明 + 控件；被每模型覆盖的键在说明里标出来 */
export function ParamRow({ field, value, onChange, overridden, desc, controlClassName }) {
  const list = field.kind === 'list';
  return (
    <SettingRow
      label={field.label}
      tip={field.tip}
      controlClassName={list ? undefined : controlClassName}
      desc={desc || (overridden ? '已被当前模型单独覆盖（改这里只影响该模型）' : null)}
      below={list ? (
        <ChipsEditor
          items={Array.isArray(value) ? value : []}
          onChange={(next) => onChange(normalizeValue(field, next))}
          placeholder="例：git status"
          emptyText="清单为空：所有命令都会按访问级别询问"
        />
      ) : null}
    >
      {list ? null : <ParamControl field={field} value={value} onChange={onChange} />}
    </SettingRow>
  );
}

/* ============================ chips（允许清单这类条目集合） ============================ */

function ChipsEditor({ items = [], onChange, placeholder = '输入后回车添加', emptyText = '还没有条目' }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim();
    if (!v) return;
    setDraft('');
    if (items.includes(v)) { toast('已经在清单里了'); return; }
    onChange([...items, v].slice(-100));
  };
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {items.length ? items.map((it) => (
          <Badge key={it} variant="secondary" className="gap-1 pr-1 font-mono text-[11px]">
            <span className="max-w-[16rem] truncate">{it}</span>
            <button
              type="button"
              aria-label={`移除 ${it}`}
              onClick={() => onChange(items.filter((x) => x !== it))}
              className="rounded-sm p-0.5 text-subtle transition-colors hover:bg-border hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </Badge>
        )) : <span className="text-xs text-subtle">{emptyText}</span>}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <ImeInput
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          className="h-8 w-64 font-mono text-xs"
        />
        <Button variant="outline" size="sm" onClick={add}><Plus />添加</Button>
        {items.length ? (
          <Button variant="ghost" size="sm" onClick={() => onChange([])}>清空</Button>
        ) : null}
      </div>
    </div>
  );
}

/* ============================ 下载 ============================ */

/** 触发浏览器下载（导出数据 / 记忆用；不经过服务端） */
export function downloadText(filename, text, mime = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
