// Composer.jsx —— 输入区：自增高 textarea、Enter 发送/Shift+Enter 换行、IME 保护、模板菜单与访问级别菜单
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronUp, Send, Square } from 'lucide-react';
import { AgentPolicy } from '../../core/policy.js';
import { Prompts } from '../../core/prompts.js';
import { send, steer, stop } from '../state/session.js';
import { accessOf } from '../state/host.js';
import { setParam } from '../state/settings.js';
import { patch, useApp } from '../state/store.js';
import { Button } from '../components/ui/button.jsx';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuTrigger,
} from '../components/ui/dropdown-menu.jsx';
import { Textarea } from '../components/ui/textarea.jsx';
import { toast } from '../components/ui/toast.jsx';
import { cn } from '../lib/utils.js';
import { requestScrollBottom } from './chat-utils.js';

/* 只输入 /xxx 时按 Tab 才开模板菜单（正文里打 / 不打扰） */
const TPL_ONLY = /^\s*\/[^\s]*$/;

/** 访问级别菜单（向上弹出）：四档来自 AgentPolicy.MODES，当前档位显示实际效果摘要 */
function AccessMenu({ access }) {
  const meta = AgentPolicy.meta(access.mode);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={`访问级别：${meta.label} —— ${AgentPolicy.summary(access)}（点击切换）`}
          className={cn(
            'flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] transition-colors',
            meta.danger
              ? 'border-destructive/60 bg-destructive/10 font-semibold text-destructive'
              : 'border-border text-muted-foreground hover:text-foreground',
          )}
        >
          <span>{meta.icon}</span><span>{meta.short}</span>
          <ChevronUp className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-72">
        <DropdownMenuLabel>访问级别 · 模型动手前要不要先问你</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={access.mode}
          onValueChange={(v) => {
            setParam('agent_access', v);
            toast(`访问级别：${AgentPolicy.meta(v).label}`, 'ok');
          }}
        >
          {AgentPolicy.MODES.map((m) => (
            <DropdownMenuRadioItem key={m.value} value={m.value} className="items-start">
              <span className="flex flex-col gap-0.5 whitespace-normal">
                <span className={cn('text-xs', m.danger && 'font-semibold text-destructive')}>{m.icon} {m.label}</span>
                <span className="text-[11px] leading-snug text-subtle">
                  {m.value === access.mode ? `当前：${AgentPolicy.summary(access)}` : m.desc}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default function Composer() {
  const st = useApp();
  const draft = st.draft || '';
  const streaming = !!st.streaming;
  const taRef = useRef(null);
  const boxRef = useRef(null);
  const [tplOpen, setTplOpen] = useState(false);
  const composingRef = useRef(false);      // 输入法组合中（中文/日文正在选词）

  /* 输入框是**非受控**的：不传 value/defaultValue，值由我们自己写进 DOM。
     为什么必须这样（2026-09-30 用真实 Chrome + CDP 的 Input.imeSetComposition 复现 + 逐项二分）：
     受控 textarea 每次输入后 React 都要把 value/defaultValue 回写 DOM（受控输入的固有行为），
     而 Chromium 的输入法组合态经不起这次回写——组合被取消后，下一次预编辑不是"替换上一段"
     而是"插到光标处"，于是拼音与汉字叠加、一个键出多个字母：
        组合 n → "n"；组合 ni → "nni"；组合 nihao → "nninihao"；上屏 → "nninihao你好"
     （同一页面里一个不受 React 管的 textarea 完全正常，所以不是浏览器/站点 CSS 的问题。）
     现在：值只在**我们主动改草稿**时写回 DOM（模板 / 回撤 / 插话回填 / 发送后清空），
     用户打字全程不经过 React 的受控往返。 */
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    /* 组合中绝不写 DOM：那正是上面说的"取消组合"的动作。组合结束后由
       onCompositionEnd 把最终文本同步进草稿，不会丢字。 */
    if (!composingRef.current && ta.value !== draft) ta.value = draft;
  }, [draft]);

  // 自增高：上限 220px；只在草稿变化时量一次（生成中的高频重渲不触发布局）
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
    ta.style.overflowY = ta.scrollHeight > 220 ? 'auto' : 'hidden';
  }, [draft]);

  // 模板菜单：点外面关掉（Escape 由 textarea 的键盘处理负责）
  useEffect(() => {
    if (!tplOpen) return undefined;
    const onDown = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setTplOpen(false); };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [tplOpen]);

  /** 套用模板：有 {{变量}} 就逐个取值（取消则不动草稿） */
  const pickTemplate = (tpl) => {
    setTplOpen(false);
    const vars = Prompts.templateVars(tpl.text);
    if (!vars.length) {
      patch({ draft: tpl.text });
      taRef.current && taRef.current.focus();
      return;
    }
    const answers = {};
    for (const v of vars) {
      const a = window.prompt(`模板「${tpl.name}」的变量：${v}`, '');
      if (a === null) return;
      answers[v] = a;
    }
    const { text, missing } = Prompts.applyTemplate(tpl, answers);
    patch({ draft: text });
    taRef.current && taRef.current.focus();
    if (missing.length) toast('还有变量未填：' + missing.join('、'), 'info');
  };

  /** 发送 / 插话：生成中一律走插话（不打断当前调用，下一轮开始前注入） */
  const submit = () => {
    const text = draft.trim();
    if (streaming) {
      if (!text) { toast('生成中：输入内容后回车即可插话'); return; }
      steer(text);
      patch({ draft: '' });
      requestScrollBottom();                     // 用户自己的动作：让他看见自己那条插话
      return;
    }
    if (!text) { toast('先输入内容再发送'); return; }
    send();                                      // 不带参数：send 读 state.draft 并清空；失败时草稿保留
    requestScrollBottom();                       // 双保险（send 内部也会调 hooks.scrollBottom）
  };

  const onInput = (e) => {
    const v = e.target.value;
    patch({ draft: v });
    setTplOpen(TPL_ONLY.test(v));
  };

  /* 组合开始/结束：组合期间不写 DOM（见上面的 useLayoutEffect）；结束时把最终文本同步进草稿
     （最后一次 input 事件偶尔会在组合收尾时缺席，这里兜一道，保证草稿与框里内容一致）。 */
  const onCompositionStart = () => { composingRef.current = true; };
  const onCompositionEnd = (e) => {
    composingRef.current = false;
    patch({ draft: e.currentTarget.value });
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { if (tplOpen) { e.preventDefault(); setTplOpen(false); } return; }
    /* 中文/日文输入法：组合期间敲回车是"确认候选词"，不是发送。isComposing（部分 IME
       只给 keyCode 229）就是这个时刻的标志——不挡住的话 preventDefault 会吃掉候选词，
       还会拿着没上屏的半截内容发出去。 */
    if ((e.nativeEvent && e.nativeEvent.isComposing) || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); return; }
    if (e.key === 'Tab' && !streaming && TPL_ONLY.test(draft)) { e.preventDefault(); setTplOpen(true); }
  };

  const filter = draft.trim().replace(/^\//, '');
  const tplList = tplOpen
    ? Prompts.templates().filter((t) => !filter || t.name.replace(/^\//, '').includes(filter) || t.name.includes(filter))
    : [];

  return (
    <div className="shrink-0 border-t border-border bg-background px-3 pt-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-4">
      {/* 宽度：外层内边距与消息列完全一致，内层直接拉满 —— 输入框的边框正好压在消息列的
          左右边界上（旧实现内外两层各有一个 max-w-3xl 居中列，宽屏下与消息列错开十几像素）。 */}
      <div ref={boxRef} className="relative w-full">
        {tplOpen ? (
          <div className="absolute bottom-full left-0 z-30 mb-2 max-h-72 w-full overflow-y-auto rounded-lg border border-border bg-card p-1 shadow-lg">
            <p className="px-2 py-1 text-[10.5px] text-subtle">提示词模板（内容在设置 → 提示词里改）</p>
            {tplList.length ? tplList.map((t) => (
              <button
                key={t.id}
                type="button"
                title={String(t.text)}
                onClick={() => pickTemplate(t)}
                className="flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
              >
                <span className="shrink-0 text-xs font-medium text-foreground">{t.name}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-subtle">
                  {String(t.text).replace(/\s+/g, ' ').slice(0, 72)}
                </span>
              </button>
            )) : <p className="px-2 py-1.5 text-[11px] text-subtle">没有匹配的模板</p>}
          </div>
        ) : null}

        <div className="rounded-[1.35rem] border border-border bg-card shadow-[0_2px_12px_-4px_rgba(0,0,0,.18)] transition-all focus-within:border-border-strong focus-within:shadow-[0_4px_20px_-6px_rgba(0,0,0,.25)]">
          {/* 非受控：没有 value/defaultValue（见组件开头那段注释）。
              placeholder 也保持**恒定**：它随生成状态变化时 React 会为 textarea 提交一次更新，
              而提交就会碰 defaultValue —— 组合中被打断的正是这类写入。生成中的提示在下面那行文字里。 */}
          <Textarea
            ref={taRef}
            rows={1}
            onChange={onInput}
            onKeyDown={onKeyDown}
            onCompositionStart={onCompositionStart}
            onCompositionEnd={onCompositionEnd}
            placeholder="输入消息…（Enter 发送，Shift+Enter 换行，打 / 用模板）"
            className="max-h-[220px] min-h-[2.9rem] resize-none border-0 bg-transparent px-4 pt-3 pb-1 text-[15px] leading-relaxed shadow-none focus-visible:ring-0"
          />
          <div className="flex flex-wrap items-center gap-2 px-3 pb-2.5 pt-0.5">
            <AccessMenu access={accessOf()} />
            {streaming ? (
              <span className="text-[11px] text-muted-foreground">
                Agent 运行中：回车 = 插话（下一轮生效）{st.steering ? ` · 已排队 ${st.steering} 条` : ''}
              </span>
            ) : null}
            <span className="ml-auto" />
            {streaming ? (
              <Button variant="outline" size="sm" title="停止生成（已经生成的内容会保留）" onClick={() => stop()}>
                <Square className="size-3.5" />停止
              </Button>
            ) : null}
            <Button
              size="sm"
              onClick={submit}
              disabled={!streaming && !draft.trim()}
              title={streaming ? '插话：下一轮开始前注入，不打断当前调用' : '发送（Enter）'}
            >
              {streaming ? '插话' : <><Send className="size-3.5" />发送</>}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
