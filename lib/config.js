/** lib/config.js —— 全局配置与常量（无内部依赖，最先加载）
 *  参照 Node.js CommonJS 规范：https://nodejs.org/api/modules.html（一文件一模块） */
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const WEB_ROOT = __dirname + '/..';
const PUBLIC_ROOT = path.join(WEB_ROOT, 'public');

// 文档根目录：项目自「文明论研究/web」迁入 Htmlweb 后，md 文档仍留在原处，默认指向该目录；
// 可用环境变量 DOC_ROOT 指向任意 md 文件夹
const DOC_ROOT = path.resolve(process.env.DOC_ROOT || '/media/leo/DATA/workspace/文明论研究');

// 目录树扫描时跳过的目录：只跳过依赖目录；原实现硬编码跳过名为 web 的目录，
// 会误伤用户自建的同名文件夹（审计项⑰）
const SKIP_DIRS = new Set(['node_modules']);

// 状态文件（密码哈希/会话令牌/配额账本/审计日志）放 STATE_DIR：默认 ~/.local/share/wenming-web。
// 原因：项目在 NTFS(fuseblk) 数据盘上，POSIX chmod 不生效、0600 无法强制（审计项②；
// 依据 OWASP Secrets/Session Management：凭证与会话须以最小权限存储）。可用 STATE_DIR 覆盖。
const STATE_DIR = path.resolve(process.env.STATE_DIR || path.join(os.homedir(), '.local', 'share', 'wenming-web'));

const SESSION_COOKIE = 'wm_session';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.ogg': 'application/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
};

// 允许经 /files/ 对外提供的媒体扩展名（文档里引用图片/视频/音频用）。
// 注意：svg 虽在 MIME 表内，但上传与对外提供均排除（内联脚本的存储型 XSS 通道，OWASP File Upload）
const MEDIA_EXT = new Set(Object.keys(MIME).filter((e) =>
  ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.mp4', '.webm', '.mov', '.m4v', '.ogg', '.mp3', '.m4a', '.wav'].includes(e)
));
// 扩展名 → 内容家族（魔数校验用，参照 OWASP File Upload：内容与扩展名必须一致）
const MEDIA_FAMILY = {
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image',
  '.webp': 'image', '.avif': 'image', '.bmp': 'image',
  '.mp4': 'video', '.webm': 'video', '.mov': 'video', '.m4v': 'video',
  '.mp3': 'audio', '.m4a': 'audio', '.wav': 'audio', '.ogg': 'audio',
};

module.exports = {
  PORT, HOST, WEB_ROOT, PUBLIC_ROOT, DOC_ROOT, STATE_DIR, SKIP_DIRS, SESSION_COOKIE,
  MIME, MEDIA_EXT, MEDIA_FAMILY,
};
