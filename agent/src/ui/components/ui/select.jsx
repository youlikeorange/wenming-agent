// ui/components/ui/select.jsx —— 下拉选择（Radix Select）：触发器 + 浮层 + 滚动按钮 + 选项/分组/标签/分隔线
import * as React from 'react';
import { Select as SelectPrimitive } from 'radix-ui';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '../../lib/utils.js';

export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;

/** 滚动按钮：选项超出可视高度时出现在浮层上下沿 */
export const SelectScrollUpButton = React.forwardRef(({ className, ...props }, ref) => {
  return (
    <SelectPrimitive.ScrollUpButton
      ref={ref}
      className={cn('flex h-6 cursor-default items-center justify-center text-subtle', className)}
      {...props}
    >
      <ChevronUp className="size-4" />
    </SelectPrimitive.ScrollUpButton>
  );
});

export const SelectScrollDownButton = React.forwardRef(({ className, ...props }, ref) => {
  return (
    <SelectPrimitive.ScrollDownButton
      ref={ref}
      className={cn('flex h-6 cursor-default items-center justify-center text-subtle', className)}
      {...props}
    >
      <ChevronDown className="size-4" />
    </SelectPrimitive.ScrollDownButton>
  );
});

export const SelectTrigger = React.forwardRef(({ className, children, ...props }, ref) => {
  return (
    <SelectPrimitive.Trigger
      ref={ref}
      className={cn(
        'flex h-9 w-full items-center justify-between gap-2 whitespace-nowrap rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground shadow-xs',
        'transition-[color,box-shadow,border-color] data-[placeholder]:text-subtle',
        '[&>span]:min-w-0 [&>span]:truncate',
        'focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20',
        className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="size-4 shrink-0 text-subtle" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
});

export const SelectContent = React.forwardRef((
  { className, children, position = 'popper', sideOffset = 4, ...props },
  ref
) => {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        position={position}
        sideOffset={sideOffset}
        className={cn(
          'ui-anim-pop relative z-50 max-h-[min(20rem,var(--radix-select-content-available-height))]',
          'min-w-[8rem] overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-md',
          position === 'popper' && 'data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1',
          className
        )}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          className={cn(
            'p-1',
            position === 'popper' && 'min-h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)]'
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
});


export const SelectItem = React.forwardRef(({ className, children, ...props }, ref) => {
  return (
    <SelectPrimitive.Item
      ref={ref}
      className={cn(
        'relative flex w-full cursor-default select-none items-center rounded-md py-1.5 pl-2 pr-8 text-sm outline-none',
        'transition-colors focus:bg-accent focus:text-accent-foreground',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className
      )}
      {...props}
    >
      <SelectPrimitive.ItemText className="truncate">{children}</SelectPrimitive.ItemText>
      <span className="pointer-events-none absolute right-2 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="size-3.5 text-primary" strokeWidth={2.5} />
        </SelectPrimitive.ItemIndicator>
      </span>
    </SelectPrimitive.Item>
  );
});

