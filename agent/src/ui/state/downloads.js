/* ui/state/downloads.js —— 「📥 待下载」目录的动作层（传输文件插件的前端一半）
 *
 *  每个账号在服务端有一个待下载目录（`lib/agent/files.js`）：模型用 `deliver_file` 把产出物放进去，
 *  这里负责把它拉给界面看、并把「下载」做成**普通链接**（`<a href download>`）——
 *  链接直连 `GET /agent/files/download?name=`，浏览器自己带 Cookie 下载，
 *  不经过任何 JS 中转（大文件也不占内存、断点续传交给浏览器）。
 *
 *  什么时候刷新：打开菜单时、以及服务端推来 `files_changed`（模型刚放进来一个文件）时。
 *  不做轮询：没变化就没请求。
 */
import { state, patch } from './store.js';
import { get, post } from '../../core/http.js';
import { EP } from '../../core/endpoints.js';
import { toast } from '../components/ui/toast.jsx';
import { hooks } from './host.js';

/** 下载链接（**这是唯一入口**：卡片与菜单都用它，形状一致） */
export const downloadUrl = (name) => `${EP.filesDownload}?name=${encodeURIComponent(String(name || ''))}`;

/** 内联预览链接（会话卡片里的 <img>/<video>/<audio> 引用这条）：
 *  同一端点加 inline=1，服务端只对白名单内的图片/音视频按 inline 发出（其余照旧 attachment），
 *  所以这条链接对任何文件都安全——不支持预览的类型点了就是普通下载。 */
export const inlineUrl = (name) => `${downloadUrl(name)}&inline=1`;

export async function loadDownloads() {
  patch({ downloads: Object.assign({}, state.downloads, { loading: true, error: '' }) });
  try {
    const d = await get(EP.files, { timeoutMs: 15000 });
    patch({
      downloads: Object.assign({}, state.downloads, {
        loading: false, error: '', dir: (d && d.dir) || '',
        entries: (d && Array.isArray(d.entries)) ? d.entries : [],
      }),
    });
    return true;
  } catch (e) {
    patch({ downloads: Object.assign({}, state.downloads, { loading: false, error: (e && e.message) || String(e) }) });
    return false;
  }
}

export function openDownloads() {
  patch({ downloads: Object.assign({}, state.downloads, { open: true }) });
  loadDownloads();
}

export function closeDownloads() {
  patch({ downloads: Object.assign({}, state.downloads, { open: false }) });
}

/** 删掉一个（待下载目录会越攒越多，菜单里能清） */
export async function removeDownload(name) {
  try {
    await post(EP.filesDelete, { name });
    toast(`已删除「${name}」`, 'ok');
    await loadDownloads();
    return true;
  } catch (e) {
    toast('删除失败：' + ((e && e.message) || e), 'err');
    return false;
  }
}

/** 服务端说"目录变了"（模型刚 deliver_file）：刷新列表（菜单没开也刷新——菜单上的计数要跟上） */
export function markChanged() {
  if (!state.info || !state.info.loggedIn) return;
  loadDownloads();
}

/* 接上宿主钩子：run.js 收到 files_changed 时回调这里（它不直接 import 本模块，避免成环） */
hooks.onFilesChanged = () => markChanged();
