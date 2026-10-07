/* lib/agent/proctree-subreaper.c —— 两个极小 N-API 导出（产物缓存在 os.tmpdir()，见 proctree.js）
 *
 *  mark():    prctl(PR_SET_CHILD_SUBREAPER, 1)。站点进程被标记为"子进程收养者"之后，
 *             agent 命令派生的孤儿（setsid/nohup 的后台任务、它们的子孙）在父进程退出时
 *             不再交给 init，而是归养回站点进程——归属判定靠祖先链**永远**可查。
 *             prctl 标志随 exec 保留，且只影响"孤儿归谁养"，不改变任何信号/权限语义。
 *  reap(pid): waitpid(pid, NULL, WNOHANG)。被收养的孤儿退出后会成为站点进程的僵尸
 *             （libuv 不认识这个 pid，不会替它 wait）——由 JS 侧的采样器定期清扫，
 *             只收"已是僵尸且不在 libuv 管理清单里"的，绝不抢 libuv 正在管的子进程
 *             （抢了会把 run_command 的退出码弄成 null，成功被误报成失败）。
 *
 *  两个导出都可能失败（seccomp 拦 prctl / pid 已被收走报 ECHILD），调用方自行兜底。
 */
#include <node_api.h>
#include <sys/prctl.h>
#include <sys/types.h>
#include <sys/wait.h>

static napi_value Mark(napi_env env, napi_callback_info info) {
  (void)info;
  if (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0) {
    napi_throw_error(env, NULL, "prctl(PR_SET_CHILD_SUBREAPER) failed");
    return NULL;
  }
  napi_value out;
  napi_get_boolean(env, true, &out);
  return out;
}

static napi_value Reap(napi_env env, napi_callback_info info) {
  (void)info;
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) {
    napi_throw_type_error(env, NULL, "reap(pid) requires a pid argument");
    return NULL;
  }
  double v = 0;
  if (napi_get_value_double(env, argv[0], &v) != napi_ok) {
    napi_throw_type_error(env, NULL, "reap(pid) pid must be a number");
    return NULL;
  }
  int status = 0;
  const pid_t r = waitpid((pid_t)v, &status, WNOHANG);
  napi_value out;
  napi_create_int32(env, (int32_t)r, &out);
  return out;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "mark", NAPI_AUTO_LENGTH, Mark, NULL, &fn);
  napi_set_named_property(env, exports, "mark", fn);
  napi_create_function(env, "reap", NAPI_AUTO_LENGTH, Reap, NULL, &fn);
  napi_set_named_property(env, exports, "reap", fn);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
