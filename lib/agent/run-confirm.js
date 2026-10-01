/** lib/agent/run-confirm.js —— 托管运行的**确认中继**（人工闸门）
 *
 *  模型要做需要点头的事（写文件 / 跑命令 / 改技能 / 装技能）时，循环在服务端停住等人：
 *  推给当前挂着的界面 → 人在界面上点 → 回答经 POST /agent/run/confirm 回到这里。
 *
 *  三条铁律：
 *    ① **没人回答 = 不同意**（超时按拒绝处理）。无人值守时默认放行等于把闸门拆掉；
 *    ② 一个运行可以**同时**挂着多个确认（并行的 skill_import 就会），所以用 Map 而不是单槽位——
 *       单槽位时后来的会顶掉先前的，先那条只能等满超时才被拒（2026-10-01 审计）；
 *    ③ 结算必须**只认自己的 id**：别人（或已经结算过的那个）的回答不能把我的这条结掉。
 */
const { emit } = require('./run-events');

/** 人不在时等确认的时长：超时按"没同意"处理 */
const CONFIRM_WAIT_MS = Number(process.env.AGENT_CONFIRM_WAIT_MS || 120000);

/** 需要人点确认时：推给当前挂着的客户端并等回答。
 *  没人挂着也照样登记（用户可能正要切回来，attach 时会把未答的确认重发一遍）。 */
function ask(run, kind, payload) {
  const id = 'c' + (++run.confirmSeq);
  if (!run.clients.size) emit(run, { type: 'confirm_waiting', id, kind, payload });
  emit(run, { type: 'confirm', id, kind, payload });
  return new Promise((resolve) => {
    let done = false;
    const rec = { id, kind, payload };
    rec.settle = (v) => {
      if (done) return;
      done = true;
      clearTimeout(rec.timer);
      run.confirms.delete(id);
      resolve(v);
    };
    rec.timer = setTimeout(() => rec.settle({ ok: false, timeout: true }), CONFIRM_WAIT_MS);
    run.confirms.set(id, rec);
  });
}

/** 客户端回答一个确认（人点了按钮 / 输入框）。grant 是危险命令的一次性票据。
 *  只结算**这个 id**：多槽位下"先超时的那条"不会再把后装上的那条清掉。 */
function answerConfirm(run, id, ok, remember, grant) {
  const rec = run && run.confirms.get(String(id || ''));
  if (!rec) return false;
  rec.settle({ ok: !!ok, remember: !!remember, grant: String(grant || '') });
  return true;
}

module.exports = { ask, answerConfirm, CONFIRM_WAIT_MS };
