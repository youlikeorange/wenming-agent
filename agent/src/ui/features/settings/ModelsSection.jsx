// ModelsSection.jsx —— 模型分区：模板快速添加、已配置列表（选中/测试/删除）、编辑表单、模型清单点选
import { useState } from 'react';
import { Check, ChevronDown, ChevronRight, Download, Trash2 } from 'lucide-react';
import { useApp } from '../../state/store.js';
import {
  addProvider, updateProvider, removeProvider, setActiveProvider, listModels, testProvider,
} from '../../state/settings.js';
import { TEMPLATES, PROTOCOL_LIST, getProtocol } from '../../../core/protocol.js';
import { parseExtraBody } from '../../../core/params.js';
import { cn } from '../../lib/utils.js';
import { Badge } from '../../components/ui/badge.jsx';
import { Button } from '../../components/ui/button.jsx';
import { FieldDesc, SectionTitle } from '../../components/ui/field.jsx';
import { ImeInput } from '../../components/ui/ime-field.jsx';
import { Label } from '../../components/ui/label.jsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select.jsx';
import { Spinner } from '../../components/ui/spinner.jsx';
import { toast } from '../../components/ui/toast.jsx';
import { EmptyHint, JsonTextarea, NumberInput } from './parts.jsx';
import { askConfirm } from '../../state/host.js';

/** 测试用的配置引用：草稿里新填了密钥就用临时配置（adHoc 显式标记），
    否则让服务端按 id 取已保存的密钥与自定义头。 */
const testRef = (p, apiKey, headers) => (apiKey
  ? { adHoc: true, type: p.type, baseUrl: p.baseUrl, model: p.model, apiKey, headers, sessionHeader: p.sessionHeader }
  : { provider: p.id, type: p.type, baseUrl: p.baseUrl, model: p.model });

async function runTest(cfg) {
  const r = await testProvider(cfg);
  if (r.ok) toast(`连接正常：列出 ${r.models.length} 个模型`, 'ok');
  else toast('连接失败：' + r.error, 'err');
  return r;
}

/* ============================ 模板快速添加 ============================ */

function TemplateGrid({ onPick }) {
  return (
    <>
      <SectionTitle>快速添加</SectionTitle>
      <div className="flex flex-wrap gap-1.5 px-4 pt-0.5">
        {TEMPLATES.map((t) => (
          <Button key={t.key} variant="outline" size="sm" onClick={() => onPick(t)} title={t.note || t.baseUrl}>
            {t.name}
          </Button>
        ))}
      </div>
      <div className="px-4 pt-2">
        <FieldDesc>点一个模板会直接建好一条配置（地址与模型名已填），再补上密钥即可。</FieldDesc>
      </div>
    </>
  );
}

/* ============================ 已配置列表 ============================ */

/** 列表本体：点一行展开编辑，点已展开的那行收起 */
function ProviderList({ providers, activeId, editingId, busyId, onToggle, onTest, onUse, onDelete }) {
  if (!providers.length) {
    return <EmptyHint>还没有配置模型：点上面的模板添加一个，或选「自定义…」自己填。</EmptyHint>;
  }
  const toggle = (id) => onToggle(id === editingId ? null : id);
  return providers.map((p) => (
    <ProviderRow
      key={p.id}
      p={p}
      active={p.id === activeId}
      editing={p.id === editingId}
      busy={busyId === p.id}
      onEdit={() => toggle(p.id)}
      onTest={() => onTest(p)}
      /* onUse 收的是**服务商 id**（ModelsSection 直接接的是 setActiveProvider）。
         旧写法传了整个 p，setActiveProvider 里 `p.id === id` 永远不成立、静默早退——
         表现就是「设为当前」点了没反应。 */
      onUse={() => onUse(p.id)}
      onDelete={() => onDelete(p)}
    />
  ));
}

