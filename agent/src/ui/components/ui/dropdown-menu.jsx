// ui/components/ui/dropdown-menu.jsx —— 下拉菜单（Radix DropdownMenu）：触发/浮层/菜单项/单选组/分隔线/标签
// 审计：子菜单(Sub*)、复选(CheckboxItem)、快捷键(Shortcut)、Portal/Group 这些零件本界面从没用过，已删
// （shadcn 模板整份抄来的残留——要再加回来时抄上游即可，别留着没人看懂的代码）
import * as React from 'react';
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui';
import { Circle } from 'lucide-react';
import { cn } from '../../lib/utils.js';

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

/** 菜单项共用样式：高亮走 accent 令牌，禁用走 data-disabled */
const itemCls = [
  'relative flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none',
  'transition-colors focus:bg-accent focus:text-accent-foreground',
  'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
  '[&_svg]:size-4 [&_svg]:shrink-0',
].join(' ');

const contentCls =
  'ui-anim-pop z-50 min-w-[9rem] overflow-hidden rounded-lg border border-border bg-card p-1 text-card-foreground shadow-md';

export const DropdownMenuContent = React.forwardRef((
  { className, sideOffset = 4, ...props },
  ref
) => {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(contentCls, className)}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
});


export const DropdownMenuItem = React.forwardRef((
  { className, variant = 'default', inset, ...props },
  ref
) => {
  return (
    <DropdownMenuPrimitive.Item
      ref={ref}
      className={cn(
        itemCls,
        variant === 'destructive' && 'text-destructive focus:bg-destructive/10 focus:text-destructive',
        inset && 'pl-8',
        className
      )}
      {...props}
    />
  );
});


export const DropdownMenuRadioItem = React.forwardRef((
  { className, children, ...props },
  ref
) => {
  return (
    <DropdownMenuPrimitive.RadioItem ref={ref} className={cn(itemCls, 'pl-8', className)} {...props}>
      <span className="absolute left-2 flex size-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Circle className="size-2 fill-current text-primary" strokeWidth={0} />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
});

export const DropdownMenuLabel = React.forwardRef((
  { className, inset, ...props },
  ref
) => {
  return (
    <DropdownMenuPrimitive.Label
      ref={ref}
      className={cn('px-2 py-1.5 text-xs font-medium text-subtle', inset && 'pl-8', className)}
      {...props}
    />
  );
});

export const DropdownMenuSeparator = React.forwardRef(({ className, ...props }, ref) => {
  return <DropdownMenuPrimitive.Separator ref={ref} className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />;
});


/** 右侧快捷键提示（纯展示，不注册真实按键） */
