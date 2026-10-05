/* core/params.js 单测（新写；旧聊天台没有对应单测文件）：
 *   · resolve() 三层覆盖：出厂默认 → 全局设置 → 每模型覆盖（空值 = 用上一层）；
 *   · toRequestParams() 的"默认值不下发"：扩展字段（top_k / seed / 频率惩罚…）默认不出现在请求参数里；
 *   · normalizeValue() / normalizeParam() 夹紧：range/number 越界夹回、非法值回落、switch/select/list 收敛、
 *     list 兼容旧字符串形状、lines/json 与未知键原样（归一化的唯一入口，前后端共用）；
 *   · parseExtraBody()：非法 JSON / 非对象一律返回 null；
 *   · ctxLimitOf() 的取值优先级，以及 TOOL_DEFAULTS 与 TOOL_FIELDS 的推导关系。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  FIELDS, TOOL_FIELDS, TOOL_DEFAULTS, PRESETS, GROUPS,
  resolve, modelKey, overriddenBy, normalizeValue, normalizeParam, normalizeParamBag,
  toStopList, toRequestParams, ctxLimitOf, parseExtraBody,
} from '../src/core/params.js';

test('resolve()：出厂默认（没有任何设置时逐项取 def）', () => {
  const p = resolve({}, 'p1', 'm1');
  assert.equal(p.temperature, 0.7, 'temperature 出厂默认 0.7');
  assert.equal(p.topP, 0.8, 'top_p 出厂默认 0.8');
  assert.equal(p.maxTokens, -1, 'max_tokens 出厂默认 -1（不下发）');
  assert.equal(p.reasoning, 'default', '推理强度默认 default（完全不下发）');
  assert.equal(p.ctxLimit, 1000000, '上下文上限默认 100 万（1M 级模型；本地小模型要在面板里按实际 -c 改）');
  assert.equal(p.tool_search_max, 3, '工具参数同样在参数表里：单轮检索 3');
  assert.equal(p.plugin_exec_max, 6, '单轮命令上限 6');
  assert.equal(p.mem_inject, 'index', '全局记忆默认只给索引');
  assert.deepEqual(p.exec_allow, [], '命令允许清单默认空');
});

test('resolve()：全局设置覆盖出厂默认', () => {
  const p = resolve({ params: { temperature: 0.3, plugin_exec_max: 9 } }, 'p1', 'm1');
  assert.equal(p.temperature, 0.3, 'settings.params.temperature 覆盖出厂值');
  assert.equal(p.plugin_exec_max, 9, '工具参数也能被全局设置覆盖');
  assert.equal(p.topP, 0.8, '没被改的键仍取出厂默认');
});

test('resolve()：每模型覆盖压过全局（换模型不用手改一串数字）', () => {
  const settings = {
    params: { temperature: 0.3 },
    paramsByModel: { 'p1::m1': { temperature: 1.2, topK: 40 } },
  };
  const m1 = resolve(settings, 'p1', 'm1');
  assert.equal(m1.temperature, 1.2, 'paramsByModel 里的值最优先');
  assert.equal(m1.topK, 40, '每模型覆盖同样能改扩展字段');
  const m2 = resolve(settings, 'p1', 'm2');
  assert.equal(m2.temperature, 0.3, '别的模型不受这份覆盖影响（仍用全局值）');
});

test('resolve()：空值（空串） = 用上一层，不是"设为空"', () => {
  const settings = { params: { temperature: '' }, paramsByModel: { 'p1::m1': { topP: '' } } };
  const p = resolve(settings, 'p1', 'm1');
  assert.equal(p.temperature, 0.7, '全局里的空串回落到出厂默认');
  assert.equal(p.topP, 0.8, '每模型里的空串回落到上一层');
});

test('modelKey() 与 overriddenBy()：定位每模型覆盖', () => {
  assert.equal(modelKey('p1', 'm1'), 'p1::m1', '每模型覆盖的键是 <服务商id>::<模型>');
  assert.equal(modelKey('', 'm1'), '', '缺服务商或模型时没有每模型键');
  const settings = { paramsByModel: { 'p1::m1': { temperature: 0.1 } } };
  assert.equal(overriddenBy(settings, 'p1', 'm1', 'temperature'), true, '被每模型覆盖的键为真');
  assert.equal(overriddenBy(settings, 'p1', 'm1', 'topP'), false, '没被覆盖的键为假');
  assert.equal(overriddenBy({}, 'p1', 'm1', 'temperature'), false, '没有 paramsByModel 时为假');
  assert.equal(overriddenBy({ paramsByModel: { 'p1::m1': { temperature: '' } } }, 'p1', 'm1', 'temperature'), false,
    '空串不算覆盖');
});

test('toRequestParams()：默认参数下不含 top_k / seed / 频率惩罚等扩展字段', () => {
  /* 各家的扩展字段名字与语义差异很大，对不认识的字段有的忽略、有的直接 400；
     默认值 = 不下发，只在用户主动改过时才发出去。 */
  const p = resolve({}, 'p1', 'm1');
  const r = toRequestParams(p);
  assert.equal('topK' in r, false, '默认不含 top_k（topK）');
  assert.equal('seed' in r, false, '默认不含 seed');
  assert.equal('freqPenalty' in r, false, '默认不含 frequency_penalty');
  assert.equal('presPenalty' in r, false, '默认不含 presence_penalty');
  assert.equal(r.temperature, 0.7, 'temperature 是恒发字段');
  assert.equal(r.topP, 0.8, 'top_p 是恒发字段');
  assert.equal(r.maxTokens, -1, 'max_tokens 是恒发字段');
  assert.deepEqual(r.stop, [], '停止序列是恒发字段（空数组）');
  assert.equal(r.reasoning, 'default', '推理强度默认由协议层按 default 处理');
});

