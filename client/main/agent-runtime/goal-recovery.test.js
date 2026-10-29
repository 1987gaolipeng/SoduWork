'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  FileGoalCheckpointStore,
  MemoryGoalCheckpointStore,
} = require('./goal-checkpoint-store');
const {
  GoalSupervisor,
  classifyGoalRecovery,
} = require('./goal-supervisor');
const { createPiSessionBridge } = require('./pi-session-bridge');

function snapshot(overrides) {
  const value = overrides || {};
  return {
    status: value.status || 'idle',
    running: Boolean(value.running),
    queued: Number(value.queued || 0),
    execution: {
      configured: true,
      visible: true,
      active: value.active !== false,
      paused: Boolean(value.paused),
      harness: {
        runId: 'goal-recovery-run',
        node: value.node || 'act',
        phase: value.phase || 'execute',
        state: value.state || (value.paused ? 'paused' : 'running'),
        revision: Number(value.revision || 1),
        iteration: 1,
      },
      limitRequest: value.paused ? { kind: 'interrupted', reason: 'restart' } : null,
    },
  };
}

function fakeSession(initial) {
  const listeners = new Set();
  let current = initial || snapshot({ paused: true });
  const controls = [];
  return {
    id: 'goal-recovery-session',
    adapterId: 'pi',
    controls,
    snapshot() { return current; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    controlGoal(action) { controls.push(action); return { ok: true, accepted: true, action }; },
    set(next) { current = next; },
  };
}

test('only one runtime can own a goal checkpoint and disposal releases it', () => {
  const store = new MemoryGoalCheckpointStore();
  const first = new GoalSupervisor({
    session: fakeSession(), store, runtimeId: 'desktop-a', epoch: 'epoch-a',
  });
  assert.throws(() => new GoalSupervisor({
    session: fakeSession(), store, runtimeId: 'desktop-b', epoch: 'epoch-b',
  }), (error) => error.code === 'GOAL_CHECKPOINT_LEASED');

  assert.equal(first.dispose(), true);
  const second = new GoalSupervisor({
    session: fakeSession(), store, runtimeId: 'desktop-b', epoch: 'epoch-b',
  });
  assert.equal(second.checkpoint().runtimeId, 'desktop-b');
  second.dispose();
});

test('repeated goal control at the same boundary is idempotent', () => {
  const session = fakeSession(snapshot({ paused: true, state: 'paused', active: false }));
  const supervisor = new GoalSupervisor({ session, epoch: 'idempotent-epoch' });

  assert.equal(supervisor.control('continue').ok, true);
  const repeated = supervisor.control('continue');
  assert.equal(repeated.ok, true);
  assert.equal(repeated.idempotent, true);
  assert.deepEqual(session.controls, ['continue']);
  assert.match(supervisor.checkpoint().action.key, /^[a-f0-9]{64}$/);
  supervisor.dispose();
});

test('unsafe checkpoint is classified as interrupted and requires explicit resume', () => {
  const store = new MemoryGoalCheckpointStore();
  store.save({
    adapterId: 'pi', sessionId: 'goal-recovery-session', runtimeId: 'desktop-old',
    epoch: 'old-epoch', revision: 9, status: 'streaming', safeBoundary: false,
    boundaryType: 'action.started',
    goal: { configured: true, active: true, state: 'running', runId: 'old-run' },
    at: '2026-08-23T00:00:00.000Z', history: [],
  });
  const session = fakeSession(snapshot({ paused: true, state: 'paused', active: false }));
  const supervisor = new GoalSupervisor({ session, store, epoch: 'new-epoch' });
  const recovery = supervisor.recovery();

  assert.equal(recovery.kind, 'interrupted');
  assert.equal(recovery.fromEpoch, 'old-epoch');
  assert.equal(recovery.fromRevision, 9);
  assert.equal(recovery.requiresResume, true);
  assert.equal(supervisor.checkpoint().recovery.kind, 'interrupted');
  supervisor.dispose();
});

test('terminal checkpoint is never offered for recovery', () => {
  const recovery = classifyGoalRecovery({
    epoch: 'done-epoch', revision: 3, status: 'idle', safeBoundary: true,
    goal: { configured: true, state: 'completed' },
  }, snapshot({ active: false, state: 'completed' }), () => new Date('2026-08-23T00:00:00Z'));
  assert.equal(recovery.kind, 'terminal');
  assert.equal(recovery.requiresResume, false);
});

test('file lease rejects a live owner and permits deterministic stale takeover', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-goal-lease-'));
  let now = 10_000;
  try {
    const options = {
      clock: () => now, leaseTtlMs: 5000, host: 'test-host', pid: 4242,
      processAlive: () => true,
    };
    const store = new FileGoalCheckpointStore(root, options);
    store.claim('pi', 'session-a', 'owner-a');
    assert.throws(() => store.claim('pi', 'session-a', 'owner-b'),
      (error) => error.code === 'GOAL_CHECKPOINT_LEASED');

    now += 5001;
    const taken = store.claim('pi', 'session-a', 'owner-b');
    assert.equal(taken.owner, 'owner-b');
    assert.equal(store.release('pi', 'session-a', 'owner-a'), false);
    assert.equal(store.release('pi', 'session-a', 'owner-b'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bridge lists only inactive non-terminal durable goal checkpoints', async () => {
  const store = new MemoryGoalCheckpointStore();
  store.save({
    adapterId: 'pi', sessionId: 'paused-session', runtimeId: 'desktop', revision: 2,
    status: 'idle', safeBoundary: true, boundaryType: 'turn.paused',
    recovery: { kind: 'paused', requiresResume: true },
    goal: { configured: true, active: false, paused: true, state: 'paused' },
    at: '2026-08-23T01:00:00Z', history: [],
  });
  store.save({
    adapterId: 'pi', sessionId: 'done-session', runtimeId: 'desktop', revision: 3,
    status: 'idle', safeBoundary: true, boundaryType: 'turn.completed',
    recovery: { kind: 'terminal' },
    goal: { configured: true, active: false, state: 'completed' },
    at: '2026-08-23T02:00:00Z', history: [],
  });
  const bridge = createPiSessionBridge({
    checkpointStore: store,
    sessionModule: {
      async probe() { return { ok: true }; },
      async open() { return { ok: false, reason: 'unused' }; },
    },
  });
  const rows = bridge.recoverableGoals();
  assert.deepEqual(rows.map((row) => row.sessionId), ['paused-session']);
  assert.equal(rows[0].recovery.requiresResume, true);
  await bridge.dispose();
});
