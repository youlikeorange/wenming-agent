/** lib/agent/tools/screen.js —— 屏幕操作插件（看屏幕 + 键鼠，X11）
 *
 *  组成：
 *    · 截图：ImageMagick 的 `import -window root`（本机已装；不需要 sudo）；
 *    · 解析：OmniParser v2 本机服务（~/OmniParser/screen-service.sh start，
 *      默认 http://127.0.0.1:4183/parse，AGENT_OMNIPARSER_URL 可换）——
 *      icon_detect(YOLO) + easyocr(OCR) + icon_caption_florence(打标) →
 *      结构化元素清单（类型/文本/像素坐标），模型据此决定点哪里、输什么；
 *    · 动作：xdotool（mousemove/click/type/key）。**X11 专用**——Wayland 下
 *      xdotool 不工作，工具会如实报错（本站宿主机是 X11）。
 *
 *  语义（产品定的）：
 *    · screen_see = "看"：截图 → 解析 → 返回按阅读顺序排好的元素清单（坐标是屏幕像素，
 *      可直接喂给 screen_click）；不落盘原图（截屏即隐私，用完即删）；args.deliver=true
 *      时把标注图放进「待下载」给用户看。
 *    · screen_click / screen_type / screen_key = "动"：操作的是用户的**真实桌面**，
 *      只有面板开关（plugin_screen_on，默认关）这一道闸——开关本身就是用户明示授权。
 *      敏感操作（删除、提交、付款）由提示词约束模型先问用户。
 *
 *  安全：
 *    · spawn 一律数组式（不经 shell），键名/坐标/文本都先白名单校验；
 *    · OmniParser 服务只允许 127.0.0.1（URL 来自服务端环境变量，模型传不进来）；
 *    · 动作类三个工具在 core 里是 CONFIRM_SEQUENTIAL（串行），两只手不会同时操作一个桌面。
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

/** OmniParser 本机服务（只允许 localhost，出 URL 的是服务端运维不是模型）。
 *  调用时读环境变量（不是 require 时）：单测/部署都能按进程覆写。 */
const parserUrl = () => process.env.AGENT_OMNIPARSER_URL || 'http://127.0.0.1:4183/parse';
const PARSE_TIMEOUT_MS = 60e3;      // GPU 首帧/大图也可能几秒，给足
const MAX_TEXT = 2000;              // screen_type 一次输入的上限
const MAX_ELEMENTS = 200;           // 清单最多列多少条（正常屏幕 <150）

/* ============================ X11 显示环境 ============================ */

/** 找到可用的 DISPLAY / XAUTHORITY（站点进程就是桌面用户本人；su 不参与——
 *  屏幕操作绑定的是"物理桌面会话"，与绑定哪个系统账号无关）。 */
function displayEnv() {
  const display = process.env.DISPLAY
    || (() => {
      try { return ':' + fs.readdirSync('/tmp/.X11-unix')[0].slice(1); } catch { return ''; }
    })();
  if (!display) return null;
  const uid = process.getuid();
  const candidates = [
    process.env.XAUTHORITY,
    `/run/user/${uid}/gdm/Xauthority`,       // GDM 会话（本机实测的形状）
    path.join(os.homedir(), '.Xauthority'),
  ].filter(Boolean);
  const xauth = candidates.find((p) => { try { return fs.statSync(p).size > 0; } catch { return false; } });
  return { DISPLAY: display, ...(xauth ? { XAUTHORITY: xauth } : {}) };
}

/** 数组式 spawn（不经 shell），收集 stdout/stderr/退出码 */
function run(cmd, args, env) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ code: -1, out: '', err: e.message }); }
    let out = '', err = '';
    child.stdout.on('data', (b) => { if (out.length < 4096) out += b.toString('utf8'); });
    child.stderr.on('data', (b) => { if (err.length < 4096) err += b.toString('utf8'); });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, 30e3);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: err + e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