test('toRequestParams()：改过之后扩展字段才出现', () => {
  const r = toRequestParams({
    temperature: 0.7, topP: 0.8, maxTokens: -1, stop: '',
    seed: 42, topK: 20, frequencyPenalty: 0.5, presencePenalty: -0.3, reasoning: 'high',
  });
  assert.equal(r.seed, 42, '改过的 seed 下发');
  assert.equal(r.topK, 20, '改过的 top_k 下发');
  assert.equal(r.freqPenalty, 0.5, '改过的 frequency_penalty 下发');
  assert.equal(r.presPenalty, -0.3, '改过的 presence_penalty 下发');
  assert.equal(r.reasoning, 'high', '推理强度按用户选择下发');
});

test('toRequestParams()：改回"关闭值"仍不下发（seed -1 / top_k 0 / 惩罚 0）', () => {
  const r = toRequestParams({ temperature: 0.7, seed: -1, topK: 0, frequencyPenalty: 0, presencePenalty: 0 });
  assert.equal('seed' in r, false, 'seed=-1（默认值）不下发');
  assert.equal('topK' in r, false, 'top_k=0（关闭）不下发');
  assert.equal('freqPenalty' in r, false, '惩罚 0（关闭）不下发');
  assert.equal('presPenalty' in r, false, '存在惩罚 0（关闭）不下发');
});

test('toStopList()：停止序列每行一条（空行丢掉）', () => {
  assert.deepEqual(toStopList('A\nB\n\n'), ['A', 'B'], '多行文本 → 数组，空行丢弃');
  assert.deepEqual(toStopList([' x ', 'y']), ['x', 'y'], '数组入参同样 trim');
  assert.deepEqual(toStopList(''), [], '空输入 → 空数组');
});

