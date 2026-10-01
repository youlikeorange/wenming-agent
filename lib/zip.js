/** lib/zip.js —— 最小 ZIP 打包器（零依赖，只用 Node 内置 zlib）
 *
 *  为什么手写：本站服务器是**零依赖**的（仓库根没有 package.json，server.js 只用
 *  Node 内置模块）。为了"导出文件夹"这一个功能引入 archiver/jszip 会打破这条约定，
 *  而 ZIP 的骨架（本地文件头 + 中央目录 + 结束记录）本身很短，用 zlib.deflateRawSync
 *  就能拼出来。参考规范：PKWARE APPNOTE.TXT（4.3.7 本地头 / 4.3.12 中央目录 / 4.3.16 EOCD）。
 *
 *  取舍：
 *  - 整包在内存里拼（`buildZip` 返回 Buffer）。文档站是 md 为主的小文件，
 *    一个目录通常几 MB；改成流式要处理"中央目录必须写在数据之后"的回溯，
 *    复杂度不划算。目录特别大时（>100MB）再做流式。
 *  - 不写 Zip64：单文件与总大小都按 32 位记录。超过 4GB 会静默截断是危险的，
 *    所以**显式拒绝**超大输入（见 MAX_TOTAL / MAX_FILE），宁可报错也不产坏包。
 *  - 用 deflate（level 6，与 zip 默认一致）；压不小就退回 store（method 0），
 *    避免为已压缩内容（png/jpg/mp4）白花 CPU。
 *  - 目录项不单独建条目（现代解压工具会按路径自动建目录）；中文/空格路径靠
 *    通用位标记 bit 11（UTF-8 名称）声明。 */
const zlib = require('zlib');

/** 单个文件与整包上限：超过就没法用 32 位字段表达，宁可报错 */
const MAX_FILE = 0xFFFFFFFF;
const MAX_TOTAL = 0xFFFFFFFF;

/** CRC-32（IEEE 802.3，即 PKZIP 用的那张表）。查表法，表在模块加载时建一次。 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** DOS 时间/日期（ZIP 用的老式时间戳，精度 2 秒；用本地时间，与 zip 命令一致） */
function dosDateTime(d = new Date()) {
  const time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((d.getSeconds() / 2) & 0x1F);
  const date = (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
  return { time: time & 0xFFFF, date: date & 0xFFFF };
}

/** 把已压缩数据组装成 buffer 拼接器（避免反复 concat 产生 O(n²) 拷贝） */
function concat(parts) {
  return Buffer.concat(parts);
}

/**
 * 打包一个 ZIP。
 * @param {Array<{name: string, data: Buffer, mtime?: Date}>} entries
 *        条目路径用 `/` 分隔（相对路径，不含前导斜杠）；目录层级由路径自带。
 * @returns {Buffer}
 */
function buildZip(entries) {
  if (!Array.isArray(entries) || !entries.length) {
    // 空包也要能开：给一个占位说明，否则解压工具看到"零条目"容易报错
    entries = [{ name: '（此文件夹为空）.txt', data: Buffer.from('此文件夹没有可导出的内容。\n', 'utf8') }];
  }
  const locals = [];   // 本地文件头 + 数据
  const centrals = []; // 中央目录记录
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(String(e.name), 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ''), 'utf8');
    if (data.length > MAX_FILE) throw new Error(`文件过大，无法打包：${e.name}`);

    const crc = crc32(data);
    // 压得动就压；已压缩格式（png/jpg/mp4）deflate 后更大，直接 store
    let method = 8;
    let body = zlib.deflateRawSync(data, { level: 6 });
    if (body.length >= data.length) { method = 0; body = data; }

    const { time, date } = dosDateTime(e.mtime instanceof Date ? e.mtime : new Date());
    // 通用位：bit 11 = 文件名是 UTF-8（中文目录名必须置位，否则 Windows 解压乱码）
    const flags = 0x0800;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);        // 本地文件头签名 "PK\3\4"
    lh.writeUInt16LE(20, 4);                // 解压所需版本 2.0
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);      // 压缩后大小
    lh.writeUInt32LE(data.length, 22);      // 原始大小
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);                // 扩展字段长度

    locals.push(lh, nameBuf, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);        // 中央目录签名 "PK\1\2"
    ch.writeUInt16LE(20, 4);                // 创建版本
    ch.writeUInt16LE(20, 6);                // 解压所需版本
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);                // 扩展字段
    ch.writeUInt16LE(0, 32);                // 注释
    ch.writeUInt16LE(0, 34);                // 磁盘号
    ch.writeUInt16LE(0, 36);                // 内部属性
    ch.writeUInt32LE(0, 38);                // 外部属性
    ch.writeUInt32LE(offset, 42);           // 本地头偏移
    centrals.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + body.length;
    if (offset > MAX_TOTAL) throw new Error('导出内容超过 4GB，暂不支持（需要 Zip64）');
  }

  const centralBuf = concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);        // EOCD 签名 "PK\5\6"
  eocd.writeUInt16LE(0, 4);                 // 本磁盘号
  eocd.writeUInt16LE(0, 6);                 // 中央目录起始磁盘
  eocd.writeUInt16LE(entries.length, 8);    // 本磁盘条目数
  eocd.writeUInt16LE(entries.length, 10);   // 总条目数
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);           // 中央目录偏移
  eocd.writeUInt16LE(0, 20);                // 注释长度

  return concat([concat(locals), centralBuf, eocd]);
}

module.exports = { buildZip, crc32 };
