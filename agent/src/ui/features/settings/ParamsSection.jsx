// ParamsSection.jsx —— 模型参数：作用范围（全局 / 当前模型）、快速预设、按组参数行
/*  边界（唯一一份，改动前先读）：**这一页只放模型生成参数**（core/params.js 的 FIELDS：
 *  温度/采样/重复惩罚/上下文与扩展）。工具的开关、调用次数、可访问目录与权限在「权限与工具」
 *  （TOOL_FIELDS）。两页曾经各画一份工具参数（同键两处可改），2026-10-03 去重：工具项只留在
 *  「权限与工具」。新增参数时按这条归位，别再让同一项出现在两页里。 */
import { useState } from 'react';
import { Eraser, RotateCcw } from 'lucide-react';
import { useApp } from '../../state/store.js';
import { activeProvider } from '../../state/host.js';
import { setParam, resetParamSection, applyPreset, clearModelOverrides } from '../../state/settings.js';
import { FIELDS, GROUPS, PRESETS, modelKey, overriddenBy, resolve } from '../../../core/params.js';
import { Badge } from '../../components/ui/badge.jsx';
import { Button } from '../../components/ui/button.jsx';
import { FieldDesc, SectionTitle } from '../../components/ui/field.jsx';
import { ChoiceGroup, EmptyHint, NoteBox, ParamRow } from './parts.jsx';

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

      <div className="px-4">
        <NoteBox>
          这一页只放<b>模型生成参数</b>（可以按模型单独覆盖）。工具的开关、调用次数与上限、
          可访问目录与权限在「<b>权限与工具</b>」里。
        </NoteBox>
      </div>
    </div>
  );
}
