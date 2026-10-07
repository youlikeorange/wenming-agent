/* 工具层回归（含危险命令清单、票据、工具闸门与执行，
 * 另新写工具注册闸门与 ToolRunner 执行层用例）：
 *   · AgentDefs：本轮给模型注册哪些工具（登录/绑定闸门、各插件开关、技能与记忆开关）；
 *   · ToolRunner：runTool 分发、单轮预算、危险命令授权窗、服务端错误标记 → 人话；
 *   · denyHit / commandSegments / issueGrant / takeGrant：危险命令清单与一次性票据。
 * 移植改动：手写 check() → node:test + node:assert/strict；客户端模块 ESM import，
 *           服务端模块（已从 lib/agent-tools.js 拆到 lib/agent/deny.js 与 lib/agent/grants.js）
 *           用 createRequire 相对引入——它们是纯逻辑、不碰网络/文件系统。
 * 假 window 不需要：ToolRunner / AgentDefs 的宿主依赖全部走 init(deps) 注入。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { AgentDefs } from '../src/core/agent-defs.js';
import { AgentPolicy } from '../src/core/policy.js';
import { ToolRunner } from '../src/core/tool-runner.js';
import { Prompts } from '../src/core/prompts.js';

const require = createRequire(import.meta.url);
const { denyHit, commandSegments } = require('../../lib/agent/deny.js');
const { issueGrant, takeGrant } = require('../../lib/agent/grants.js');

/* =====================================================================
 * 一、危险命令清单 denyHit / commandSegments（原 agent-tools-test.js）
 * ===================================================================== */

/** 原 check(what, denyHit(cmd), want) 的语义：want=null 要求放行，否则要求命中并包含 want */
function checkDeny(what, cmd, want) {
  const got = denyHit(cmd);
  const ok = want === null ? got === null : !!got && String(got).includes(want);
  assert.ok(ok, `${what}  → ${JSON.stringify(got)}（期望 ${want === null ? '放行' : '包含 ' + want}）`);
}

test('denyHit：子壳里的命令同样要拦（2026-09-19 审计补）', () => {
  checkDeny('echo $(reboot)', 'echo $(reboot)', 'reboot');
  checkDeny('echo `reboot`', 'echo `reboot`', 'reboot');
  checkDeny('echo "$(rm -rf /)"（嵌套）', 'echo "$(rm -rf /)"', 'rm');
  checkDeny('watch $(systemctl reboot)', 'watch $(systemctl reboot)', 'systemctl');
  checkDeny('echo $(passwd leo)', 'echo $(passwd leo)', 'passwd');
});

test('denyHit：引号 / 长选项 / 解释器载荷（五轮实测放行过的矩阵，六轮修复）', () => {
  checkDeny('rm -rf "/"', 'rm -rf "/"', 'rm');
  checkDeny("rm -rf '/'", "rm -rf '/'", 'rm');
  checkDeny('rm -rf //', 'rm -rf //', 'rm');
  checkDeny('rm --recursive --force /', 'rm --recursive --force /', 'rm');
  checkDeny('rm -r -f /（分离短选项）', 'rm -r -f /', 'rm');
  checkDeny('chmod 777 "/"', 'chmod 777 "/"', 'chmod');
  checkDeny('dd if=/dev/zero of="/dev/sda"', 'dd if=/dev/zero of="/dev/sda"', 'dd');
  checkDeny('bash -c "rm -rf /"', 'bash -c "rm -rf /"', 'rm');
  checkDeny("sh -c 'reboot'", "sh -c 'reboot'", 'reboot');
  checkDeny('su -c "reboot" leo', 'su -c "reboot" leo', 'reboot');
  checkDeny('systemctl "reboot"', 'systemctl "reboot"', 'systemctl');
  checkDeny('eval "reboot"', 'eval "reboot"', 'reboot');
  checkDeny("python3 -c \"import os; os.system('reboot')\"", "python3 -c \"import os; os.system('reboot')\"", '解释器载荷');
});

test('denyHit：六轮修复后原有放行行为不回归', () => {
  checkDeny('grep -i reboot /var/log/syslog（reboot 只是参数）', 'grep -i reboot /var/log/syslog', null);
  checkDeny('journalctl | grep halt', 'journalctl | grep halt', null);
  checkDeny('echo "please reboot later"', 'echo "please reboot later"', null);
  checkDeny('echo $(uname -r)', 'echo $(uname -r)', null);
  checkDeny("python3 -c \"print('rebooted ok')\"（词边界：rebooted 不算）", "python3 -c \"print('rebooted ok')\"", null);
  checkDeny('head -n 5 file（带值短选项不误拼）', 'head -n 5 file', null);
  checkDeny('diff -r dir1 dir2（-r 但无 / 目标）', 'diff -r dir1 dir2', null);
});

test('denyHit：原有的拦截行为不回归（三轮矩阵）', () => {
  checkDeny('ls -la', 'ls -la', null);
  checkDeny('reboot（命令位置）', 'reboot', 'reboot');
  checkDeny('sudo -u root shutdown -h now', 'sudo -u root shutdown -h now', 'shutdown');
  checkDeny('rm -rf /', 'rm -rf /', 'rm');
  checkDeny('dd if=/dev/zero of=/dev/sda', 'dd if=/dev/zero of=/dev/sda', 'dd');
});

test('commandSegments：包装器剥离（denyHit 的地基）', () => {
  const segs = commandSegments('sudo -u root shutdown -h now');
  assert.ok(segs.length === 1 && segs[0].prog === 'shutdown', '剥掉 sudo 与其选项后取到 shutdown');
});

test('denyHit：包装器/选项不再放走危险程序（2026-09-20 审计）', () => {
  checkDeny('timeout 5 reboot', 'timeout 5 reboot', 'reboot');
  checkDeny('timeout 5s reboot（时长带单位）', 'timeout 5s reboot', 'reboot');
  checkDeny('timeout -s KILL 5 reboot（-s 带值）', 'timeout -s KILL 5 reboot', 'reboot');
  checkDeny('timeout --signal=KILL 5 systemctl reboot', 'timeout --signal=KILL 5 systemctl reboot', 'systemctl');
  checkDeny('sudo -n reboot（-n 不带值）', 'sudo -n reboot', 'reboot');
  checkDeny('time -p reboot（time 的 -p 不带值）', 'time -p reboot', 'reboot');
  checkDeny('watch -n1 reboot', 'watch -n1 reboot', 'reboot');
  checkDeny('script -c reboot', 'script -c reboot', 'reboot');
  checkDeny('timeout 5 rm -rf /', 'timeout 5 rm -rf /', 'rm');
  checkDeny('timeout 5 passwd leo', 'timeout 5 passwd leo', 'passwd');
  checkDeny('包装器剥离后只读命令仍不误拦：time -p ls', 'time -p ls', null);
  checkDeny('包装器剥离后只读命令仍不误拦：sudo -u root ls -l /', 'sudo -u root ls -l /', null);
  checkDeny('包装器剥离后只读命令仍不误拦：timeout 5 grep reboot /var/log/x', 'timeout 5 grep reboot /var/log/x', null);
});

/* =====================================================================
 * 二、危险命令的一次性授权票据（原 audit7-test.js）
 * ===================================================================== */

