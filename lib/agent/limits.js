/** lib/agent/limits.js —— 工具执行的硬上限与"只能收紧"的收敛（纯函数，无 IO）
 *
 *  服务端硬上限是最后一道闸；界面上能调的参数只能比它更小。以前面板值只存在浏览器里、
 *  从不发送：改了"单次读取上限""单条命令超时"毫无作用，而模型自己在参数里写 timeout_sec
 *  反倒能一路顶到硬上限。这里把两者收敛到一处：客户端传什么都要过 clamp。
 *
 *  五个键与面板的对应（`agent/src/core/params.js` 是 schema 的唯一真源）：
 *    read_kb → plugin_fs_read_kb · write_kb → plugin_fs_write_kb · out_kb → plugin_exec_out_kb
 *    nodes   → plugin_fs_nodes   · timeout_sec → plugin_exec_timeout
 *  硬上限本身可用环境变量抬高（AGENT_READ_MAX_BYTES / AGENT_WRITE_MAX_BYTES /
 *  AGENT_OUTPUT_MAX_BYTES / AGENT_TREE_MAX_NODES / AGENT_EXEC_MAX_SEC）——
 *  界面上改不动它们，这是有意的（最后一道闸归运维）。
 */
const LIMITS = {
  readBytes: Number(process.env.AGENT_READ_MAX_BYTES || 512 * 1024),
  writeBytes: Number(process.env.AGENT_WRITE_MAX_BYTES || 4 * 1024 * 1024),
  outputBytes: Number(process.env.AGENT_OUTPUT_MAX_BYTES || 256 * 1024),
  treeNodes: Number(process.env.AGENT_TREE_MAX_NODES || 800),
  timeoutSec: Number(process.env.AGENT_EXEC_MAX_SEC || 600),
  /* wait 工具的单次等待上限：等待是"空转但占着运行"的操作，硬上限给到 30 分钟，
     再往上就该走"提交后告诉用户稍后再问"（一轮能等多久 = 单次上限 × 单轮次数，面板可调）。 */
  waitSec: Number(process.env.AGENT_WAIT_MAX_SEC || 1800),
};

/** 单次模型调用的最高时长（秒）服务端硬上限：面板值（call_timeout_sec）只能比它小；
 *  面板给 0 = 用户明确"不限"，尊重之（思考循环检测仍在，不依赖时长）。 */
function capCallTimeout(sec) {
  const v = Number(sec) || 0;
  if (v <= 0) return 0;
  return Math.min(v, Math.max(1, Number(process.env.AGENT_LLM_CALL_MAX_SEC) || 3600));
}

function effLimits(over) {
  const o = (over && typeof over === 'object') ? over : {};
  const kb = (v, hard) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return hard;
    return Math.max(1024, Math.min(hard, Math.floor(n * 1024)));
  };
  const sec = (v, hard) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return hard;
    return Math.max(1, Math.min(hard, Math.floor(n)));
  };
  return {
    readBytes: kb(o.read_kb, LIMITS.readBytes),
    writeBytes: kb(o.write_kb, LIMITS.writeBytes),
    outputBytes: kb(o.out_kb, LIMITS.outputBytes),
    /* 目录树 / 找文件的结果条数：面板「目录树/找文件结果上限」（plugin_fs_nodes）。
       同样只能收紧——硬上限是 LIMITS.treeNodes，抬它要改服务端环境变量。 */
    treeNodes: clampPos(o.nodes, 10, LIMITS.treeNodes, LIMITS.treeNodes),
    timeoutSec: sec(o.timeout_sec, LIMITS.timeoutSec),
    /* wait 工具的单次等待秒数：面板「单次等待上限」（plugin_wait_sec，随每次调用下发）。 */
    waitSec: sec(o.wait_sec, LIMITS.waitSec),
  };
}

const clamp = (v, lo, hi, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
};

/** 同名参数的"正数才认"版本：0 与负数一律当"没传"，用默认值。
 *  为什么单独要它：模型常把 `timeout_sec: 0` 当成"不限时"写给工具，而 clamp 会把它压成下限 1
 *  —— 一条本该跑 30 秒的命令 1 秒就被杀掉、报"超时"。 */
const clampPos = (v, lo, hi, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
};

const kb = (n) => (n < 1024 ? n + 'B' : n < 1024 * 1024 ? (n / 1024).toFixed(1) + 'KB' : (n / 1024 / 1024).toFixed(1) + 'MB');

/** 并发 + 频率闸门（纯逻辑，可单测）：给"每次调用都要拉起一个外部进程"的操作兜底。
 *
 *  为什么必须有：联网搜索是 `spawn python`，每个请求最长 60 秒；而路由层原先既不限并发、
 *  也不限频率——任意已登录用户并发几十个请求就能把进程表/内存吃光（2026-10-01 审计）。
 *  语义：
 *    · maxConcurrent  同时最多几个在跑，多出来的排队（**不是拒绝**：正常用户感觉不到）；
 *    · perMinute      同一 key（账号）每分钟最多放行几个，超了直接 429；
 *    · 排队也不许无限排：队列超过 maxQueue 就立刻拒绝（否则慢请求会把内存堆起来）。
 *  返回值：{ ok:false, reason:'rate'|'queue' } 或 { ok:true, run: (fn) => Promise }。
 */
function makeGate({ maxConcurrent = 4, perMinute = 30, maxQueue = 32 } = {}) {
  const running = new Set();
  const queue = [];
  const hits = new Map();          // key → 最近一分钟的时间戳（只留窗口内的）

  const prune = (key, now) => {
    const list = (hits.get(key) || []).filter((t) => now - t < 60e3);
    hits.set(key, list);
    return list;
  };
  const pump = () => {
    while (queue.length && running.size < maxConcurrent) {
      const job = queue.shift();
      running.add(job);
      Promise.resolve().then(job.fn)
        .then(job.resolve, job.reject)
        .finally(() => { running.delete(job); pump(); });
    }
  };
  return {
    stats: () => ({ running: running.size, queued: queue.length, keys: hits.size }),
    /** @param {string} key 限频键（账号） @param {() => Promise} fn 真正要跑的活儿 */
    run(key, fn) {
      const now = Date.now();
      const list = prune(String(key || ''), now);
      if (list.length >= perMinute) return Promise.resolve({ ok: false, reason: 'rate' });
      list.push(now);
      if (running.size >= maxConcurrent && queue.length >= maxQueue) return Promise.resolve({ ok: false, reason: 'queue' });
      return new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject });
        pump();
      });
    },
  };
}

module.exports = { LIMITS, effLimits, clamp, clampPos, kb, makeGate, capCallTimeout };
