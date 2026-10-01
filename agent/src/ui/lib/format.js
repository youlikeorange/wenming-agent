/* ui/lib/format.js —— 纯格式化函数（不碰 React、不读状态，可在 Node 下直接单测）
 *
 *  审计发现同一件事被写了好几遍，而且**单位口径已经走岔**：
 *    · shortPath：3 份逐字相同（DirectoryPicker / ArchiveSection / ProjectsSection）；
 *    · fmtTime：2 份逐字相同（MemorySection / ArchiveSection）；
 *    · "多大"：2 份语义不同——host.js 那份按**字符**、ToolsSection 那份按**字节**，都叫 fmtBytes；
 *    · fmtNum：2 份语义不同——parts.jsx 那份截三位小数、DataSection 那份加千分位。
 *  现在全站只此一份，且名字带上单位（字符 / 字节 / 数量），读代码的人不会再搞混。
 */

/** 路径显示：家目录换成 ~（只认 /home/<user> 这一段，用于列表里省地方） */
export const shortPath = (p) => String(p || '').replace(/^\/home\/[^/]+/, '~');

/** 本地时间（zh-CN、24 小时制）；时间戳非法时回落到"现在" */
export const fmtTime = (ts) => {
  try { return new Date(Number(ts) || Date.now()).toLocaleString('zh-CN', { hour12: false }); } catch { return ''; }
};

/** 字符数（**不是字节**）：说"这段文本多大"，用于写文件、提示词长度这类 */
export function fmtChars(s) {
  const n = String(s || '').length;
  if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + 'M 字符';
  if (n > 1024) return (n / 1024).toFixed(1) + 'K 字符';
  return n + ' 字符';
}

/** 字节数：说"磁盘/传输上限多大"（面板上的参数值本身是 KB，调用方先乘 1024） */
export function fmtBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '-';
  return v >= 1024 * 1024 ? (v / 1024 / 1024).toFixed(0) + ' MB' : Math.round(v / 1024) + ' KB';
}

/** 数值（滑块读数）：最多三位小数、去掉多余的 0 */
export const fmtNum = (v) => String(Math.round(Number(v) * 1000) / 1000);

/** 整数（统计读数）：千分位 */
export const fmtCount = (n) => Number(n || 0).toLocaleString('zh-CN');

/** token 数缩写：32000 → 32K（万位以上不留小数） */
export function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  return (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'K';
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / M-D */
export function timeAgo(ts) {
  const t = Number(ts) || 0;
  if (!t) return '';
  const d = Date.now() - t;
  if (d < 60e3) return '刚刚';
  if (d < 3600e3) return `${Math.floor(d / 60e3)} 分钟前`;
  if (d < 86400e3) return `${Math.floor(d / 3600e3)} 小时前`;
  if (d < 7 * 86400e3) return `${Math.floor(d / 86400e3)} 天前`;
  const dt = new Date(t);
  return `${dt.getMonth() + 1}-${String(dt.getDate()).padStart(2, '0')}`;
}

/** 完整时间（title 提示用） */
export const fullTime = (ts) => (Number(ts) ? new Date(Number(ts)).toLocaleString() : '');

/** 一轮的元信息：tok/s · tokens · prompt · 耗时（拿不到 usage 时按字数估算 tokens） */
/** 一轮的元信息：tok/s · tokens · prompt · 耗时（拿不到 usage 时按字数估算 tokens） */
export function statsParts(stats, wallMs, content) {
  const out = [];
  if (stats && stats.eval_count) {
    const n = stats.eval_count;
    const secs = stats.eval_duration ? stats.eval_duration / 1e9 : (wallMs ? wallMs / 1000 : 0);
    if (secs > 0.05) out.push(`${(n / secs).toFixed(1)} tok/s`);
    out.push(`${n} tokens`);
    if (stats.prompt_eval_count) out.push(`prompt ${stats.prompt_eval_count}`);
  } else if (content) {
    out.push(`≈${Math.round(String(content).length / 1.6)} tokens`);
  }
  if (wallMs) out.push(`${(wallMs / 1000).toFixed(1)}s`);
  return out;
}