test('denyHit 命中 → 发票据 → 携票据执行应放行', () => {
  assert.ok(denyHit('rm -rf /'), 'rm -rf / 命中清单（hit 非空才需要授权）');
  const cmd = 'chmod 777 /';                       // rm -rf 指向子目录本就不命中清单，选一条真命中的
  assert.ok(denyHit(cmd), 'chmod 777 / 命中清单');
  const t = issueGrant(cmd);
  assert.equal(takeGrant(t, cmd), true, '有效票据 + 同一条命令 → takeGrant 放行');
});

test('票据一次性：第二笔同命令请求被拒', () => {
  const cmd = 'dd if=/dev/zero of=/dev/sda';
  const t = issueGrant(cmd);
  assert.equal(takeGrant(t, cmd), true, '第一笔放行');
  assert.equal(takeGrant(t, cmd), false, '同一票据不能再用');
});

test('票据绑定命令全文：换一条命令不认', () => {
  const t = issueGrant('reboot');
  assert.equal(takeGrant(t, 'reboot -f'), false, '命令被改动后票据无效');
  assert.equal(takeGrant(t, 'shutdown'), false, '换一条命令同样不认');
});

test('伪造/空票据一律不放行', () => {
  assert.equal(takeGrant('', 'reboot'), false, '空票据不放行');
  assert.equal(takeGrant('deadbeef', 'reboot'), false, '伪造票据不放行');
});

test('未命中清单的命令根本不需要票据（hit 为空）', () => {
  assert.equal(denyHit('ls -la /'), null, 'ls -la / 不命中');
  assert.equal(denyHit('grep -i reboot /var/log/syslog'), null, 'grep reboot 日志不命中');
});

test('deny-check 的完整语义：命中即拦、无票据不放行（toolRunCommand 的服务端兜底）', () => {
  assert.ok(denyHit('rm -rf "/"'), 'denyHit 命中矩阵不回归：rm -rf "/"');
  assert.ok(denyHit("python3 -c \"import os; os.system('reboot')\""), '命中矩阵不回归：解释器载荷');
  assert.equal(denyHit('echo please reboot later'), null, '命中矩阵不回归：reboot 只是回显文本');
});

/* =====================================================================
 * 三、工具注册闸门 AgentDefs
 * ===================================================================== */

const AGENT_API = '/agent/tools';
const BASE_VAL = {
  plugin_fs_on: true, plugin_fs_write: true, plugin_fs_delete: false, plugin_exec_on: true,
  plugin_deliver_on: true,
  tool_mem_on: true, mem_auto: true, skill_tools_on: true, skill_write_confirm: true, exec_allow: [],
};
const valMap = (map) => (k) => Object.assign({}, BASE_VAL, map)[k];
const initDefs = (over = {}) => AgentDefs.init(Object.assign({
  Prompts, val2: valMap({}), me: () => ({ name: 'leo' }), bound: () => true, AGENT_API,
}, over));
const namesOf = (defs) => defs.map((d) => d.function.name);

test('AgentDefs.pluginsAllowed()：未登录 → false；已登录未绑定 → false；已登录已绑定 → true', () => {
  AgentDefs.init({ Prompts, val2: valMap({}), me: () => null, bound: () => true, AGENT_API });
  assert.equal(AgentDefs.pluginsAllowed(), false, '未登录 → false（bound 为真也不算）');
  AgentDefs.init({ me: () => ({ name: 'leo' }), bound: () => false });
  assert.equal(AgentDefs.pluginsAllowed(), false, '已登录但未绑定本机账号 → false');
  AgentDefs.init({ bound: () => true });
  assert.equal(AgentDefs.pluginsAllowed(), true, '已登录且已绑定 → true');
});

test('AgentDefs 插件闸门：未绑定本机账号 → 不注册文件/命令工具，并说明原因', () => {
  initDefs({ bound: () => false });
  assert.equal(AgentDefs.pluginsAllowed(), false, '已登录未绑定 → 闸门关闭');
  assert.deepEqual(AgentDefs.pluginToolDefs(), [], '未绑定时一个插件工具都不注册');
  const names = namesOf(AgentDefs.activeToolDefs());
  assert.ok(!names.includes('read_file') && !names.includes('run_command'),
    'activeToolDefs 里也没有文件/命令工具');
  const note = AgentDefs.pluginGateNote();
  assert.equal(note && note.id, 'plugin.need_bind.note', '已登录未绑定 → 注入"需要绑定本机账号"的说明');
  assert.ok(note && /绑定本机账号/.test(note.text), '说明里点明要让用户去绑定本机账号');
});

test('AgentDefs 插件闸门：未登录 → 沿用 plugin.need_login.note 文案（逐字不动）', () => {
  initDefs({ me: () => null, bound: () => true });
  assert.deepEqual(AgentDefs.pluginToolDefs(), [], '未登录不注册插件工具');
  const note = AgentDefs.pluginGateNote();
  assert.equal(note && note.id, 'plugin.need_login.note', '未登录沿用原 note 的 id');
  assert.equal(note && note.text, Prompts.text('plugin.need_login.note'), '文案从提示词登记表取（与原文一致）');
});

test('AgentDefs 插件闸门：闸门放行时不注入说明', () => {
  initDefs();
  assert.equal(AgentDefs.pluginsAllowed(), true, '登录+绑定 → 闸门放行');
  assert.equal(AgentDefs.pluginGateNote(), null, '放行时不注入任何闸门说明');
});

test('AgentDefs：登录+绑定后按开关注册（写入/删除/命令各自独立）', () => {
  initDefs({ val2: valMap({ plugin_fs_write: false, plugin_fs_delete: false, plugin_exec_on: false }) });
  const names = namesOf(AgentDefs.pluginToolDefs());
  assert.ok(names.includes('read_file'), '只读文件工具在（plugin_fs_on 开着）');
  assert.ok(!names.includes('write_file'), '关掉写入 → 不注册写类工具');
  assert.ok(!names.includes('delete_path'), '删除默认不给模型（开关为假）');
  assert.ok(!names.includes('run_command'), '关掉命令行 → 不注册 run_command');
  initDefs({ val2: valMap({ plugin_fs_delete: true }) });
  const names2 = namesOf(AgentDefs.pluginToolDefs());
  assert.ok(names2.includes('write_file') && names2.includes('delete_path') && names2.includes('run_command'),
    '开关打开后写/删/命令一并注册');
});

test('AgentDefs：没有接入站点后端（AGENT_API 为空）同样不注册插件工具', () => {
  initDefs({ AGENT_API: '' });
  assert.deepEqual(AgentDefs.pluginToolDefs(), [], '没有后端就没有插件工具');
  assert.ok(!namesOf(AgentDefs.activeToolDefs()).includes('read_file'), 'activeToolDefs 同样不含');
});

