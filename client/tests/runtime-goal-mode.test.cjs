'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const catalog = require('../main/agent-runtime/runtime-catalog');
const { createRunnerRuntimeAdapter, _uuidV5 } = require('../main/agent-runtime/runner-adapter');
const { createPiSessionBridge } = require('../main/agent-runtime/pi-session-bridge');
const goalActions = require('../main/pi-session/goal-actions');

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-no-goal-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const spec = { ...catalog.runtime('qwen'), id: 'chat-only-acp', goalMode: 'none' };
  const calls = [];
  const adapter = createRunnerRuntimeAdapter({ runtimeSpec: spec,
    modelConfig: { fetchModel: async () => {
      calls.push('model'); return { ok: true, model: { id: 'fixture' } };
    } },
    runnerRuntime: { rpc: async (op, payload) => {
      calls.push(op);
      if (op === 'job.dispatch') return { ok: true, data: {
        ref: _uuidV5('9af442c8-cd1d-4b91-a668-22da2b2635bf', payload.dispatchId),
      } };
      if (op === 'job.session') return { ok: true, data: { status: 'done', round: 1,
        items: [{ seq: 1, kind: 'say', text: 'Ordinary chat delivered' }] } };
      return { ok: true, data: {} };
    } },
  });
  const bridge = createPiSessionBridge({ runnerAdapters: [adapter],
    catalog: catalog.createRuntimeCatalog({ schemaVersion: 1, agents: [catalog.runtime('pi'), spec] }),
    sessionModule: { probe: async () => ({ ok: true }),
      open: async () => { throw Error('Unexpected Pi fallback'); } },
  });
  t.after(() => bridge.dispose());
  return { cwd, spec, adapter, bridge, calls };
}

test('chat-only ACP declines goal create/resume before contacting models or the Runner', async t => {
  const f = fixture(t);
  assert.equal(f.adapter.capabilities.some(row => row.id === 'goal.control'), false);
  for (const method of ['createSession', 'resumeSession']) {
    for (const options of [{ consumer: 'goal' }, { native: { runner: { openOptions: { intent: 'goal' } } } },
      { native: { runner: { openOptions: { mode: 'goal' } } } }]) {
      await assert.rejects(() => f.adapter[method](options), error => error.code === 'GOAL_MODE_UNSUPPORTED');
    }
  }
  for (const resumePath of ['', 'old-session']) {
    const result = await f.bridge.open({ adapterId: f.spec.id, intent: 'goal', resumePath, cwd: f.cwd });
    assert.equal(result.ok, false);
    assert.equal(result.runtimeError, 'GOAL_MODE_UNSUPPORTED');
  }
  assert.deepEqual(f.calls, [], 'unsupported goal never fetches credentials or starts execution');
});

test('ordinary chat stays usable and cannot enable goal controls through the active session API', async t => {
  const f = fixture(t);
  const opened = await f.bridge.open({ adapterId: f.spec.id, ref: 'chat-none', cwd: f.cwd });
  assert.equal(opened.ok, true, opened.reason);
  assert.equal(opened.session.snapshot().execution.configured, false);
  const runtimeSession = f.bridge.runtimeSession(opened.session.ref);
  assert.equal(runtimeSession.capabilities.some(row => row.id === 'goal.control'), false);
  assert.equal(f.bridge.runtimes().find(row => row.id === f.spec.id).capabilities.includes('goal.control'), false);
  assert.throws(() => runtimeSession.controlGoal('continue'), error => error.code === 'CAPABILITY_UNAVAILABLE');
  const act = goalActions.create({ session: { get: () => opened.session },
    publish: () => assert.fail('rejected controls must not publish'), scheduleRelease() {} });
  for (const action of ['continue', 'stop', 'disable']) {
    assert.equal(act(null, opened.session.ref, action).ok, false);
  }
  assert.equal(opened.session.snapshot().execution.configured, false);
  const sent = await opened.session.submit('Ordinary chat').completion;
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.equal(f.calls.filter(op => op === 'job.dispatch').length, 1);
});

test('all existing Runner substrates keep their declared goal capability', () => {
  for (const spec of catalog.runnerRuntimes()) {
    assert.equal(spec.goalMode, 'native');
    const adapter = createRunnerRuntimeAdapter({ runtimeSpec: spec });
    assert.equal(adapter.capabilities.some(row => row.id === 'goal.control'), true, spec.id);
  }
});

test('goal IPC waits for process admission and publishes settled only after execution completion', async () => {
  let admit, complete;
  const completion = new Promise(resolve => { complete = resolve; });
  const publications = [], releases = [];
  const handle = { snapshot: () => ({ status: 'idle' }), detached: true,
    continueGoal: () => new Promise(resolve => { admit = resolve; }),
    pauseGoal: async () => ({ ok: true }), disableGoal: async () => ({ ok: true }) };
  const act = goalActions.create({ session: { get: () => handle },
    publish: (_handle, event) => publications.push(event.kind), scheduleRelease: value => releases.push(value) });
  const pending = act(null, 'chat', 'continue');
  assert.deepEqual(publications, []);
  admit({ ok: true, accepted: true, completion });
  assert.equal((await pending).accepted, true);
  assert.deepEqual(publications, ['goal-resuming']); assert.equal(releases.length, 0);
  complete({ ok: true }); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(publications, ['goal-resuming', 'settled']); assert.deepEqual(releases, [handle]);
  assert.equal((await act(null, 'chat', 'stop')).ok, true);
  assert.equal((await act(null, 'chat', 'disable')).ok, true);
  assert.deepEqual(publications.slice(-2), ['goal-stop', 'goal-disable']);
});

test('idempotent goal admission without a new completion cannot invent a settled/error event', async () => {
  const publications = [];
  const handle = { snapshot: () => ({}), continueGoal: async () => ({ ok: true, accepted: true, idempotent: true }) };
  const act = goalActions.create({ session: { get: () => handle },
    publish: (_handle, event) => publications.push(event.kind), scheduleRelease() {} });
  assert.equal((await act(null, 'chat', 'continue')).idempotent, true);
  await Promise.resolve(); assert.deepEqual(publications, ['goal-resuming']);
});
