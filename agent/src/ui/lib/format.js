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
/** 字节 → 人读的字符串。**小于 1KB 时按字节显示**：待下载目录里的小文件
 *  （几百字节的 md/脚本）以前一律显示成"0 KB"，看着像空文件。 */
export function fmtBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '-';
  if (v < 1024) return Math.round(v) + ' B';
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

/** 一句提问的「名字」（右侧会话大纲的悬停标题）。
 *  输入框里可以是 Markdown：直接显示会把 ``` / ** / "- " 这些记号带进标题，
 *  所以取第一条有效行、剥掉行首记号与行内强调、压平空白；超长按**码点**截断（不劈开 emoji）。 */
export function outlineLabel(text, max = 60) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const head = lines.find((l) => !l.startsWith('```')) || lines[0] || '';
  const plain = head
    .replace(/^#{1,6}\s+/, '')                        // # 标题
    .replace(/^>\s?/, '')                             // > 引用
    .replace(/^(?:[-*+]|\d{1,3}[.)])\s+/, '')         // - / * / 1. / 2) 列表记号
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')         // 图片 → alt 文字
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')          // 链接 → 链接文字
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...plain];
  return chars.length > max ? chars.slice(0, max).join('') + '…' : plain;
}

/** 运行时长（人话）：12.3 秒 / 1 分 23 秒 / 1 小时 2 分。
 *  用来把"这一轮跑了多久"说清楚——旧写法只有 `(ms/1000).toFixed(1) + 's'`，
 *  跑十分钟的一轮显示成 "612.4s"，用户得自己换算。 */
export function fmtDuration(ms) {
  const v = Number(ms) || 0;
  if (v <= 0) return '';
  if (v < 60000) return `${(v / 1000).toFixed(v < 10000 ? 1 : 0)} 秒`;
  const secs = Math.round(v / 1000);
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m} 分 ${secs % 60} 秒`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

/** 一轮的元信息：tok/s · tokens · prompt · 耗时（拿不到 usage 时按字数估算 tokens） */
export function statsParts(stats, wallMs, content) {
  const out = [];
  if (stats && stats.eval_count) {
    const n = stats.eval_count;
    /* tok/s 的分母只能是**生成耗时**：优先内核实测的 gen_ms（第一个增量 → 最后一个增量，
       见 core/agent.js 的 readRound），其次上游给的 eval_duration（Ollama 那类会带）。
       两个都没有就**不显示 tok/s**——旧实现回落到整轮 wallMs，把排队、首字节、工具执行全算进去，
       实测一轮 8 tokens 跑了 30 秒（含两次工具调用）显示成 0.3 tok/s，那是假数不是速度。 */
    const secs = Number(stats.gen_ms) > 0 ? Number(stats.gen_ms) / 1000
      : (Number(stats.eval_duration) > 0 ? Number(stats.eval_duration) / 1e9 : 0);
    if (secs > 0.05) out.push(`${(n / secs).toFixed(1)} tok/s`);
    out.push(`${n} tokens`);
    if (stats.prompt_eval_count) out.push(`prompt ${stats.prompt_eval_count}`);
  } else if (content) {
    out.push(`≈${Math.round(String(content).length / 1.6)} tokens`);
  }
  if (wallMs) out.push(`${(wallMs / 1000).toFixed(1)}s`);
  return out;
}