test('AgentDefs：联网搜索的登录 + 技能开关闸门', () => {
  initDefs({ me: () => null });
  assert.equal(AgentDefs.searchOn(), false, '未登录 → 不注册 web_search（服务端 401，别让模型空转）');
  assert.ok(!namesOf(AgentDefs.activeToolDefs()).includes('web_search'), '未登录 → 工具清单里没有 web_search');
  initDefs();
  assert.equal(AgentDefs.searchOn(), true, '登录且技能开关开着 → 注册');
  assert.ok(namesOf(AgentDefs.activeToolDefs()).includes('web_search'), '工具清单里有 web_search');
  Prompts.setEnabled('skill.web_search', false);
  initDefs();
  assert.equal(AgentDefs.searchOn(), false, '关掉联网搜索技能 → 不注册');
  Prompts.setEnabled('skill.web_search', true);
  assert.equal(AgentDefs.searchOn(), true, '恢复开关后重新注册');
});

test('★ 内置联网搜索关掉后：工具不注册，相关提示词也不注入（2026-10-03「权限与工具」的开关）', async () => {
  /* 开关就是提示词登记表里那条内置技能（skill.web_search）的启停——「权限与工具 → 联网搜索」
     那一行只是它的视图（写 setPromptEnabled）。这里守住关掉之后的两件事：
       · 注册：activeToolDefs 里没有 web_search（它的 schema 描述也就不会发给模型）；
       · 注入：system 里没有那条技能正文，连工具名都不出现。 */
  const { Assemble } = await import('../src/core/assemble.js');
  const { TOOL_DEFAULTS } = await import('../src/core/params.js');
  const memStub = { fullBlock: () => null, indexBlock: () => null, projectBlock: () => null, sessionBlock: () => null };
  const env = { params: {}, Prompts, Memory: memStub, AgentDefs, AgentPolicy, TOOL_DEFAULTS };
  initDefs();
  Prompts.setEnabled('skill.web_search', true);
  const on = Assemble.promptBlocks(env);
  assert.ok(on.tools.includes('web_search'), '开启时注册 web_search');
  assert.ok(on.blocks.some((b) => b.id === 'skill.web_search'), '开启时注入联网搜索的技能正文');
  Prompts.setEnabled('skill.web_search', false);
  const off = Assemble.promptBlocks(env);
  assert.ok(!off.tools.includes('web_search'), '关闭时工具清单里没有 web_search');
  assert.ok(!off.blocks.some((b) => b.id === 'skill.web_search'), '关闭时不再注入它的技能正文');
  const sys = Assemble.systemMessage(env);
  assert.ok(!/web_search/.test(sys ? sys.content : ''), 'system 里连工具名都不出现（schema 描述只在工具定义里）');
  Prompts.setEnabled('skill.web_search', true);       // 还原：默认实例在多个用例间共用
  assert.ok(Assemble.promptBlocks(env).tools.includes('web_search'), '恢复开关后重新注册 + 注入');
});

test('AgentDefs：技能与记忆工具的开关', () => {
  initDefs({ val2: valMap({ skill_tools_on: false, tool_mem_on: false }) });
  assert.deepEqual(AgentDefs.skillsToolDefs(), [], '关掉技能能力 → 不注册技能工具');
  assert.deepEqual(AgentDefs.memoryToolDefs(), [], '关掉记忆能力 → 不注册记忆工具');
  initDefs();
  assert.deepEqual(namesOf(AgentDefs.skillsToolDefs()), ['list_skills', 'use_skill', 'skill_write', 'skill_import'],
    '零技能时也要给 list/use/skill_write：否则模型会说"我没有 use_skill 这个工具"，'
    + '连"当前没有配置技能"都答不出来（2026-09-30 实测踩到）');
  assert.deepEqual(namesOf(AgentDefs.memoryToolDefs()),
    ['memory_write', 'memory_search', 'memory_read', 'memory_forget'], '记忆类四件套');
  const fakePrompts = Object.assign(Object.create(null), Prompts, {
    onDemandSkills: () => [{ id: 'sk-1', name: 'demo', description: '按需技能', text: '正文' }],
    skills: () => [{ id: 'sk-2', name: 'demo2', description: '已有技能', text: '正文' }],
  });
  initDefs({ Prompts: fakePrompts });
  assert.deepEqual(namesOf(AgentDefs.skillsToolDefs()),
    ['list_skills', 'use_skill', 'skill_write', 'skill_import', 'skill_delete'],
    '有技能 → 再加 skill_delete（list/use/import/write 一直都在）');
});

/* =====================================================================
 * 四、工具执行层 ToolRunner（假 fetch，不碰网络）
 * ===================================================================== */

/** 可注入的假元素/假响应：http.js 只读 ok/status/headers.get/json */
const jsonRes = (status, data, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
  json: async () => data,
});

/** 替换 globalThis.fetch，记录每次请求；返回 { seen, restore } */
function stubFetch(handler) {
  const orig = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    seen.push({ url, body, headers: (opts && opts.headers) || {} });
    return handler(String(url), body, opts);
  };
  return { seen, restore: () => { globalThis.fetch = orig; } };
}

const baseBudget = () => ({ search: 0, aux: 0, fs: 0, exec: 0, wait: 0, screen: 0, maxSearch: 3, maxAux: 8, maxFs: 12, maxExec: 6, maxWait: 12, maxScreen: 30 });

/** 会话 / 项目 / 全局记忆的假实现（ToolRunner 用到 write/search/find/remove/listOf/scopeCn/projectMeta） */
function fakeMemory(hasProject = false) {
  const g = [{ id: 'm1', title: '偏好', content: '喜欢深色主题', tags: ['ui'], source: 'user', updated: 1 }];
  const s = [{ id: 'm2', title: '待办', content: '把单测跑绿', tags: [], source: 'model', updated: 2 }];
  const p = [{ id: 'p1', title: '跑法', content: '用 up.sh 起', tags: [], source: 'user', updated: 3 }];
  const writes = [];
  return {
    writes,
    projectMeta: hasProject ? { id: 'proj-1', name: '文档站', root: '/w', memoryDir: '/w/m' } : null,
    project: hasProject ? p : [],
    write: (o) => {
      writes.push(o);
      return { entry: { id: 'm9', title: o.title || '新记忆', content: o.content || '', tags: o.tags || [] }, updated: false };
    },
    search: (q) => (String(q).includes('深色') ? [{ id: 'm1', scope: 'global', title: '偏好', tags: ['ui'], excerpt: '喜欢深色主题' }] : []),
    find: (id) => (id === 'm1' ? g[0] : id === 'm2' ? s[0] : (id === 'p1' && hasProject ? p[0] : null)),
    listOf: (scope) => (scope === 'global' ? g : scope === 'project' ? (hasProject ? p : []) : s),
    remove: () => g[0],
    scopeCn: (scope) => ({ global: '全局', project: '项目', session: '会话' }[scope] || '全局'),
  };
}

/** 按主题初始化执行层依赖；返回可断言的调用记录与预算对象 */
function initRunner(over = {}) {
  const calls = { save: 0, persist: 0, renderMemory: 0, renderPrompt: 0, ctxMeter: 0, toast: [], openLogin: [], needBind: 0, needUnlock: [] };
  const budget = baseBudget();
  ToolRunner.init(Object.assign({
    Prompts, AgentPolicy, AgentDefs,
    Memory: fakeMemory(),
    val2: valMap({}),
    me: () => ({ name: 'leo' }),
    accessOf: () => ({ fsAsk: false, delAsk: false, execAsk: false }),
    AGENT_API,
    runSignal: () => null,
    save: () => { calls.save++; },
    persistSession: () => { calls.persist++; },
    renderMemoryPanel: () => { calls.renderMemory++; },
    renderPromptPanel: () => { calls.renderPrompt++; },
    updateCtxMeter: () => { calls.ctxMeter++; },
    toast: (m) => calls.toast.push(m),
    openLogin: (m) => calls.openLogin.push(m),
    onNeedBind: () => { calls.needBind++; },
    onNeedUnlock: (u) => calls.needUnlock.push(u),
    onStatus: null,
    confirmPluginAction: async () => ({ ok: true }),
    confirmSkillChange: async () => ({ ok: true }),
    askDangerGrant: async () => ({ ok: false }),
  }, over));
  return { calls, budget };
}