test('normalizeValue()：range / number 越界夹紧、非法值回落', () => {
  assert.equal(normalizeValue(FIELDS.temperature, 3), 2, 'temperature 超过 max=2 夹回 2');
  assert.equal(normalizeValue(FIELDS.temperature, -1), 0, 'temperature 低于 min=0 夹回 0');
  assert.equal(normalizeValue(FIELDS.topP, 1.5), 1, 'top_p 超过 1 夹回 1');
  assert.equal(normalizeValue(FIELDS.topP, 'abc'), '', '非数字 → 空值（由上一层兜底）');
  assert.equal(normalizeValue(TOOL_FIELDS.plugin_fs_max, 9999), 9999, '无 max 的 number 不夹上界（由服务端硬上限兜底）');
  assert.equal(normalizeValue(TOOL_FIELDS.plugin_fs_max, 0), 1, 'number 低于 min=1 夹回 1');
  assert.equal(normalizeValue(TOOL_FIELDS.plugin_fs_max, ''), '', '空串保持空串（不当作 0）');
  assert.equal(normalizeValue(TOOL_FIELDS.plugin_fs_max, 'abc'), '', '非数字 → 空值');
  assert.equal(normalizeValue(TOOL_FIELDS.plugin_wait_sec, 9999), 1800, '等待单次上限有 max（对齐服务端硬上限 1800）');
  assert.equal(normalizeValue(TOOL_FIELDS.plugin_wait_sec, 0), 1, '等待单次上限低于 min=1 夹回 1');
});

test('normalizeValue()：switch / select / list 的形状收敛', () => {
  assert.equal(normalizeValue(TOOL_FIELDS.plugin_fs_delete, 'yes'), true, 'switch 真值 → true');
  assert.equal(normalizeValue(TOOL_FIELDS.plugin_fs_delete, ''), false, 'switch 空值 → 出厂默认 false');
  assert.equal(normalizeValue(TOOL_FIELDS.plugin_fs_delete, undefined), false, 'switch 缺省 → 出厂默认 false');
  assert.equal(normalizeValue(TOOL_FIELDS.agent_access, 'nope'), 'custom', 'select 非法选项 → 回落默认档');
  assert.equal(normalizeValue(TOOL_FIELDS.agent_access, 'full'), 'full', 'select 合法选项保留');
  assert.deepEqual(normalizeValue(TOOL_FIELDS.exec_allow, ['a', 1]), ['a', '1'], 'list 每项转字符串');
  assert.deepEqual(normalizeValue(TOOL_FIELDS.exec_allow, 'git log'), [], 'list 非数组 → 空数组');
});

test('parseExtraBody()：非法 JSON / 非对象一律返回 null', () => {
  assert.deepEqual(parseExtraBody(''), {}, '空文本 = 没有额外请求体');
  assert.deepEqual(parseExtraBody('   '), {}, '空白文本同上');
  assert.deepEqual(parseExtraBody('{"options":{"num_ctx":32768}}'), { options: { num_ctx: 32768 } }, '合法对象原样解析');
  assert.equal(parseExtraBody('{bad'), null, '非法 JSON → null（调用方给提示，不静默吞掉）');
  assert.equal(parseExtraBody('[1,2]'), null, '数组不是请求体 → null');
  assert.equal(parseExtraBody('123'), null, 'JSON 数字不是对象 → null');
  assert.equal(parseExtraBody('null'), null, 'null 不是对象 → null');
});

test('ctxLimitOf()：参数 > 服务商设置 > 出厂默认', () => {
  assert.equal(ctxLimitOf({}, {}, { ctxLimit: 8000 }), 8000, '参数里的 ctxLimit 优先');
  assert.equal(ctxLimitOf({}, { ctxLimit: 16000 }, { ctxLimit: 100 }), 16000, '参数值太小（<512）视为没填，回落到服务商设置');
  assert.equal(ctxLimitOf({}, {}, {}), FIELDS.ctxLimit.def, '都没有时取出厂默认');
});

test('参数表元数据：GROUPS 覆盖生成参数的 group、PRESETS 只写存在的键', () => {
  const ids = new Set(GROUPS.map(g => g.id));
  const badGroup = Object.entries(FIELDS)
    .filter(([, f]) => f.group && !ids.has(f.group)).map(([k]) => k);
  assert.deepEqual(badGroup, [], 'FIELDS 里每个字段的 group 都在 GROUPS 里有定义（TOOL_FIELDS 的分组由工具面板另行组织）');
  const badKey = PRESETS.flatMap(p => Object.keys(p.params))
    .filter(k => !(k in FIELDS) && !(k in TOOL_FIELDS));
  assert.deepEqual(badKey, [], '预设只写 FIELDS/TOOL_FIELDS 里存在的键');
});

