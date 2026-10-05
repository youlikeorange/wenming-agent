/** lib/agent/tools/wait.js —— 等待工具（长任务的"等一段时间再查"那一环）
 *
 *  与 run_command 的关系：run_command 的超时会**杀掉整个进程组**，所以"前台 sleep 等
 *  后台任务"从来走不通（这也是提示词教"提交与等待分离"的原因）。wait 补上中间那步：
 *  服务端原地延时 seconds 秒后返回，模型再查一次进度——不拉起进程、不占命令条数，
 *  有自己的次数预算（面板「单轮等待上限」）与单次上限（面板「单次等待上限」，硬上限
 *  LIMITS.waitSec，只能收紧）。
 *
 *  可中断性：托管运行里用户点「停止」→ run.abort 触发 → 这里的等待**立即结束**并回一个
 *  "已停止"的工具结果（循环随后在下一轮开头检测到 abort 按停止收尾）。HTTP 直调
 *  （/agent/tools/call，没有 run 上下文）没有这道信号，等待会等满——那是无宿主的
 *  脚本调用，等满本来就是预期行为。
 */
const { clampPos } = require('../limits');

/** 等待到点或等到停止信号（哪个先到算哪个）。返回是否被停止。 */
function delay(seconds, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve(true);
    let settled = false;
    const finish = (stopped) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(stopped);
    };
    const t = setTimeout(() => finish(false), seconds * 1000);
    const onAbort = () => finish(true);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitTool(actor, args, limits, ctx) {
  const hard = (limits && limits.waitSec) || 1800;
  const asked = Number(args && args.seconds);
  const sec = clampPos(asked, 1, hard, Math.min(60, hard));
  const signal = ctx && ctx.run && ctx.run.abort && ctx.run.abort.signal;
  const stopped = await delay(sec, signal);
  if (stopped) {
    return { ok: false, note: '已停止',
      text: `等待被用户停止（原计划等 ${sec} 秒）：不再继续等待这轮任务，直接收尾——已提交的后台任务仍在跑，结果会落在它的日志/结果文件里。` };
  }
  const clamped = Number.isFinite(asked) && asked > sec;
  return { ok: true, note: '等待', text: `已等待 ${sec} 秒${clamped ? `（要求 ${asked} 秒，已按单次上限收敛）` : ''}。现在可以查一次进度了。` };
}

module.exports = { waitTool, delay };