test('ToolRunner：未注册的工具名 → 明确回绝', async () => {
  const { budget } = initRunner();
  const r = await ToolRunner.runTool({ name: 'nope', args: {} }, '用户输入', budget);
  assert.equal(r.ok, false, '未注册工具返回 ok:false');
  assert.equal(r.note, '未注册', 'note=未注册');
  assert.ok(r.text.includes('未知工具'), '文本点明未知工具（loop.unknown_tool）');
});

test('ToolRunner：没有接入站点后端 → 插件工具不可用', async () => {
  const { budget } = initRunner({ AGENT_API: '' });
  const r = await ToolRunner.runTool({ name: 'read_file', args: { path: '/tmp/a' } }, '', budget);
  assert.equal(r.ok, false, '没有后端 → ok:false');
  assert.equal(r.note, '未接入后端', 'note=未接入后端');
});

test('ToolRunner：用户在面板里关掉了这一类插件 → 不执行', async () => {
  const { budget } = initRunner({ val2: valMap({ plugin_exec_on: false }) });
  const r = await ToolRunner.runTool({ name: 'run_command', args: { command: 'ls' } }, '', budget);
  assert.equal(r.ok, false, '插件已停用 → ok:false');
  assert.equal(r.note, '已停用', 'note=已停用');
  assert.ok(r.text.includes('已被用户关闭'), '文本来自 loop.plugin_off');
});

test('ToolRunner：未登录 → 插件工具不可用（服务端也会 401，提前拦下给人话）', async () => {
  const { budget } = initRunner({ me: () => null });
  const r = await ToolRunner.runTool({ name: 'read_file', args: { path: '/tmp/a' } }, '', budget);
  assert.equal(r.ok, false, '未登录 → ok:false');
  assert.equal(r.note, '需要登录', 'note=需要登录');
  assert.equal(r.text, Prompts.text('plugin.need_login'), '文本来自 plugin.need_login');
});

test('ToolRunner：写操作确认被拒 → 不执行也不烧预算', async () => {
  const { budget } = initRunner({
    accessOf: () => ({ fsAsk: true, delAsk: false, execAsk: false }),
    confirmPluginAction: async () => ({ ok: false }),
  });
  const r = await ToolRunner.runTool({ name: 'write_file', args: { path: '/a', content: 'x' } }, '', budget);
  assert.equal(r.ok, false, '用户拒绝 → ok:false');
  assert.equal(r.note, '用户未同意', 'note=用户未同意');
  assert.ok(r.text.includes('write_file'), '文本点明工具名（loop.plugin_denied）');
  assert.equal(budget.fs, 0, '确认被拒时不扣文件预算');
});

test('ToolRunner：文件预算用尽 → 回绝（确认通过后才扣）', async () => {
  const { budget } = initRunner();
  budget.fs = budget.maxFs;
  const r = await ToolRunner.runTool({ name: 'write_file', args: { path: '/a', content: 'x' } }, '', budget);
  assert.equal(r.ok, false, '预算用尽 → ok:false');
  assert.equal(r.note, '已达上限', 'note=已达上限');
  assert.ok(r.text.includes('文件操作次数已达上限'), '文本来自 loop.budget_fs');
});

test('ToolRunner：读文件走服务端桥（成功路径）', async () => {
  const { budget, calls } = initRunner();
  const stub = stubFetch(() => jsonRes(200, { ok: true, note: '完成', text: 'file body' }));
  try {
    const r = await ToolRunner.runTool({ name: 'read_file', args: { path: '/tmp/a' } }, '', budget);
    assert.equal(r.ok, true, '服务端返回成功 → ok:true');
    assert.equal(r.text, 'file body', '输出原样带回');
    assert.equal(r.note, '完成', 'note 原样带回');
    assert.equal(stub.seen.length, 1, '只发一次 /tools/call');
    assert.ok(stub.seen[0].url.endsWith('/agent/tools/call'), '端点走新的 /agent/* 前缀');
    assert.equal(calls.toast.length, 0, '成功路径不弹 toast');
  } finally { stub.restore(); }
});

test('ToolRunner：危险命令授权窗拒绝 → 不执行、不扣命令预算', async () => {
  const { budget } = initRunner({ askDangerGrant: async () => ({ ok: false }) });
  const stub = stubFetch((url) => (url.includes('deny-check')
    ? jsonRes(200, { ok: true, hit: 'rm', grant: '' })
    : jsonRes(200, { ok: true, text: '不该走到这' })));
  try {
    const r = await ToolRunner.runTool({ name: 'run_command', args: { command: 'rm -rf /' } }, '', budget);
    assert.equal(r.ok, false, '授权被拒 → ok:false');
    assert.equal(r.note, '用户拒绝授权', 'note=用户拒绝授权');
    assert.ok(r.text.includes('拒绝'), '文本说明用户点了拒绝');
    assert.equal(budget.exec, 0, '拒绝不烧命令预算（扣费在授权通过之后）');
    assert.equal(stub.seen.length, 1, '只发了 deny-check，没有发执行请求');
  } finally { stub.restore(); }
});

test('ToolRunner：skill_import（预览 → 确认 → 安装；拒绝/空目录都不装）', async () => {
  const plan = { ok: true, dryRun: true, path: '/skills', errors: [],
    items: [{ name: 'demo-a', description: '甲技能', auto: true, file: '/skills/demo-a/SKILL.md', chars: 20 }] };
  const done = { ok: true, path: '/skills', errors: [], count: 1, imported: [{ name: 'demo-a', action: '新建' }] };
  const stub = stubFetch((url, body) => (url.includes('/agent/skills/import')
    ? (body && body.dryRun ? jsonRes(200, plan) : jsonRes(200, done))
    : jsonRes(404, { ok: false, error: 'unexpected ' + url })));
  try {
    let confirmed = null;
    const { budget } = initRunner({ confirmSkillChange: async (action, name, args) => { confirmed = { action, name, args }; return { ok: true }; } });
    const r = await ToolRunner.runTool({ name: 'skill_import', args: { path: '/skills' } }, '', budget);
    assert.equal(r.ok, true, '安装成功');
    assert.equal(r.note, '已安装技能');
    assert.ok(r.text.includes('demo-a（新建）'), '结果里写明装了哪个');
    assert.equal(confirmed.action, '导入', '确认框走"导入"档（列出要装的技能）');
    assert.equal(confirmed.args.items.length, 1, '确认框拿得到预览清单');
    assert.equal(stub.seen.length, 2, '先 dryRun 预览、再正式提交');
    assert.equal(stub.seen[0].body.dryRun, true, '第一次请求必须是只解析');
    assert.equal(budget.aux, 1, '改动类扣 aux 预算');
  } finally { stub.restore(); }

  const stub2 = stubFetch((url, body) => (url.includes('/agent/skills/import')
    ? (body && body.dryRun ? jsonRes(200, plan) : jsonRes(200, done))
    : jsonRes(404, { ok: false, error: 'unexpected' })));
  try {
    const { budget } = initRunner({ confirmSkillChange: async () => ({ ok: false }) });
    const r = await ToolRunner.runTool({ name: 'skill_import', args: { path: '/skills' } }, '', budget);
    assert.equal(r.note, '用户未同意', '拒绝 → 不安装');
    assert.equal(stub2.seen.length, 1, '拒绝后不再提交（只发了预览）');
    assert.equal(budget.aux, 0, '拒绝不扣预算');
  } finally { stub2.restore(); }

  const stub3 = stubFetch(() => jsonRes(200, { ok: true, dryRun: true, path: '/empty', items: [], errors: ['x.md：正文是空的'] }));
  try {
    const { budget } = initRunner();
    const r = await ToolRunner.runTool({ name: 'skill_import', args: { path: '/empty' } }, '', budget);
    assert.equal(r.ok, false, '没扫到技能 → 不成功');
    assert.equal(r.note, '没找到技能');
    assert.ok(r.text.includes('正文是空的'), '把逐条失败原因带给模型');
    assert.equal(budget.aux, 0, '没装成不扣预算');
  } finally { stub3.restore(); }
});

