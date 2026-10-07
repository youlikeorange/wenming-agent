/* ui/lib/brand.js —— 本智能体的**名字与卖点**（唯一真源：头部、欢迎页、关于对话框都从这里取）
 *
 *  为什么单独一份：名字与卖点会出现在好几个地方（页头标题、欢迎页、浏览器标签页），
 *  散着写就会出现"改了一处、别处还是旧名"。要改名或换文案，只动这个文件。
 *
 *  写法上的两条自律：
 *    · 每一条卖点都必须是**这个代码库里真实存在的能力**（能指出实现文件），不许写成愿景；
 *    · 一句话说清"和别人比，差别在哪"，不堆形容词——宣传归宣传，别骗人。
 */
import { SlidersHorizontal, PlugZap, ShieldCheck, CloudOff, GitCompareArrows, HardDrive, Layers, Wand2, UserCheck, TicketCheck, TimerReset } from 'lucide-react';

export const BRAND = {
  /* 名字：启 = 说得清、做得实（提示词与工具都摊开）；明 = 每一步都看得见、撤得回。
     与本站「文明论研究」同字根，念着也短。要改名只改这里。 */
  name: '启明',
  full: '启明 · 本地智能体',
  tagline: '把每一步都摊开给你看',
  oneLiner: '模型自己决定查文件、跑命令、联网搜索、记事情、加载技能；而它看到的提示词、动过的文件、'
    + '花掉的每一步，你都看得见、改得动、撤得回。',
};

/** 卖点：每条都对应实现（括号里是落点），文案给用户看，括号内容不展示 */
export const HIGHLIGHTS = [
  { icon: SlidersHorizontal, title: '提示词可见可改', weight: 1,
    desc: '注入给模型的每一段文字——系统区块、工具说明、循环文案、技能正文——都在面板里，改完立刻生效，随时恢复默认。',
    from: 'core/prompts.js 登记表 + 设置抽屉「提示词」' },
  { icon: PlugZap, title: '不锁厂商、不用 MCP', weight: 1,
    desc: '只认标准 OpenAI / Anthropic 协议：云端服务商、自建网关、局域网外的任意兼容端点都能接；工具就是本机的文件与命令，没有插件协议层要维护。',
    from: 'core/protocol/* + lib/agent/upstream.js' },
  { icon: ShieldCheck, title: '权限不越界', weight: 1,
    desc: '文件与命令以你绑定的本机账号的真实权限执行（内核说了算），判不过就直接拒绝；危险命令要一张一次性授权票据，站点自己的账号与目录同样受保护。',
    from: 'lib/agent/osaccess.js + deny.js + grants.js' },
  { icon: CloudOff, title: '关掉浏览器也跑完', weight: 1,
    desc: '这一轮的循环在服务端跑：关页面、断网、换设备都不影响，回来一键接上继续看；每一轮结束前先落盘，进程重启也丢不了。',
    from: 'lib/agent/run-loop.js（托管运行）' },
  { icon: GitCompareArrows, title: '改动都有账、能逐文件撤回', weight: 1,
    desc: '每轮写/改/删都记 +N/−M，点开就是两侧内容对比；撤销可以只撤其中一个文件，刷新、换窗口回来按钮还在。',
    from: 'lib/agent/undo.js + ui/features/FileDiffSheet.jsx' },
  { icon: HardDrive, title: '数据在自己机器上', weight: 1,
    desc: '会话、记忆、技能、密钥都在你的 STATE_DIR 里，站点可以整站自托管；仓库下载即可运行（零依赖的单文件 Node 宿主）。',
    from: 'lib/paths.js + 仓库 standalone.js' },
  { icon: Layers, title: '多会话并行 + 子智能体', weight: 2,
    desc: '几条会话可以同时跑（一条会话一段、账号 3 段、全局 8 段三道闸），互不串数据；子智能体有自己的预算与转录，用完即止。',
    from: 'lib/agent/run-registry.js + run-subagent.js' },
  { icon: Wand2, title: '技能可写、可导入', weight: 2,
    desc: '技能（Skills）按需加载：模型能自己写一份并登记，也能直接把现成的 SKILL.md 导进来；每份技能的正文同样可见可改。',
    from: 'core/tool-runner.js（skill_* / skills/import）' },
  { icon: UserCheck, title: '绑定即授权：以你的身份干活', weight: 1,
    desc: '设置里绑定一个本机系统账号（输一次密码解锁，密码只进内存），之后文件与命令都以**那个账号的真实权限**执行——模型能碰到什么，你在系统里就是什么，不多一分。',
    from: 'lib/agent/session.js + osaccess.js（绑定/解锁/换身份执行）' },
  { icon: TicketCheck, title: '危险命令要票据，清单摊开看', weight: 1,
    desc: '危险操作清单在面板里**逐条可见**；命中即弹授权窗，签一张与命令全文绑定的一次性票据——改一个字符都不认，模型自己拿不到，只有你点过「授权执行」才放行。',
    from: 'lib/agent/deny.js（清单）+ grants.js（一次性票据）' },
  { icon: TimerReset, title: '卡死自己会挣脱：超时与循环保护', weight: 1,
    desc: '单次调用最高时长（面板可设）到点自动中断重调；模型在思考里原地打转（反复输出同样内容）也会被检出、中断重来——过程都写在追踪条上，最终回答不会被一个死循环吊住。',
    from: 'core/thinkloop.js + agent.js 调用保护（call_timeout_sec）' },
];

/** 首页只展示 weight=1 的那几条；完整清单在「为什么选它」对话框里 */
export const TOP_HIGHLIGHTS = HIGHLIGHTS.filter((h) => h.weight === 1);
