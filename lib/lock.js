/** lib/lock.js —— "按键串行化"的唯一实现（纯内存，无 IO）
 *
 *  为什么要有它：同一段 7 行代码原先有**四份**副本（lib/agent 的 store/settings/projects
 *  各一份，lib/packstore.js 一份）。审计的结论是"改口径时不会漏掉其中一条"——
 *  所以实现只留这一处（放在站点公共的 lib/ 下，agent 与 packstore 都能用），各模块 makeLock() 各取一把。
 *
 *  **为什么是"各取一把"而不是全线共用一把**：
 *  withLock 的语义是"同一把锁上的任务串行"。若全站共用一把，任何"锁里再调另一个模块的
 *  加锁函数"（projects 调 settings、archive 调 store…）都会自我等待、**死锁**。
 *  各模块锁自己的文件，既消掉了实现重复，也不会把跨模块调用变成地雷。
 *  （真要全站一把锁，得先把所有跨模块的加锁调用梳理干净——那是另一个量级的改动。）
 *
 *  用法：
 *    const withLock = makeLock();            // lib/lock.js
 *    return withLock(account, async () => { ...读改写... });
 */

/** 造一把"按键串行"的锁：同一个 key 上的任务按调用顺序排队，不同 key 互不影响。
 *  · 前一个任务失败**不影响**后一个（`prev.then(fn, fn)`：失败也要接着跑）；
 *  · 队列只保留"最后一个"的引用，跑完自然被 GC（不会随账号数无限增长）。 */
function makeLock() {
  const chains = new Map();
  return function withLock(key, fn) {
    const k = String(key);
    const prev = chains.get(k) || Promise.resolve();
    const next = prev.then(fn, fn);
    chains.set(k, next.then(() => {}, () => {}));
    return next;
  };
}

module.exports = { makeLock };