test('ToolRunner：危险命令授权通过 → 携一次性票据执行', async () => {
  const { budget } = initRunner({ askDangerGrant: async () => ({ ok: true }) });
  const stub = stubFetch((url) => (url.includes('deny-check')
    ? jsonRes(200, { ok: true, hit: 'rm', grant: 'g-1' })
    : jsonRes(200, { ok: true, note: '完成', text: 'done' })));
  try {
    const r = await ToolRunner.runTool({ name: 'run_command', args: { command: 'rm -rf /' } }, '', budget);
    assert.equal(r.ok, true, '授权通过 → 执行成功');
    assert.equal(r.text, 'done', '输出原样带回');
    assert.equal(budget.exec, 1, '授权通过后才扣一格命令预算');
    const call = stub.seen.find((s) => s.url.endsWith('/agent/tools/call'));
    assert.ok(call, '执行请求发出去了');
    assert.equal(call.body.grant, 'g-1', '请求体里带上 deny-check 下发的一次性票据');
  } finally { stub.restore(); }
});

test('ToolRunner：needGrant 自愈——执行时被 403 而没弹过窗 → 现取预检弹窗 → 带票据重试一次', async () => {
  /* 场景（2026-10-07 用户报"弹窗与实际执行不同步"）：预检说不需要票据（hit:''），
     执行闸门判定需要（目标状态在两次判定之间变了）→ 旧实现只回一句"需要授权"、没有窗口；
     新实现现取一次预检、弹窗、带票据重试一次，两边由此一致。 */
  let callN = 0, checkN = 0;
  const asked = [];
  const { budget } = initRunner({
    askDangerGrant: async (hit, cmd) => { asked.push({ hit, cmd }); return { ok: true }; },
  });
  const stub = stubFetch((url) => {
    if (url.includes('deny-check')) {
      checkN++;
      // 预检第一次说"不需要票据"（豁免），执行被拒后第二次预检给出命中+票据
      return checkN === 1
        ? jsonRes(200, { ok: true, hit: '', grant: '' })
        : jsonRes(200, { ok: true, hit: 'pkill', grant: 'g-2' });
    }
    callN++;
    return callN === 1
      ? jsonRes(403, { ok: false, error: '这条命令需要授权', needGrant: true, hit: 'pkill' })
      : jsonRes(200, { ok: true, note: '完成', text: '已停止后台任务' });
  });
  try {
    const r = await ToolRunner.runTool({ name: 'run_command', args: { command: 'pkill -f "train.py"' } }, '', budget);
    assert.equal(r.ok, true, '重试成功 → 有真正的执行结果');
    assert.equal(r.text, '已停止后台任务', '输出原样带回');
    assert.equal(asked.length, 1, '补了弹窗（且只弹一次）');
    assert.equal(callN, 2, '执行请求发了两次（第一次被拒 → 携票据重试）');
    const retry = stub.seen.filter((s) => s.url.endsWith('/agent/tools/call')).pop();
    assert.equal(retry.body.grant, 'g-2', '重试带上现取的一次性票据');
    assert.equal(budget.exec, 1, '重试不重复扣命令预算（第一次没执行）');
  } finally { stub.restore(); }
});

test('ToolRunner.callAgentTool：needUnlock → 提示解锁并回调宿主', async () => {
  const { calls } = initRunner();
  const stub = stubFetch(() => jsonRes(403, { error: '需要解锁', needUnlock: true, osUser: 'leo' }));
  try {
    const r = await ToolRunner.callAgentTool('read_file', { path: '/tmp/a' });
    assert.equal(r.ok, false, 'needUnlock → ok:false');
    assert.equal(r.note, '需要解锁', 'note=需要解锁');
    assert.ok(r.text.includes('解锁'), '文本告诉模型要等用户解锁');
    assert.deepEqual(calls.needUnlock, ['leo'], '宿主收到 onNeedUnlock(osUser)');
    assert.equal(calls.toast.length, 1, '弹出解锁提示 toast');
  } finally { stub.restore(); }
});

test('ToolRunner.callAgentTool：needBind → 提示绑定本机账号并回调宿主', async () => {
  const { calls } = initRunner();
  const stub = stubFetch(() => jsonRes(403, { error: '还没有绑定', needBind: true }));
  try {
    const r = await ToolRunner.callAgentTool('read_file', { path: '/tmp/a' });
    assert.equal(r.ok, false, 'needBind → ok:false');
    assert.equal(r.note, '需要绑定本机账号', 'note=需要绑定本机账号');
    assert.ok(r.text.includes('绑定本机账号'), '文本告诉模型去设置里绑定');
    assert.equal(calls.needBind, 1, '宿主收到 onNeedBind()');
  } finally { stub.restore(); }
});

test('ToolRunner.callAgentTool：needPermission / needRoots → 原样带出服务端理由', async () => {
  initRunner();
  const s1 = stubFetch(() => jsonRes(403, { error: '权限不足：该文件不可写', needPermission: true }));
  try {
    const r = await ToolRunner.callAgentTool('write_file', { path: '/etc/x', content: 'x' });
    assert.equal(r.ok, false, 'needPermission → ok:false');
    assert.equal(r.note, '权限不足', 'note=权限不足');
    assert.equal(r.text, '权限不足：该文件不可写', '服务端理由原样回给模型');
  } finally { s1.restore(); }
  const s2 = stubFetch(() => jsonRes(403, { error: '路径不在可访问目录内', needRoots: true }));
  try {
    const r2 = await ToolRunner.callAgentTool('read_file', { path: '/etc/passwd' });
    assert.equal(r2.ok, false, 'needRoots → ok:false');
    assert.equal(r2.note, '路径不可访问', 'note=路径不可访问');
    assert.equal(r2.text, '路径不在可访问目录内', '服务端理由原样回给模型');
  } finally { s2.restore(); }
});

