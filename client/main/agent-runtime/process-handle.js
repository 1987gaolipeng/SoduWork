'use strict';

const windowed = require('../pi-session/snapshot-window');
const projection = require('./process-projection');
const failure = () => Object.assign(Error('会话执行已中断，请重新打开会话后继续；未确认的操作不会自动重试'),
  { code: 'RUNTIME_PROCESS_GONE' });
const READ_METHODS = new Set(['snapshot', 'uiSnapshot', 'status', 'inFlight', 'historyRow', 'goalView', 'resumeLocation']);

function createProcessHandle({ ref, invoke, setProperty, release, onClose, confirmStopped }) {
  const listeners = new Set();
  const state = { revision: 0, messages: [], tools: [], data: null };
  let lost = null, closed = false, closing = null;
  const local = { ref, adapterId: 'pi', displayName: 'Pi', ui: {} };
  function snapshot() {
    const value = { ...(state.data?.state || {}), messages: state.messages.slice(), tools: state.tools.slice() };
    if (!lost) return value;
    return { ...value, status: 'failed', statusText: '执行已中断', pendingUi: null,
      execution: { ...(value.execution || {}), running: false, paused: true, stopped: true, state: 'interrupted',
        turnQueue: { ...(value.execution?.turnQueue || {}), active: null, blocked: true, paused: true } },
      runtimeUnavailable: true, runtimeFailure: { code: lost.code, reason: lost.message },
      completion: { ...(value.completion || {}), completed: false, reason: 'runtime-interrupted', retryable: false } };
  }
  function call(method, args, options) {
    if (closed || lost) return Promise.reject(lost || failure());
    return invoke(ref, method, args, options);
  }
  function observed(method, args, options) {
    const pending = call(method, args, options);
    // Some legacy lifecycle observers intentionally do not await mutations.
    // Keep the returned rejection observable without an unhandled rejection.
    pending.catch(() => {});
    return pending;
  }
  Object.assign(local, {
    snapshot,
    uiSnapshot: options => windowed.limitSnapshot(snapshot(), options),
    status: () => lost ? 'failed' : state.data?.status || 'idle',
    inFlight: () => !closed && !lost && Boolean(state.data?.inFlight),
    executionStopped: () => Boolean(confirmStopped?.()),
    historyRow: () => state.data?.history ? { ...state.data.history,
      ...(lost ? { status: 'failed', state: 'failed' } : {}) } : null,
    goalView: () => state.data?.goal || { mode: 'chat', intent: '' },
    resumeLocation: () => state.data?.resumePath || '',
    on(listener) { if (typeof listener !== 'function') throw TypeError('Session listener must be a function');
      listeners.add(listener); return () => listeners.delete(listener); },
    async send(...args) { const result = await local.submit(...args); return result.completion || result.result || result; },
    async close() {
      if (closing) return closing;
      closed = true;
      closing = (lost ? Promise.resolve() : invoke(ref, 'close', [], { timeoutMs: 5000 }))
        .finally(() => { listeners.clear(); release?.(); onClose?.(ref); });
      closing.catch(() => {}); return closing;
    },
  });
  const outputs = require('../pi-session/outputs');
  local.outputs = () => outputs.list(local.cwd, local.outputSince ?? local.startedAt ?? 0);
  local.outputSnapshot = () => ({ ...outputs.scan(local.cwd, local.outputSince ?? local.startedAt ?? 0,
    state.data?.state?.execution?.startedAt || 0), fileChanges: local.fileChanges || null });
  for (const method of ['submit', 'continueGoal', 'pauseGoal', 'disableGoal', 'cancel', 'cancelQueued', 'updateQueue',
    'setAccessPolicy', 'selectModel', 'setThinkingMode', 'bindTask', 'answerUi', 'toolDetail',
    'outputSnapshotAsync', 'appendTaskMessage', 'appendTaskTool',
    'appendTaskRuntimeEvent', 'appendTaskBatch', 'rememberWorkflowPlugin',
    'taskExecutionChanged', 'pluginDebugChanged', 'claimInterruptedTask', 'releaseInterruptedTask']) {
    local[method] = (...args) => observed(method, args,
      ['cancel', 'answerUi'].includes(method) ? { timeoutMs: 5000 } : undefined);
  }
  // Callers needing the entire raw tool record use an asynchronous read. The
  // ordinary snapshot is the complete platform transcript with tool summaries.
  local.snapshotAsync = options => call('snapshot', [options]);
  const handle = new Proxy(local, {
    set(target, key, value) {
      Reflect.set(target, key, value);
      if (key === 'captureDelivery') {
        const pending = setProperty(ref, key, value); pending.catch(() => {});
      }
      return true;
    },
  });
  function update(packet) {
    if (closed || lost) return;
    projection.apply(state, packet);
    if (packet.data) {
      Object.assign(local, packet.data.properties, { model: packet.data.model });
    }
    if (packet.event) {
      const value = snapshot();
      for (const listener of listeners) { try { listener(packet.event, value); } catch (_) { /* observer isolation */ } }
    }
  }
  function interrupted(error) {
    if (closed || lost) return;
    lost = Object.assign(failure(), { cause: error });
    const value = snapshot();
    for (const listener of listeners) { try { listener({ kind: 'runtime-unavailable', reason: lost.message }, value); } catch (_) {} }
  }
  return { handle, update, interrupted, isLost: () => Boolean(lost), state };
}
module.exports = { createProcessHandle, READ_METHODS };
