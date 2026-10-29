'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const policy = require('../main/access-control/policy');
const broker = require('../main/access-control/broker');
const catalog = require('../main/agent-runtime/runtime-catalog');
const runControl = require('../main/pi-session/run-control');

test('a refused operation cannot repeat confirmation until the next real user turn', async () => {
  const p = policy.create('standard', os.tmpdir());
  const b = broker.create({ policy: p });
  const op = policy.operation(p, 'bash', { command: 'echo repeated' });
  const first = b.authorize(op);
  b.answer({ ...b.pending()[0], decision: 'deny' });
  assert.equal(await first, false);
  assert.equal(await b.authorize(op), false);
  assert.equal(b.pending().length, 0);
  b.beginTurn();
  const second = b.authorize(op);
  assert.equal(b.pending().length, 1);
  b.answer({ ...b.pending()[0], decision: 'once' });
  assert.equal(await second, true);
  b.close();
});

test('approval cannot race an expired deadline when the timer callback has not run', async () => {
  const p = policy.create('standard', os.tmpdir());
  const b = broker.create({ policy: p, timeoutMs: 20 });
  const waiting = b.authorize(policy.operation(p, 'bash', { command: 'echo expired' }));
  const request = b.pending()[0];
  // Keep this event-loop turn occupied past expiry, before timer callbacks execute.
  const deadline = Date.now() + 30;
  while (Date.now() < deadline) {}
  assert.equal(b.answer({ ...request, decision: 'session' }).ok, false);
  assert.equal(await waiting, false);
  b.close();
});

test('the selected access policy survives archive restoration', () => {
  const original = policy.create('full', os.tmpdir());
  const restored = policy.restore(original, os.tmpdir());
  assert.equal(restored.mode, 'full');
  assert.equal(restored.revision, original.revision);
  assert.equal(original.mode, 'full');
  assert.equal(policy.restore(undefined), null);
  assert.equal(policy.restore(policy.create('readonly', os.tmpdir())).mode, 'readonly');
});

test('catalog exposes versioned access support and never claims a universal sandbox', () => {
  for (const row of catalog.runtimes()) {
    const exported = catalog.publicRuntime(row);
    assert.equal(exported.accessControl.schema, policy.SCHEMA);
    assert.equal(exported.accessControl.sandbox, false);
    assert.equal(exported.accessControl.supported, ['pi', 'codex-harness', 'opencode', 'qwen', 'codex', 'dsh', 'harness2'].includes(row.id));
    assert.deepEqual(exported.accessControl.modes, exported.accessControl.supported ? ['standard', 'readonly', 'full'] : []);
  }
});

test('waiting for permission freezes execution clocks without stalled or long-running hints', () => {
  const run = runControl.createState(), now = Date.now();
  run.startedAt = now - 600000;
  run.lastActivityAt = now - 590000;
  run.promptActive = true;
  run.permissionWaitSince = now - 580000;
  run.activeTools.set('tool', { id: 'tool', name: 'bash', startedAt: now - 590000, lastProgressAt: now - 590000 });
  const context = { status: () => 'waiting-user', limitRequest: () => null, configured: true,
    visible: () => true, goalEnabled: () => true, inFlight: () => true,
    qualityPhase: () => 'executing', qualityReason: () => '', qualityRounds: () => 1,
    queueView: () => [], queueSize: () => 0, harnessView: () => ({}),
    toolGuard: { SOFT_NOTICE_MS: 1000, STALL_NOTICE_MS: 1000 } };
  const view = runControl.execution(run, context);
  assert.equal(view.waitingPermission, true);
  assert.equal(view.elapsedMs, 20000);
  assert.equal(view.running, true);
  assert.equal(view.stalled, false);
  assert.equal(view.longRunning, false);
  runControl.permissionWait(run, false);
  assert.equal(run.permissionWaitSince, 0);
  assert.ok(Date.now() - run.startedAt < 21000);
});