function ProviderRow({ p, active, editing, busy, onEdit, onTest, onUse, onDelete }) {
  const Chevron = editing ? ChevronDown : ChevronRight;
  return (
    <div
      onClick={onEdit}
      className={cn(
        'flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-1.5 rounded-md border px-3 py-2 transition-colors',
        editing ? 'border-primary/60 bg-accent/50' : 'border-border hover:bg-muted/50'
      )}
    >
      <Chevron className="size-4 shrink-0 text-subtle" aria-hidden="true" />
      {/* 这一块既是"点开编辑"的键盘入口，也是 AT 的读屏目标；外层 div 的 onClick 只负责
          把整行的空白处也算进点击区，所以这里必须 stopPropagation，否则一次点击会切换两次 */}
      <button
        type="button"
        aria-expanded={editing}
        title={editing ? '收起编辑' : '点击展开编辑'}
        className="min-w-[14rem] flex-1 text-left"
        onClick={(e) => { e.stopPropagation(); onEdit(); }}
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-sm font-medium text-foreground">{p.name || '未命名'}</span>
          {active ? <Badge variant="success">当前</Badge> : null}
          {p.hasKey === false ? <Badge variant="warning">未填密钥</Badge> : null}
        </div>
        <p className="truncate font-mono text-xs text-muted-foreground">
          {p.type} · {p.model || '(未填模型名)'}
        </p>
        <p className="truncate font-mono text-[11px] text-subtle" title={p.baseUrl || ''}>{p.baseUrl || '(未填 Base URL)'}</p>
      </button>
      <div className="ml-auto flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
        {busy ? <Spinner size="sm" /> : null}
        {active ? null : (
          <Button size="sm" variant="ghost" onClick={onUse} title="设为当前使用的模型">设为当前</Button>
        )}
        <Button size="sm" variant="outline" onClick={onTest}>测试</Button>
        <Button size="icon" variant="ghost" className="size-8 text-destructive" aria-label="删除该模型配置" onClick={onDelete}>
          <Trash2 />
        </Button>
      </div>
    </div>
  );
}

/* ============================ 模型清单（拉取后点选填入） ============================ */

