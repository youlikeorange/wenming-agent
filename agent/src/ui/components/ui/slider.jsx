// ui/components/ui/slider.jsx —— 滑块（Radix Slider）：细轨 + 主色进度条 + 圆钮，值数组多长就渲染几个钮
import * as React from 'react';
import { Slider as SliderPrimitive } from 'radix-ui';
import { cn } from '../../lib/utils.js';

/** 轨道与钮的共用样式（横向为默认，竖向由 data-orientation 兜住） */
const TRACK_CLS =
  'relative h-1.5 w-full grow overflow-hidden rounded-full bg-border-strong/70 ' +
  'data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1.5';
const THUMB_CLS = [
  'block size-4 shrink-0 cursor-grab rounded-full border-2 border-primary bg-card shadow-sm',
  'transition-transform hover:scale-105 active:cursor-grabbing',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
  'disabled:pointer-events-none disabled:opacity-50',
].join(' ');

export const Slider = React.forwardRef((
  { className, value, defaultValue, min, max, step, ...props },
  ref
) => {
  const values = value ?? defaultValue ?? [min ?? 0];
  const thumbCount = Array.isArray(values) ? values.length : 1;

  return (
    <SliderPrimitive.Root
      ref={ref}
      value={value}
      defaultValue={defaultValue}
      min={min}
      max={max}
      step={step}
      className={cn(
        'relative flex w-full touch-none select-none items-center',
        'data-[orientation=vertical]:h-full data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col',
        className
      )}
      {...props}
    >
      <SliderPrimitive.Track className={TRACK_CLS}>
        <SliderPrimitive.Range className="absolute h-full bg-primary data-[orientation=vertical]:w-full" />
      </SliderPrimitive.Track>
      {Array.from({ length: thumbCount }, (_, i) => (
        <SliderPrimitive.Thumb key={i} className={THUMB_CLS} />
      ))}
    </SliderPrimitive.Root>
  );
});
