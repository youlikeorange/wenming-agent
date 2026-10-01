// ui/lib/utils.js —— 类名合并助手：clsx 拼接条件类名，tailwind-merge 让后写的同类工具类覆盖先写的
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** 合并任意类名输入，并消解 Tailwind 同属性冲突（如 h-8 与 h-9 只留后者） */
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
