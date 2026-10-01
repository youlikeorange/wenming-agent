/** lib/http.js —— HTTP 公共工具：请求体读取（含 413）、JSON 响应、服务端错误脱敏
 *  依赖：无（独立小工具，可复用） */
const MAX_BODY = 8e6; // 8MB 上限（按**字节**计）—— 大多数接口够用；个别接口（聊天台的会话存储）另有更大的上限，见 readBody 的参数

/** 读取请求体为字符串；超限时以 413 错误拒绝（不再直接掐断连接，审计项⑭）。
 *
 *  ⚠ 必须先收 Buffer、最后一次性 toString('utf8')，**不能** `data += chunk`：
 *  chunk 是 socket 读出来的原始字节，按 chunk 各自解码时，被切断的多字节字符
 *  （中文 3 字节、emoji 4 字节）会在两个 chunk 里各留一个 U+FFFD —— 实测一篇
 *  300KB 中文文档经 /api/save 落盘后会多出 6 个 U+FFFD（正好一个 chunk 边界一个），
 *  2026-09-20 审计发现线上 05/07/08/11 四篇文档已被此 bug 写坏 161 处。
 *  改用 StringDecoder 亦可，Buffer.concat 语义最直白。
 *  上限同样按字节判：按字符判会让中文的实际上限放宽到 3 倍。
 *
 *  maxBytes 可调（2026-09-20）：不限死一个数——聊天台的会话存储自带 32MB 配额
 *  （lib/agent/store.js 的 MAX_SESSION_BYTES），却卡在 8MB 的传输上限上，
 *  于是"存的进去"的会话永远存不进去（历史一大就 413）。调用方按自己的契约传上限，
 *  两边口径一致；缺省仍是全局的 8MB。 */
function readBody(req, maxBytes) {
  const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : MAX_BODY;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      if (tooBig) return; // 已判定超限：继续排空，等待 413 响应送出
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
      chunks.push(buf);
      size += buf.length;
      if (size > cap) {
        tooBig = true;
        chunks.length = 0;
        const err = new Error(`请求体过大（上限 ${Math.round(cap / 1024 / 1024)}MB）`);
        err.status = 413;
        reject(err);
      }
    });
    req.on('end', () => { if (!tooBig) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', (e) => { if (!tooBig) reject(e); });
  });
}

/** 读取请求体为**原始字节**（二进制上传：图片不能按 utf8 解，见 readBody 的说明）。
 *  与 readBody 同一套上限判定，只是不 toString。 */
function readBodyBuffer(req, maxBytes) {
  const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : MAX_BODY;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      if (tooBig) return;
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
      chunks.push(buf);
      size += buf.length;
      if (size > cap) {
        tooBig = true;
        chunks.length = 0;
        reject(Object.assign(new Error(`请求体过大（上限 ${Math.round(cap / 1024 / 1024)}MB）`), { status: 413 }));
      }
    });
    req.on('end', () => { if (!tooBig) resolve(Buffer.concat(chunks)); });
    req.on('error', (e) => { if (!tooBig) reject(e); });
  });
}

/** 统一 JSON 响应 */
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

/** 读取请求体并解析 JSON，统一处理 400/413（maxBytes 见 readBody 的说明） */
async function readJson(req, maxBytes) {
  let body;
  try {
    body = await readBody(req, maxBytes);
  } catch (e) {
    if (e && e.status === 413) throw Object.assign(new Error(e.message), { status: 413 });
    throw Object.assign(new Error('bad json'), { status: 400 });
  }
  try {
    return JSON.parse(body);
  } catch {
    throw Object.assign(new Error('bad json'), { status: 400 });
  }
}

/** 服务端错误统一出口：完整错误只进日志，客户端只见通用信息（审计项⑬：不泄露内部路径/细节） */
function serverError(res, e) {
  console.error('[server]', e);
  return json(res, 500, { error: '服务器内部错误，请稍后重试' });
}

module.exports = { readBody, readBodyBuffer, json, readJson, serverError };