test('★ 面板归位：模型参数（参数页）与工具参数（权限与工具页）键集不相交，工具项不再两页都有', () => {
  const both = Object.keys(FIELDS).filter((k) => k in TOOL_FIELDS);
  assert.deepEqual(both, [], '同一个键不能同时出现在两页：' + both.join('、'));
  /* 源码级守门：参数页不许再画 TOOL_FIELDS。2026-10-03 之前它有一段「Agent 行为」区块，
     与「权限与工具」逐行重复（同一项两处可改，改哪边生效看不出来）。
     先把注释剥掉再判：文件头的说明里会提到 TOOL_FIELDS（那是文档，不是渲染）。 */
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const srcDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src');
  const paramsSrc = stripComments(fs.readFileSync(path.join(srcDir, 'ui/features/settings/ParamsSection.jsx'), 'utf8'));
  assert.ok(!/TOOL_FIELDS/.test(paramsSrc), 'ParamsSection 不该引用 TOOL_FIELDS（工具项只留在「权限与工具」）');
  const toolsSrc = stripComments(fs.readFileSync(path.join(srcDir, 'ui/features/settings/ToolsSection.jsx'), 'utf8'));
  assert.ok(/TOOL_FIELDS/.test(toolsSrc), 'ToolsSection 是工具参数的唯一界面入口');
});

test('TOOL_DEFAULTS 从 TOOL_FIELDS 推导，键集与值完全一致（唯一真源，没有第二份副本）', () => {
  const sortEntries = (o) => Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1));
  assert.deepEqual(sortEntries(TOOL_DEFAULTS), sortEntries(Object.fromEntries(
    Object.entries(TOOL_FIELDS).map(([k, f]) => [k, f.def]))),
    'TOOL_DEFAULTS 必须等于 TOOL_FIELDS 各键的 def');
});

test('★ 代码里读的每个参数键都存在于 TOOL_FIELDS / FIELDS（防拼错键名后静默回落默认值）', () => {
  /* val2('<key>') 是界面读参数的唯一入口（core/agent-defs.js、ui/**）。键名拼错不会报错——
     val2 一路回落到 undefined，行为静默变成"出厂默认"，线上极难排查。扫源码把字面量揪出来核对。 */
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : (/\.(js|jsx)$/.test(e.name) ? [p] : []);
  });
  const srcDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src');
  const keys = new Set();
  for (const file of walk(srcDir)) {
    const code = fs.readFileSync(file, 'utf8');
    for (const m of code.matchAll(/val2\(\s*'([^']+)'/g)) keys.add(m[1]);
  }
  assert.ok(keys.size > 10, '应当扫到一批参数键（实际 ' + keys.size + '）');
  const unknown = [...keys].filter((k) => !(k in TOOL_FIELDS) && !(k in FIELDS));
  assert.deepEqual(unknown, [], '这些键在 TOOL_FIELDS/FIELDS 里不存在：' + unknown.join('、'));
});

test('normalizeParam：单键归一（list 用 asStringList、lines/json 原样、未知键原样）', () => {
  assert.equal(normalizeParam('temperature', 1e9), 2, 'range 越界夹到 max');
  assert.equal(normalizeParam('temperature', -3), 0, 'range 越界夹到 min');
  assert.equal(normalizeParam('plugin_fs_max', 'abc'), '', '非法数字 → 空值（= 用上一层）');
  assert.equal(normalizeParam('mem_inject', 'nope'), 'index', 'select 非法选项回落出厂默认');
  assert.equal(normalizeParam('plugin_fs_delete', 1), true, 'switch 转布尔');
  assert.deepEqual(normalizeParam('exec_allow', 'git status\ngit log'), ['git status', 'git log'],
    'list 容忍旧的换行字符串（不能用 normalizeValue：它把非数组抹成空数组）');
  assert.deepEqual(normalizeParam('exec_allow', ['a', 'a', 'b']), ['a', 'a', 'b'], 'list 数组原样（去空白，不去重）');
  assert.equal(normalizeParam('stop', 42), 42, 'lines 原样保留（不做 String() 转换）');
  assert.deepEqual(normalizeParam('extraBody', { a: 1 }), { a: 1 }, 'json 原样保留（不变成 "[object Object]"）');
  assert.deepEqual(normalizeParam('brand_new_param', { x: 1 }), { x: 1 }, '未知键原样保留');
});

