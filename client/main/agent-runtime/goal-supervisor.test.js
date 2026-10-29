'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  FileGoalCheckpointStore,
  MemoryGoalCheckpointStore,
  checkpointKey,
} = require('./goal-checkpoint-store');
const { GoalSupervisor, isSafeTurnBoundary } = require('./goal-supervisor');

function snapshot(overrides) {
  const value = overrides || {};
  return {
    schema: 'soduwork.agent-runtime.snapshot/v1',
    adapterId: 'pi',
    sessionId: 'pi-goal-1',
    status: value.status || 'idle',
    running: Boolean(value.running),
    queued: Number(value.queued || 0),
    execution: {
      configured: true,
      visible: true,
      active: value.active !== false,
      paused: Boolean(value.paused),
      harness: {
        runId: 'goal-run-1',
        node: value.node || 'act',
        phase: value.phase || 'execute',
        state: value.state || (value.paused ? 'paused' : 'running'),
        decision: value.decision || '',
        reason: value.reason || '',
        iteration: Number(value.iteration || 1),
        revision: Number(value.revision || 1),
      },
      quality: { phase: value.qualityPhase || 'implementing', reason: value.reason || '' },
      limitRequest: value.paused ? { kind: 'steps', reason: 'limit reached' } : null,
    },
  };
}