function ModelChips({ provider, onPick }) {
  const models = Array.isArray(provider.models) ? provider.models : [];
  if (!models.length) return null;
  return (
    <div className="border-t border-border px-4 py-2">
      <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
        <span>模型清单（{models.length}，点一个填入模型名）</span>
        {provider.keyHint ? <span className="font-mono text-subtle">已存密钥 {provider.keyHint}</span> : null}
      </div>
      <div className="flex max-h-40 flex-wrap gap-1 overflow-y-auto rounded-md border border-border p-2">
        {models.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onPick(m)}
            className={cn(
              'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[11px] transition-colors',
              m === provider.model
                ? 'border-primary/60 bg-accent text-accent-foreground'
                : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground'
            )}
          >
            {m === provider.model ? <Check className="size-3" /> : null}
            <span className="max-w-[18rem] truncate">{m}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ============================ 编辑表单 ============================ */

/** 表单草稿：全部本地 state，点「保存」才写服务端（密钥留空 = 保持原值） */
function useProviderDraft(provider) {
  const [name, setName] = useState(provider.name || '');
  const [type, setType] = useState(provider.type || 'openai');
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl || '');
  const [model, setModel] = useState(provider.model || '');
  const [key, setKey] = useState('');
  const [ctxLimit, setCtxLimit] = useState(provider.ctxLimit ? String(provider.ctxLimit) : '');
  const [extra, setExtra] = useState(provider.extraBody || '');
  const [headers, setHeaders] = useState(provider.headers ? JSON.stringify(provider.headers, null, 2) : '');
  const [sessionHeader, setSessionHeader] = useState(provider.sessionHeader || '');
  return {
    name, setName, type, setType, baseUrl, setBaseUrl, model, setModel,
    key, setKey, ctxLimit, setCtxLimit, extra, setExtra, headers, setHeaders,
    sessionHeader, setSessionHeader,
  };
}

function NameTypeFields({ d }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <Label htmlFor="p-name" className="mb-1.5 block text-xs text-muted-foreground">名称</Label>
        <ImeInput id="p-name" value={d.name} onChange={(e) => d.setName(e.target.value)} placeholder="例：本机 Qwen" />
      </div>
      <div>
        <Label htmlFor="p-type" className="mb-1.5 block text-xs text-muted-foreground">协议类型</Label>
        <Select value={d.type} onValueChange={d.setType}>
          <SelectTrigger id="p-type"><SelectValue /></SelectTrigger>
          <SelectContent>
            {PROTOCOL_LIST.map((x) => <SelectItem key={x.id} value={x.id}>{x.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

function ModelKeyFields({ d, provider }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <Label htmlFor="p-model" className="mb-1.5 block text-xs text-muted-foreground">模型名</Label>
        <ImeInput id="p-model" value={d.model} onChange={(e) => d.setModel(e.target.value)}
          className="font-mono text-xs" placeholder="如 deepseek-chat" />
      </div>
      <div>
        <Label htmlFor="p-key" className="mb-1.5 block text-xs text-muted-foreground">API Key</Label>
        <ImeInput id="p-key" type="password" autoComplete="off" value={d.key}
          onChange={(e) => d.setKey(e.target.value)} className="font-mono text-xs"
          placeholder={provider.hasKey ? `已保存 ${provider.keyHint || ''}（留空 = 保持不变）` : '粘贴密钥'} />
      </div>
    </div>
  );
}

function KeyHintRow({ provider, onClear }) {
  if (!provider.hasKey) return null;
  return (
    <div className="flex items-center justify-between">
      <FieldDesc>密钥只存在服务端，浏览器拿不到原文；留空保存 = 保持原值。</FieldDesc>
      <Button size="sm" variant="outline" onClick={onClear}>清除密钥</Button>
    </div>
  );
}

function AdvancedFields({ d }) {
  return (
    <div className="grid grid-cols-2 gap-3 pt-1">
      <div>
        <Label htmlFor="p-ctx" className="mb-1.5 block text-xs text-muted-foreground">上下文上限（token）</Label>
        <NumberInput id="p-ctx" className="w-full" value={d.ctxLimit} min={512} step={512}
          onCommit={(v) => d.setCtxLimit(v === '' ? '' : String(v))} placeholder="如 32768" />
        <FieldDesc>只影响用量环与自动压缩阈值，不发给模型。</FieldDesc>
      </div>
      <div>
        <Label htmlFor="p-extra" className="mb-1.5 block text-xs text-muted-foreground">额外请求体（JSON）</Label>
        <JsonTextarea id="p-extra" rows={3} value={d.extra} onCommit={d.setExtra}
          placeholder='{"options":{"num_ctx":32768}}' />
        <p className="mt-1 text-[11px] leading-snug text-subtle">
          直接合并进请求体，给协议之外的厂商扩展用（核心字段 model/messages/stream/tools 不允许被覆盖）。
        </p>
      </div>
      <div>
        <Label htmlFor="p-headers" className="mb-1.5 block text-xs text-muted-foreground">额外请求头（JSON）</Label>
        <JsonTextarea id="p-headers" rows={2} value={d.headers} onCommit={d.setHeaders}
          placeholder='{"X-Api-Version":"2024-01"}' />
        <p className="mt-1 text-[11px] leading-snug text-subtle">
          有些网关除密钥外还要额外的头（例如企业网关要 <code className="md-code">X-Api-Version</code>）。
          这里填的会原样带上；Authorization / x-api-key / Host 不允许在这里覆盖
          （那两个由密钥与地址决定）。opencode 要的 <code className="md-code">x-opencode-session</code>
          属于下面那一栏，程序会自动带上，不用写在这儿。
        </p>
      </div>
      <div>
        <Label htmlFor="p-sess" className="mb-1.5 block text-xs text-muted-foreground">会话标识头（可选）</Label>
        <ImeInput id="p-sess" value={d.sessionHeader} onChange={(e) => d.setSessionHeader(e.target.value)}
          className="font-mono text-xs" placeholder="留空 = 自动（opencode 自动带 x-opencode-session）" />
        <p className="mt-1 text-[11px] leading-snug text-subtle">
          头名，不带值：值要用「这段对话的 id」，所以由程序在每次请求时填（同一段对话恒定，
          上游据此做路由与提示词缓存）。opencode 的 Go 网关不带这个头会直接 400，
          程序按 Base URL 认出来会自动加；其它自建网关需要时在这里填头名。
        </p>
      </div>
    </div>
  );
}

function FormHeader({ provider, isActive, onClose }) {
  return (
    <div className="flex items-center justify-between border-b border-border px-4 py-2">
      <span className="truncate text-sm font-semibold text-foreground">编辑：{provider.name || '未命名'}</span>
      <div className="flex items-center gap-1.5">
        {isActive ? <Badge variant="success">当前使用</Badge>
          : <Button size="sm" variant="ghost" onClick={() => setActiveProvider(provider.id)}>设为当前</Button>}
        <Button size="sm" variant="ghost" onClick={onClose}>关闭</Button>
      </div>
    </div>
  );
}

function ProviderForm({ provider, isActive, onClose }) {
  const d = useProviderDraft(provider);
  const [busy, setBusy] = useState(false);
  const proto = getProtocol(d.type);

  const save = () => {
    if (d.extra.trim() && parseExtraBody(d.extra) === null) { toast('额外请求体不是合法的 JSON 对象', 'err'); return; }
    if (d.headers.trim() && parseExtraBody(d.headers) === null) { toast('额外请求头不是合法的 JSON 对象', 'err'); return; }
    const fields = {
      name: d.name.trim() || '未命名',
      type: d.type,
      baseUrl: d.baseUrl.trim(),
      model: d.model.trim(),
      ctxLimit: d.ctxLimit === '' ? undefined : Number(d.ctxLimit),
      extraBody: d.extra.trim(),
      headers: d.headers.trim() ? parseExtraBody(d.headers) : null,
      sessionHeader: d.sessionHeader.trim().toLowerCase(),
    };
    if (d.key.trim()) fields.apiKey = d.key.trim();   // 留空 = 保持服务端原值（前端拿不到密钥）
    updateProvider(provider.id, fields);
    d.setKey('');
    toast('模型配置已保存', 'ok');
  };

  const clearKey = () => {
    updateProvider(provider.id, { apiKey: '' });      // 空串 + keyDirty → 服务端置 null，明确清除
    d.setKey('');
    toast('已清除服务端保存的密钥');
  };

  const fetchModels = async () => {
    setBusy(true);
    try {
      const list = await listModels(provider.id);
      if (list.length) toast(`拉取到 ${list.length} 个模型`, 'ok');
    } finally { setBusy(false); }
  };

  const test = async () => {
    setBusy(true);
    try {
      const headers = d.headers.trim() ? parseExtraBody(d.headers) : null;
      const draft = {
        ...provider, type: d.type, baseUrl: d.baseUrl, model: d.model, headers,
        sessionHeader: d.sessionHeader.trim().toLowerCase(),
      };
      await runTest(testRef(draft, d.key.trim(), headers));
    }
    finally { setBusy(false); }
  };

  return (
    <div className="mx-4 mb-4 rounded-lg border border-border bg-card">
      <FormHeader provider={provider} isActive={isActive} onClose={onClose} />
      <div className="space-y-3 px-4 py-3">
        <NameTypeFields d={d} />
        <FieldDesc>{proto.hint}</FieldDesc>
        <div>
          <Label htmlFor="p-base" className="mb-1.5 block text-xs text-muted-foreground">Base URL</Label>
          <ImeInput id="p-base" value={d.baseUrl} onChange={(e) => d.setBaseUrl(e.target.value)}
            placeholder={proto.defaults.baseUrl} className="font-mono text-xs" />
        </div>
        <ModelKeyFields d={d} provider={provider} />
        <KeyHintRow provider={provider} onClear={clearKey} />
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={save} disabled={busy}>保存</Button>
          <Button size="sm" variant="outline" onClick={test} disabled={busy}>
            {busy ? <Spinner size="sm" /> : null}测试连接
          </Button>
          <Button size="sm" variant="outline" onClick={fetchModels} disabled={busy}><Download />拉取模型清单</Button>
        </div>
        <AdvancedFields d={d} />
      </div>
      <ModelChips provider={provider} onPick={d.setModel} />
    </div>
  );
}

/* ============================ 分区 ============================ */

export default function ModelsSection() {
  const st = useApp();
  const providers = (st.settings && st.settings.providers) || [];
  const activeId = (st.settings && st.settings.activeId) || '';
  const [editingId, setEditingId] = useState(null);
  const [busyId, setBusyId] = useState('');
  const editing = providers.find((p) => p.id === editingId) || null;

  const add = (tpl) => {
    const id = addProvider({ name: tpl.name, type: tpl.type, baseUrl: tpl.baseUrl, model: tpl.model });
    setEditingId(id);
    toast(tpl.key === 'custom' ? '已新建一条空配置，请填写地址与模型名' : `已添加「${tpl.name}」`, 'ok');
  };

  const test = async (p) => {
    setBusyId(p.id);
    try { await runTest(testRef(p, '')); } finally { setBusyId(''); }
  };

  /* 删除确认走全局 askConfirm（与工具确认框同一套；原先这里自带一份局部弹窗） */
  const askDeleteProvider = async (gone) => {
    const r = await askConfirm({
      title: '删除这条模型配置？',
      body: `「${gone.name || '未命名'}」（${gone.model || '未填模型'}）将从账号里移除，密钥一并删除，不可恢复。`,
      okText: '删除', danger: true,
    });
    if (!r.ok) return;
    removeProvider(gone.id);
    if (editingId === gone.id) setEditingId(null);
  };

  return (
    <div className="pb-6">
      {/* 分区顺序是产品决策：先"快速添加"（模板一行摆开，点一下就建好），再"已配置模型"
          （点任意一行展开编辑），编辑表单就近出现在列表下面。 */}
      <TemplateGrid onPick={add} />

      <SectionTitle>已配置模型</SectionTitle>
      <div className="space-y-2 px-4 pt-0.5">
        <ProviderList
          providers={providers}
          activeId={activeId}
          editingId={editingId}
          busyId={busyId}
          onToggle={setEditingId}
          onTest={test}
          onUse={setActiveProvider}
          onDelete={askDeleteProvider}
        />
        {providers.length && !editing ? (
          <FieldDesc>点任意一行（不是只有名字）就能展开编辑；「测试」按服务端存的密钥与自定义头试连通。</FieldDesc>
        ) : null}
      </div>

      {editing ? (
        <div className="pt-4">
          <ProviderForm key={editing.id} provider={editing} isActive={editing.id === activeId} onClose={() => setEditingId(null)} />
        </div>
      ) : null}

    </div>
  );
}
