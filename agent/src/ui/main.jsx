/* ui/main.jsx —— 入口：装配 core 层 → 挂载 React → 拉取数据
 *
 *  顺序不能乱：
 *    ① wireCore()：把 core 模块的依赖注入好（登记表、记忆、工具、上下文都要在）
 *    ② bootstrap()：探针 → 拉服务端数据 → 灌进登记表与状态 → 探测模型连接
 *    ③ render()：界面起来后，任何一次 patch 都会让 React 重绘
 *  顺序反了会出现"界面先渲染、core 还没依赖"的空跑（例如工具清单取不到）。
 */
import { createRoot } from 'react-dom/client';
import { StrictMode } from 'react';
import App from './App.jsx';
import { wireCore } from './state/host.js';
import { bootstrap } from './state/session.js';
import { patch } from './state/store.js';
// 样式不在这里 import：CSS 由 Tailwind CLI 单独编译成 vendor/agent.css，页面用 <link> 引入
// （esbuild 解析不了 Tailwind 的 @import "tailwindcss"，交给它只会编译不过）

wireCore();

bootstrap()
  .catch((e) => {
    console.error('[agent] 初始化失败', e);
    patch({ ready: true, bootError: e && e.message ? e.message : String(e) });
  })
  .finally(() => {
    const el = document.getElementById('app');
    if (!el) return;
    createRoot(el).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  });
