// ui/components/ui/dialog.jsx —— 模态对话框（Radix Dialog）：遮罩 + 居中面板 + 头/脚/标题/描述/关闭按钮
import * as React from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils.js';

export const Dialog = DialogPrimitive.Root;
export const DialogPortal = DialogPrimitive.Portal;

export const DialogOverlay = React.forwardRef(({ className, ...props }, ref) => {
  return (
    <DialogPrimitive.Overlay
      ref={ref}
      className={cn('ui-anim-fade fixed inset-0 z-50 bg-black/50 backdrop-blur-[1px]', className)}
      {...props}
    />
  );
});

export const DialogContent = React.forwardRef((
  { className, children, showClose = true, ...props },
  ref
) => {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          'ui-anim-pop fixed left-1/2 top-1/2 z-50 grid max-h-[85vh] w-[calc(100%-2rem)] max-w-lg',
          '-translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-lg border border-border bg-card p-5',
          'text-card-foreground shadow-lg',
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
    </DialogPortal>
  );
});

export const DialogHeader = React.forwardRef(({ className, ...props }, ref) => {
  return <div ref={ref} className={cn('flex flex-col gap-1.5 pr-6', className)} {...props} />;
});

export const DialogFooter = React.forwardRef(({ className, ...props }, ref) => {
  return (
    <div
      ref={ref}
      className={cn('flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  );
});

export const DialogTitle = React.forwardRef(({ className, ...props }, ref) => {
  return (
    <DialogPrimitive.Title
      ref={ref}
      className={cn('text-base font-semibold leading-tight text-foreground', className)}
      {...props}
    />
  );
});

export const DialogDescription = React.forwardRef(({ className, ...props }, ref) => {
  return (
    <DialogPrimitive.Description
      ref={ref}
      className={cn('text-sm leading-relaxed text-muted-foreground', className)}
      {...props}
    />
  );
});
