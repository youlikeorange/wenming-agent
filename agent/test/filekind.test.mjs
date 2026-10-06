/* filekind.test.mjs —— 会话文件卡片的内联预览分类
 *
 *  两条关键约定：
 *   ① 前端 ui/lib/filekind.js 与服务端 lib/agent/files.js 的 INLINE_MIME 白名单**必须一致**：
 *      服务端决定 Content-Disposition: inline，前端决定画不画 <img>/<video>/<audio> 预览；
 *      表对不上 = "画了预览却 attachment"（破图）或"能预览却只给下载"。两边逐扩展名比对。
 *   ② 只收"浏览器不装插件就能显示/播"的类型；mov/mkv/avi/pdf 之类编码没保证的**故意不收**
 *      （预览失败比没有预览更糟），这条口径要用测试钉住，防止顺手加回去。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileKind } from '../src/ui/lib/filekind.js';

const require = createRequire(import.meta.url);
const serverFiles = require('../../lib/agent/files.js');

/* 服务端白名单的每个扩展名 → 前端必须分出类型（两边都有才算一致） */
const SERVER_EXTS = Object.keys(serverFiles.INLINE_MIME);
/* 刻意不收的类型（pdf 走下载卡片；mov/mkv/avi 编码没保证；zip/文档本来就不能播） */
const NEVER_INLINE = ['zip', 'exe', 'html', 'htm', 'txt', 'md', 'json', 'csv', 'pdf', 'mov', 'mkv', 'avi', 'flv', 'docx', ''];

test('★ 前端 fileKind 与服务端 INLINE_MIME 白名单逐扩展名一致', () => {
  for (const ext of SERVER_EXTS) {
    assert.notEqual(fileKind(`文件名.${ext}`), null, `服务端白名单里有 .${ext}（${serverFiles.INLINE_MIME[ext]}），前端却不给预览`);
  }
  /* 反向：前端认的每个扩展名，服务端也要给 inline MIME */
  const frontAll = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg', 'mp4', 'webm', 'ogv',
    'mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac', 'opus'];
  for (const ext of frontAll) {
    assert.ok(serverFiles.inlineMimeOf(`文件名.${ext}`), `前端给 .${ext} 预览，服务端却不认（会 attachment → 破图）`);
  }
  assert.deepEqual(new Set(SERVER_EXTS), new Set(frontAll), '两边的扩展名集合应完全相等');
});

test('分类正确：image / video / audio / null，后缀大小写不敏感', () => {
  assert.equal(fileKind('截图.png'), 'image');
  assert.equal(fileKind('photo.JPG'), 'image');
  assert.equal(fileKind('图.svg'), 'image');
  assert.equal(fileKind('demo.mp4'), 'video');
  assert.equal(fileKind('demo.WEBM'), 'video');
  assert.equal(fileKind('录音.mp3'), 'audio');
  assert.equal(fileKind('voice.M4A'), 'audio');
  for (const ext of NEVER_INLINE) {
    assert.equal(fileKind(`名字.${ext}`), null, `.${ext} 不该给预览`);
  }
  assert.equal(fileKind('README'), null, '无后缀不给预览');
  assert.equal(fileKind(''), null);
  assert.equal(fileKind(null), null);
});

test('打包产物（exec/packaged）的判断在前端组件里先于 fileKind——白名单不含 zip 兜底', () => {
  /* 组件里 (f.exec || f.packaged) 时不看 fileKind；这里只兜"zip 后缀永不预览" */
  assert.equal(fileKind('交付物.zip'), null);
  assert.equal(fileKind('run.sh.zip'), null);
});
