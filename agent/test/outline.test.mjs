/* SessionOutline（会话大纲）回归：
 *  · outlineLabel —— 提问 → 标题的纯函数（剥 Markdown 记号、跳过代码围栏、按码点截断）；
 *  · 组件渲染 —— 用 react-dom/server 真渲一遍：桌面轨有几条可点的横线、标题是否截断、
 *    只有一条提问时不出大纲、手机上换成浮标（导轨收起）；顺带守住 Message 的 data-mi 锚点
 *    （跳转就是靠它在 DOM 里找目标）与手机列表的每行原文。
 *
 *  为什么来这一档而不是源码文本断言：大纲的契约是"每条提问一条线 / 一行 + 标题 = 那句提问"，
 *  这是**渲染结果**（条数与文字都由 history 现算），断言源码看不出漏算/多算（见 regression.test.mjs 头注）。
 *  ui/state/* 的依赖链里有 .jsx（toast 组件），Node 默认不认，所以先装 esbuild 就地加载器
 *  （与 hosted-run.test.mjs 同一套做法）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import { outlineLabel } from '../src/ui/lib/format.js';

registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('.jsx')) return nextLoad(url, context);
    const code = transformSync(readFileSync(fileURLToPath(url), 'utf8'), {
      loader: 'jsx', format: 'esm', jsx: 'automatic', target: 'esnext', sourcefile: url,
    }).code;
    return { format: 'module', source: code, shortCircuit: true };
  },
});

/* 组件模块在求值期就要 window/document（useMedia 的 matchMedia 探测）。
   phone 开关让同一份用例既能渲桌面轨、也能渲手机浮标（useMedia 只读 matches）。 */
let phoneView = false;
globalThis.document = {
  documentElement: { setAttribute: () => {} }, addEventListener: () => {}, visibilityState: 'visible',
};
globalThis.window = {
  matchMedia: () => ({ matches: phoneView, addEventListener: () => {}, removeEventListener: () => {} }),
  addEventListener: () => {}, removeEventListener: () => {},
};

const { renderToStaticMarkup } = await import('react-dom/server');
const React = await import('react');
const { patch } = await import('../src/ui/state/store.js');
const { default: SessionOutline, OutlineList, buildItems } = await import('../src/ui/features/SessionOutline.jsx');
const { default: Message } = await import('../src/ui/features/Message.jsx');

