'use strict';

const crypto = require('crypto');
const { RuntimeContractError } = require('./contract');
const { MemoryGoalCheckpointStore, normalizeGoalCheckpoint } = require('./goal-checkpoint-store');

const BOUNDARY_EVENTS = new Set([
  'turn.completed', 'turn.failed', 'turn.cancelled', 'turn.paused',
  'approval.requested', 'approval.resolved',
]);
const TERMINAL_GOAL_STATES = new Set(['completed', 'cancelled', 'disabled']);

function _object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function _iso(clock) {
  return new Date(clock()).toISOString();
}

function _goalState(snapshot) {
  const snap = _object(snapshot);
  const execution = _object(snap.execution);
  const harness = _object(execution.harness);
  const quality = _object(execution.quality);
  const pause = _object(execution.limitRequest || harness.pause);
  return {
    configured: Boolean(execution.configured),
    visible: Boolean(execution.visible),
    active: Boolean(execution.active),
    runId: String(harness.runId || ''),
    node: String(harness.node || ''),
    phase: String(harness.phase || quality.phase || ''),
    state: String(harness.state || (execution.paused ? 'paused' : '')),
    decision: String(harness.decision || ''),
    reason: String(harness.reason || quality.reason || execution.reason || ''),
    iteration: Number(harness.iteration || 0),
    harnessRevision: Number(harness.revision || 0),
    qualityPhase: String(quality.phase || ''),
    qualityReason: String(quality.reason || ''),
    paused: Boolean(execution.paused || harness.state === 'paused'),
    pauseKind: String(pause.kind || ''),
  };
}

function _isTerminalCheckpoint(checkpoint) {
  const row = _object(checkpoint);
  const goal = _object(row.goal);
  const action = _object(row.action);
  return TERMINAL_GOAL_STATES.has(String(goal.state || '')) ||
    (action.name === 'disable' && action.state === 'accepted');
}

function classifyGoalRecovery(previous, snapshot, clock) {
  const row = _object(previous);
  if (!row.revision) {
    return {
      kind: 'fresh', fromEpoch: '', fromRevision: 0, previousSafeBoundary: true,
      interrupted: false, requiresResume: false, at: _iso(clock),
    };
  }
  const paused = Boolean(row.goal && (row.goal.paused || row.goal.state === 'paused'));
  const interrupted = !row.safeBoundary ||
    ['running', 'streaming', 'working'].includes(String(row.status || ''));
  const terminal = _isTerminalCheckpoint(row);
  return {
    kind: terminal ? 'terminal' : (interrupted ? 'interrupted' : (paused ? 'paused' : 'resumed')),
    fromEpoch: String(row.epoch || ''),
    fromRevision: Number(row.revision || 0),
    previousSafeBoundary: Boolean(row.safeBoundary),
    interrupted,
    requiresResume: !terminal && (interrupted || paused),
    at: _iso(clock),
  };
}

function isSafeTurnBoundary(snapshot) {
  const snap = _object(snapshot);
  const goal = _goalState(snap);
  const status = String(snap.status || 'idle');
  const terminal = ['idle', 'failed', 'cancelled'].includes(status) ||
    ['paused', 'blocked', 'completed'].includes(goal.state);
  return !Boolean(snap.running) && Number(snap.queued || 0) === 0 && terminal;
}

