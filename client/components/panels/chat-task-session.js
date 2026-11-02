/*
 * Single frontend state model for requirement-bound conversations, joining
 * conversation/task/run identities and current snapshots. NativeChat still owns ordinary
 * chat. Store only public metadata, not credentials, raw prompts, or absolute paths;
 * localStorage is a sidebar recovery cache, not authority.
 */
(function (global) {
  'use strict';

  const clean = (value, max) => String(value == null ? '' : value).trim().slice(0, max || 240);
  const idOf = (value) => clean(value, 180);
  const STATUS = {
    idle: 'idle', starting: 'starting', queued: 'queued', pending: 'pending', todo: 'todo',
    draft: 'draft', dispatching: 'dispatching', doing: 'doing', running: 'running',
    executing: 'executing', streaming: 'streaming', waiting: 'waiting',
    'waiting-user': 'waiting-user', waiting_human: 'waiting_human', waiting_external: 'waiting_external',
    paused: 'paused', completed: 'completed', complete: 'complete', done: 'done', delivered: 'delivered',
    failed: 'failed', blocked: 'blocked', unreachable: 'unreachable', incomplete: 'incomplete',
    stopped: 'stopped', cancelled: 'cancelled', canceled: 'canceled', aborted: 'aborted',
  };
  const STATUS_ALIAS = {
    waiting_user: 'waiting-user', 'waiting-human': 'waiting_human', 'waiting-external': 'waiting_external',
    in_progress: 'running', 'in-progress': 'running', processing: 'running',
    success: 'completed', succeeded: 'completed', error: 'failed', canceled: 'cancelled',
  };
  const TERMINAL = new Set(['completed', 'complete', 'done', 'delivered', 'failed', 'blocked',
    'unreachable', 'incomplete', 'stopped', 'cancelled', 'canceled', 'aborted']);
  const PHASE_ALIAS = {
    understanding: 'understand', understood: 'understand', planning: 'plan', planned: 'plan',
    dispatching: 'dispatch', queued: 'dispatch', dispatched: 'dispatch',
    running: 'execute', executing: 'execute', implementing: 'execute', coding: 'execute',
    verifying: 'verify', reviewing: 'verify', reviewed: 'verify', checking: 'verify',
    delivery: 'complete', delivered: 'complete', done: 'complete', completed: 'complete',
    failed: 'failed', blocked: 'failed',
  };
  const PHASES = ['understand', 'plan', 'dispatch', 'execute', 'verify', 'complete'];

  function normalizeStatus(value) {
    const raw = clean(value, 40).toLowerCase();
    const key = STATUS_ALIAS[raw] || raw;
    return STATUS[key] ? key : 'starting';
  }

  function phaseOf(state) {
    const s = state || {};
    const snapshot = s.snapshot || {};
    const execution = snapshot.execution || {};
    const raw = clean(s.phase || execution.phase ||
      (execution.harness || {}).phase || (execution.quality || {}).phase, 40)
      .toLowerCase().replace(/-/g, '_');
    if (PHASE_ALIAS[raw]) return PHASE_ALIAS[raw];
    const status = normalizeStatus(s.status || snapshot.status || (s.task || {}).status);
    if (status === 'failed' || status === 'blocked' || status === 'unreachable' || status === 'incomplete') return 'failed';
    if (['waiting', 'waiting-user', 'waiting_human', 'waiting_external', 'paused'].includes(status)) return 'verify';
    if (['complete', 'completed', 'done', 'delivered'].includes(status)) return 'complete';
    if (['running', 'doing', 'executing', 'streaming'].includes(status)) return 'execute';
    if (['dispatching', 'queued'].includes(status)) return 'dispatch';
    return status === 'todo' || status === 'draft' || status === 'pending' ? 'understand' : 'plan';
  }

  function publicTask(value) {
    const task = value && typeof value === 'object' ? value : {};
    return Object.assign({}, task, {
      id: idOf(task.id), title: clean(task.title, 200), status: clean(task.status, 40),
      executionContext: task.executionContext && typeof task.executionContext === 'object'
        ? task.executionContext : undefined,
    });
  }

  function create(seed) {
    const initial = seed && typeof seed === 'object' ? seed : {};
    let current = {
      conversationId: idOf(initial.conversationId), taskId: idOf(initial.taskId), runId: idOf(initial.runId),
      status: normalizeStatus(initial.status || 'starting'), phase: clean(initial.phase, 40),
      task: publicTask(initial.task), snapshot: initial.snapshot || {}, execution: initial.execution || {},
      eventCursor: Math.max(0, Number(initial.eventCursor || 0)), revision: 0,
    };
    const events = new Map();
    const listeners = new Set();

    function emit() {
      current = Object.assign({}, current, { revision: current.revision + 1 });
      listeners.forEach((listener) => { try { listener(snapshot()); } catch (_) {} });
    }

    function snapshot() {
      return Object.assign({}, current, {
        task: publicTask(current.task),
        execution: Object.assign({}, current.execution || {}),
        snapshot: current.snapshot || {}, events: Array.from(events.values()).sort(eventOrder),
      });
    }

    function eventOrder(left, right) {
      const a = Number(left && (left.eventSequence || left.sequence || left.seq) || 0);
      const b = Number(right && (right.eventSequence || right.sequence || right.seq) || 0);
      return a - b;
    }

    function matchesScope(event) {
      const e = event || {};
      const scope = e.scope || e.eventScope || {};
      const conversationId = idOf(e.conversationId || e.conversation_id || scope.conversationId);
      const taskId = idOf(e.taskId || e.task_id || scope.taskId);
      const runId = idOf(e.runId || e.run_id || scope.runId);
      return (!conversationId || !current.conversationId || conversationId === current.conversationId) &&
        (!taskId || !current.taskId || taskId === current.taskId) &&
        (!runId || !current.runId || runId === current.runId);
    }

    function attach(task, patch) {
      const value = publicTask(task);
      const next = patch && typeof patch === 'object' ? patch : {};
      if (value.id) current.taskId = value.id;
      if (next.conversationId) current.conversationId = idOf(next.conversationId);
      if (next.runId) current.runId = idOf(next.runId);
      current.task = Object.assign({}, current.task || {}, value);
      if (value.status) current.status = normalizeStatus(value.status);
      if (next.status) current.status = normalizeStatus(next.status);
      if (next.phase) current.phase = clean(next.phase, 40);
      if (next.execution) current.execution = Object.assign({}, current.execution || {}, next.execution);
      emit();
      return snapshot();
    }

    function applySnapshot(value, meta) {
      const snapshotValue = value && typeof value === 'object' ? value : {};
      const extra = meta && typeof meta === 'object' ? meta : {};
      if (extra.conversationId && !current.conversationId) current.conversationId = idOf(extra.conversationId);
      if (extra.taskId && !current.taskId) current.taskId = idOf(extra.taskId);
      const execution = snapshotValue.execution && typeof snapshotValue.execution === 'object'
        ? snapshotValue.execution : {};
      const runId = idOf(extra.runId || execution.runId || execution.run_id ||
        snapshotValue.runId || snapshotValue.run_id);
      if (runId) current.runId = runId;
      const seq = Number(extra.eventSequence || extra.sequence || snapshotValue.eventSequence || snapshotValue.seq || 0);
      if (seq > current.eventCursor) current.eventCursor = seq;
      current.snapshot = snapshotValue;
      current.execution = Object.assign({}, current.execution || {}, execution);
      current.status = normalizeStatus(snapshotValue.status || execution.status || current.status);
      current.phase = clean(extra.phase || execution.phase ||
        (execution.harness || {}).phase || (execution.quality || {}).phase || current.phase, 40);
      emit();
      return snapshot();
    }

    function applyEvent(value) {
      const event = value && typeof value === 'object' ? value : null;
      if (!event || !matchesScope(event)) return false;
      const seq = Number(event.eventSequence || event.sequence || event.seq || 0);
      const key = idOf(event.id || (seq ? 'seq:' + seq : 'event:' + JSON.stringify(event).slice(0, 180)));
      if (events.has(key) || (seq > 0 && seq <= current.eventCursor)) return false;
      events.set(key, event);
      if (seq > current.eventCursor) current.eventCursor = seq;
      const snapshotValue = event.snapshot || event.data && event.data.snapshot;
      if (snapshotValue) applySnapshot(snapshotValue, event);
      else emit();
      return true;
    }

    function setExecution(value, runId) {
      const execution = value && typeof value === 'object' ? value : {};
      const nextRunId = idOf(runId || execution.runId || execution.run_id);
      if (nextRunId && current.runId && nextRunId !== current.runId) {
        events.clear();
        current.eventCursor = 0;
      }
      current.execution = Object.assign({}, current.execution || {}, execution);
      if (runId || execution.runId || execution.run_id) current.runId = idOf(runId || execution.runId || execution.run_id);
      if (execution.status) current.status = normalizeStatus(execution.status);
      emit();
      return snapshot();
    }

    function clearExecution() {
      events.clear();
      current.execution = {};
      current.runId = '';
      current.eventCursor = 0;
      emit();
    }

    function update(value) {
      const patch = value && typeof value === 'object' ? value : {};
      if (patch.task) attach(patch.task, patch);
      else {
        current = Object.assign({}, current, patch);
        if (patch.status) current.status = normalizeStatus(patch.status);
        emit();
      }
      return snapshot();
    }

    return {
      snapshot, attach, applySnapshot, applyEvent, setExecution, clearExecution, update,
      on: (listener) => { if (typeof listener !== 'function') return () => {}; listeners.add(listener); return () => listeners.delete(listener); },
      get conversationId() { return current.conversationId; },
      get taskId() { return current.taskId; },
      get runId() { return current.runId; },
    };
  }

  global.ChatTaskSession = { create, normalizeStatus, phaseOf, terminal: (status) => TERMINAL.has(normalizeStatus(status)), phases: PHASES.slice() };
})(window);
