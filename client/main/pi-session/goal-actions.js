'use strict';
function create({session, publish, scheduleRelease}) {
  return (event, ref, action) => {
    const s = session.get(ref);
    if (!s) return { ok: false, reason: '会话不在了' };
    if (action === 'continue') {
      if (typeof s.continueGoal !== 'function') {
        return { ok: false, reason: '当前执行底座暂不支持继续目标循环' };
      }
      const accepted = started => {
        if (!started || !started.ok) return started || { ok: false, reason: '无法继续执行' };
        publish(s, { kind: 'goal-resuming' }, typeof s.uiSnapshot === 'function' ? s.uiSnapshot() : s.snapshot());
        if (started.completion) Promise.resolve(started.completion).then((result) => {
          if (!result || !result.ok) {
            publish(s, { kind: 'error', reason: result && result.reason }, typeof s.uiSnapshot === 'function' ? s.uiSnapshot() : s.snapshot());
          } else {
            publish(s, { kind: result.paused ? 'goal-paused' : 'settled' }, typeof s.uiSnapshot === 'function' ? s.uiSnapshot() : s.snapshot());
          }
          if (s.detached) scheduleRelease(s);
        }).catch((error) => {
          publish(s, { kind: 'error', reason: String(error && error.message || error) }, typeof s.uiSnapshot === 'function' ? s.uiSnapshot() : s.snapshot());
        });
        return { ok: true, accepted: true, ...(started.idempotent ? { idempotent: true } : {}),
          snapshot: typeof s.uiSnapshot === 'function' ? s.uiSnapshot() : s.snapshot() };
      };
      const started = s.continueGoal();
      return started?.then ? Promise.resolve(started).then(accepted) : accepted(started);
    }
    const result = action === 'stop' ? (typeof s.pauseGoal === 'function'
      ? s.pauseGoal() : { ok: false, reason: '当前执行底座暂不支持暂停目标循环' })
      : action === 'disable' ? (typeof s.disableGoal === 'function'
        ? s.disableGoal() : { ok: false, reason: '当前执行底座暂不支持关闭目标模式' })
        : { ok: false, reason: '不认识的目标操作' };
    const settled = value => {
      if (value && value.ok) publish(s, { kind: 'goal-' + action }, typeof s.uiSnapshot === 'function' ? s.uiSnapshot() : s.snapshot());
      return value;
    };
    return result?.then ? Promise.resolve(result).then(settled) : settled(result);
  };
}
module.exports = {create};