class GoalSupervisor {
  constructor(options) {
    const opts = options || {};
    const session = opts.session;
    if (!session || typeof session.snapshot !== 'function' ||
        typeof session.subscribe !== 'function' || typeof session.controlGoal !== 'function') {
      throw new RuntimeContractError('INVALID_GOAL_SESSION',
        'Goal Supervisor needs snapshot(), subscribe() and controlGoal()');
    }
    this.session = session;
    this.adapterId = String(opts.adapterId || session.adapterId || '');
    this.sessionId = String(opts.sessionId || session.id || '');
    this.runtimeId = String(opts.runtimeId || 'local');
    this.store = opts.store || new MemoryGoalCheckpointStore();
    this.clock = typeof opts.clock === 'function' ? opts.clock : () => new Date();
    this.epoch = String(opts.epoch || crypto.randomUUID());
    this.owner = String(opts.owner || [this.runtimeId, process.pid, this.epoch].join(':'));
    this.disposed = false;
    this.pendingControls = new Map();
    this.persistenceError = '';
    this.current = this.store.load(this.adapterId, this.sessionId);
    this.recoveryState = classifyGoalRecovery(this.current, session.snapshot(), this.clock);
    this.lease = null;
    if (typeof this.store.claim === 'function') {
      try { this.lease = this.store.claim(this.adapterId, this.sessionId, this.owner); }
      catch (error) {
        throw new RuntimeContractError(error && error.code || 'GOAL_CHECKPOINT_LEASE_FAILED',
          String(error && error.message || error), error && error.details);
      }
    }
    this._unsubscribe = session.subscribe((event) => this._onEvent(event));
    this._capture('session.attached', null, session.snapshot());
  }

  _controlKey(name, snapshot) {
    const snap = _object(snapshot);
    const goal = _goalState(snap);
    const lastEvent = _object(this.current && this.current.lastEvent);
    return crypto.createHash('sha256').update(JSON.stringify({
      adapterId: this.adapterId,
      sessionId: this.sessionId,
      name,
      runId: goal.runId,
      harnessRevision: goal.harnessRevision,
      state: goal.state,
      paused: goal.paused,
      status: String(snap.status || ''),
      running: Boolean(snap.running),
      queued: Number(snap.queued || 0),
      lastEventId: String(lastEvent.id || ''),
    })).digest('hex');
  }

  _checkpoint(boundaryType, event, snapshot, action) {
    const previous = this.current || {};
    const goal = _goalState(snapshot);
    const at = _iso(this.clock);
    const lastEvent = event ? {
      id: event.id,
      sequence: event.sequence,
      type: event.type,
      at: event.at,
    } : previous.lastEvent;
    const row = {
      adapterId: this.adapterId,
      sessionId: this.sessionId,
      runtimeId: this.runtimeId,
      epoch: this.epoch,
      revision: Number(previous.revision || 0) + 1,
      status: String(snapshot && snapshot.status || 'idle'),
      safeBoundary: isSafeTurnBoundary(snapshot),
      boundaryType,
      recovery: this.recoveryState,
      goal,
      action: action || previous.action,
      lastEvent,
      at,
    };
    const history = Array.isArray(previous.history) ? previous.history : [];
    row.history = [...history, {
      revision: row.revision,
      status: row.status,
      safeBoundary: row.safeBoundary,
      boundaryType: row.boundaryType,
      goal: row.goal,
      action: row.action,
      lastEvent: row.lastEvent,
      at: row.at,
    }].slice(-64);
    return normalizeGoalCheckpoint(row);
  }

  _capture(boundaryType, event, suppliedSnapshot, action) {
    if (this.disposed) return this.current;
    const snapshot = suppliedSnapshot || this.session.snapshot();
    const next = this._checkpoint(boundaryType, event, snapshot, action);
    try {
      if (typeof this.store.renew === 'function') {
        this.lease = this.store.renew(this.adapterId, this.sessionId, this.owner);
      }
      this.current = this.store.save(next, { owner: this.lease ? this.owner : '' });
      this.persistenceError = '';
    } catch (error) {
      this.current = next;
      this.persistenceError = String((error && error.message) || error);
    }
    return this.current;
  }

  _onEvent(event) {
    if (this.disposed || !event || typeof event !== 'object') return;
    const snapshot = _object(event.payload).snapshot || this.session.snapshot();
    const goal = _goalState(snapshot);
    const previousRevision = Number(this.current && this.current.goal &&
      this.current.goal.harnessRevision || 0);
    if (BOUNDARY_EVENTS.has(String(event.type || '')) ||
        goal.harnessRevision !== previousRevision) {
      this._capture(String(event.type || 'state.changed'), event, snapshot);
    }
  }

