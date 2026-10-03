/* core/memory.js —— 三类记忆（全局 / 项目 / 会话）与"项目记忆"注入区块的回归
 *
 *  项目记忆是 2026-09-30 新增的一类：跟着"当前项目"（一个根目录）走，
 *  真源是服务端的项目记忆文件夹（每条一个 .md，见 lib/agent/projects.js），
 *  这里只测 core 层：作用域分派、id 生成（可读文件名）、注入区块的内容与开关。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Memory } from '../src/core/memory.js';

/** 假登记表：只认这几条文本，其余回落成模块内的兜底文案 */
const fakePrompts = {
  text(id) {
    return {
      'memory.project.intro': '当前项目：',
      'memory.project.usage': '（索引；正文用 memory_read）',
      'memory.project.empty': '（这个项目还没有记忆）',
      'memory.index.intro': '你的全局记忆：',
      'memory.session.intro': '本会话的记忆：',
    }[id] || '';
  },
};

const PROJECT = { id: 'htmlweb-ab12cd34', name: '文档站', root: '/w/htmlweb', memoryDir: '/s/agent/admin/projects/htmlweb-ab12cd34/memory' };
const reset = () => {
  Memory.init({ Prompts: fakePrompts });
  Memory.load([], []);   // 项目条目不经 load（只有 setProject(meta, entries) 一条来路）
  Memory.setProject(null);
};

test('记忆作用域：三类互不串味，listOf/serialize 各给各的', () => {
  reset();
  Memory.setProject(PROJECT, []);
  Memory.write({ scope: 'global', title: '偏好', content: '深色', source: 'user' });
  Memory.write({ scope: 'project', title: '跑法', content: 'up.sh', source: 'model' });
  Memory.write({ scope: 'session', title: '待办', content: '跑单测' });
  assert.deepEqual(Memory.listOf('global').map((e) => e.title), ['偏好']);
  assert.deepEqual(Memory.listOf('project').map((e) => e.title), ['跑法']);
  assert.deepEqual(Memory.listOf('session').map((e) => e.title), ['待办']);
  assert.equal(Memory.listOf('project')[0].source, 'model', 'source 标记跟着条目走');
  assert.equal(Memory.serialize('project').length, 1);
});

test('项目记忆的 id 由标题生成（它就是 Markdown 文件名，要可读）', () => {
  reset();
  Memory.setProject(PROJECT, []);
  const r = Memory.write({ scope: 'project', title: '启动方式', content: '用 up.sh' });
  assert.equal(r.entry.id, '启动方式', '中文标题直接当文件名');
  const r2 = Memory.write({ scope: 'project', title: 'a/b: c', content: 'x' });
  assert.ok(!/[/:]/.test(r2.entry.id), '路径分隔符被换掉（不会写坏目录结构）：' + r2.entry.id);
  const r3 = Memory.write({ scope: 'global', title: '启动方式', content: 'x' });
  assert.notEqual(r3.entry.id, '启动方式', '全局记忆仍用随机 id（不进文件名，没有可读性要求）');
});

test('同标题合并：项目记忆与全局记忆同一口径（不重复堆积）', () => {
  reset();
  Memory.setProject(PROJECT, []);
  Memory.write({ scope: 'project', title: '跑法', content: 'A' });
  const again = Memory.write({ scope: 'project', title: '跑法', content: 'B' });
  assert.equal(again.updated, true, '同标题 = 更新，不是新增');
  assert.equal(Memory.listOf('project').length, 1);
  assert.equal(Memory.listOf('project')[0].content, 'B');
});

test('★ 项目记忆区块：项目名 / 根目录 / 记忆文件夹都在，条目只给索引（正文按需取）', () => {
  reset();
  const tail = '这一段只在全文模式里出现：' + '长'.repeat(120);
  Memory.setProject(PROJECT, [{ id: '跑法', title: '跑法', content: '用 up.sh 起服务。' + tail, source: 'user' }]);
  const b = Memory.projectBlock('index');
  assert.equal(b.id, 'memory.project');
  assert.ok(b.text.includes('文档站'), '有项目名');
  assert.ok(b.text.includes('/w/htmlweb'), '有项目根目录（模型据此知道"这个项目在哪"）');
  assert.ok(b.text.includes(PROJECT.memoryDir), '有记忆文件夹位置');
  assert.ok(b.text.includes('[跑法]'), '有条目索引');
  assert.ok(!b.text.includes(tail), '索引模式只给摘要，不给正文（省 token）');
  const full = Memory.projectBlock('full');
  assert.ok(full.text.includes(tail), '全文模式给正文');
  assert.equal(Memory.projectBlock('off'), null, 'off = 不注入');
});

test('没有当前项目 → 不注入项目记忆（不注入空壳）；空项目 → 给一句"还没有记忆"', () => {
  reset();
  assert.equal(Memory.projectBlock('index'), null, '没项目就没有这一段');
  Memory.setProject(PROJECT, []);
  const b = Memory.projectBlock('index');
  assert.ok(b && b.text.includes('（这个项目还没有记忆）'), '有项目但没条目：仍然注入（它同时告诉模型项目在哪）');
});

test('setProject：换项目换条目；meta 为空清空；不给 entries 时保留现有条目', () => {
  reset();
  Memory.setProject(PROJECT, [{ id: 'a', title: 'A', content: '1' }]);
  Memory.setProject(PROJECT);                                   // 只换事实、不动条目（登录拉数据那条路）
  assert.equal(Memory.listOf('project').length, 1, '不给 entries = 保留');
  Memory.setProject({ id: 'other-1', name: '别的', root: '/w/o' }, [{ id: 'b', title: 'B', content: '2' }]);
  assert.deepEqual(Memory.listOf('project').map((e) => e.title), ['B'], '换项目 = 换条目');
  Memory.setProject(null);
  assert.equal(Memory.listOf('project').length, 0, '退出项目 = 清空');
  assert.equal(Memory.projectMeta, null);
});

test('检索与定位跨三类：scope 过滤、find 先项目后全局再会话、scopeCn 中文名', () => {
  reset();
  Memory.setProject(PROJECT, [{ id: 'p1', title: '项目跑法', content: 'up.sh' }]);
  Memory.load([{ id: 'g1', title: '偏好', content: '深色主题' }], [{ id: 's1', title: '待办', content: '跑单测' }]);
  const all = Memory.search('跑');
  assert.deepEqual(all.map((h) => h.scope).sort(), ['project', 'session'], '两个作用域都命中');
  assert.deepEqual(Memory.search('深色', 'global').map((h) => h.scope), ['global'], 'scope 过滤生效');
  assert.equal(Memory.find('p1').title, '项目跑法');
  assert.equal(Memory.find('项目跑法').id, 'p1', '按标题也能找到');
  assert.equal(Memory.scopeCn('project'), '项目');
  assert.equal(Memory.scopeCn('session'), '会话');
});

test('★ load 内容没变不发变更事件（载入不是"用户改了记忆"——会误写盘、丢会话）', () => {
  reset();
  let n = 0;
  Memory.onChange(() => { n += 1; });
  const g = [{ id: 'g1', title: '偏好', content: '深色' }];
  Memory.load(g, []);
  assert.equal(n, 1, '第一次载入（有内容）发一次');
  Memory.load(g.map((e) => Object.assign({}, e)), []);
  assert.equal(n, 1, '内容相同 → 不再发（订阅方据此落盘，多发一次就多写一次）');
  Memory.load([{ id: 'g1', title: '偏好', content: '浅色' }], []);
  assert.equal(n, 2, '内容变了才发');
});
