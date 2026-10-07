/* ui/state/fileDiff.js —— 「比对修改」抽屉的状态与动作
 *
 *  两个入口共用同一份状态、同一个抽屉（features/FileDiffSheet.jsx）：
 *    · 追踪条上的 +N/−M 卡片（entry 维度）："这条命令把文件改成了什么"；
 *    · 撤销菜单里点一个文件（file 维度）："这个文件在本轮累计变成了什么"。
 *  两端的分工：内容不在这层算——抽屉打开时向 `POST /agent/run/undo/diff` 取两侧文本
 *  （服务端按 AGENT_UNDO_DIFF_CHARS 截断、二进制/目录只回元信息），
 *  差异行由纯函数 ui/lib/diff.js 现算（渲染在组件里）。
 *
 *  「仅恢复这一个」走的是与整轮撤销**同一个端点**（paths 参数），闸门引导共用 state/undo-help.js。
 */
import { state, patch } from './store.js';
import { post } from '../../core/http.js';
import { EP } from '../../core/endpoints.js';
import { toast } from '../components/ui/toast.jsx';
import { shortPath } from '../lib/format.js';
import { undoGateHelp } from './undo-help.js';
import { undoRun } from './run.js';

const cur = () => state.fileDiff;
const put = (over) => patch({ fileDiff: Object.assign({}, cur(), over) });

/** 这次请求的结果还作数吗——加载期间用户可能切了文件、关了抽屉或换了运行 */
const stale = (s, f) => {
  const now = cur();
  return !now.open || now.runId !== s.runId || now.files[now.index] !== f;
};

/**
 * 打开抽屉。`files` = `[{ path, entry? }]`（entry 只在"这一条命令的改动"入口给；
 * 多文件 = 一条命令动了多个路径，比如 move_file，抽屉里用标签切换）。
 */
export function openFileDiff({ runId, sessionId, files, index = 0 }) {
  const list = (Array.isArray(files) ? files : []).filter((f) => f && f.path);
  if (!runId || !list.length) return;
  const i = Math.max(0, Math.min(index, list.length - 1));
  patch({
    fileDiff: { open: true, runId: String(runId), sessionId: String(sessionId || ''), files: list, index: i,
      loading: false, error: '', restoring: false, data: null },
  });
  loadFileDiff();
}

export function closeFileDiff() { put({ open: false }); }

/** 切到清单里的另一个文件（多路径的卡片 / 菜单逐个点开时） */
export function selectFileDiff(index) {
  const i = Math.max(0, Math.min(Number(index) || 0, cur().files.length - 1));
  if (i === cur().index) return;
  put({ index: i, data: null, error: '' });
  loadFileDiff();
}

/** 请求当前文件的两侧内容（单独的取数函数：加载流程的"判定/写状态"都在 loadFileDiff 里） */
const fetchDiff = (s, f) => post(EP.runUndoDiff, {
  id: s.runId, sessionId: s.sessionId || undefined,
  path: f.path, entry: Number.isInteger(f.entry) ? f.entry : undefined,
}, { timeoutMs: 60000 });

/** 取数的两种落点（都在 stale 检查之后调用）：成功写 data，失败写 error 并按需引导 */
function settleDiff(err, d) {
  if (!err) { put({ loading: false, data: d }); return; }
  const body = (err && err.payload) || {};
  put({ loading: false, error: body.error || err.message || '读取差异失败' });
  if (body.needUnlock || body.needBind) undoGateHelp({ payload: body, message: err.message });
}

/** 取当前文件的两侧内容；回来时对不上（切了文件/关了抽屉）就丢弃这次结果。 */
async function loadFileDiff() {
  const s = cur();
  const f = s.files[s.index];
  if (!f || !s.runId) return;
  put({ loading: true, error: '' });
  let d = null, err = null;
  try { d = await fetchDiff(s, f); } catch (e) { err = e; }
  if (stale(s, f)) return;
  settleDiff(err, d);
}

/** 恢复结果里有失败 → 提示 + 闸门引导；返回 true 表示"这一趟没有成功" */
function reportRestoreFails(d) {
  const fails = ((d && d.result) || {}).failed || [];
  if (!fails.length) return false;
  const f0 = fails[0];
  toast(`没能恢复：${f0.error || '未知原因'}`, 'err');
  if (f0.needUnlock || f0.needBind) undoGateHelp({ payload: f0 });
  return true;
}

/**
 * 「仅恢复这一个」：把当前文件恢复成这一轮开始前的样子（同一轮里被改过多次就一起回退）。
 * 服务端按 paths 只处理这一个文件——其余文件原样不动；成功推进度写回本地（undoRun 内部做）。
 */
export async function restoreFileDiff() {
  const s = cur();
  const f = s.files[s.index];
  if (!s.runId || !f || s.restoring) return false;
  put({ restoring: true });
  try {
    const d = await undoRun(s.runId, [f.path]);
    put({ restoring: false });
    if (reportRestoreFails(d)) return false;
    toast(`已恢复 ${shortPath(f.path)}：回到这一轮开始前的样子`, 'ok');
    /* 重取两侧内容：恢复成功后这里应当显示"两侧一致"（让用户看见结果，而不是猜） */
    await loadFileDiff();
    return true;
  } catch (e) {
    put({ restoring: false });
    undoGateHelp(e);
    return false;
  }
}