/** 把 history 灌进真 store（组件读的就是它）再渲一遍；asPhone=1 时按手机布局渲 */
async function renderOutline(history, asPhone = false) {
  patch({ history });
  phoneView = asPhone;
  await new Promise((r) => setTimeout(r, 0));      // 等 store 的微任务快照
  const html = renderToStaticMarkup(React.createElement(SessionOutline, { scrollRef: { current: null } }));
  phoneView = false;
  return html;
}
const lineCount = (html) => (html.match(/aria-label="跳到第/g) || []).length;
const u = (id, content) => ({ id, role: 'user', content });
const a = (id, content) => ({ id, role: 'assistant', content });

test('outlineLabel：取第一条有效行、剥掉 Markdown 记号', () => {
  assert.equal(outlineLabel('帮我看一下这个项目'), '帮我看一下这个项目');
  assert.equal(outlineLabel('# 标题\n正文第一段'), '标题');
  assert.equal(outlineLabel('- 第一步\n- 第二步'), '第一步');
  assert.equal(outlineLabel('1. 先跑测试'), '先跑测试');
  assert.equal(outlineLabel('> 引用一句'), '引用一句');
  assert.equal(outlineLabel('看 `src/ui` 里的 **大纲** 文件'), '看 src/ui 里的 大纲 文件');
  assert.equal(outlineLabel('[文档](https://example.dev/a) 说了什么'), '文档 说了什么');
  assert.equal(outlineLabel('\n\n   \n第一行有内容\n第二行'), '第一行有内容');
});

test('outlineLabel：代码围栏跳过去、纯数字/下划线不误伤', () => {
  assert.equal(outlineLabel('```bash\nnpm test\n```'), 'npm test');
  assert.equal(outlineLabel('2026 年的计划是什么'), '2026 年的计划是什么');
  assert.equal(outlineLabel('foo_bar 这个名字'), 'foo_bar 这个名字');
  assert.equal(outlineLabel('   \n  '), '');
  assert.equal(outlineLabel(undefined), '');
});

test('outlineLabel：超长按码点截断（不劈开 emoji）', () => {
  assert.equal(outlineLabel('啊'.repeat(80)), '啊'.repeat(60) + '…');
  const emoji = outlineLabel('🙂'.repeat(70));
  assert.equal(emoji, '🙂'.repeat(60) + '…');
  assert.equal([...emoji].length, 61);
  assert.equal(outlineLabel('短句不动它'), '短句不动它');
});

test('渲染：每个提问一条横线，顺序与标题都对', async () => {
  const html = await renderOutline([
    u('u1', '第一个问题'), a('a1', '答案'), u('u2', '# 第二个问题\n正文'),
    a('a2', '答案'), u('u3', '- 第三个问题'),
  ]);
  assert.equal(lineCount(html), 3);
  assert.match(html, /aria-label="跳到第 1 个提问：第一个问题"/);
  assert.match(html, /aria-label="跳到第 2 个提问：第二个问题"/);   // Markdown 记号不进标题
  assert.match(html, /aria-label="跳到第 3 个提问：第三个问题"/);
  assert.ok(html.indexOf('第 1 个提问') < html.indexOf('第 3 个提问'));   // 顺序 = 会话先后
  assert.equal((html.match(/aria-current="true"/g) || []).length, 1);   // 当前段只高亮一条
});

test('渲染：只有一条提问时不出大纲，助手消息也不占线', async () => {
  assert.equal(await renderOutline([u('u1', '独苗问题'), a('a1', '回答')]), '');
  assert.equal(await renderOutline([]), '');
  assert.equal(await renderOutline([a('a1', '# 助手的小标题'), a('a2', '再来一条')]), '');
});

test('渲染：超长提问在卡片里截断成 60 字 + 省略号', async () => {
  const html = await renderOutline([u('u1', '长'.repeat(120)), u('u2', '短问题'), a('a1', '答案')]);
  assert.match(html, /长{60}…/);
  assert.ok(!html.includes('长'.repeat(61)), '卡片里不该出现第 61 个字');
});

test('锚点：Message 把 data-mi 写在消息根节点上（大纲靠它找目标）', () => {
  const one = (msg, index) => renderToStaticMarkup(React.createElement(Message, { msg, index }));
  assert.match(one(u('u1', '提问'), 4), /^<div class="group\/msg[^"]*" data-mi="4"/);
  assert.match(one(a('a1', '回答'), 5), /^<div class="group\/msg[^"]*" data-mi="5"/);
});

test('手机：导轨换成左下角浮标（同一条会话两种布局）', async () => {
  const hist = [u('u1', '第一个问题'), a('a1', '答案'), u('u2', '第二个问题'), a('a2', '答案')];
  const desk = await renderOutline(hist);
  assert.match(desk, /data-ol-rail/);
  assert.ok(!desk.includes('data-ol-fab'), '桌面不出浮标');

  const mob = await renderOutline(hist, true);
  assert.match(mob, /data-ol-fab/);
  assert.ok(!mob.includes('data-ol-rail'), '手机上不出右侧导轨（触屏没有 hover，横线看不懂也点不准）');
  assert.match(mob, /aria-label="会话大纲：共 2 轮提问，当前第 1 轮，点开选择"/);
  assert.match(mob, />1\/2</, '浮标上写着"读到第几轮"');
  assert.equal(lineCount(mob), 0, '手机上不该有那些 12px 的小横线');
  assert.equal(await renderOutline([u('u1', '独苗问题')], true), '', '手机上同样≥2 条提问才出');
});

test('手机列表：一条提问一行原文，当前那条带 aria-current（列表只渲一份，不偷懒画成一行）', () => {
  const items = buildItems([
    u('u1', '第一个问题'), a('a1', '答案'), u('u2', '# 第二个问题\n正文'),
    a('a2', '答案'), u('u3', '- 第三个问题'),
  ]);
  assert.deepEqual(items.map((x) => [x.mi, x.n, x.label]),
    [[0, 1, '第一个问题'], [2, 2, '第二个问题'], [4, 3, '第三个问题']]);

  const html = renderToStaticMarkup(React.createElement(OutlineList, { items, cur: 1, onJump: () => {} }));
  assert.equal((html.match(/data-ol-row/g) || []).length, 3, '三行');
  assert.match(html, /aria-label="跳到第 2 个提问：第二个问题"/);
  const rows = html.split('data-ol-row').slice(1);
  assert.deepEqual(rows.map((r) => r.includes('aria-current="true"')), [false, true, false], '只有当前那条高亮');
});

test('buildItems：只认提问、空标签跳过（代码块提问不占一行）', () => {
  assert.deepEqual(buildItems([]), []);
  assert.deepEqual(buildItems([a('a1', '助手的话')]), []);
  assert.deepEqual(buildItems([u('u1', '   \n  '), u('u2', '有内容')]).map((x) => x.n), [1]);
  assert.equal(buildItems([u('u1', '有内容')])[0].mi, 0, 'mi 是它在 history 里的下标（跳转锚点）');
});
