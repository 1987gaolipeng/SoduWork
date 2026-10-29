'use strict';

// A priority change keeps the original item, promise and turn resources. The
// provider must acknowledge interruption AND the previous turn must settle
// before the existing queue can consume the selected message.
function create({ queue, unavailable, interrupt, settled = () => !queue.active(), changed, drain, timeoutMs = 30000 }) {
  let current = null;
  const blockedReason = () => unavailable() || (!current && queue.state().paused ? queue.state().reason : '');
  function view() {
    const reason = current?.pending ? '正在停止当前回复，请稍候' : blockedReason() || current?.reason || '';
    return { supported: true, available: !current?.pending && !blockedReason(),
      pending: Boolean(current?.pending), queueId: current?.id || '', reason };
  }
  function send(id) {
    if (current?.pending) return current.id === id ? current.promise
      : Promise.resolve({ ok: false, reason: '正在停止当前回复，请稍候' });
    const item = queue.find(id);
    if (!item) return Promise.resolve({ ok: false, reason: '这条排队消息已经开始执行或已被取消' });
    if (item.options.taskId || item.options.controlled || item.options.goalMode)
      return Promise.resolve({ ok: false, reason: '仅支持用排队中的普通消息引导' });
    const reason = blockedReason();
    if (reason) return Promise.resolve({ ok: false, reason });
    const previous = queue.prioritize(id), active = queue.active();
    const request = { id, previous, pending: true, reason: '', promise: null };
    const valid = () => current === request && request.pending;
    const cancelled = new Promise(resolve => { request.cancel = resolve; });
    current = request;
    if (active) queue.stopActive();
    request.promise = Promise.resolve().then(async () => {
      let timer;
      try {
        await Promise.race([
          (async () => {
            if (!valid()) return;
            await interrupt(active, valid);
            if (active) await active.completion;
          })(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(Error('停止尚未确认，排队消息已保留，请重试引导')), timeoutMs); }),
          cancelled,
        ]);
        if (current !== request) return { ok: false, cancelled: true, reason: '引导已取消' };
        // A failed poll or an aborted local wait can settle the queue promise
        // without proving that the original runtime has actually stopped.
        if (!settled()) throw Error('Stop not confirmed');
        // Other rows may have been reordered in another window while stopping.
        if (!queue.prioritize(id)) throw Error('这条排队消息已经开始执行或已被取消');
        request.pending = false; queue.resume(); current = null;
        changed(); queueMicrotask(drain);
        return { ok: true, accepted: true, queueId: id };
      } catch (error) {
        if (current !== request) return { ok: false, cancelled: true, reason: '引导已取消' };
        queue.moveBefore(id, queue.find(previous.beforeId) ? previous.beforeId : '');
        request.pending = false;
        request.reason = '停止尚未确认，排队消息已保留，请重试引导';
        queue.pause(request.reason); changed();
        return { ok: false, reason: request.reason };
      } finally { clearTimeout(timer); }
    });
    changed();
    return request.promise;
  }
  return { view, send, blocked: () => Boolean(current),
    locked: id => Boolean(current?.pending && current.id === id),
    resume() {
      if (current && (current.pending || !settled()))
        return { ok: false, reason: '停止尚未确认，排队消息已保留，请重试引导' };
      current = null; queue.resume(); return { ok: true };
    },
    cancel() {
      const request = current; current = null;
      if (request?.pending) {
        queue.moveBefore(request.id, queue.find(request.previous.beforeId) ? request.previous.beforeId : '');
        request.pending = false; request.cancel();
      }
    } };
}

module.exports = { create };
