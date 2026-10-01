// ui/components/ui/input.jsx —— 单行输入框：h-9 控件尺度、焦点环、禁用态、aria-invalid 时红边
import * as React from 'react';
import { cn } from '../../lib/utils.js';

export const Input = React.forwardRef(({ className, type = 'text', ...props }, ref) => {
  return (
    <input
      ref={ref}
      type={type}
      className={cn(
        'flex h-9 w-full min-w-0 rounded-md border border-border bg-input px-3 py-1 text-sm text-foreground shadow-xs',
        'transition-[color,box-shadow,border-color] placeholder:text-subtle',
        'file:mr-2 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground',
        'focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20',
        className
      )}
      {...props}
    />
  );
});
