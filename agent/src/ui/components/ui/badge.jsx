// ui/components/ui/badge.jsx —— 徽标：default/secondary/outline/success/warning/destructive 六种语义变体
import * as React from 'react';
import { cva } from 'class-variance-authority';
import { cn } from '../../lib/utils.js';

export const badgeVariants = cva(
  'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-2 py-0.5 text-[11px] font-medium leading-4',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-muted text-muted-foreground',
        outline: 'border-border bg-transparent text-foreground',
        success: 'border-transparent bg-success/15 text-success',
        warning: 'border-transparent bg-warning/15 text-warning',
        destructive: 'border-transparent bg-destructive/15 text-destructive',
      },
    },
    defaultVariants: { variant: 'default' },
  }
);

export const Badge = React.forwardRef(({ className, variant, ...props }, ref) => {
  return <span ref={ref} className={cn(badgeVariants({ variant }), className)} {...props} />;
});
