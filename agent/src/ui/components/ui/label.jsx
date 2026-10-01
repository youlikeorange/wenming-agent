// ui/components/ui/label.jsx —— 表单标签（Radix Label）：点标签聚焦对应控件，控件禁用时随 peer 一起变淡
import * as React from 'react';
import { Label as LabelPrimitive } from 'radix-ui';
import { cn } from '../../lib/utils.js';

export const Label = React.forwardRef(({ className, ...props }, ref) => {
  return (
    <LabelPrimitive.Root
      ref={ref}
      className={cn(
        'select-none text-sm font-medium leading-none text-foreground',
        'peer-disabled:cursor-not-allowed peer-disabled:opacity-60',
        className
      )}
      {...props}
    />
  );
});
