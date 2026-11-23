'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createRunnerRuntimeAdapter, getRunnerSessionDetails, _uuidV5 } = require('../main/agent-runtime/runner-adapter');
const catalog = require('../main/agent-runtime/runtime-catalog');
const rules = require('../main/access-control/policy');
const cache = require('../main/app-resource-cache.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const body = { template: 'method', key: 'worker-recovery', name: 'Worker recovery', version: '1.0.0',
  description: 'Synthetic package', instructions: 'Summarize the supplied material.' };
test.after(() => cache.close());

async function fixture(t, options = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-check-recovery-'));
  const file = path.join(cwd, 'soduwork-plugin-draft.json'), calls = [], receipts = [];
  const identity = {}, capability = { schema: rules.SCHEMA, supported: true, modes: [...rules.MODES], canChangeDuringSession: true };
  let round = 1, pending = null;
  const runtime = { async rpc(op, value) {
    calls.push({ op, value });
    if (op === 'runtime.detect') return { ok: true, data: { accessControl: capability } };
    if (op === 'job.dispatch') {
      if (options.dispatchFailure) throw options.dispatchFailure;
      fs.writeFileSync(file, JSON.stringify(body));
      return { ok: true, data: { ok: true, ref: _uuidV5('9af442c8-cd1d-4b91-a668-22da2b2635bf', value.dispatchId) } };
    }
    if (op === 'job.comment') { round++; return { ok: true, data: { ok: true, state: 'running' } }; }
    if (op === 'job.access') { pending = value.accessPolicy; return { ok: true, data: { ok: true, nextAccessPolicy: pending } }; }
    if (op === 'job.session' && pending && options.accessPoll) {
      options.onAccessPoll(); await options.accessPoll;
    }
    if (op === 'job.session') return { ok: true, data: { ok: true, status: 'done', round, seq: round + 1,
      accessControl: capability, nextAccessPolicy: pending, items: [{ seq: round + 1, kind: 'say', text: 'Native turn completed' }] } };
    return { ok: true, data: { ok: true } };
  } };
  const app = { getPath: () => cwd }, model = { ok: true, model: { id: 'fixture', key: 'fixture', input: ['text'] } };
  const adapter = createRunnerRuntimeAdapter({ app, runnerRuntime: runtime, runtimeSpec: catalog.runtime('opencode'),
    modelConfig: { fetchModel: async () => model, fetchSelection: async () => model } });
  const session = await adapter.createSession({ identity, native: { runner: { openOptions: { app, cwd, ref: 'worker-recovery' } } } });
  const handle = getRunnerSessionDetails(session).handle;
  t.after(async () => { await session.dispose(); await delay(20); fs.rmSync(cwd, { recursive: true, force: true }); });
  return { cwd, file, handle, session, calls, receipts, identity,
    submit: text => handle.submit(text, [], { afterTurn: (state, result) => receipts.push({ state, result }) }) };
}

function blockedFailure(t, phase) {
  let enter, fail, used = false, checked = false, candidatesAfterCheck = 0;
  const entered = new Promise(resolve => { enter = resolve; });
  const fault = new Promise(resolve => { fail = resolve; });
  if (phase === 'baseline') {
    const outputs = require('../main/pi-session/outputs'), scan = outputs.scanAsync;
    t.mock.method(outputs, 'scanAsync', async (...args) => {
      if (!used) { used = true; enter(); throw await fault; }
      return scan(...args);
    });
  } else {
    const request = cache.request;
    t.mock.method(cache, 'request', async input => {
      // The first candidate request after draft-check verifies its bytes;
      // the second recollects the final set, outside validateFile's catch.
      if (!used && input.action === 'draft-candidates' && checked && ++candidatesAfterCheck === 2) {
        used = true; enter(); throw await fault;
      }
      const result = await request(input);
      if (input.action === 'draft-check') checked = true;
      return result;
    });
  }
  t.after(() => fail(Error('Fixture cleanup')));
  return { entered, fail: () => fail(Error('Synthetic worker unavailable')) };
}

test('failed baseline scanning reports a retryable failure without dispatching and permits a new submission', async t => {
  const blocked = blockedFailure(t, 'baseline'), f = await fixture(t);
  const turn = f.submit('Make a plugin');
  await blocked.entered; blocked.fail();
  const result = await turn.completion;
  await delay(0);
  assert.equal(result.ok, false);
  assert.equal(result.failureKind, 'plugin-validation');
  assert.equal(result.retrySafe, true);
  assert.equal(f.handle.snapshot().status, 'unreachable');
  assert.equal(f.handle.inFlight(), false);
  assert.equal(f.calls.some(row => row.op.startsWith('job.')), false);
  assert.equal((await f.submit('Make a plugin after the worker recovers').completion).ok, true);
  assert.equal(f.calls.filter(row => row.op === 'job.dispatch').length, 1);
});

