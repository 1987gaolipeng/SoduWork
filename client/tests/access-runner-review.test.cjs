'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRunnerRuntimeAdapter, getRunnerSessionDetails } = require('../main/agent-runtime/runner-adapter');
const policy = require('../main/access-control/policy');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let n = 0; n < 300; n++) { if (check()) return; await delay(10); }
  throw Error('Condition timeout');
}
async function fixture(t, mode, initialStatus, pendingMode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-access-resume-'));
  const state = { status: initialStatus, accessPolicy: policy.create(mode, root), calls: [] };
  if (pendingMode) state.nextAccessPolicy = policy.next(pendingMode, root, state.accessPolicy, 1);
  state.pendingPermissions = initialStatus === 'waiting-permission'
    ? [{ requestId: 'pending-restored', policyRevision: 1, action: 'command.execute' }] : [];
  const adapter = createRunnerRuntimeAdapter({
    runnerRuntime: { async rpc(op, payload) {
      state.calls.push({ op, payload });
      if (op === 'job.session') return { ok: true, data: { ...state, nextAccessPolicy: state.nextAccessPolicy || {}, items: [] } };
      if (op === 'job.permission' || op === 'job.stop') {
        if (state.stopWait && op === 'job.stop') await state.stopWait;
        state.status = 'done'; state.pendingPermissions = [];
        return { ok: true, data: { ok: true } };
      }
      if (op === 'job.comment') {
        state.accessPolicy = payload.cfg.accessPolicy;
        state.nextAccessPolicy = null;
        state.status = 'done';
        return { ok: true, data: { ok: true } };
      }
      if (op === 'job.access') {
        assert.equal(payload.expectedRevision, (state.nextAccessPolicy || state.accessPolicy).revision);
        state.nextAccessPolicy = payload.accessPolicy;
        return { ok: true, data: { ok: true } };
      }
      if (op === 'runtime.detect') return { ok: true, data: { installed: true, state: 'ready', accessControl: {
        schema: policy.SCHEMA, supported: true, canChangeDuringSession: true, modes: ['standard', 'readonly', 'full'] } } };
      throw Error(op);
    } },
    modelConfig: { fetchModel: async () => ({ ok: true, model: { id: 'fixture', key: 'fixture' } }) },
  });
  const session = await adapter.resumeSession({ native: { runner: { openOptions: {
    ref: 'restore-fixture', resumePath: 'restored-run', cwd: root,
  } } } });
  t.after(async () => { await session.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { ...state, state, adapter, session, handle: getRunnerSessionDetails(session).handle };
}

test('restoring an ended full session keeps its selected access mode', async t => {
  const f = await fixture(t, 'full', 'done');
  await until(() => f.handle.snapshot().accessPolicy?.mode === 'full');
  assert.equal(f.handle.snapshot().accessPolicy.mode, 'full');
  const submitted = f.session.send({ text: 'new user turn' });
  await submitted.completion;
  const sent = f.state.calls.find(row => row.op === 'job.comment').payload.cfg.accessPolicy;
  assert.equal(sent.mode, 'full'); assert.equal(sent.revision, 1);
  assert.equal(f.handle.snapshot().accessPolicy.mode, 'full');
});

test('restored waiting session holds queued input until the real approval completes', async t => {
  const f = await fixture(t, 'standard', 'waiting-permission');
  await until(() => f.handle.snapshot().pendingPermissions.length);
  const submitted = f.session.send({ text: 'queued behind approval' });
  assert.equal(submitted.queued, true);
  await delay(30);
  assert.equal(f.state.calls.some(row => row.op === 'job.comment'), false);
  assert.equal(f.handle.inFlight(), true);
  await f.handle.answerUi({ ...f.handle.snapshot().pendingPermissions[0], decision: 'deny' });
  await submitted.completion;
  assert.equal(f.state.calls.filter(row => row.op === 'job.comment').length, 1);
});

test('restoring full with pending readonly keeps the explicit downgrade, saves it and can select again', async t => {
  const f = await fixture(t, 'full', 'done', 'readonly');
  await until(() => f.handle.snapshot().accessControl.canChangeDuringSession);
  assert.equal(f.handle.snapshot().nextAccessPolicy.mode, 'readonly');
  assert.equal(f.handle.snapshot().nextAccessPolicy.revision, 2);
  assert.equal(f.state.nextAccessPolicy.mode, 'readonly');
  await f.session.send({ text: 'respect the scheduled downgrade' }).completion;
  assert.equal(f.handle.snapshot().accessPolicy.mode, 'readonly');
  const standard = policy.next('standard', f.handle.cwd, f.handle.snapshot().accessPolicy, 2);
  assert.equal((await f.handle.setAccessPolicy(standard, 2)).ok, true);
  assert.equal(f.state.nextAccessPolicy.revision, 3);
});

test('cancel removes pending choices and waits for stop acknowledgement before next work', async t => {
  const f = await fixture(t, 'standard', 'waiting-permission');
  await until(() => f.handle.snapshot().pendingPermissions.length);
  const request = f.handle.snapshot().pendingPermissions[0];
  let acknowledge;
  f.state.stopWait = new Promise(resolve => { acknowledge = resolve; });
  f.handle.cancel();
  assert.equal(f.handle.snapshot().pendingPermissions.length, 0);
  assert.equal((await f.handle.answerUi({ ...request, decision: 'once' })).ok, false);
  const submitted = f.session.send({ text: 'after cancel' });
  await delay(30);
  assert.equal(f.state.calls.some(row => row.op === 'job.comment'), false);
  acknowledge(); await submitted.completion;
  assert.equal(f.state.calls.filter(row => row.op === 'job.comment').length, 1);
});

test('Runner detection preserves authoritative permission capability metadata', async t => {
  const f = await fixture(t, 'standard', 'done');
  const result = await f.adapter.detect();
  assert.equal(result.accessControl.supported, true);
  assert.equal(result.accessControl.schema, policy.SCHEMA);
});
