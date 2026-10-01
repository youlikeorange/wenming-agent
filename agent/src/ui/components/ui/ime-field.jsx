// ui/components/ui/ime-field.jsx —— 输入法（IME）安全的输入框：非受控 + 组合态保护
//
// 为什么不能直接把 value/onChange 交给受控 Input/Textarea（2026-09-30 用真实 Chrome +
// CDP 的 Input.imeSetComposition 复现并逐项二分过，细节见 Composer.jsx 顶部）：
// 受控组件每次输入后 React 都要把值回写 DOM，而 Chromium 的输入法组合态经不起这次回写 ——
// 组合被取消后，下一次预编辑不是"替换上一段"而是"插到光标处"，于是拼音与汉字叠加、
// 一个键出多个字母：
//     组合 n → "n"；组合 ni → "nni"；组合 nihao → "nninihao"；上屏 → "nninihao你好"
// 输入消息框当时就是这样修的；这里把同一套做法收成通用零件，凡是让用户自由打字的框都该用它。
//
// 语义：value 只当**外部真源**（预填 / 清空 / 恢复默认 / 切换条目时由外部改动），
// 只有它与框内内容不同且**不在输入法组合中**时才写回 DOM；用户打字全程不经过 React 的
// 受控往返；组合结束时把最终文本再上报一次（最后一次 input 事件偶尔缺席，兜一道）。
import * as React from 'react';
import { Input } from './input.jsx';
import { Textarea } from './textarea.jsx';

const textOf = (v) => (v === undefined || v === null ? '' : String(v));

/** 非受控绑定：ref + 事件。onChange 沿用 DOM 事件签名（e.target.value），换标签即可替换受控写法 */
export function useImeSafe(value, onChange) {
  const ref = React.useRef(null);
  const composingRef = React.useRef(false);     // 输入法组合中（中文/日文正在选词）
  const text = textOf(value);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    /* 组合中绝不写 DOM：那正是上面说的"取消组合"的动作，组合中的外部值变化（极少）让位给用户输入 */
    if (!composingRef.current && el.value !== text) el.value = text;
  }, [text]);
  return {
    ref,
    onChange: (e) => { if (onChange) onChange(e); },
    onCompositionStart: () => { composingRef.current = true; },
    onCompositionEnd: (e) => { composingRef.current = false; if (onChange) onChange(e); },
  };
}

export function ImeInput({ value, onChange, ...props }) {
  const bind = useImeSafe(value, onChange);
  return <Input {...props} {...bind} />;
}

export function ImeTextarea({ value, onChange, ...props }) {
  const bind = useImeSafe(value, onChange);
  return <Textarea {...props} {...bind} />;
}