test('ToolRunner.callAgentTool：needLogin → 打开登录并回一句需要登录', async () => {
  const { calls } = initRunner();
  const stub = stubFetch(() => jsonRes(401, { error: '请先登录' }, { 'x-agent-auth': 'need-login' }));
  try {
    const r = await ToolRunner.callAgentTool('read_file', { path: '/tmp/a' });
    assert.equal(r.ok, false, 'needLogin → ok:false');
    assert.equal(r.note, '需要登录', 'note=需要登录');
    assert.equal(r.text, Prompts.text('plugin.need_login'), '文本来自 plugin.need_login');
    assert.equal(calls.openLogin.length, 1, '宿主被叫去打开登录框');
  } finally { stub.restore(); }
});

test('ToolRunner.callAgentTool：工具执行了但失败（HTTP 200 / ok:false）→ 输出不丢', async () => {
  initRunner();
  const stub = stubFetch(() => jsonRes(200, { ok: false, note: '超时', text: '$ sleep 9\n（超时已终止）' }));
  try {
    const r = await ToolRunner.callAgentTool('run_command', { command: 'sleep 9', }, undefined);
    assert.equal(r.ok, false, '业务失败仍是 ok:false');
    assert.equal(r.note, '超时', 'note 原样带回');
    assert.equal(r.text, '$ sleep 9\n（超时已终止）', '真正的输出不被换成 HTTP 200');
  } finally { stub.restore(); }
});

test('ToolRunner.callAgentTool：网络层失败 → 请求失败（不当作业务拒绝）', async () => {
  initRunner();
  const stub = stubFetch(() => { throw new TypeError('fetch failed'); });
  try {
    const r = await ToolRunner.callAgentTool('read_file', { path: '/tmp/a' });
    assert.equal(r.ok, false, '网络失败 → ok:false');
    assert.equal(r.note, '请求失败', 'note=请求失败');
    assert.ok(r.text.includes('调用服务端工具失败'), '文本是可读的传输层失败');
  } finally { stub.restore(); }
});

test('ToolRunner：stripBadArgs 去掉解析失败标记（__badArgs / __raw）', () => {
  assert.deepEqual(ToolRunner.stripBadArgs({ a: 1, __badArgs: true, __raw: '{bad' }), { a: 1 },
    '解析失败的调用只把可读参数发给服务端');
  assert.deepEqual(ToolRunner.stripBadArgs(null), {}, '非对象 → 空参数');
});

test('ToolRunner：pluginLimits 把面板限额随每次调用下发', () => {
  initRunner({
    val2: (k) => ({
      plugin_fs_read_kb: 128, plugin_fs_write_kb: 512, plugin_fs_nodes: 300,
      plugin_exec_out_kb: 32, plugin_exec_timeout: 30, plugin_wait_sec: 120,
    })[k],
  });
  assert.deepEqual(ToolRunner.pluginLimits(),
    { read_kb: 128, write_kb: 512, nodes: 300, out_kb: 32, timeout_sec: 30, wait_sec: 120 },
    '六项限额都来自 val2（服务端再按硬上限收敛一次）');
});

test('ToolRunner：联网搜索走同源代理，401 时给模型明确的话', async () => {
  initRunner();
  const ok = stubFetch(() => jsonRes(200, { ok: true, markdown: '# 结果一' }));
  try {
    const text = await ToolRunner.doSearch('天气', 5);
    assert.equal(text, '# 结果一', '返回服务端给的 markdown');
    assert.equal(ok.seen[0].body.max_results, 5, '条数随请求发出');
  } finally { ok.restore(); }
  const denied = stubFetch(() => jsonRes(401, { error: '请先登录' }, { 'x-agent-auth': 'need-login' }));
  try {
    await assert.rejects(() => ToolRunner.doSearch('天气', 5), /联网搜索需要登录/, '未登录 → 明说需要登录');
  } finally { denied.restore(); }
});

test('ToolRunner：联网搜索的单轮预算', async () => {
  const { budget } = initRunner();
  budget.search = budget.maxSearch;
  const r = await ToolRunner.runTool({ name: 'web_search', args: { query: 'x' } }, '', budget);
  assert.equal(r.ok, false, '预算用尽 → ok:false');
  assert.equal(r.note, '已达上限', 'note=已达上限');
  assert.ok(r.text.includes('联网检索次数已达上限'), '文本来自 loop.budget_search');
});

test('ToolRunner：memory_write 三条路径（关闭 / 缺内容 / 成功）', async () => {
  const off = initRunner({ val2: valMap({ mem_auto: false }) });
  const r1 = await ToolRunner.runTool({ name: 'memory_write', args: { scope: 'global', title: 'a', content: 'b' } }, '', off.budget);
  assert.equal(r1.note, '已关闭', 'mem_auto=false → 模型不能自己写记忆');
  const noArg = initRunner();
  const r2 = await ToolRunner.runTool({ name: 'memory_write', args: { scope: 'session' } }, '', noArg.budget);
  assert.equal(r2.note, '缺内容', 'title 与 content 都空 → 明确回绝');
  assert.equal(noArg.budget.aux, 0, '参数残缺不扣额度');
  const okRun = initRunner();
  const r3 = await ToolRunner.runTool({ name: 'memory_write', args: { scope: 'global', title: '偏好', content: '深色' } }, '', okRun.budget);
  assert.equal(r3.ok, true, '写记忆成功');
  assert.equal(r3.note, '已记住', '新条目 note=已记住');
  assert.ok(r3.text.includes('全局'), '文本点明写进全局记忆');
  assert.equal(okRun.budget.aux, 1, '改动类：成功才扣一格记忆预算');
  assert.deepEqual([okRun.calls.persist, okRun.calls.renderMemory, okRun.calls.ctxMeter], [1, 1, 1],
    '写记忆后宿主被通知持久化/重绘/刷新用量环');
});

test('ToolRunner：memory_write 的 scope="project"（有项目写项目；没项目落到会话并说明）', async () => {
  const mem1 = fakeMemory(true);
  const withP = initRunner({ Memory: mem1 });
  const r = await ToolRunner.runTool({ name: 'memory_write', args: { scope: 'project', title: '跑法', content: '用 up.sh 起' } }, '', withP.budget);
  assert.equal(r.ok, true, '有当前项目 → 写成功');
  assert.ok(r.text.includes('项目记忆'), '文本点明写进了项目记忆');
  assert.equal(mem1.writes[0].scope, 'project', 'scope 原样交给 Memory.write');
  const mem2 = fakeMemory(false);
  const noP = initRunner({ Memory: mem2 });
  const r2 = await ToolRunner.runTool({ name: 'memory_write', args: { scope: 'project', title: 'x', content: 'y' } }, '', noP.budget);
  assert.equal(mem2.writes[0].scope, 'session', '没有当前项目 → 落到会话记忆（不静默丢弃）');
  assert.ok(r2.text.includes('没有选中项目'), '并明确告诉模型为什么、去哪里选项目');
});

