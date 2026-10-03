// ToolsSection.jsx —— 权限与工具：访问级别、命令允许清单、各工具开关与调用次数/上限、可访问目录、服务端上限与危险清单
/*  边界（唯一一份，改动前先读）：**这一页只管工具与权限**——能不能用（访问级别 + 各工具开关）、
 *  能调用几次（单轮/每个子智能体的次数）、单次能多大（读取/写入/超时/输出/记录上限），
 *  模型本身的生成参数（温度、采样、上下文上限…）在「参数」（FIELDS）。
 *  两页曾经各画一份工具参数（同键两处可改），2026-10-03 去重：工具项只留在这里。 */
import { useMemo, useState } from 'react';
import { FolderPlus, RotateCcw, Trash2 } from 'lucide-react';
import { useApp } from '../../state/store.js';
import { val2 } from '../../state/host.js';
import { fmtBytes } from '../../lib/format.js';
import { setParam, setPromptEnabled, setRoots } from '../../state/settings.js';
import { TOOL_FIELDS, resolve } from '../../../core/params.js';
import { Prompts } from '../../../core/prompts.js';
import { AgentPolicy } from '../../../core/policy.js';
import { cn } from '../../lib/utils.js';
import { Badge } from '../../components/ui/badge.jsx';
import { Button } from '../../components/ui/button.jsx';
import { FieldDesc, SectionTitle } from '../../components/ui/field.jsx';
import { ImeInput } from '../../components/ui/ime-field.jsx';
import { toast } from '../../components/ui/toast.jsx';
import { EmptyHint, NoteBox, ParamRow } from './parts.jsx';

/* 工具开关组（TOOL_FIELDS 的 group → 标题）；access 组在下面单独画 */
const GROUPS = [
  ['fs', '文件与目录'],
  ['exec', '命令行'],
  ['search', '联网搜索'],
  ['memory', '记忆'],
  ['skills', '技能'],
  ['subagent', '子智能体'],
  ['record', '结果与记录'],
];

/* ============================ 访问级别 ============================ */

function AccessCard({ mode, all, active, onPick }) {
  const eff = AgentPolicy.eff(Object.assign({}, all, { agent_access: mode.value }), null);
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => onPick(mode.value)}
      className={cn(
        'flex w-full items-start gap-3 rounded-lg border px-3 py-2 text-left transition-colors',
        active ? 'border-primary/60 bg-accent/50' : 'border-border hover:bg-muted/50'
      )}
    >
      <span className="mt-0.5 text-base leading-none">{mode.icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium text-foreground">{mode.label}</span>
          {mode.danger ? <Badge variant="destructive">危险</Badge> : null}
          {active ? <Badge variant="success">当前</Badge> : null}
        </span>
        <FieldDesc>{mode.desc}</FieldDesc>
        <FieldDesc className="text-subtle">实际效果：{AgentPolicy.summary(eff)}</FieldDesc>
      </span>
    </button>
  );
}

function AccessLevels({ value, all, onPick }) {
  return (
    <div className="space-y-2 px-4">
      {AgentPolicy.MODES.map((m) => (
        <AccessCard key={m.value} mode={m} all={all} active={m.value === value} onPick={onPick} />
      ))}
    </div>
  );
}

/* ============================ 工具开关组 ============================ */

/* 内置联网搜索的开关：**不是** TOOL_FIELDS 里的参数，而是提示词登记表里那条内置技能
   （skill.web_search）的启停——它同时管三件事（唯一真源，别在别处再判一次）：
     · 注册：core/agent-defs.js 的 searchOn()（关掉 = 连 web_search 工具都不给模型）；
     · 注入：core/prompts.js 的 systemBlocks()（关掉 = 技能正文不进 system）；
     · 面板：「提示词 → ② 技能 → 联网搜索」那一行的开关（同一个值，两处都是它的视图）。
   所以这里直接读写登记表（setPromptEnabled），不新增参数、也不复制一份状态。 */
const SEARCH_FIELD = {
  label: '内置联网搜索（web_search）',
  kind: 'switch',
  tip: '关掉后：不再给模型注册 web_search 工具，联网搜索的技能正文与工具描述也不再注入——'
    + '模型完全不知道有联网这回事。需要联网时，可以在「提示词 → ② 技能」里自己装一份搜索技能'
    + '（例如让模型用 run_command 调一个搜索 CLI）。'
    + '与「提示词 → ② 技能 → 联网搜索」的开关是同一个值，改哪边都一样。',
};

