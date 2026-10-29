'use strict';
const rules = require('./access-control/policy');
const terminal = new Set(['done', 'completed', 'failed', 'cancelled', 'interrupted', 'stopped']);
const signature = policy => policy ? [policy.schema, policy.workspaceRoot, policy.mode, policy.revision].join('|') : '';

// Relay only user-selected, committed parent modes. Native children own their
// workspace and revision sequence; never redispatch a job to change access.
function create({ handle, cwd, readPolicy, initialPolicy, readChild, apply, checkOwner,
  stop, committed = () => {} }) {
  const workspaceRoot = rules.canonical(cwd || initialPolicy?.workspaceRoot || readPolicy()?.workspaceRoot);
  const selected = () => rules.normalize(readPolicy(), workspaceRoot);
  let seen = signature(initialPolicy), work = null, dirty = false, closed = false, failure = null;
  let unsubscribe = () => {};
  async function drain() {
    while (dirty && !closed && !failure) {
      dirty = false;
      const desired = selected();
      if (!desired || signature(desired) === seen) continue;
      await checkOwner();
      const state = await readChild();
      if (closed) return;
      // A completed node has no remaining operations. Its successor inherits
      // the current selection on admission, without rewriting old evidence.
      if (terminal.has(state.status)) { seen = signature(desired); continue; }
      const current = rules.normalize(state.accessPolicy, workspaceRoot);
      if (!current) throw Error('missing child access policy');
      const latest = selected();
      if (signature(latest) !== signature(desired)) { dirty = true; continue; }
      await checkOwner();
      if (closed) return;
      let effective = current;
      if (current.mode !== desired.mode) {
        const policy = rules.next(desired.mode, current.workspaceRoot, current, current.revision);
        const result = await apply(policy, current.revision);
        if (!result?.ok || result.effective !== 'current-turn') throw Error('child access not acknowledged');
        effective = rules.normalize(result.accessPolicy, current.workspaceRoot);
        if (!effective || effective.mode !== policy.mode || effective.revision !== policy.revision ||
            effective.workspaceRoot !== workspaceRoot) {
          throw Error('child access acknowledgement mismatch');
        }
      }
      await checkOwner();
      if (closed) return;
      seen = signature(desired);
      committed(effective, desired.revision);
      // A later choice can arrive while native tools settle. Do not replay
      // intermediate modes (in particular an obsolete unrestricted choice).
      dirty = signature(selected()) !== seen;
    }
  }
  function sync() {
    if (failure) return Promise.reject(failure);
    if (closed) return Promise.resolve();
    dirty = true;
    if (!work) work = Promise.resolve().then(drain).catch(async () => {
      failure = Error('当前节点未能同步会话访问权限，已请求停止；请确认节点已停止后重试');
      try { await stop(); }
      catch (_) { failure = Error('当前节点未能同步会话访问权限，尚未确认停止；请恢复连接后停止当前节点'); }
    }).finally(() => { work = null; });
    return work.then(() => { if (failure) throw failure; if (dirty && !closed) return sync(); });
  }
  unsubscribe = handle?.on?.(event => {
    const kind = typeof event === 'string' ? event : event?.kind;
    if (kind === 'permission' || kind === 'access-changed') void sync().catch(() => {});
  }) || unsubscribe;
  return {
    sync, error: () => failure,
    async close() { closed = true; unsubscribe(); if (work) await work; },
  };
}
module.exports = { create };
