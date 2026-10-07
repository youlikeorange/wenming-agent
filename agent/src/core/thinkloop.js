/** core/thinkloop.js —— 思考循环检测（纯函数，零依赖、零 IO）
 *
 *  解决的问题（2026-10-07 用户报告）：模型有时在思考里**打转**——同一段话反反复复地
 *  重新输出，永不收敛也不给 finish_reason，一次调用可以挂几十分钟。
 *  这里的判据只有一类：**思考流的尾部在精确重复**。把最近的思考当文本看，
 *  如果结尾是同一个块（周期）一字不差地连排了好几遍，就是循环——
 *  人类写作与正常推理不会一字不差地连说三遍同一句话。
 *
 *  口径（故意保守，宁可漏报也不误杀正常思考）：
 *    · 只在**后缀**上找：循环意味着"最新的文本"在重复，早期内容重复不算；
 *    · 周期 ≥24 字连排 3 遍、或 8~23 字连排 6 遍（短周期允许更高的重复数，
 *      "再想想。"这种短语循环靠它抓）；正文、工具调用不参与；
 *    · 检测由调用方（agent.js 的 readRound）每积累一段思考跑一次，代价 O(周期总和)，
 *      相对思考流本身可忽略。
 *  另有一个"纯思考总量"兜底：整轮只有思考、零正文零工具调用还超过 THINK_ONLY_CAP
 *  字，基本就是跑飞了（正常推理模型极少单调用产出 6 万字纯思考）。
 */

/** 尾部窗口：只在最近的文本里找重复（早期内容里出现过的句子不算循环） */
const WINDOW = 6000;
/** 长周期（≥24 字）连排 3 遍判循环 */
const LONG_UNIT = 24, LONG_REPEATS = 3;
/** 短周期（8~23 字）连排 6 遍判循环 */
const SHORT_UNIT = 8, SHORT_REPEATS = 6;
/** 纯思考兜底：一轮里只有思考（无正文、无工具调用）超过这么多字 → 判跑飞 */
export const THINK_ONLY_CAP = 65536;
/** 检测跑多勤：思考每新积累这么多字查一次（调用方控制节奏） */
export const THINK_CHECK_STEP = 512;

/** 结尾是否是 b 一字不差地连排 k 遍（不构造重复串，直接分段比较） */
const endsWithRepeat = (w, b, k) => {
  const L = b.length;
  for (let i = 1; i < k; i++) {
    if (w.slice(w.length - L * (i + 1), w.length - L * i) !== b) return false;
  }
  return true;
};

/** 思考流是否在循环：命中返回一句人话描述，没命中返回 ''（供 notice 与单测） */
export function thinkLoopHit(thinking) {
  const s = String(thinking || '');
  if (s.length < SHORT_UNIT * SHORT_REPEATS) return '';
  const w = s.length > WINDOW ? s.slice(-WINDOW) : s;
  /* 短周期（8~23）：连排 6 遍；长周期（24~600）：连排 3 遍。
     周期上限 600：更长的"重复"已经是几十上百 token 的整段反复，WINDOW 内 3 遍
     就要 1800+ 字，上面的窗口足够覆盖；再大的周期交给纯思考总量兜底。 */
  for (let L = SHORT_UNIT; L <= 600; L++) {
    if (w.length < L * (L < LONG_UNIT ? SHORT_REPEATS : LONG_REPEATS)) break;
    const b = w.slice(-L);
    if (endsWithRepeat(w, b, L < LONG_UNIT ? SHORT_REPEATS : LONG_REPEATS)) {
      return `思考尾部以 ${L} 字为周期重复输出（循环）`;
    }
  }
  return '';
}

/** 纯思考兜底：这轮是不是只有思考且已超量（content/calls 都空、thinking 超过 THINK_ONLY_CAP） */
export function thinkOnlyRunaway(thinking, content, calls) {
  return !content && !(calls && calls.length) && String(thinking || '').length > THINK_ONLY_CAP;
}
