'use strict';

// History is allowed to paint with lightweight resources. Its first real turn
// must restore the configured execution tools before asking the model to act.
// Prepare separately and swap only at an idle boundary, never during a tool.
function create({ current, load, prepare, commit, changed = () => {}, closed = () => false }) {
  let pending = null, generation = 0;
  function required() {
    const live = current();
    return Boolean(live.resources?.extensionsDeferred && (!live.policy || live.policy.mode === 'full'));
  }
  function release(resources) {
    try { resources?.resourceLoader?.getExtensions?.()?.runtime?.invalidate?.('Resource activation abandoned'); } catch (_) {}
  }
  function ensure(cancelled = () => false) {
    if (pending) return pending;
    if (!required()) return Promise.resolve({ ok: true });
    const live = current(), token = generation, policy = live.policy;
    const stopped = () => closed() || cancelled() || token !== generation;
    const stale = () => stopped() || current().changing || current().session !== live.session ||
      current().policy !== policy;
    const obsolete = () => ({ ok: false, cancelled: stopped(), retrySafe: true,
      reason: '会话设置已变化，请重新发送' });
    const model = live.session.model, thinkingLevel = live.session.thinkingLevel;
    const modelChanged = () => live.session.model !== model || live.session.thinkingLevel !== thinkingLevel;
    pending = Promise.resolve().then(async () => {
      let resources, next;
      try {
        if (stale()) return obsolete();
        resources = await load();
        if (stale() || modelChanged()) return obsolete();
        if (resources.degraded) throw Error('会话工具恢复超时，请重试；已有对话和文件均已保留');
        next = await prepare(resources, live);
        if (stale() || modelChanged()) return obsolete();
        if (next.session.sessionManager !== live.session.sessionManager) throw Error('Resource activation must preserve session history');
        commit({ ...next, resources, policy: live.policy });
        next = null; resources = null;
        try { live.access?.broker.close(); } catch (_) {}
        try { live.session.dispose(); } catch (_) {}
        return { ok: true };
      } catch (error) {
        return { ok: false, retrySafe: true, failureKind: 'session-resources', reason: String(error?.message || error) };
      } finally {
        try { next?.access?.broker.close(); next?.session?.dispose(); } catch (_) {}
        release(resources);
      }
    }).finally(() => { pending = null; changed(); });
    changed();
    return pending;
  }
  return { ensure, required, cancel: () => { generation++; }, busy: () => Boolean(pending) };
}
module.exports = { create };