function SearchBuiltinRow() {
  const { revision } = useApp();
  /* Prompts 是 core 层对象：登记表改动只 bump revision，这里按它重算（与 PromptsSection 同一姿势） */
  const on = useMemo(() => { void revision; return Prompts.enabled('skill.web_search'); }, [revision]);
  return (
    <ParamRow
      field={SEARCH_FIELD}
      value={on}
      desc={on ? '关掉即停用联网能力；它的提示词也随之不再注入。' : '已停用：模型不知道有联网这回事。'}
      onChange={(v) => setPromptEnabled('skill.web_search', v)}
    />
  );
}

function ToolGroup({ gid, title, all, searchOn }) {
  const entries = Object.entries(TOOL_FIELDS).filter(([, f]) => f.group === gid);
  if (!entries.length) return null;
  return (
    <section>
      <SectionTitle>{title}</SectionTitle>
      <div className="overflow-hidden rounded-lg border border-border">
        {gid === 'search' ? <SearchBuiltinRow /> : null}
        {entries.map(([key, field]) => (
          <ToolField key={key} fieldKey={key} field={field} value={all[key]} searchOff={gid === 'search' && !searchOn} />
        ))}
      </div>
    </section>
  );
}

/** 工具参数一行：控件与说明都走共用的 ParamRow（list 型自动用 chips 渲染） */
function ToolField({ fieldKey, field, value, searchOff }) {
  const desc = field.customOnly
    ? '只在访问级别为「自定」时生效'
    : searchOff
      ? '内置联网搜索已关闭：这一项在开启后才生效。'
      : field.kind === 'list'
        ? '命中的命令不再询问（任何档位都生效），只按「整条命令的前缀」匹配；带管道/串联的整行不豁免。'
        : null;
  return <ParamRow field={field} value={value} desc={desc} onChange={(v) => setParam(fieldKey, v, '')} />;
}

/* ============================ 可访问目录 ============================ */

