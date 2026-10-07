// AppearanceSection.jsx —— 外观分区：主题模式 / 强调色 / 界面字号 / 消息密度（改完立刻生效并自动保存）
import { useApp } from '../../state/store.js';
import { setTheme } from '../../state/settings.js';
import { cn } from '../../lib/utils.js';
import { SectionTitle } from '../../components/ui/field.jsx';
import { NoteBox, ChoiceGroup, SettingRow } from './parts.jsx';

const MODES = [['dark', '深色'], ['light', '浅色'], ['system', '跟随系统']];
const SCALES = [['0.9', '小'], ['1', '标准'], ['1.1', '大'], ['1.2', '更大']];
const DENSITIES = [['compact', '紧凑'], ['cozy', '适中'], ['comfortable', '宽松']];

/* 与服务端白名单（lib/agent/sanitize.js 的 theme.accent）逐一对应，颜色取自 styles.css 的令牌
   （blue 无专门规则：取深色默认 #6366f1，浅色出厂是 #4f46e5，同属靛蓝系） */
const ACCENTS = [
  { id: 'blue', label: '蓝', color: '#6366f1' },
  { id: 'violet', label: '紫', color: '#7c5cff' },
  { id: 'emerald', label: '绿', color: '#10b981' },
  { id: 'amber', label: '琥珀', color: '#f59e0b' },
  { id: 'rose', label: '玫红', color: '#f43f5e' },
  { id: 'cyan', label: '青', color: '#06b6d4' },
];

function AccentDot({ item, active, onPick }) {
  return (
    <button
      type="button"
      title={item.label}
      aria-label={`强调色 ${item.label}`}
      aria-pressed={active}
      onClick={() => onPick(item.id)}
      style={{ background: item.color }}
      className={cn(
        'size-6 rounded-full border transition-transform hover:scale-110',
        active
          ? 'border-foreground ring-2 ring-ring/50 ring-offset-2 ring-offset-card'
          : 'border-black/10 dark:border-white/20'
      )}
    />
  );
}

export default function AppearanceSection() {
  const st = useApp();
  const theme = (st.settings && st.settings.theme) || {};
  const mode = theme.mode || 'dark';
  const accent = theme.accent || 'blue';
  const scale = String(theme.scale || 1);
  const density = theme.density || 'cozy';

  return (
    <div>
      <SectionTitle>主题</SectionTitle>
      <SettingRow label="主题模式" tip="「跟随系统」跟随操作系统的浅色/深色偏好，系统切换时立即跟随。">
        <ChoiceGroup options={MODES} value={mode} onChange={(v) => setTheme({ mode: v })} />
      </SettingRow>
      <SettingRow label="强调色" desc="按钮、链接、选中态与用量环的主色" tip="只换主色与配套的 ring，其余中性色不动；选中态的文字（侧栏、设置分区）在深浅两套主题下都会跟着强调色。">
        <div className="flex items-center gap-2.5">
          {ACCENTS.map((a) => (
            <AccentDot key={a.id} item={a} active={a.id === accent} onPick={(id) => setTheme({ accent: id })} />
          ))}
        </div>
      </SettingRow>

      <SectionTitle>排版</SectionTitle>
      <SettingRow label="界面字号" tip="整页字号（含消息区与面板），按 0.9 / 1 / 1.1 / 1.2 四档缩放。">
        <ChoiceGroup options={SCALES} value={scale} onChange={(v) => setTheme({ scale: Number(v) })} />
      </SettingRow>
      <SettingRow label="消息密度" tip="只影响消息之间的间距与控件行高：紧凑适合小屏多看内容，宽松更适合阅读。">
        <ChoiceGroup options={DENSITIES} value={density} onChange={(v) => setTheme({ density: v })} />
      </SettingRow>

      <div className="px-4 pt-4">
        <NoteBox>
          外观偏好随账号同步（存在服务端设置里），改动立刻应用到本页，不需要保存。
          深色/浅色与强调色都是 CSS 变量切换，不会重新加载页面。
        </NoteBox>
      </div>
    </div>
  );
}
