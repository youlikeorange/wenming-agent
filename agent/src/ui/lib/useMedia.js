/* ui/lib/useMedia.js —— 响应式断点的唯一来源（"电脑版 / 手机版"两套布局的开关）
 *
 *  为什么单独一个文件：断点值写散在各组件里（有的用 max-md: 有的用 sm:），
 *  改一处忘一处就会出现"手机上侧栏抽屉开了但没有遮罩"这类半成品状态。
 *  这里给两个语义化的钩子，组件按**语义**判断，不自己写宽度数字。
 *
 *  phone  :  ≤ 767px（手机竖屏 / 极窄窗口）——侧栏改抽屉、工具栏收进「更多」、抽屉全屏
 *  desktop:  ≥ 1024px（正常电脑窗口）——侧栏常驻、消息列放宽、设置抽屉加宽
 *  两者之间（768~1023）按平板处理：侧栏仍常驻但不加宽内容，与原来一致。
 */
import { useEffect, useState } from 'react';

function useMediaQuery(query) {
  const [hit, setHit] = useState(() => (typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia(query).matches : false));
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mq = window.matchMedia(query);
    const on = (e) => setHit(e.matches);
    setHit(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return hit;
}

export const useIsPhone = () => useMediaQuery('(max-width: 767px)');