  control(action) {
    if (this.disposed) {
      return { ok: false, code: 'GOAL_SUPERVISOR_DISPOSED', reason: 'Goal session is closed' };
    }
    const name = String(action || '');
    if (!['continue', 'pause', 'disable'].includes(name)) {
      return { ok: false, code: 'INVALID_GOAL_ACTION', reason: 'Unsupported goal action: ' + name };
    }
    if (this.pendingControls.has(name)) return this.pendingControls.get(name);
    if (name !== 'disable' && this.persistenceError) {
      return {
        ok: false,
        code: 'GOAL_CHECKPOINT_UNAVAILABLE',
        reason: 'The durable goal checkpoint is unavailable',
      };
    }
    const snapshot = this.session.snapshot();
    const key = this._controlKey(name, snapshot);
    const previousAction = _object(this.current && this.current.action);
    if (previousAction.key === key && previousAction.state === 'accepted') {
      return { ok: true, accepted: true, action: name, idempotent: true };
    }
    /* Continue may only start from a durable boundary. Pause is deliberately
       allowed while a native agent is active: the requested checkpoint is
       persisted first, then the adapter aborts its current turn while keeping
       the native session and workspace resumable. */
    if (name === 'continue' && !isSafeTurnBoundary(snapshot)) {
      return {
        ok: false,
        code: 'GOAL_TURN_ACTIVE',
        reason: 'Goal continuation is available only after the current turn reaches a safe boundary',
      };
    }
    const requested = { name, state: 'requested', reason: '', at: _iso(this.clock), key };
    this._capture('control.requested', null, snapshot, requested);
    if (name !== 'disable' && this.persistenceError) {
      return {
        ok: false,
        code: 'GOAL_CHECKPOINT_UNAVAILABLE',
        reason: 'The action was not sent because its checkpoint could not be persisted',
      };
    }
    let result;
    try { result = this.session.controlGoal(name); }
    catch (error) {
      result = { ok: false, reason: String((error && error.message) || error) };
    }
    const settle = value => {
      const accepted = Boolean(value && value.ok);
      const settled = { name, state: accepted ? 'accepted' : 'rejected',
        reason: String(value && value.reason || ''), at: _iso(this.clock), key };
      // A later emergency pause/disable must not be replaced by an older
      // delayed acknowledgement. Its own requested action remains current.
      const currentAction = _object(this.current && this.current.action);
      if (currentAction.key === key)
        this._capture('control.' + settled.state, null, this.session.snapshot(), settled);
      if (this.persistenceError && value && typeof value === 'object')
        return { ...value, checkpointWarning: this.persistenceError };
      return value;
    };
    if (!result?.then) return settle(result);
    const pending = Promise.resolve(result).then(settle, error => settle({ ok: false,
      code: String(error?.code || ''), reason: String(error?.message || error) }))
      .finally(() => { if (this.pendingControls.get(name) === pending) this.pendingControls.delete(name); });
    this.pendingControls.set(name, pending);
    return pending;
  }

  checkpoint() {
    return this.current ? normalizeGoalCheckpoint(this.current) : null;
  }

  recovery() {
    return { ...this.recoveryState };
  }

  dispose() {
    if (this.disposed) return false;
    this._capture('session.detached', null, this.session.snapshot());
    this.disposed = true;
    try { if (typeof this._unsubscribe === 'function') this._unsubscribe(); } catch (error) { /* ignore */ }
    try {
      if (typeof this.store.release === 'function') {
        this.store.release(this.adapterId, this.sessionId, this.owner);
      }
    } catch (error) { /* A stale lease will be reclaimed by the next runtime. */ }
    return true;
  }
}

module.exports = {
  BOUNDARY_EVENTS,
  TERMINAL_GOAL_STATES,
  GoalSupervisor,
  classifyGoalRecovery,
  isSafeTurnBoundary,
};
