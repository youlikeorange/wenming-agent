/* ui/lib/filekind.js —— 会话文件卡片的内联预览分类（deliver_file 那张卡怎么画，看这里）
 *
 *  服务端把文件放进待下载目录后，卡片拿到的只有结构化字段（name/size/exec/packaged）。
 *  这份表按**扩展名**把「浏览器不装插件就能直接显示」的类型分出来：
 *    image → <img>（点击在新页看原图）
 *    video → <video controls>（可播放；preload="metadata" 会发 Range 请求，服务端支持）
 *    audio → <audio controls>
 *  其余类型（压缩包、文档、可执行打包出的 zip…）一律走普通下载行卡片。
 *
 *  ★ 这份表必须与 lib/agent/files.js 的 INLINE_MIME 白名单一致（agent/test/filekind.test.mjs
 *  会两边比对）——服务端决定 Content-Disposition，这里决定画不画预览；表对不上就会出现
 *  "画了预览却 attachment"（破图）或"能 inline 却只给下载"两种怪状。
 *
 *  刻意**不收** mov/mkv/avi/flv：容器合法不代表编码能播（H.264 之外的编码各浏览器各凭运气），
 *  预览失败比没有预览更糟，宁可给下载卡片。
 */

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'ogv']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac', 'opus']);

const extOf = (name) => {
  const n = String(name || '');
  const dot = n.lastIndexOf('.');
  return dot < 0 ? '' : n.slice(dot + 1).toLowerCase();
};

/** 'image' | 'video' | 'audio' | null（null = 只给下载卡片） */
export function fileKind(name) {
  const ext = extOf(name);
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  return null;
}
