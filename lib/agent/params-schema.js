/** lib/agent/params-schema.js —— 服务端侧取**参数 schema 唯一真源**的唯一入口
 *
 *  schema 本身在 agent/src/core/params.js（ESM：浏览器界面、托管运行、Node 单测共用一份）。
 *  服务端是 CJS，所以这里用**动态 import** 缓存一份，而不是 require：
 *    · Node 16+ 都支持动态 import；`require(esm)` 要 Node ≥20.19/22.12，会让"下载即可运行"
 *      的最低版本被悄悄抬高（up.sh 只保证 ≥16）；
 *    · 模块被 require 时**立刻开始加载**（fire-and-forget），正常情况处理第一个请求时已就绪；
 *    · 万一还没就绪（进程刚起）：同步读路径按"暂不归一"放行（值仍然可用，只是没夹范围），
 *      **写路径 await ready()** —— 落盘那一步不能含糊。
 *
 *  归一化规则本身一行都不在这里（唯一真源仍是 core/params.js 的 normalizeParamBag），
 *  本模块只负责"跨 CJS/ESM 边界把它取过来 + 缓存"。
 */
let mod = null;
let pending = null;

function load() {
  if (!mod && !pending) {
    pending = import('../../agent/src/core/params.js')
      .then((m) => { mod = m; return m; })
      .catch(() => null);           // 加载失败：调用方按"没有 schema"降级（不阻断保存）
  }
  return pending;
}
load();

/** 同步取（未就绪 = null）；供诊断/测试 */
const loaded = () => mod;
/** 异步取（写路径用）；加载失败返回 null */
const ready = () => load();

/** 同步归一"一袋参数"；未就绪或形状不对时原样返回 */
function normalizeBag(bag) {
  if (!mod || !bag || typeof bag !== 'object' || Array.isArray(bag)) return bag;
  return mod.normalizeParamBag(bag);
}

/** 同步归一 paramsByModel（{模型键 → 参数袋}）；未就绪时原样返回 */
function normalizeByModel(map) {
  if (!mod || !map || typeof map !== 'object' || Array.isArray(map)) return map;
  const out = {};
  for (const [k, v] of Object.entries(map)) out[k] = mod.normalizeParamBag(v);
  return out;
}

module.exports = { ready, loaded, normalizeBag, normalizeByModel };