/** 截一张全屏到 pngPath（X11 root 窗口）。失败时给人话（常见：Wayland / 没有显示）。 */
async function capture(pngPath) {
  const env = displayEnv();
  if (!env) {
    throw Object.assign(new Error('没找到 X 显示（DISPLAY）：这看的是**本机桌面**，站点所在机器需要有图形会话（X11）。'),
      { status: 400 });
  }
  const r = await run('import', ['-window', 'root', '-display', env.DISPLAY, pngPath], env);
  if (r.code !== 0 || !fs.existsSync(pngPath)) {
    throw Object.assign(new Error(`截屏失败：${(r.err || r.out || '').trim().slice(0, 200)}。`
      + '若系统是 Wayland，import/xdotool 都不工作——本插件目前只支持 X11。'), { status: 500 });
  }
  return env;
}

/** 调 OmniParser 服务解析一张图。服务没起 → 给出启动方法。 */
function parseImage(pngPath) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ image: fs.readFileSync(pngPath).toString('base64') });
    const PARSER_URL = parserUrl();
    const url = new URL(PARSER_URL);
    if (!/^127\.|^\[::1\]|^localhost$/.test(url.hostname)) {
      return reject(Object.assign(new Error(`OmniParser 服务地址必须是本机（127.0.0.1），当前配置：${url.hostname}`), { status: 500 }));
    }
    const req = http.request({
      hostname: url.hostname, port: url.port || 80, path: url.pathname + (url.search || ''),
      method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: PARSE_TIMEOUT_MS,
    }, (res) => {
      let raw = '';
      res.on('data', (b) => { if (raw.length < 64e6) raw += b; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { reject(Object.assign(new Error('OmniParser 服务返回不是 JSON'), { status: 500 })); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('OmniParser 服务超时（60 秒）')); });
    req.on('error', (e) => {
      reject(Object.assign(new Error(`连不上 OmniParser 本机服务（${PARSER_URL}）：${e.message}。`
        + `请先在宿主机上启动它：bash ~/OmniParser/screen-service.sh start（启动后约 20-40 秒加载模型）。`), { status: 502 }));
    });
    req.end(body);
  });
}

/* ============================ 参数校验（白名单） ============================ */

const intArg = (v, lo, hi) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
};
/** xdotool 键名令牌：ctrl/alt/shift/super、字母数字、F1-F24、Return/space/Tab/方向键…… */
const KEY_TOKEN_RE = /^[A-Za-z0-9_]+(\+[A-Za-z0-9_]+)*$/;

/* ============================ 四个工具 ============================ */

/** screen_see：截图 → 解析 → 元素清单（模型"看"屏幕的唯一入口） */
async function screenSee(actor, args) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-screen-'));
  const shot = path.join(tmp, 'screen.png');
  try {
    await capture(shot);
    const parsed = await parseImage(shot);
    if (!parsed.ok) throw Object.assign(new Error('解析失败：' + (parsed.error || '未知')), { status: 502 });
    const els = parsed.elements || [];
    const lines = els.slice(0, MAX_ELEMENTS).map((el) =>
      `[${el.index}] ${el.type === 'icon' ? '控件' : '文本'} "${(el.text || '').slice(0, 80)}" @(${el.center[0]},${el.center[1]}) 框[${Math.round(el.bbox[0])},${Math.round(el.bbox[1])},${Math.round(el.bbox[2])},${Math.round(el.bbox[3])}]`);
    let out = `屏幕 ${parsed.width}×${parsed.height}，共 ${els.length} 个元素（按阅读顺序；坐标是屏幕像素，screen_click 直接用 center）：\n`
      + lines.join('\n');
    if (els.length > MAX_ELEMENTS) out += `\n（超过 ${MAX_ELEMENTS} 条只列前 ${MAX_ELEMENTS} 条）`;
    out += '\n点之前先看清要点的元素；点完/输完用 screen_see 再看一眼结果。';
    const result = { ok: true, note: `${els.length} 元素`, ms: parsed.ms, text: out };
    /* 标注图（可选交付）：模型要用户"亲眼看到屏幕"时用 */
    if (args && args.deliver === true && parsed.annotated) {
      const fsMod = require('../files');   // 待下载目录（deliver 同款）
      const annPath = path.join(tmp, 'annotated.png');
      fs.writeFileSync(annPath, Buffer.from(parsed.annotated, 'base64'));
      const pub = await fsMod.publish(actor.account, annPath);
      if (pub) {
        result.files = [{ name: pub.name || 'screen.png', size: pub.size, exec: false, packaged: false, source: annPath }];
      }
    }
    return result;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });   // 截屏即隐私：用完即删
  }
}

