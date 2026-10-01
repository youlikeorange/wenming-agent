// ui/components/ui/button.jsx —— 按钮：六种变体 × 四种尺寸，asChild 时用 Radix Slot 把样式套到子元素上
import * as React from 'react';
import { Slot } from 'radix-ui';
import { cva } from 'class-variance-authority';
import { cn } from '../../lib/utils.js';

/** 变体表：default / secondary / outline / ghost / destructive / link；尺寸 sm / md / lg / icon */
export const buttonVariants = cva(
  [
    'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium',
    'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
    'disabled:pointer-events-none disabled:opacity-50',
    '[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        secondary: 'bg-muted text-foreground hover:bg-border',
        outline: 'border border-border bg-background text-foreground hover:bg-muted',
        ghost: 'text-foreground hover:bg-muted',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-8 px-3 text-[13px]',
        md: 'h-9 px-4',
        lg: 'h-10 px-5',
        icon: 'size-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'md' },
  }
);

export const Button = React.forwardRef((
  { className, variant, size, asChild = false, type, ...props },
  ref
) => {
  const Comp = asChild ? Slot.Root : 'button';
  return (
    <Comp
      ref={ref}
      type={asChild ? undefined : type ?? 'button'}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
});
