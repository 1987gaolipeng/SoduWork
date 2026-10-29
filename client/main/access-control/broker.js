'use strict';
const { randomUUID, createHash } = require('node:crypto');
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}
function digest(value) { return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex'); }
function grantOperation(operation) {
  const result = structuredClone(operation);
  // A session approval is for the operation's stable target. File contents,
  // byte ranges and other request payloads naturally change on the next turn;
  // including them in the grant key caused session-scoped approval to repeat for every
  // edit of the same file. Keep command and extension-tool arguments strict,
  // because they can change the side effect even when the label is unchanged.
  if (result.action === 'file.read' || result.action === 'file.write') {
    delete result.arguments;
    // read/list/grep and write/edit are equivalent permission classes for a
    // canonical target. A model switching built-in tools should not turn one
    // approved file operation into a new prompt.
    delete result.tool;
  }
  // Only the built-in shell's display/timeout metadata may vary. Never strip
  // fields from arbitrary MCP tools, where these names can be actual inputs.
  if (result.action === 'command.execute' && result.tool === 'bash' &&
      result.arguments && typeof result.arguments.command === 'string') {
    delete result.arguments.description;
    delete result.arguments.timeout;
  }
  return result;
}
function create({ policy, onChange = () => {}, timeoutMs = 10 * 60 * 1000 } = {}) {
  const pending = new Map(), grants = new Set(), denials = new Set();
  let closed = false;
  function changed() { onChange(); }
  function finish(id, decision, remember = true) {
    const item = pending.get(id);
    if (!item) return;
    pending.delete(id); clearTimeout(item.timer);
    if (item.signal) item.signal.removeEventListener('abort', item.abort);
    if (remember && decision === 'session') grants.add(item.grantKey);
    if (remember && decision === 'deny') denials.add(item.denyKey);
    item.resolve(decision !== 'deny'); changed();
  }
  return {
    pending: () => [...pending.values()].map(item => structuredClone(item.view)),
    upgradeToFull(next) {
      if (closed || policy.mode !== 'standard' || next?.mode !== 'full' ||
          next.workspaceRoot !== policy.workspaceRoot || next.revision !== policy.revision + 1) {
        throw Error('Invalid live access upgrade');
      }
      policy = next;
      grants.clear(); denials.clear();
      // Consent to full access supersedes these waits. Keep the original call,
      // AbortSignal and post-approval target checks; never replay its effects.
      for (const [id, item] of pending) finish(id, item.signal?.aborted ? 'deny' : 'once', false);
    },
    // Only a real user turn may reopen an operation refused in the previous turn.
    beginTurn() { if (!pending.size) denials.clear(); },
    async authorize(operation, signal) {
      if (closed || signal?.aborted || operation.verdict === 'deny') return false;
      if (operation.verdict === 'allow') return true;
      const grantKey = digest({ policy, operation: grantOperation(operation) });
      const denyKey = digest({ policy, operation });
      if (denials.has(denyKey)) return false;
      if (operation.allowSession !== false && grants.has(grantKey)) return true;
      if (pending.size >= 32) return false;
      const requestId = randomUUID();
      return new Promise(resolve => {
        const view = { method: 'permission', requestId, policyRevision: policy.revision,
          action: operation.action, tool: operation.tool, target: operation.target,
          arguments: structuredClone(operation.arguments), createdAt: Date.now(),
          expiresAt: Date.now() + timeoutMs, allowSession: operation.allowSession !== false,
          choices: operation.allowSession === false ? ['once', 'deny'] : ['once', 'session', 'deny'] };
        const item = { grantKey, denyKey, view, resolve, signal, abort: () => finish(requestId, 'deny') };
        pending.set(requestId, item);
        item.timer = setTimeout(item.abort, timeoutMs);
        item.timer.unref?.();
        signal?.addEventListener('abort', item.abort, { once: true });
        if (signal?.aborted) item.abort(); else changed();
      });
    },
    answer(value = {}) {
      const item = pending.get(value.requestId);
      if (!item || value.policyRevision !== policy.revision || !['once', 'session', 'deny'].includes(value.decision)) {
        return { ok: false, reason: '这条权限请求已失效，请使用当前请求' };
      }
      if (closed || item.signal?.aborted || Date.now() >= item.view.expiresAt) {
        finish(value.requestId, 'deny');
        return { ok: false, reason: '这条权限请求已失效，请使用当前请求' };
      }
      if (value.decision === 'session' && !item.view.allowSession) {
        return { ok: false, reason: '此操作需要单次授权' };
      }
      finish(value.requestId, value.decision);
      // A session choice also covers identical work already queued in parallel.
      // Allow once still resolves exactly one request.
      if (value.decision !== 'once') {
        for (const [id, queued] of pending) {
          const same = value.decision === 'session' ? queued.grantKey === item.grantKey : queued.denyKey === item.denyKey;
          if (!same) continue;
          if (queued.signal?.aborted || Date.now() >= queued.view.expiresAt) finish(id, 'deny', false);
          else if (value.decision === 'deny' || queued.view.allowSession) finish(id, value.decision);
        }
      }
      return { ok: true };
    },
    cancel() { for (const id of [...pending.keys()]) finish(id, 'deny'); },
    close() { closed = true; this.cancel(); grants.clear(); denials.clear(); },
  };
}
module.exports = { create, digest };
