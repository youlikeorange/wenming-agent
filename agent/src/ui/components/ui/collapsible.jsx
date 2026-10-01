// ui/components/ui/collapsible.jsx —— 折叠面板（Radix Collapsible）：触发器 + 高度动画内容区
import * as React from 'react';
import { Collapsible as CollapsiblePrimitive } from 'radix-ui';
import { cn } from '../../lib/utils.js';

export const Collapsible = CollapsiblePrimitive.Root;
export const CollapsibleTrigger = CollapsiblePrimitive.Trigger;

export const CollapsibleContent = React.forwardRef(({ className, ...props }, ref) => {
  return <CollapsiblePrimitive.Content ref={ref} className={cn('ui-collapse overflow-hidden', className)} {...props} />;
});