function RootsCard({ roots, defaults, start, onAction }) {
  const [draft, setDraft] = useState('');
  const add = (path) => {
    const v = String(path || '').trim();
    if (!v) return;
    setDraft('');
    onAction('add', { path: v });
  };
  const missing = (defaults || []).filter((d) => !roots.includes(d));
  return (
    <section>
      <SectionTitle>可访问目录（文件工具能碰哪）</SectionTitle>
      <div className="space-y-2 px-4">
        <NoteBox>
          默认是<b>整个文件系统</b>（<span className="font-mono">/</span>）——agent 要能操作环境、系统盘这类
          非工作目录的内容。真正的限制来自<b>绑定账号的系统权限</b>（它做不到的，agent 也做不到）
          与服务端硬上限；想收窄就把下面几项换成具体目录。项目"放在哪"由设置 → 项目的<b>起点</b>决定
          （当前起点 <span className="font-mono">{start || '(未设置)'}</span>），与这里的范围无关。
        </NoteBox>
        {roots.length ? roots.map((r) => (
          <div key={r} className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5">
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{r}</span>
            <Button size="icon" variant="ghost" className="size-7 text-destructive" aria-label={`移除 ${r}`}
              onClick={() => onAction('remove', { path: r })} title="移除">
              <Trash2 />
            </Button>
          </div>
        )) : <EmptyHint>还没有可访问目录：文件工具与命令默认在第一个目录里工作。</EmptyHint>}

        <div className="flex items-center gap-2">
          <ImeInput value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="绝对路径，如 /home/leo/project"
            className="h-8 font-mono text-xs"
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(draft); } }} />
          <Button size="sm" variant="outline" onClick={() => add(draft)}><FolderPlus />添加</Button>
          <Button size="sm" variant="ghost" onClick={() => onAction('reset', {})}><RotateCcw />恢复默认</Button>
        </div>

        {missing.length ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-subtle">默认目录：</span>
            {missing.map((d) => (
              <button key={d} type="button" onClick={() => add(d)}
                className="rounded-md border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground">
                + {d}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

/* ============================ 服务端只读信息 ============================ */

function ServerInfo({ status }) {
  const limits = (status && status.limits) || {};
  const deny = Array.isArray(status && status.deny) ? status.deny : [];
  return (
    <section>
      <SectionTitle>服务端硬上限与危险清单</SectionTitle>
      <div className="space-y-3 px-4">
        <NoteBox tone="warn" title="这些是服务端的最后一道闸，界面上只能调得更小">
          <ul className="space-y-0.5">
            <li>单次读取上限：{fmtBytes(limits.readBytes)}</li>
            <li>单次写入上限：{fmtBytes(limits.writeBytes)}</li>
            <li>单次输出上限（命令输出与所有工具结果）：{fmtBytes(limits.outputBytes)}</li>
            <li>目录树/找文件节点上限：{limits.treeNodes ?? '-'}</li>
            <li>命令超时硬上限：{limits.timeoutSec ?? '-'} 秒</li>
          </ul>
          <p className="mt-1.5">
            上面各组的对应参数（单次读取/写入上限、输出上限、目录树/找文件结果上限、单条命令超时）
            只能比它更小；超出的会被服务端夹回。要<b>抬高</b>这些硬上限，改服务端环境变量后重启：
            <span className="font-mono text-[11px]"> AGENT_READ_MAX_BYTES / AGENT_WRITE_MAX_BYTES /
            AGENT_OUTPUT_MAX_BYTES / AGENT_TREE_MAX_NODES / AGENT_EXEC_MAX_SEC</span>。
          </p>
        </NoteBox>

        <NoteBox tone="danger" title={`危险命令清单（${deny.length} 条）——命中不等于拒绝`}>
          <p className="mb-1.5">命中这些模式时，界面会弹一次授权窗，你点了「授权执行」才会跑（票据只对这一条命令有效）。</p>
          <div className="max-h-40 overflow-y-auto rounded-md border border-destructive/30 bg-card/60 p-2">
            {deny.length ? deny.map((d) => (
              <div key={d} className="truncate font-mono text-[11px] text-muted-foreground">{d}</div>
            )) : <span className="text-[11px]">（服务端没有下发清单）</span>}
          </div>
        </NoteBox>
      </div>
    </section>
  );
}

/* ============================ 分区 ============================ */

/** 可访问目录：优先服务端下发的生效值，其次设置里的记录 */
const rootsOf = (status, settings) => (status && status.roots)
  || (settings && settings.tools && settings.tools.roots) || [];

function rootsAction(kind, payload, roots) {
  if (kind === 'remove' && roots.length <= 1) { toast('至少要保留一个可访问目录', 'err'); return; }
  setRoots(kind, payload);
}

function ServerPanels({ status, roots }) {
  return (
    <>
      <RootsCard roots={roots} defaults={status.defaults || []} start={status.start || ''}
        onAction={(k, p) => rootsAction(k, p, roots)} />
      <ServerInfo status={status} />
    </>
  );
}

export default function ToolsSection() {
  const st = useApp();
  const status = st.agentStatus;
  const all = resolve(st.settings || {}, '', '');
  const roots = rootsOf(status, st.settings);
  /* 内置联网搜索的当前状态（真源在提示词登记表；revision 变了就重算，见 SearchBuiltinRow） */
  const searchOn = useMemo(() => { void st.revision; return Prompts.enabled('skill.web_search'); }, [st.revision]);

  return (
    <div className="space-y-4 pb-6">
      <div className="px-4 pt-3">
        <NoteBox>
          这一页只管<b>工具与权限</b>：能不能用（访问级别与各工具开关）、<b>能调用几次</b>
          （单轮与每个子智能体的次数）、单次能读/写/输出多大（各上限），以及工具能碰哪些目录。
          模型本身的生成参数（温度、采样、上下文上限…）在「<b>参数</b>」里。
        </NoteBox>
      </div>

      <SectionTitle>访问级别</SectionTitle>
      <AccessLevels value={val2('agent_access')} all={all} onPick={(v) => setParam('agent_access', v, '')} />

      <ToolGroup gid="access" title="命令允许清单" all={all} />
      {GROUPS.map(([gid, title]) => <ToolGroup key={gid} gid={gid} title={title} all={all} searchOn={searchOn} />)}

      {status ? <ServerPanels status={status} roots={roots} /> : (
        <div className="px-4">
          <NoteBox>未登录或没绑定本机账号：可访问目录、危险清单与服务端上限要登录后才显示。</NoteBox>
        </div>
      )}
    </div>
  );
}