function fakeSession(initial) {
  const listeners = new Set();
  let current = initial || snapshot();
  const controls = [];
  return {
    id: 'pi-goal-1',
    adapterId: 'pi',
    controls,
    snapshot() { return current; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    controlGoal(action) {
      controls.push(action);
      return { ok: true, accepted: true, action };
    },
    set(next) { current = next; },
    emit(type, sequence) {
      const event = {
        id: 'pi-goal-1:' + sequence,
        sequence,
        type,
        at: new Date(1700000000000 + sequence).toISOString(),
        payload: { snapshot: current },
      };
      listeners.forEach((listener) => listener(event));
    },
  };
}

test('safe turn boundaries exclude running and queued work', () => {
  assert.equal(isSafeTurnBoundary(snapshot({ running: true, status: 'running' })), false);
  assert.equal(isSafeTurnBoundary(snapshot({ queued: 1 })), false);
  assert.equal(isSafeTurnBoundary(snapshot({ status: 'waiting', state: 'running' })), false);
  assert.equal(isSafeTurnBoundary(snapshot({ paused: true, state: 'paused' })), true);
  assert.equal(isSafeTurnBoundary(snapshot({ active: false, state: 'completed' })), true);
});

test('Goal Supervisor persists only meaningful progress and canonical boundaries', () => {
  const store = new MemoryGoalCheckpointStore();
  const session = fakeSession(snapshot({ revision: 1 }));
  const supervisor = new GoalSupervisor({ session, store, epoch: 'epoch-a' });
  const attached = supervisor.checkpoint();

  session.emit('message.delta', 1);
  assert.equal(supervisor.checkpoint().revision, attached.revision);

  session.set(snapshot({ revision: 2, phase: 'verify', node: 'verify' }));
  session.emit('state.changed', 2);
  assert.equal(supervisor.checkpoint().goal.harnessRevision, 2);

  session.set(snapshot({ revision: 2, active: false, state: 'completed' }));
  session.emit('turn.completed', 3);
  const completed = supervisor.checkpoint();
  assert.equal(completed.safeBoundary, true);
  assert.equal(completed.boundaryType, 'turn.completed');
  assert.equal(completed.lastEvent.sequence, 3);
  assert.ok(completed.history.length >= 3);
  supervisor.dispose();
});

test('Goal Supervisor rejects steering during an active turn but allows emergency disable', () => {
  const session = fakeSession(snapshot({ running: true, status: 'running' }));
  const supervisor = new GoalSupervisor({ session, epoch: 'epoch-b' });

  const continued = supervisor.control('continue');
  assert.equal(continued.ok, false);
  assert.equal(continued.code, 'GOAL_TURN_ACTIVE');
  assert.deepEqual(session.controls, []);

  const disabled = supervisor.control('disable');
  assert.equal(disabled.ok, true);
  assert.deepEqual(session.controls, ['disable']);
  assert.equal(supervisor.checkpoint().action.state, 'accepted');
  supervisor.dispose();
});

test('Goal Supervisor continues a paused goal through the adapter capability', () => {
  const session = fakeSession(snapshot({ paused: true, state: 'paused', active: false }));
  const supervisor = new GoalSupervisor({ session, epoch: 'epoch-c' });
  const result = supervisor.control('continue');

  assert.equal(result.ok, true);
  assert.deepEqual(session.controls, ['continue']);
  assert.equal(supervisor.checkpoint().boundaryType, 'control.accepted');
  assert.equal(supervisor.checkpoint().action.name, 'continue');
  supervisor.dispose();
});

test('asynchronous goal admission is deduplicated and its completion remains independent', async () => {
  const session = fakeSession(snapshot({ paused: true, state: 'paused', active: false }));
  let admit, complete, calls = 0;
  const admission = new Promise(resolve => { admit = resolve; });
  const completion = new Promise(resolve => { complete = resolve; });
  session.controlGoal = () => { calls++; return admission; };
  const supervisor = new GoalSupervisor({ session });
  const first = supervisor.control('continue'), duplicate = supervisor.control('continue');
  assert.equal(first, duplicate); assert.equal(calls, 1);
  assert.equal(supervisor.checkpoint().action.state, 'requested');
  admit({ ok: true, accepted: true, completion });
  const accepted = await first;
  assert.equal(supervisor.checkpoint().action.state, 'accepted');
  let done = false; accepted.completion.then(() => { done = true; });
  await Promise.resolve(); assert.equal(done, false);
  complete({ ok: true }); assert.deepEqual(await accepted.completion, { ok: true });
  supervisor.dispose();
});

test('delayed continuation acknowledgements do not replace a newer emergency pause', async () => {
  const session = fakeSession(snapshot({ paused: true, state: 'paused', active: false }));
  let admit;
  session.controlGoal = action => action === 'continue' ? new Promise(resolve => { admit = resolve; }) : { ok: true };
  const supervisor = new GoalSupervisor({ session });
  const continuing = supervisor.control('continue');
  assert.equal(supervisor.control('pause').ok, true);
  admit({ ok: true, accepted: true }); await continuing;
  assert.equal(supervisor.checkpoint().action.name, 'pause');
  assert.equal(supervisor.checkpoint().action.state, 'accepted');
  supervisor.dispose();
});

test('a failed asynchronous control records rejection and permits an explicit retry', async () => {
  const session = fakeSession(snapshot({ paused: true, state: 'paused', active: false }));
  session.controlGoal = async () => { throw Object.assign(Error('execution process unavailable'), { code: 'RUNTIME_PROCESS_GONE' }); };
  const supervisor = new GoalSupervisor({ session });
  const rejected = await supervisor.control('continue');
  assert.equal(rejected.ok, false); assert.equal(rejected.code, 'RUNTIME_PROCESS_GONE');
  assert.equal(supervisor.checkpoint().action.state, 'rejected');
  session.controlGoal = () => ({ ok: true, accepted: true });
  assert.equal(supervisor.control('continue').ok, true);
  assert.equal(supervisor.checkpoint().action.state, 'accepted');
  supervisor.dispose();
});

test('file checkpoint store uses a hashed filename and restores bounded state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-goal-checkpoints-'));
  try {
    const store = new FileGoalCheckpointStore(root);
    const row = {
      adapterId: 'pi', sessionId: 'secret-looking-session-id', runtimeId: 'desktop',
      revision: 1, status: 'idle', safeBoundary: true, boundaryType: 'turn.completed',
      goal: { configured: true, state: 'completed', reason: 'done' },
      at: new Date().toISOString(), history: [],
    };
    store.save(row);
    const names = fs.readdirSync(root);
    assert.deepEqual(names, [checkpointKey('pi', 'secret-looking-session-id') + '.json']);
    assert.equal(names[0].includes('secret-looking-session-id'), false);
    store.save({ ...row, revision: 2, goal: { ...row.goal, reason: 'verified again' } });
    const restored = store.load('pi', 'secret-looking-session-id');
    assert.equal(restored.revision, 2);
    assert.equal(restored.goal.state, 'completed');
    assert.equal(restored.goal.reason, 'verified again');
    assert.equal(fs.existsSync(path.join(root, names[0] + '.bak')), false);
    assert.equal(store.load('pi', 'another-session'), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('checkpoint revisions continue across a supervisor restart', () => {
  const store = new MemoryGoalCheckpointStore();
  const firstSession = fakeSession(snapshot({ paused: true, state: 'paused', revision: 4 }));
  const first = new GoalSupervisor({ session: firstSession, store, epoch: 'epoch-1' });
  const before = first.checkpoint().revision;
  first.dispose();

  const resumedSession = fakeSession(snapshot({ paused: true, state: 'paused', revision: 4 }));
  const resumed = new GoalSupervisor({ session: resumedSession, store, epoch: 'epoch-2' });
  assert.ok(resumed.checkpoint().revision > before);
  assert.equal(resumed.checkpoint().epoch, 'epoch-2');
  assert.equal(resumed.checkpoint().goal.state, 'paused');
  resumed.dispose();
});
