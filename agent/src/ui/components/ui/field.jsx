// ui/components/ui/field.jsx —— 设置面板行样式：FieldRow（左标签说明 + 右控件，行间细线）、FieldLabel/Desc/Value、SectionTitle
import * as React from 'react';
import { cn } from '../../lib/utils.js';

/** 分组标题：小号大写字 + 右侧一条横线，段落感接近 VS Code / Notion 设置面板 */
export const SectionTitle = React.forwardRef(({ className, children, ...props }, ref) => {
  return (
    <div ref={ref} className={cn('flex items-center gap-3 pb-1.5 pt-4 first:pt-0', className)} {...props}>
      <span className="shrink-0 text-xs font-semibold uppercase tracking-wider text-subtle">{children}</span>
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
    </div>
  );
});

/** 设置项标签：给 htmlFor 时渲染 <label>，否则退化成 <span>（只做视觉标签） */
export const FieldLabel = React.forwardRef(({ className, htmlFor, ...props }, ref) => {
  const Comp = htmlFor ? 'label' : 'span';
  return (
    <Comp
      ref={ref}
      htmlFor={htmlFor}
      className={cn('block text-sm font-medium leading-snug text-foreground', className)}
      {...props}
    />
  );
});

/** 设置项说明：标签下一行的次要文字 */
export const FieldDesc = React.forwardRef(({ className, ...props }, ref) => {
  return <p ref={ref} className={cn('mt-0.5 text-xs leading-relaxed text-muted-foreground', className)} {...props} />;
});

/** 只读值：右侧展示当前取值（数字、模型名、路径），等宽字体 + 超长省略 */
export const FieldValue = React.forwardRef(({ className, ...props }, ref) => {
  return (
    <span
      ref={ref}
      className={cn('max-w-[18rem] truncate font-mono text-xs tabular-nums text-muted-foreground', className)}
      {...props}
    />
  );
});

/** 设置行：左标签/说明占满剩余宽度，右控件不收缩；行底线由 last:border-b-0 收尾 */
export const FieldRow = React.forwardRef((
  { className, label, desc, children, align = 'center', controlClassName, ...props },
  ref
) => {
  return (
    <div
      ref={ref}
      className={cn(
        'flex gap-3 border-b border-border/70 px-4 py-2.5 last:border-b-0',
        align === 'start' ? 'items-start' : 'items-center',
        className
      )}
      {...props}
    >
      <div className="min-w-0 flex-1">
        <FieldLabel>{label}</FieldLabel>
        {desc ? <FieldDesc>{desc}</FieldDesc> : null}
      </div>
      {children == null ? null : (
        <div className={cn('flex shrink-0 items-center justify-end gap-2', controlClassName)}>{children}</div>
      )}
    </div>
  );
});
