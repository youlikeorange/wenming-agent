/* settings-normalize.test.mjs —— 参数写入的**归一化下沉**（2026-10-02）
 *
 *  背景：归一化原先只在控件层（features/settings/parts.jsx 的 ParamControl 提交前调
 *  normalizeValue），任何绕过控件的写入（预设重放、插话钩子、"以后不再问"、以后新增的
 *  直连调用）都会把越界/非法值原样写进 state 与服务端。现在下沉到 action（setParam）。
 *
 *  为什么真跑模块而不是文本断言"它调了 normalizeParam"：本项目吃过"119 项测试全绿、
 *  线上全坏"的亏——文本看不出接线对不对（见 hosted-run.test.mjs 头注）。
 *  ui/state/*.js 的依赖链里有 .jsx（toast 组件），Node 默认不认，所以这里照
 *  hosted-run.test.mjs 的做法装一个就地加载器并给最小 DOM 桩。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('.jsx')) return nextLoad(url, context);
    const code = transformSync(readFileSync(fileURLToPath(url), 'utf8'), {
      loader: 'jsx', format: 'esm', jsx: 'automatic', target: 'esnext', sourcefile: url,
    }).code;
    return { format: 'module', source: code, shortCircuit: true };
  },
});

globalThis.document = {
  documentElement: { setAttribute: () => {} },
  addEventListener: () => {},
  visibilityState: 'visible',
};
globalThis.window = { matchMedia: () => ({ matches: false }), addEventListener: () => {} };

test('setParam：越界/非法值在 action 里就被夹回（不依赖控件层）', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  try {
    const { state } = await import('../src/ui/state/store.js');
    const { setParam } = await import('../src/ui/state/settings.js');

    setParam('temperature', 1e9, '');                 // range 0~2：越界
    assert.equal(state.settings.params.temperature, 2, '温度夹到 schema 上限（不是原样 1e9）');

    setParam('plugin_fs_max', 'abc', '');             // number：非法数字
    assert.equal(state.settings.params.plugin_fs_max, '', '非法数字 → 空值（= 用上一层），不是 "abc"');

    setParam('exec_allow', 'ls -la\ngit status', ''); // list：旧的"换行字符串"形状
    assert.deepEqual(state.settings.params.exec_allow, ['ls -la', 'git status'],
      '命令允许清单收敛成数组（旧形状不被抹成空数组）');

    setParam('mem_inject', 'nope', '');               // select：非法选项
    assert.equal(state.settings.params.mem_inject, 'index', '非法选项回落出厂默认');

    setParam('plugin_fs_delete', 1, '');              // switch：真值转布尔
    assert.equal(state.settings.params.plugin_fs_delete, true, '开关值转布尔');

    setParam('not_a_real_param', { keep: 1 }, '');    // 未知键
    assert.deepEqual(state.settings.params.not_a_real_param, { keep: 1 },
      'schema 不认识的键原样保留（新旧版本之间不互相丢字段）');

    setParam('temperature', 0.2, 'p1::m1');           // 每模型覆盖走同一条归一化
    assert.equal(state.settings.paramsByModel['p1::m1'].temperature, 0.2, '每模型覆盖照常写入');
    setParam('temperature', 99, 'p1::m1');
    assert.equal(state.settings.paramsByModel['p1::m1'].temperature, 2, '每模型覆盖同样被夹回');
  } finally {
    globalThis.fetch = orig;
  }
});
