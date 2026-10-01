// ParamsSection.jsx —— 生成参数：作用范围（全局 / 当前模型）、快速预设、按组参数行、Agent 行为子区
import { useState } from 'react';
import { Eraser, RotateCcw } from 'lucide-react';
import { useApp } from '../../state/store.js';
import { activeProvider } from '../../state/host.js';
import { setParam, resetParamSection, applyPreset, clearModelOverrides } from '../../state/settings.js';
import { FIELDS, GROUPS, PRESETS, TOOL_FIELDS, modelKey, overriddenBy, resolve } from '../../../core/params.js';
import { AgentPolicy } from '../../../core/policy.js';
import { Badge } from '../../components/ui/badge.jsx';
import { Button } from '../../components/ui/button.jsx';
import { FieldDesc, SectionTitle } from '../../components/ui/field.jsx';
import { ChoiceGroup, EmptyHint, NoteBox, ParamRow } from './parts.jsx';

/* Agent 行为子区的分组顺序与标题（TOOL_FIELDS 的 group 字段为准） */
const TOOL_GROUPS = [
  ['access', '访问级别与豁免'],
  ['fs', '文件与目录'],
  ['exec', '命令行'],
  ['search', '联网搜索'],
  ['memory', '记忆'],
  ['skills', '技能'],
];

/* ============================ 作用范围 ============================ */

function ScopePicker({ scope, modelKeyValue, modelLabel, onPick }) {
  if (!modelKeyValue) {
    return (
      <div className="px-4 pb-1">
        <NoteBox>还没有可用的当前模型：下面改的是全局参数。配置模型后可以在这里按模型单独覆盖。</NoteBox>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-1">
      <span className="text-xs text-muted-foreground">作用范围</span>
      <ChoiceGroup
        options={[['', '全局'], [modelKeyValue, `当前模型（${modelLabel}）`]]}
        value={scope}
        onChange={onPick}
      />
      <span className="text-xs text-subtle">
        {scope ? '以下的改动只影响这个模型' : '以下的改动对所有模型生效'}
      </span>
    </div>
  );
}

/* ============================ 快速预设 ============================ */

function PresetBar({ scope }) {
  return (
    <div className="px-4 pt-1">
      <div className="flex flex-wrap items-center gap-1.5">
        {PRESETS.map((preset) => (
          <Button key={preset.id} variant="outline" size="sm" onClick={() => applyPreset(preset, scope)}>
            {preset.label}
          </Button>
        ))}
      </div>
      <FieldDesc>预设只写它列出的那几项（如「长文 128K」会同时调大上下文上限），其余参数不动。</FieldDesc>
    </div>
  );
}

/* ============================ 单个参数分组 ============================ */

function GroupBlock({ group, values, settings, pid, model, scope }) {
  const entries = Object.entries(FIELDS).filter(([, f]) => f.group === group.id);
  if (!entries.length) return null;
  const keys = entries.map(([k]) => k);
  return (
    <section>
      <div className="flex items-end gap-2">
        <SectionTitle className="flex-1">{group.label}</SectionTitle>
        <Button size="sm" variant="ghost" className="text-subtle"
          onClick={() => resetParamSection(keys, scope)} title="把本节参数恢复成出厂值">
          <RotateCcw />重置本节
        </Button>
      </div>
      <div className="overflow-hidden rounded-lg border border-border">
        {entries.map(([key, field]) => (
          <ParamRow
            key={key}
            field={field}
            value={values[key]}
            overridden={!!scope && overriddenBy(settings, pid, model, key)}
            onChange={(v) => setParam(key, v, scope)}
          />
        ))}
      </div>
    </section>
  );
}

/* ============================ Agent 行为（全局一份） ============================ */

function toolDesc(key, all) {
  if (key !== 'agent_access') return null;
  const meta = AgentPolicy.meta(all.agent_access);
  return `${meta.label}：${AgentPolicy.summary(AgentPolicy.eff(all, null))}`;
}

function ToolBlock({ all }) {
  return (
    <section>
      <SectionTitle>Agent 行为</SectionTitle>
      <NoteBox>
        下面这些是与工具、权限相关的参数，只有全局一份（不参与每模型覆盖）：
        选了「当前模型」作用范围时，它们改动依然对所有模型生效。
      </NoteBox>
      <div className="space-y-3 pt-2">
        {TOOL_GROUPS.map(([gid, title]) => {
          const entries = Object.entries(TOOL_FIELDS).filter(([, f]) => f.group === gid);
          if (!entries.length) return null;
          return (
            <div key={gid}>
              <p className="px-1 pb-1 text-xs font-medium text-subtle">{title}</p>
              <div className="overflow-hidden rounded-lg border border-border">
                {entries.map(([key, field]) => (
                  <ParamRow
                    key={key}
                    field={field}
                    value={all[key]}
                    desc={toolDesc(key, all)}
                    onChange={(v) => setParam(key, v, '')}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ============================ 当前模型条 ============================ */

function ActiveModelBar({ p, scope, onClear }) {
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
      <Badge variant="secondary" className="font-mono">
        当前模型：{p ? `${p.name || '未命名'} · ${p.model || '未填模型'}` : '未配置'}
      </Badge>
      {scope ? (
        <Button size="sm" variant="outline" onClick={onClear}>
          <Eraser />清除该模型的单独覆盖
        </Button>
      ) : null}
    </div>
  );
}

/* ============================ 分区 ============================ */

/** 每模型覆盖的键：<服务商id>::<模型名>；模型换了就回落到全局，避免改错对象 */
const scopeOf = (raw, mk) => (raw === mk ? mk : '');
const modelPair = (p) => (p ? [p.id, p.model] : ['', '']);

export default function ParamsSection() {
  const st = useApp();
  const p = activeProvider();
  const settings = st.settings || {};
  const mk = p ? modelKey(p.id, p.model) : '';
  const [rawScope, setRawScope] = useState('');
  const scope = scopeOf(rawScope, mk);
  const [pid, pmodel] = modelPair(p);
  const focused = scope ? [pid, pmodel] : ['', ''];
  const values = resolve(settings, focused[0], focused[1]);
  const all = resolve(settings, pid, pmodel);

  return (
    <div className="space-y-4 pb-6">
      <ActiveModelBar p={p} scope={scope} onClear={() => clearModelOverrides(scope)} />
      <ScopePicker scope={scope} modelKeyValue={mk} modelLabel={pmodel} onPick={setRawScope} />
      <PresetBar scope={scope} />

      {GROUPS.map((g) => (
        <GroupBlock
          key={g.id}
          group={g}
          values={values}
          settings={settings}
          pid={pid}
          model={pmodel}
          scope={scope}
        />
      ))}

      {mk ? null : <EmptyHint className="mx-4">配置一个模型后，这里可以按模型单独覆盖参数。</EmptyHint>}

      <ToolBlock all={all} />
    </div>
  );
}