test('normalizeParamBag：整袋归一；非对象 → 空袋', () => {
  const bag = normalizeParamBag({ temperature: 9, exec_allow: 'ls\npwd', keepme: 1 });
  assert.equal(bag.temperature, 2);
  assert.deepEqual(bag.exec_allow, ['ls', 'pwd']);
  assert.equal(bag.keepme, 1);
  assert.deepEqual(normalizeParamBag(null), {});
  assert.deepEqual(normalizeParamBag('nope'), {});
  assert.deepEqual(normalizeParamBag([1, 2]), {});
});

test('★ resolve()：盘上的越界值在读取端就被夹回（历史数据/外部写入的兜底）', () => {
  const p = resolve({ params: { temperature: 1e9, ctxLimit: 1 }, paramsByModel: { 'p1::m1': { topK: 999999 } } }, 'p1', 'm1');
  assert.equal(p.temperature, 2, '全局参数越界 → 夹回上限');
  assert.equal(p.ctxLimit, 512, 'ctxLimit 低于 min=512 → 夹回 512');
  assert.equal(p.topK, 1000, '每模型覆盖同样被夹回（max=1000）');
});

test('★ 有服务端硬上限的参数在 schema 里声明 max（面板不会显示一个做不到的数）', () => {
  /* 子智能体的并发/轮次在服务端被 clampInt(…, hi) 夹住；schema 若不写 max，
     面板能填 100 而实际只有 30——"显示的值 ≠ 生效的值"是本次归一化要收掉的口径。 */
  assert.equal(TOOL_FIELDS.subagent_parallel.max, 8, '并发上限 8 要写进 schema');
  assert.equal(TOOL_FIELDS.subagent_rounds.max, 30, '轮次上限 30 要写进 schema');
  assert.equal(normalizeParam('subagent_parallel', 99), 8, '越界并发被夹到 8');
  assert.equal(normalizeParam('subagent_rounds', 100), 30, '越界轮次被夹到 30');
});

test('★ 结果与记录：追踪条上限的默认值/范围写在 schema（4000 不再是散落各处的魔数）', () => {
  /* 这三项原先各自硬编码在 core/agent.js、ui/state/host.js、lib/agent/run-loop.js、
     lib/agent/run-subagent.js（两处）、core/context.js、lib/agent/run.js —— 共七处 4000。
     现在默认值只在 schema 里写一次；每处的取值都必须经 val2（照上面的键名扫描用例）。 */
  assert.equal(TOOL_FIELDS.record_trace_chars.def, 4000, '追踪条单条结果默认 4000（与旧行为一致，升级不改现有效果）');
  assert.equal(TOOL_FIELDS.record_args_chars.def, 2000, '参数截断默认 2000（与 core/agent.js 的 ARG_STR_MAX 一致）');
  assert.equal(TOOL_FIELDS.record_compact_chars.def, 4000, '压缩输入单条默认 4000');
  assert.equal(normalizeParam('record_trace_chars', 1e9), 200000, '越界被夹到 20 万字（= 服务端单条记录上限）');
  assert.equal(normalizeParam('record_trace_chars', 10), 500, '低于下限被夹到 500');
  assert.equal(normalizeParam('record_args_chars', 'abc'), '', '非法数字 → 空值（= 用上一层）');
  assert.equal(TOOL_FIELDS.subagent_steps.def, 200, '子智能体转录默认保留 200 步（与旧行为一致）');
  /* 只能收紧的两项：默认值 = 服务端硬上限本身（升级后行为不变，用户可以往下调） */
  assert.equal(TOOL_FIELDS.plugin_fs_write_kb.def, 4096, '单次写入默认 4MB（服务端硬上限同值）');
  assert.equal(TOOL_FIELDS.plugin_fs_nodes.def, 800, '目录树/找文件默认 800 项（服务端硬上限同值）');
});
