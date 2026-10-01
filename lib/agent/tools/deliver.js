/** lib/agent/tools/deliver.js —— deliver_file：把文件放进用户的「待下载」目录
 *
 *  这是"传输文件"插件的落点：Agent 产出物在服务端，用户要能点一下拿到——文件先进
 *  `STATE_DIR/agent/<账号>/downloads/`（见 lib/agent/files.js），界面菜单与会话卡片都从那儿取。
 *
 *  与文件工具**同一套闸门**（roots 白名单 + 绑定账号的 POSIX 权限 + 解锁），
 *  因为它要读的正是用户磁盘上的文件：不给"传文件"开一条绕开权限的路。
 *  可执行文件由 files.publish 自动打包成 `<名>.zip`（用户拿到的永远是 zip）。
 */
const fsTools = require('./fs');
const files = require('../files');
const { kb } = require('../limits');

async function deliverFile(actor, args) {
  const target = String((args && args.path) || '').trim();
  if (!target) throw Object.assign(new Error('deliver_file 需要 path：要交给用户的那个文件的路径'), { status: 400 });
  /* 同一套判定：路径必须落在可访问目录内、绑定账号读得到、且已解锁 */
  const real = await fsTools.guard(actor, target, 'read');
  const out = await files.publish(actor.account, real, { name: args.name });
  const where = files.dirOf(actor.account);
  const text = `已放入待下载目录：${out.name}（${kb(out.size)}）`
    + (out.exec ? `\n原文件是可执行文件，已打包成 zip（用户拿到的就是这个 zip，不会拿到裸的可执行文件）。` : '')
    + `\n用户可以在「📥 待下载」菜单里看到并下载它；这条工具卡片上也有下载链接。`
    + `\n目录：${where}`;
  return {
    ok: true,
    note: out.exec ? '已打包并放入待下载' : '已放入待下载',
    text,
    /* files 会被内核原样带进追踪条（core/agent.js 的 asResult → run-loop 的 onToolEnd），
       界面据此画那张"文件卡片"。字段名与 lib/agent/files.js 的列表保持一致。 */
    files: [{
      name: out.name,
      size: out.size,
      exec: !!out.exec,
      packaged: !!out.packaged,
      source: real,
    }],
  };
}

module.exports = { deliverFile };
