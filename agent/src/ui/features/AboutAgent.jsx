// AboutAgent.jsx —— 「为什么选它」：名字、一句话定位、以及和其他 Agent 的差别清单
//
//  两个入口共用这一个对话框：页头标题旁的按钮（任何时刻都能看）、欢迎页的「全部 N 条」。
//  文案的唯一真源在 ui/lib/brand.js —— 名字与卖点要改名/改口径时只动那一处。
import { Check } from 'lucide-react';
import { BRAND, HIGHLIGHTS } from '../lib/brand.js';
import { patch, useApp } from '../state/store.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog.jsx';
import { Badge } from '../components/ui/badge.jsx';

/** 打开对话框（页头与欢迎页都调它；与 openDownloads 同一形状） */
export function openAbout() {
  patch({ about: { open: true } });
}

function closeAbout() {
  patch({ about: { open: false } });
}

/** 一条卖点：图标 + 标题 + 一句话（标题与描述都来自 brand.js） */
export function Highlight({ h, compact }) {
  return (
    <div className={compact ? 'flex gap-2' : 'flex gap-2.5 rounded-lg border border-border bg-card/60 p-3'}>
      <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
        <h.icon className="size-3.5" />
      </span>
      <div className="min-w-0 space-y-0.5">
        <div className="text-[13px] font-medium leading-tight text-foreground">{h.title}</div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">{h.desc}</p>
      </div>
    </div>
  );
}

export function AboutAgentDialog() {
  const st = useApp();
  if (!st.about || !st.about.open) return null;
  return (
    <Dialog open onOpenChange={(next) => { if (!next) closeAbout(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span>{BRAND.name}</span>
            <Badge variant="secondary">本地智能体</Badge>
          </DialogTitle>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {BRAND.tagline} —— {BRAND.oneLiner}
          </p>
        </DialogHeader>

        <div className="space-y-2">
          {HIGHLIGHTS.map((h) => <Highlight key={h.title} h={h} />)}
        </div>

        <p className="text-[11px] leading-relaxed text-subtle">
          和常见 Agent 的差别可以概括成三句话：提示词不藏着（能看见、能改）、工具不锁在协议层里
          （标准 OpenAI / Anthropic 协议 + 本机文件与命令）、改动不留在黑箱里（+N/−M 可对比、可逐文件撤回）。
        </p>
        <p className="flex items-center gap-1.5 text-[11px] text-subtle">
          <Check className="size-3.5 shrink-0" />
          名字与这段介绍都在 <code className="rounded bg-muted px-1 font-mono">agent/src/ui/lib/brand.js</code>，改一处即可。
        </p>
      </DialogContent>
    </Dialog>
  );
}
