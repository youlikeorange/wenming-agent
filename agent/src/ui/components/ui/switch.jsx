// ui/components/ui/switch.jsx —— 开关（Radix Switch）：34×20 轨道 + 16 号白滑块，选中态填充主色
import * as React from 'react';
import { Switch as SwitchPrimitive } from 'radix-ui';
import { cn } from '../../lib/utils.js';

export const Switch = React.forwardRef(({ className, ...props }, ref) => {
  return (
    <SwitchPrimitive.Root
      ref={ref}
      className={cn(
        'peer inline-flex h-5 w-[34px] shrink-0 cursor-pointer items-center rounded-full border border-transparent p-[2px]',
        'bg-border-strong transition-colors data-[state=checked]:bg-primary',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'pointer-events-none block size-4 rounded-full bg-white shadow-sm transition-transform',
          'data-[state=checked]:translate-x-[14px] data-[state=unchecked]:translate-x-0'
        )}
      />
    </SwitchPrimitive.Root>
  );
});
