// ui/components/ui/sheet.jsx —— 抽屉（Radix Dialog 改造）：side="right"|"left"|"bottom"，尺寸用 className 覆盖
// （桌面设置抽屉传 w-[min(900px,96vw)]；手机的底部列表传 w-full，基类的 h-full/w-3/4/sm:max-w-md 会被 twMerge 顶掉）
import * as React from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils.js';

export const Sheet = DialogPrimitive.Root;
export const SheetPortal = DialogPrimitive.Portal;

/** 三套定位：贴边 + 单侧描边 + 对应方向的滑入/滑出动画。
 *  bottom 是手机上的"底部面板"：高度随内容（上限 72vh），圆角只在上面两角。 */
const SIDE_CLS = {
  right: 'inset-y-0 right-0 border-l ui-anim-slide-right',
  left: 'inset-y-0 left-0 border-r ui-anim-slide-left',
  bottom: 'inset-x-0 bottom-0 h-auto max-h-[72vh] rounded-t-2xl border-t ui-anim-slide-up',
};

export const SheetOverlay = React.forwardRef(({ className, ...props }, ref) => {
  return (
    <DialogPrimitive.Overlay
      ref={ref}
      className={cn('ui-anim-fade fixed inset-0 z-50 bg-black/50', className)}
      {...props}
    />
  );
});

export const SheetContent = React.forwardRef((
  { className, children, side = 'right', showClose = true, ...props },
  ref
) => {
  return (
    <SheetPortal>
      <SheetOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          'fixed z-50 flex h-full w-3/4 flex-col gap-0 border-border bg-card text-card-foreground shadow-lg',
          'sm:max-w-md',
          SIDE_CLS[side] ?? SIDE_CLS.right,
          className
        )}
        {...props}
      >
        {children}
        {showClose ? (
          <DialogPrimitive.Close
            className={cn(
              'absolute right-3 top-3 rounded-md p-1 text-subtle transition-colors',
              'hover:bg-muted hover:text-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40'
            )}
          >
            <X className="size-4" />
            <span className="sr-only">关闭</span>
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </SheetPortal>
  );
});

export const SheetHeader = React.forwardRef(({ className, ...props }, ref) => {
  return (
    <div
      ref={ref}
      className={cn('flex flex-col gap-1 border-b border-border px-5 py-4 pr-12', className)}
      {...props}
    />
  );
});

export const SheetBody = React.forwardRef(({ className, ...props }, ref) => {
  return <div ref={ref} className={cn('min-h-0 flex-1 overflow-y-auto', className)} {...props} />;
});


export const SheetTitle = React.forwardRef(({ className, ...props }, ref) => {
  return (
    <DialogPrimitive.Title
      ref={ref}
      className={cn('text-base font-semibold leading-tight text-foreground', className)}
      {...props}
    />
  );
});

export const SheetDescription = React.forwardRef(({ className, ...props }, ref) => {
  return (
    <DialogPrimitive.Description
      ref={ref}
      className={cn('text-xs leading-relaxed text-muted-foreground', className)}
      {...props}
    />
  );
});
