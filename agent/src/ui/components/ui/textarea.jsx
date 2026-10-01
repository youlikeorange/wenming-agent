// ui/components/ui/textarea.jsx —— 多行输入框：与 Input 同一套边框/焦点/禁用/校验样式，纵向可拉伸
import * as React from 'react';
import { cn } from '../../lib/utils.js';

export const Textarea = React.forwardRef(({ className, ...props }, ref) => {
  return (
    <textarea
      ref={ref}
      className={cn(
        'flex min-h-20 w-full resize-y rounded-md border border-border bg-input px-3 py-2 text-sm leading-relaxed text-foreground shadow-xs',
        'transition-[color,box-shadow,border-color] placeholder:text-subtle',
        'focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20',
        className
      )}
      {...props}
    />
  );
});