test('final recollection failure preserves files and pauses dependent work until explicit queue resume', async t => {
  const blocked = blockedFailure(t, 'final'), f = await fixture(t);
  const turn = f.submit('Make a plugin');
  await blocked.entered;
  const original = fs.readFileSync(f.file), next = f.submit('Review the existing draft');
  blocked.fail();
  const result = await turn.completion;
  await delay(0);
  assert.equal(result.ok, false);
  assert.equal(result.failureKind, 'plugin-validation');
  assert.equal(result.retrySafe, false, 'native writes must not be automatically replayed');
  const failed = f.handle.snapshot();
  assert.equal(failed.status, 'unreachable');
  assert.equal(failed.execution.running, false);
  assert.equal(failed.execution.turnQueue.paused, true);
  assert.equal(failed.queue.length, 1);
  assert.deepEqual(fs.readFileSync(f.file), original);
  assert.deepEqual(f.receipts.map(row => row.state), ['failed']);
  assert.equal(f.calls.filter(row => row.op === 'job.comment').length, 0);
  assert.equal(f.handle.updateQueue('', 'resume').ok, true);
  assert.equal((await next.completion).ok, true);
  await delay(0);
  assert.equal(f.handle.snapshot().status, 'idle');
  assert.equal(f.handle.inFlight(), false);
  assert.equal(f.calls.filter(row => row.op === 'job.dispatch').length, 1);
  assert.deepEqual(f.calls.filter(row => row.op === 'job.comment').map(row => row.value.text), ['Review the existing draft']);
  assert.deepEqual(fs.readFileSync(f.file), original);
  assert.deepEqual(f.receipts.map(row => row.state), ['failed', 'completed']);
});

for (const phase of ['baseline', 'final']) for (const control of ['cancel', 'close', 'owner', 'policy']) {
  test(phase + ' worker rejection cannot overwrite a newer ' + control + ' control', async t => {
    const blocked = blockedFailure(t, phase), f = await fixture(t), turn = f.submit('Make a plugin');
    await blocked.entered;
    if (control === 'cancel') f.handle.cancel();
    else if (control === 'close') f.handle.close();
    else if (control === 'owner') f.handle.deliveryOwner = { account: 'replacement-owner' };
    else {
      const snapshot = f.handle.snapshot(), previous = snapshot.nextAccessPolicy || snapshot.accessPolicy;
      const revision = previous?.revision || 0;
      const policy = rules.next('readonly', f.cwd, previous, revision);
      assert.equal((await f.handle.setAccessPolicy(policy, revision)).ok, true);
    }
    const previous = f.handle.snapshot();
    blocked.fail();
    const result = await turn.completion;
    await delay(20);
    assert.equal(result.cancelled, true);
    assert.notEqual(result.failureKind, 'plugin-validation');
    const after = f.handle.snapshot();
    assert.doesNotMatch(after.statusText || '', /Synthetic worker unavailable/);
    // Baseline preparation itself presents streaming over the original idle
    // state; releasing that preparation is not a write to the replacement owner.
    if (control === 'owner') assert.equal(after.status, phase === 'baseline' ? 'idle' : previous.status);
    if (control === 'policy') {
      assert.equal((after.nextAccessPolicy || after.accessPolicy).mode, 'readonly');
      assert.equal(after.execution.running, false);
      assert.equal(f.handle.inFlight(), false);
    }
    if (control === 'cancel') assert.equal(after.status, 'aborted');
    assert.equal(f.calls.filter(row => row.op === 'job.comment').length, 0);
    if (phase === 'baseline') assert.equal(f.calls.filter(row => row.op === 'job.dispatch').length, 0);
  });
}

test('a permission change retires rejected final checks without waiting for a later status poll', async t => {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const accessPoll = new Promise(resolve => { release = resolve; });
  const blocked = blockedFailure(t, 'final'), f = await fixture(t, { accessPoll, onAccessPoll: enter });
  t.after(release);
  const turn = f.submit('Make a plugin');
  await blocked.entered;
  assert.equal((await f.handle.setAccessPolicy(rules.next('readonly', f.cwd, null, 0), 0)).ok, true);
  await entered;
  blocked.fail();
  const result = await turn.completion;
  await delay(0);
  assert.equal(result.cancelled, true);
  assert.equal(result.snapshot.status, 'aborted');
  const snapshot = f.handle.snapshot();
  assert.equal(snapshot.status, 'aborted');
  assert.equal(snapshot.execution.running, false);
  assert.equal(f.handle.inFlight(), false);
  assert.equal(snapshot.nextAccessPolicy.mode, 'readonly');
  assert.equal(f.calls.filter(row => row.op === 'job.comment').length, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), body);
  release();
});

test('native admission failures keep their existing reason and retry semantics', async t => {
  const error = Object.assign(Error('Synthetic Runner is not running'), { code: 'RUNNER_NOT_RUNNING' });
  const f = await fixture(t, { dispatchFailure: error });
  const result = await f.submit('Make a plugin').completion;
  assert.equal(result.ok, false);
  assert.equal(result.reason, error.message);
  assert.equal(result.retrySafe, true);
  assert.equal(result.failureKind, undefined);
  assert.equal(f.handle.snapshot().status, 'unreachable');
  assert.equal(fs.existsSync(f.file), false);
});
