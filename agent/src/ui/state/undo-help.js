/* ui/state/undo-help.js —— 撤销/比对被闸门拦下时的统一引导（三个入口共用一份）
 *
 *  撤销与「仅恢复这一个」都要过与**工具**同一套闸门（roots 白名单 + 绑定账号权限 + 解锁，
 *  见 lib/agent/tools/fs.js）。被拦下时不能只甩一句报错：要把用户引到该去的地方
 *  （解锁框 / 绑定抽屉）。原先这段逻辑只长在 Message.jsx 的整轮撤销里，
 *  逐文件撤销与比对抽屉是另外两个入口，各写一份必然漂移——所以抽到这里。
 */
import { toast } from '../components/ui/toast.jsx';
import { hooks } from './host.js';

/** 两类"要把用户引到该去的地方"的拦法（顺序即优先级：解锁先说，其次是绑定） */
const GUIDES = [
  {
    when: (p) => !!p.needUnlock,
    run: (p) => {
      toast(`撤销要写入文件：先解锁绑定账号 ${p.osUser || ''}（输入一次密码，只存在内存里）`, 'info');
      hooks.onNeedUnlock(p.osUser || '');
    },
  },
  {
    when: (p) => !!p.needBind,
    run: () => {
      toast('撤销要写入文件：先在设置里绑定本机账号', 'info');
      hooks.onNeedBind();
    },
  },
];

/** 结构化错误（needUnlock / needBind）→ toast + 引导；其余只 toast 原因。
 *  接受两种形状：HttpError 本体（读 e.payload）或直接一个带标记的对象（撤销结果里的 failed[0]）。 */
export function undoGateHelp(e) {
  const p = (e && e.payload) || e || {};
  const hit = GUIDES.find((g) => g.when(p));
  if (hit) { hit.run(p); return; }
  toast('撤销失败：' + ((e && e.message) || p.error || e), 'err');
}