test('ToolRunner：memory_search / memory_read', async () => {
  const { budget } = initRunner();
  const hit = await ToolRunner.runTool({ name: 'memory_search', args: { query: '深色' } }, '', budget);
  assert.equal(hit.ok, true, '检索成功');
  assert.ok(hit.text.includes('偏好'), '命中条目出现在结果里');
  const miss = await ToolRunner.runTool({ name: 'memory_search', args: { query: '不存在' } }, '', budget);
  assert.ok(miss.text.includes('没有与'), '未命中给一句人话');
  assert.equal(budget.aux, 0, '读类（检索）不扣预算');
  const read = await ToolRunner.runTool({ name: 'memory_read', args: { id: 'm1' } }, '', budget);
  assert.equal(read.ok, true, '按 id 读到条目');
  assert.ok(read.text.includes('喜欢深色主题'), '正文在结果里');
  assert.ok(read.text.includes('全局记忆'), '能分辨全局/会话');
  const noRead = await ToolRunner.runTool({ name: 'memory_read', args: { id: 'nope' } }, '', budget);
  assert.equal(noRead.note, '未找到', '不存在的记忆 → 未找到');
});

test('ToolRunner：memory_forget（未找到不扣、找到才扣）', async () => {
  const { budget } = initRunner();
  const miss = await ToolRunner.runTool({ name: 'memory_forget', args: { id: 'nope' } }, '', budget);
  assert.equal(miss.note, '未找到', '不存在 → 未找到');
  assert.equal(budget.aux, 0, '空手不扣额度');
  const del = await ToolRunner.runTool({ name: 'memory_forget', args: { id: 'm1' } }, '', budget);
  assert.equal(del.ok, true, '删记忆成功');
  assert.equal(del.note, '已删除', 'note=已删除');
  assert.equal(budget.aux, 1, '改动类：删记忆扣一格');
});

test('ToolRunner：技能工具（list / use / write / delete 与拒绝路径）', async () => {
  /* 落盘靠**登记表自己的通知**（宿主订阅 Prompts.onChange → queuePrompts）。
     旧断言盯的是宿主的 save —— 而那个存的是"设置"，跟技能无关：模型建的技能于是只活在
     内存里、刷新即丢（2026-09-30 实测发现）。所以这里改盯登记表的通知。 */
  let notified = 0;
  Prompts.onChange(() => { notified += 1; });
  const r1 = initRunner();
  const empty = await ToolRunner.runTool({ name: 'list_skills', args: {} }, '', r1.budget);
  assert.ok(empty.text.includes('当前没有配置技能'), '没有技能时给一句人话');
  const miss = await ToolRunner.runTool({ name: 'use_skill', args: { name: 'nope' } }, '', r1.budget);
  assert.equal(miss.note, '未找到', '不存在的技能 → 未找到');
  assert.equal(r1.budget.aux, 0, '读类（加载技能）不扣预算');
  const item = Prompts.addSkill({ name: 'demo', description: '示例技能', text: '技能正文', auto: true });
  try {
    const list = await ToolRunner.runTool({ name: 'list_skills', args: {} }, '', r1.budget);
    assert.ok(list.text.includes('demo'), '新技能出现在清单里');
    const use = await ToolRunner.runTool({ name: 'use_skill', args: { name: 'demo' } }, '', r1.budget);
    assert.equal(use.note, '已加载技能', '加载技能成功');
    assert.ok(use.text.includes('【技能 demo】'), '正文随结果返回');
    const w2 = await ToolRunner.runTool({ name: 'skill_write', args: { name: 'demo-x', description: 'd', content: 'c' } }, '', r1.budget);
    assert.equal(w2.ok, true, '确认通过 → 新建技能');
    assert.equal(w2.note, '已新建技能', 'note=已新建技能');
    assert.ok(w2.text.includes('已创建'), '文本说明技能已创建');
    assert.ok(notified >= 1, '新建技能要让登记表通知订阅者（否则模型建的技能刷新即丢）');
    assert.ok(r1.calls.renderPrompt >= 1, '新建技能后重绘提示词面板');
    const deny = initRunner({ confirmSkillChange: async () => ({ ok: false }) });
    const w1 = await ToolRunner.runTool({ name: 'skill_write', args: { name: 'x', description: 'd', content: 'c' } }, '', deny.budget);
    assert.equal(w1.note, '用户未同意', '模型改技能要过确认闸门，拒绝则不写');
    assert.equal(deny.budget.aux, 0, '拒绝不扣预算');
    const r2 = initRunner();
    const delMiss = await ToolRunner.runTool({ name: 'skill_delete', args: { name: 'nope' } }, '', r2.budget);
    assert.equal(delMiss.note, '未找到', '删除不存在的技能 → 未找到');
    const del = await ToolRunner.runTool({ name: 'skill_delete', args: { name: 'demo' } }, '', r2.budget);
    assert.equal(del.ok, true, '确认通过 → 删除技能');
    assert.equal(del.note, '已删除', 'note=已删除');
  } finally {
    if (Prompts.findSkill('demo')) Prompts.removeSkill(item.id);
    const x = Prompts.findSkill('demo-x');
    if (x) Prompts.removeSkill(x.id);
  }
});

/* ============================ 传输文件（待下载） ============================ */

test('★ deliver_file：登录+绑定后注册；开关关掉就不给（与其它插件同一道闸门）', async () => {
  const { TOOL_DEFAULTS } = await import('../src/core/params.js');
  assert.equal(TOOL_DEFAULTS.plugin_deliver_on, true, '出厂默认是开的（面板上可以关）');
  initDefs();
  const names = namesOf(AgentDefs.pluginToolDefs());
  assert.ok(names.includes('deliver_file'), '默认开着 → 注册 deliver_file（实际 ' + names.join(',') + '）');
  initDefs({ val2: valMap({ plugin_deliver_on: false }) });
  const off = namesOf(AgentDefs.pluginToolDefs());
  assert.ok(!off.includes('deliver_file'), '关掉「传输文件」→ 不注册');
  initDefs({ bound: () => false });
  assert.deepEqual(AgentDefs.pluginToolDefs(), [], '未绑定本机账号 → 连它也不注册（它要读用户的磁盘）');
  assert.ok(AgentDefs.PLUGIN_TOOL_NAMES.has('deliver_file'), '它在插件族里（走同一套登录/绑定闸门与预算）');
  assert.ok(!AgentDefs.FS_WRITE_NAMES.includes('deliver_file'), '★ 不是"写文件"工具：不弹写确认框（它只往账号自己的下载目录拷一份）');
  assert.ok(!AgentDefs.FS_READ_NAMES.includes('deliver_file'), '也不是只读：它会创建文件，要扣 fs 预算');
  assert.ok(!AgentDefs.CONFIRM_SEQUENTIAL.has('deliver_file'), '无需串行（不碰同一份东西）');
  assert.equal(AgentDefs.labelOf({ name: 'deliver_file', args: { path: '/tmp/a.md', name: '报告.md' } }), '传给用户：报告.md',
    '卡片标题是"传给用户：…"（用 name，没有才用 path）');
});

