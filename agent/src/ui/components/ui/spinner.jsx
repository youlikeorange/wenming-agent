// ui/components/ui/spinner.jsx —— 载入转圈：纯 CSS 动画（border 缺口 + animate-spin），不依赖图标库
import * as React from 'react';
import { cn } from '../../lib/utils.js';

const SIZES = {
  sm: 'size-3.5 border-2',
  md: 'size-4 border-2',
  lg: 'size-6 border-[3px]',
};

export const Spinner = React.forwardRef((
  { className, size = 'md', label = '加载中', ...props },
  ref
) => {
  return (
    <span
      ref={ref}
      role="status"
      aria-label={label}
      className={cn(
        'inline-block shrink-0 animate-spin rounded-full border-current border-t-transparent text-muted-foreground',
        SIZES[size] ?? SIZES.md,
        className
      )}
      {...props}
    />
  );
});
