'use strict';
const rules = require('./policy');
const { install } = require('./pi');
const PENDING_ENTRY = 'soduwork.access.pending';
function create({ cwd, pending = null, current, preload = async () => undefined, release = () => {}, prepare, commit, commitPolicy, changed = () => {}, readScope, rememberDefault = () => {} }) {
  let nextPolicy = pending, applying = null, loading = null, closed = false, rememberAfterApply = false;
  function discardResources() {
    const abandoned = loading; loading = null;
    abandoned?.promise.then(resources => release(resources)).catch(() => {});
  }
  function load(policy) {
    if (!loading || loading.policy !== policy) loading = {
      policy, promise: Promise.resolve().then(() => preload(policy)),
    };
    return loading.promise;
  }
  return {
    pending: () => nextPolicy,
    preload: () => nextPolicy ? load(nextPolicy) : Promise.resolve(),
    upgrade(value, expectedRevision) {
      const live = current();
      if (!commitPolicy || closed || applying || nextPolicy || live.policy?.mode !== 'standard' ||
          value?.mode !== 'full' || !live.access?.upgradeToFull) return null;
      rules.next(value.mode, cwd, live.policy, expectedRevision);
      const policy = rules.normalize(value, cwd);
      if (policy.revision !== expectedRevision + 1) throw Error('Invalid access policy revision');
      // Persist before releasing any tool. A failed disk write must leave the
      // original approval pending and the original policy authoritative.
      live.session.sessionManager.appendCustomEntry('soduwork.access.policy', policy);
      live.access.upgradeToFull(policy);
      commitPolicy(policy);
      rememberDefault(policy.mode);
      changed();
      return { ok: true, effective: 'current-turn' };
    },
    schedule(value, expectedRevision) {
      if (closed) return { ok: false, reason: '会话已经关闭' };
      const live = current();
      rules.next(value.mode, cwd, nextPolicy || live.policy, expectedRevision);
      const policy = rules.normalize(value, cwd);
      if (policy.revision !== expectedRevision + 1) throw Error('Invalid access policy revision');
      live.session.sessionManager.appendCustomEntry(PENDING_ENTRY, policy);
      nextPolicy = policy; rememberAfterApply = true; changed();
      return { ok: true, effective: 'next-turn' };
    },
    discard() {
      current().session.sessionManager.appendCustomEntry(PENDING_ENTRY, null);
      nextPolicy = null; rememberAfterApply = false; discardResources(); changed();
    },
    apply() {
      if (applying) return applying;
      if (!nextPolicy) return Promise.resolve();
      const policy = nextPolicy;
      const live = current();
      applying = (async () => {
        const resources = await load(policy);
        if (closed) throw Error('会话已经关闭');
        const prepared = await prepare(policy, live.session, resources);
        const session = prepared.session;
        let access;
        try {
          if (closed) throw Error('会话已经关闭');
          if (session.sessionManager !== live.session.sessionManager) throw Error('Access change must preserve the session history');
          access = install(session, policy, cwd, changed, { readScope });
          session.sessionManager.appendCustomEntry('soduwork.access.policy', policy);
          // A newer choice made while resources load must remain pending.
          if (nextPolicy === policy) {
            session.sessionManager.appendCustomEntry(PENDING_ENTRY, null);
            nextPolicy = null; loading = null;
          }
          commit({ ...prepared, access, policy });
          if (rememberAfterApply && nextPolicy === null) {
            rememberAfterApply = false;
            rememberDefault(policy.mode);
          }
          try { live.access?.broker.close(); } catch (_) { /* committed policy remains authoritative */ }
          try { live.session.dispose(); } catch (_) { /* do not dispose the replacement on cleanup failure */ }
          changed();
        } catch (error) { access?.broker.close(); session.dispose(); throw error; }
      })().finally(() => { applying = null; });
      return applying;
    },
    close() { closed = true; discardResources(); },
  };
}
module.exports = { create, PENDING_ENTRY };
