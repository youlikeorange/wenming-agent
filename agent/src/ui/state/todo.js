/* ui/state/todo.js —— 任务清单（右上角浮层）的状态与取数
 *
 *  数据有两个来源，都不由界面算：
 *    ① 运行中的工具结果：`tool_end` 事件里的 `todo` 字段（agent 刚写完/更新完，实时）；
 *    ② `GET /agent/todo?sessionId=`：刷新、切会话、换窗口时的真源（服务端账号目录里一份）。
 *  `todo: null` 是**有意义的取值**（agent 全完成/清空 → 清单已丢弃，浮层要收掉），
 *  与"这次调用与清单无关"（字段缺席）不同——所以判空一律用 `=== null` / `!== undefined`。
 */
import { state, patch } from './store.js';
import { get } from '../../core/http.js';
import { EP } from '../../core/endpoints.js';

const cur = () => state.todo;
const put = (over) => patch({ todo: Object.assign({}, cur(), over) });

/** 浮层的折叠开关（界面状态，不落盘；刷新后默认展开） */
export function setTodoOpen(open) { put({ open: !!open }); }

/** 工具结果里的清单（事件流实时推来）。别的会话的事件不显示在当前画面上。 */
export function applyTodo(todo, sessionId) {
  const sid = String(sessionId || '');
  if (sid && state.activeSessId && sid !== state.activeSessId) return;
  put({ data: todo || null, sessionId: sid || cur().sessionId, loadedAt: Date.now() });
}

/** 拉当前会话的清单（刷新/切会话/换窗口）。拉不到就保持现状——清单不是关键路径。 */
export async function loadTodo(sessionId) {
  const sid = String(sessionId || '');
  if (!sid) { put({ data: null, sessionId: '', loadedAt: Date.now() }); return; }
  try {
    const d = await get(`${EP.todo}?sessionId=${encodeURIComponent(sid)}`, { timeoutMs: 15000 });
    if (state.activeSessId !== sid) return;        // 期间切走了：这次结果作废
    put({ data: (d && d.todo) || null, sessionId: sid, loadedAt: Date.now() });
  } catch { /* 保持现状 */ }
}
