/* core/binding.js —— 本机账号绑定 / 解锁的客户端
 *
 *  绑定 = 声明"这个文档站账号名下的 Agent 以哪个本机账号的权限做事"；
 *  解锁 = 该本机账号的密码（只存在于服务端内存里一段时间的凭据）。
 *  两者都按文档站账号存：绑定信息与模型配置同处一份用户资料（换设备登录同一账号即恢复）。
 *
 *  三种状态（界面据此给不同入口）：
 *    未绑定     → 引导去设置里绑定（文件/命令工具此时对模型完全不注册）
 *    已绑定未解锁 → 只有 su 类账号需要（绑定账号 ≠ 站点进程用户）；执行命令前要输一次密码
 *    已绑定已解锁 → 一切照常
 */
import { EP } from './endpoints.js';
import { get, post } from './http.js';

const unwrap = (e) => {
  const err = new Error(e && e.message ? e.message : '操作失败');
  err.needBind = !!(e && e.needBind);
  err.verifyDisabled = !!(e && e.payload && e.payload.verifyDisabled);
  return err;
};

export async function status() {
  const d = await get(EP.binding, { timeoutMs: 8000 });
  return d.binding;
}

export async function bind(osUser, password) {
  try {
    const d = await post(EP.bind, { osUser, password }, { timeoutMs: 30000 });
    return d.binding;
  } catch (e) { throw unwrap(e); }
}

export async function unbind() {
  try {
    const d = await post(EP.unbind, {}, { timeoutMs: 15000 });
    return d.binding;
  } catch (e) { throw unwrap(e); }
}

export async function unlock(password) {
  try {
    const d = await post(EP.unlock, { password }, { timeoutMs: 30000 });
    return d.binding;
  } catch (e) { throw unwrap(e); }
}

export async function lock() {
  try {
    const d = await post(EP.lock, {}, { timeoutMs: 10000 });
    return d.binding;
  } catch (e) { throw unwrap(e); }
}

export const Binding = { status, bind, unbind, unlock, lock };