test('★ asResult 保留可下载文件清单（界面据此画卡片），但只认白名单字段', async () => {
  /* 工具返回 files → 内核原样带进 trace（run-loop 的 onToolEnd 也会写进实时追踪条） */
  const result = await import('../src/core/agent.js').then(async (m) => {
    /* 直接驱动一次 run：假 stream 先给一个工具调用，再给收尾正文 */
    const calls = [];
    const out = await m.Agent.run({
      maxRounds: 3,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'deliver_file', description: '', parameters: { type: 'object', properties: {} } } }],
      opts: {},
      signal: null,
      stream: async function* () {
        if (!calls.length) {
          calls.push(1);
          yield { type: 'tool_calls', calls: [{ id: 'c1', name: 'deliver_file', args: { path: '/tmp/a.md' } }] };
        } else {
          yield { type: 'content', text: '好了' };
        }
      },
      runTool: async () => ({
        ok: true, note: '已放入待下载', text: '已放入',
        files: [{ name: '报告.md', size: 12, exec: false, packaged: false, source: '/tmp/a.md', 恶意字段: 'x' }],
      }),
      transformContext: (msgs) => msgs,
      hooks: {},
    });
    return out.trace;
  });
  assert.equal(result.length, 1, '一次工具调用一条追踪记录');
  assert.equal(result[0].files && result[0].files[0].name, '报告.md', '★ files 要活着（实际 ' + JSON.stringify(result[0].files) + '）');
  assert.equal(result[0].files[0].恶意字段, undefined, '白名单外的字段一律丢掉（工具参数不可信）');
});

/* ---------- wait 工具（长任务"提交后台 → 等待 → 查进度"的中间步） ---------- */

test('AgentDefs：wait 跟命令行同一个开关（plugin_exec_on），在插件族里但无需串行', () => {
  initDefs({ val2: valMap({ plugin_exec_on: false }) });
  assert.ok(!namesOf(AgentDefs.pluginToolDefs()).includes('wait'), '关掉命令行 → wait 一并 deregister');
  assert.ok(AgentDefs.PLUGIN_TOOL_NAMES.has('wait'), 'wait 在插件族里（同一套登录/绑定闸门）');
  assert.ok(!AgentDefs.CONFIRM_SEQUENTIAL.has('wait'), '等待不碰任何东西，无需串行');
  initDefs();
  assert.ok(namesOf(AgentDefs.pluginToolDefs()).includes('wait'), '默认（命令行开着）→ wait 注册');
  const def = AgentDefs.pluginToolDefs().find((d) => d.function.name === 'wait');
  assert.deepEqual(def.function.parameters.required, ['seconds'], '参数只要 seconds');
});

test('ToolRunner：wait 不占命令/文件预算，扣自己的等待预算', async () => {
  const { budget } = initRunner();
  const stub = stubFetch(() => jsonRes(200, { ok: true, note: '等待', text: '已等待 1 秒。' }));
  try {
    const r = await ToolRunner.runTool({ name: 'wait', args: { seconds: 1 } }, '', budget);
    assert.equal(r.ok, true, '服务端返回成功 → ok:true');
    assert.equal(budget.exec, 0, '不占命令预算');
    assert.equal(budget.fs, 0, '不占文件预算');
    assert.equal(budget.wait, 1, '扣的是等待预算（maxWait）');
  } finally { stub.restore(); }
});

test('ToolRunner：等待次数用尽 → loop.budget_wait 文案（不是 fs/exec 的那几句）', async () => {
  const { budget } = initRunner();
  budget.wait = budget.maxWait;
  const r = await ToolRunner.runTool({ name: 'wait', args: { seconds: 1 } }, '', budget);
  assert.equal(r.ok, false, '预算用尽 → ok:false');
  assert.equal(r.note, '已达上限', 'note=已达上限');
  assert.ok(r.text.includes('等待次数已达上限'), '文本来自 loop.budget_wait');
  assert.ok(r.text.includes('稍后再来问我进度'), '并指回"提交后稍后再问"这条出路');
});

test('ToolRunner：关掉命令行开关 → wait 一并停用（同一开关）', async () => {
  const { budget } = initRunner({ val2: valMap({ plugin_exec_on: false }) });
  const r = await ToolRunner.runTool({ name: 'wait', args: { seconds: 1 } }, '', budget);
  assert.equal(r.note, '已停用', '跟着命令行走同一个开关');
});

/* ---------- 屏幕操作插件（OmniParser 看屏幕 + xdotool 键鼠） ---------- */

test('AgentDefs：屏幕工具跟独立开关（plugin_screen_on，默认关），子智能体一律不给', () => {
  initDefs({ val2: valMap({ plugin_screen_on: false }) });
  const off = namesOf(AgentDefs.pluginToolDefs());
  for (const n of ['screen_see', 'screen_click', 'screen_type', 'screen_key']) {
    assert.ok(!off.includes(n), `开关关 → ${n} 不注册`);
  }
  initDefs({ val2: valMap({ plugin_screen_on: true }) });
  const on = namesOf(AgentDefs.pluginToolDefs());
  for (const n of ['screen_see', 'screen_click', 'screen_type', 'screen_key']) {
    assert.ok(on.includes(n), `开关开 → ${n} 注册（实际 ${on.join(',')}）`);
  }
  assert.ok(AgentDefs.PLUGIN_TOOL_NAMES.has('screen_see'), '在插件族里（同一套登录/绑定闸门）');
  assert.ok(AgentDefs.CONFIRM_SEQUENTIAL.has('screen_click') && AgentDefs.CONFIRM_SEQUENTIAL.has('screen_type'),
    '动作类必须串行（一个桌面一只鼠标）');
  const rw = AgentDefs.subagentToolDefsFor(AgentDefs.pluginToolDefs().concat(
    [{ type: 'function', function: { name: 'screen_see', description: '', parameters: { type: 'object', properties: {} } } }]
  ), true).map((d) => d.function.name);
  assert.ok(!rw.includes('screen_see') && !rw.includes('screen_click'), '★ 屏幕工具不给子智能体');
});

test('ToolRunner：屏幕工具有自己的预算与开关（不占 fs/exec）', async () => {
  const { budget } = initRunner({ val2: valMap({ plugin_screen_on: true }) });
  const stub = stubFetch(() => jsonRes(200, { ok: true, note: '已按键', text: '已发送按键：Return。' }));
  try {
    const r = await ToolRunner.runTool({ name: 'screen_key', args: { keys: 'Return' } }, '', budget);
    assert.equal(r.ok, true, '服务端返回成功 → ok:true');
    assert.equal(budget.screen, 1, '扣屏幕预算');
    assert.equal(budget.exec, 0, '不占命令预算');
    assert.equal(budget.fs, 0, '不占文件预算');
  } finally { stub.restore(); }
});

test('ToolRunner：屏幕开关关着 → screen 工具不执行', async () => {
  const { budget } = initRunner({});
  const r = await ToolRunner.runTool({ name: 'screen_see', args: {} }, '', budget);
  assert.equal(r.note, '已停用', '默认（关）→ 已停用');
  assert.equal(budget.screen, 0, '没扣预算');
});

test('AgentDefs：屏幕工具的卡片标题可读', () => {
  initDefs();
  assert.equal(AgentDefs.labelOf({ name: 'screen_click', args: { x: 30, y: 40 } }), '点击 (30,40)');
  assert.equal(AgentDefs.labelOf({ name: 'screen_see', args: {} }), '看屏幕');
  assert.equal(AgentDefs.labelOf({ name: 'screen_key', args: { keys: 'ctrl+c' } }), '按键：ctrl+c');
});