/** screen_click：在屏幕像素坐标上点击（左/右/双击） */
async function screenClick(actor, args) {
  const x = intArg(args && args.x, 0, 32767);
  const y = intArg(args && args.y, 0, 32767);
  if (x == null || y == null) throw Object.assign(new Error('需要屏幕像素坐标 x、y（screen_see 的 center）'), { status: 400 });
  const env = displayEnv();
  if (!env) throw Object.assign(new Error('没找到 X 显示（DISPLAY）'), { status: 400 });
  const button = args && args.right === true ? 3 : 1;
  let r = await run('xdotool', ['mousemove', '--sync', String(x), String(y)], env);
  if (r.code !== 0) throw Object.assign(new Error('移动鼠标失败：' + (r.err || '').trim().slice(0, 160)), { status: 500 });
  r = (args && args.double === true)
    ? await run('xdotool', ['click', '--repeat', '2', '--delay', '100', String(button)], env)
    : await run('xdotool', ['click', String(button)], env);
  if (r.code !== 0) throw Object.assign(new Error('点击失败：' + (r.err || '').trim().slice(0, 160)), { status: 500 });
  return { ok: true, note: '已点击', text: `已在 (${x},${y}) ${args && args.double === true ? '双击' : '点击'}${args && args.right === true ? '（右键）' : ''}。用 screen_see 看看结果。` };
}

/** screen_type：向当前聚焦的窗口输入文本（可选先全选清空） */
async function screenType(actor, args) {
  const text = String((args && args.text) || '');
  if (!text) throw Object.assign(new Error('需要 text：要输入的内容'), { status: 400 });
  if (text.length > MAX_TEXT) throw Object.assign(new Error(`text 过长（${text.length} > ${MAX_TEXT}），分几次输入`), { status: 400 });
  const env = displayEnv();
  if (!env) throw Object.assign(new Error('没找到 X 显示（DISPLAY）'), { status: 400 });
  if (args && args.clear === true) {
    await run('xdotool', ['key', '--clearmodifiers', 'ctrl+a'], env);
    await run('xdotool', ['key', '--clearmodifiers', 'Delete'], env);
  }
  const r = await run('xdotool', ['type', '--delay', '25', '--', text], env);
  if (r.code !== 0) throw Object.assign(new Error('输入失败：' + (r.err || '').trim().slice(0, 160)), { status: 500 });
  return { ok: true, note: '已输入', text: `已输入 ${text.length} 个字符到当前聚焦的窗口。用 screen_see 看看结果。` };
}

/** screen_key：发按键/组合键（如 ctrl+c、Return、alt+F4） */
async function screenKey(actor, args) {
  const keys = String((args && args.keys) || '').trim();
  if (!keys || !KEY_TOKEN_RE.test(keys) || keys.length > 60) {
    throw Object.assign(new Error(`keys 非法："${keys.slice(0, 40)}"。示例：Return / space / ctrl+c / alt+F4（空格分隔连发多个键）`), { status: 400 });
  }
  const env = displayEnv();
  if (!env) throw Object.assign(new Error('没找到 X 显示（DISPLAY）'), { status: 400 });
  const r = await run('xdotool', ['key', '--clearmodifiers', ...keys.split(/\s+/)], env);
  if (r.code !== 0) throw Object.assign(new Error('按键失败：' + (r.err || '').trim().slice(0, 160)), { status: 500 });
  return { ok: true, note: '已按键', text: `已发送按键：${keys}。用 screen_see 看看结果。` };
}

module.exports = { screenSee, screenClick, screenType, screenKey, displayEnv, parseImage, KEY_TOKEN_RE };
