'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createRunnerRuntimeAdapter, getRunnerSessionDetails, _uuidV5 } = require('../main/agent-runtime/runner-adapter');
const { busy } = require('../main/agent-runtime/switchable-conversation');
const catalog = require('../main/agent-runtime/runtime-catalog');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
async function until(check) { for (let n = 0; n < 200; n++) { if (check()) return; await delay(5); } throw Error('Recovery condition timed out'); }

async function fixture(t, config = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-send-recovery-'));
  const alias = 'send-recovery', ref = _uuidV5('9af442c8-cd1d-4b91-a668-22da2b2635bf', 'chat:' + alias + ':harness2');
  const calls = []; let dispatches = 0, comments = 0, status = 'done', read = null;
  const runtime = { async rpc(op, input) {
    calls.push({ op, input });
    if (op === 'runtime.detect') return { ok: true, data: {} };
    if (op === 'job.dispatch') {
      dispatches++;
      if (config.dispatch) return config.dispatch(input, dispatches);
      return { ok: true, data: { ref } };
    }
    if (op === 'job.comment') { comments++; return config.comment ? config.comment(input) : { ok: true, data: { ok: true } }; }
    if (op === 'job.stop') return config.stop ? config.stop(input) : { ok: true, data: { ok: true } };
    if (op === 'job.session') return read ? read(input) : { ok: true, data: { ok: true, ref, status,
      items: status === 'done' ? [{ seq: comments + 1, kind: 'say', text: 'Recovered reply ' + comments }] : [] } };
    throw Error('Unexpected recovery operation: ' + op);
  } };
  const adapter = createRunnerRuntimeAdapter({ runtimeSpec: catalog.runtime('harness2'),
    ...(config.realRunner ? {} : { runnerRuntime: runtime }),
    modelConfig: { fetchModel: async () => ({ ok: true, model: { id: 'synthetic', key: 'synthetic', baseUrl: 'http://synthetic.invalid' } }) } });
  const session = await adapter.createSession({ identity: {}, native: { runner: { openOptions: { ref: alias, cwd: root } } } });
  const handle = getRunnerSessionDetails(session).handle;
  t.after(async () => {
    await session.dispose();
    const resolved = path.resolve(root);
    if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('soduwork-send-recovery-'))
      fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { handle, session, calls, ref, setRead: value => { read = value; }, setStatus: value => { status = value; },
    get dispatches() { return dispatches; }, get comments() { return comments; } };
}

test('the real offline Runner proves no write occurred and never traps a new explicit submission', async t => {
  const f = await fixture(t, { realRunner: true });
  const first = f.handle.submit('Hello', []);
  const result = await first.completion;
  assert.equal(result.ok, false);
  assert.equal(result.retrySafe, true);
  await new Promise(setImmediate);
  assert.equal(f.handle.snapshot().execution.recoveryRequired, false);
  assert.equal(Boolean(busy(f.handle)), false);
  const second = f.handle.submit('Explicit new request', []);
  assert.equal(second.queued, false);
  assert.equal((await second.completion).ok, false);
});

test('a definite admission refusal is switchable after settling while generic unknown failure stays fenced', async t => {
  const f = await fixture(t, { dispatch: async () => ({ ok: false, error: 'Admission refused' }) });
  await f.handle.submit('Hello', []).completion;
  await new Promise(setImmediate);
  assert.equal(Boolean(busy(f.handle)), false);
  assert.equal(Boolean(busy({ snapshot: () => ({ status: 'unreachable' }), inFlight: () => false })), true);
});

test('lost dispatch ACK recovers the same active session without replay or resuming dependent input', async t => {
  const ack = deferred(), f = await fixture(t, { dispatch: () => ack.promise });
  const first = f.handle.submit('Hello', []), later = f.handle.submit('Dependent request', []);
  f.setStatus('running'); ack.reject(Error('Runner receipt timed out'));
  const failure = await first.completion;
  assert.equal(failure.ok, false);
  assert.notEqual(failure.retrySafe, true);
  await new Promise(setImmediate);
  assert.equal(f.handle.snapshot().execution.recoveryRequired, true);
  const result = await f.handle.updateQueue('', 'resume');
  assert.equal(result.ok, false);
  assert.equal(result.recovering, true);
  await until(() => f.handle.snapshot().status === 'streaming');
  assert.equal(f.handle.snapshot().status, 'streaming');
  assert.equal(f.handle.snapshot().execution.recoveryRequired, false);
  assert.equal(f.handle.snapshot().execution.turnQueue.paused, true);
  assert.deepEqual(f.handle.snapshot().queue.map(row => row.id), [later.queueId]);
  assert.equal(f.dispatches, 1); assert.equal(f.comments, 0);
  f.setStatus('done');
  await until(() => f.handle.snapshot().status === 'idle');
  assert.equal(f.comments, 0, 'native completion cannot resume dependent messages');
  assert.equal((await f.handle.updateQueue('', 'resume')).ok, true);
  assert.equal((await later.completion).ok, true);
  assert.equal(f.dispatches, 1); assert.equal(f.comments, 1);
});

test('a terminal same-ref receipt resolves lost admission and exposes native output before switching', async t => {
  const f = await fixture(t, { dispatch: async () => { throw Error('Unknown admission'); } });
  await f.handle.submit('Hello', []).completion;
  const result = await f.handle.updateQueue('', 'resume');
  assert.equal(result.recovering, true);
  await until(() => f.handle.snapshot().status === 'idle');
  assert.equal(f.handle.snapshot().status, 'idle');
  assert.equal(f.handle.snapshot().execution.recoveryRequired, false);
  assert.equal(Boolean(busy(f.handle)), false);
  assert.match(JSON.stringify(f.handle.snapshot().messages), /Recovered reply/);
  assert.equal(f.dispatches, 1);
});

for (const receipt of ['not-found', 'unknown', 'wrong-ref', 'unidentified']) test(receipt + ' cannot certify an uncertain first dispatch', async t => {
  const f = await fixture(t, { dispatch: async () => { throw Error('Unknown admission'); } });
  f.setRead(async () => receipt === 'not-found' ? { ok: true, data: { ok: false, error: 'No local session' } } :
    { ok: true, data: { ok: true, status: receipt === 'unknown' ? 'unknown' : 'done',
      ...(receipt === 'unidentified' ? {} : { ref: receipt === 'wrong-ref' ? 'foreign-ref' : f.ref }), items: [] } });
  await f.handle.submit('Hello', []).completion;
  assert.equal((await f.handle.updateQueue('', 'resume')).ok, false);
  await until(() => f.calls.some(row => row.op === 'job.session'));
  assert.equal(f.handle.snapshot().execution.recoveryRequired, true);
  assert.equal(Boolean(busy(f.handle)), true);
  assert.equal(f.dispatches, 1);
});

test('a queued same-ref admission ledger receipt can recover a lost dispatch ACK', async t => {
  const f = await fixture(t, { dispatch: async () => { throw Error('Unknown admission'); } });
  f.setRead(async () => ({ ok: true, data: { ok: true, status: 'queued', admissionKey: 'dispatch:' + f.ref, items: [] } }));
  await f.handle.submit('Hello', []).completion;
  assert.equal((await f.handle.updateQueue('', 'resume')).ok, false);
  await until(() => f.handle.snapshot().status === 'queued');
  assert.equal(f.handle.snapshot().status, 'queued');
  assert.equal(f.handle.snapshot().execution.recoveryRequired, false);
  assert.equal(f.dispatches, 1);
});

test('late recovery reads cannot publish output or clear uncertainty after cancellation or disposal', async t => {
  for (const action of ['cancel', 'dispose']) {
    const f = await fixture(t, { dispatch: async () => { throw Error('Unknown admission'); } });
    const read = deferred(); f.setRead(() => read.promise);
    await f.handle.submit('Hello', []).completion;
    const checking = f.handle.updateQueue('', 'resume');
    await until(() => f.calls.some(row => row.op === 'job.session'));
    if (action === 'cancel') f.handle.cancel(); else await f.session.dispose();
    const before = JSON.stringify(f.handle.snapshot().messages);
    read.resolve({ ok: true, data: { ok: true, ref: f.ref, status: 'done', items: [{ seq: 1, kind: 'say', text: 'Late private output' }] } });
    await checking; await new Promise(setImmediate);
    assert.equal(JSON.stringify(f.handle.snapshot().messages), before);
    assert.equal(f.dispatches, 1);
  }
});

test('a disconnect beyond the grace period can be explicitly verified without replaying queued work', async t => {
  const f = await fixture(t), originalNow = Date.now;
  let clock = originalNow(), reads = 0;
  Date.now = () => clock;
  t.after(() => { Date.now = originalNow; });
  f.setRead(async () => { if (++reads > 1) clock += 121000; throw Error('Synthetic disconnect'); });
  const first = f.handle.submit('Hello', []), later = f.handle.submit('Dependent request', []);
  assert.equal((await first.completion).ok, false);
  await new Promise(setImmediate);
  assert.equal(f.handle.snapshot().execution.recoveryRequired, true);
  assert.deepEqual(f.handle.snapshot().queue.map(row => row.id), [later.queueId]);
  f.setRead(null);
  assert.equal((await f.handle.updateQueue('', 'resume')).recovering, true);
  assert.equal((await later.completion).ok, true);
  assert.equal(f.dispatches, 1);
});

test('passive recovery releases only its empty transport pause and never reruns authorization', async t => {
  const f = await fixture(t, { dispatch: async () => { throw Error('Unknown admission'); } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let authorizations = 0;
  await f.handle.submit('Hello', [], { beforeTurn: () => { authorizations++; } }).completion;
  f.setRead(async () => ({ ok: true, data: { ok: true, ref: f.ref, status: 'done', authorizationRequired: true, items: [] } }));
  t.mock.timers.tick(9999); await new Promise(setImmediate);
  assert.equal(f.calls.filter(row => row.op === 'job.session').length, 0);
  t.mock.timers.tick(1); await new Promise(setImmediate); await new Promise(setImmediate);
  assert.equal(f.handle.snapshot().execution.recoveryRequired, false);
  assert.equal(f.handle.snapshot().execution.turnQueue.paused, false);
  assert.equal(Boolean(busy(f.handle)), false);
  assert.equal(authorizations, 1);
  assert.equal(f.dispatches, 1);
  assert.deepEqual(f.calls.filter(row => !['runtime.detect', 'job.dispatch'].includes(row.op)).map(row => row.op), ['job.session']);
});

test('passive terminal recovery preserves dependent messages until another explicit resume', async t => {
  const ack = deferred(), f = await fixture(t, { dispatch: () => ack.promise });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = f.handle.submit('Hello', []), later = f.handle.submit('Dependent request', []);
  ack.reject(Error('Unknown admission')); await first.completion;
  t.mock.timers.tick(10000); await new Promise(setImmediate); await new Promise(setImmediate);
  assert.equal(f.handle.snapshot().execution.recoveryRequired, false);
  assert.equal(f.handle.snapshot().execution.turnQueue.paused, true);
  assert.deepEqual(f.handle.snapshot().queue.map(row => row.id), [later.queueId]);
  assert.equal(f.comments, 0);
  assert.equal(f.handle.updateQueue('', 'resume').ok, true);
  t.mock.timers.tick(30); await new Promise(setImmediate); t.mock.timers.tick(30);
  assert.equal((await later.completion).ok, true);
});

test('automatic uncertain-session observation has a finite budget and explicit verification remains available', async t => {
  const f = await fixture(t, { dispatch: async () => { throw Error('Unknown admission'); } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  f.setRead(async () => ({ ok: true, data: { ok: false, error: 'No local session' } }));
  await f.handle.submit('Hello', []).completion;
  for (let n = 0; n < 20; n++) { t.mock.timers.tick(10000); await new Promise(setImmediate); }
  assert.equal(f.calls.filter(row => row.op === 'job.session').length, 12);
  assert.equal(f.handle.snapshot().execution.recoveryRequired, true);
  f.handle.updateQueue('', 'resume'); f.handle.updateQueue('', 'resume');
  await new Promise(setImmediate);
  assert.equal(f.calls.filter(row => row.op === 'job.session').length, 13, 'concurrent explicit checks coalesce');
  assert.equal(f.dispatches, 1);
});

test('a previous terminal receipt cannot confirm an uncertain follow-up admission', async t => {
  const f = await fixture(t, { comment: async () => { throw Error('Unknown comment admission'); } });
  assert.equal((await f.handle.submit('First', []).completion).ok, true);
  await new Promise(setImmediate);
  await f.handle.submit('Follow-up', []).completion;
  f.handle.updateQueue('', 'resume');
  await new Promise(setImmediate);
  assert.equal(f.handle.snapshot().execution.recoveryRequired, true);
  assert.equal(Boolean(busy(f.handle)), true);
  assert.equal(f.dispatches, 1); assert.equal(f.comments, 1);
});

test('a live native status with an error is never terminal proof for switching or queue release', async t => {
  const f = await fixture(t, { dispatch: async () => { throw Error('Unknown admission'); } });
  f.setRead(async () => ({ ok: true, data: { ok: true, ref: f.ref, status: 'running', error: 'Old transport error', items: [] } }));
  await f.handle.submit('Hello', []).completion;
  f.handle.updateQueue('', 'resume'); await new Promise(setImmediate);
  assert.equal(f.handle.snapshot().execution.terminalConfirmed, false);
  assert.equal(Boolean(busy(f.handle)), true);
  assert.equal(f.handle.snapshot().execution.turnQueue.paused, true);
});

test('an explicit resume joins an in-flight passive read and releases work only after its terminal proof', async t => {
  const ack = deferred(), read = deferred(), f = await fixture(t, { dispatch: () => ack.promise });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  f.setRead(() => read.promise);
  const first = f.handle.submit('Hello', []), later = f.handle.submit('Dependent request', []);
  ack.reject(Error('Unknown admission')); await first.completion;
  t.mock.timers.tick(10000); await new Promise(setImmediate);
  f.handle.updateQueue('', 'resume'); await new Promise(setImmediate);
  assert.equal(f.calls.filter(row => row.op === 'job.session').length, 1);
  assert.equal(f.comments, 0);
  read.resolve({ ok: true, data: { ok: true, ref: f.ref, status: 'done', items: [] } });
  await new Promise(setImmediate); await new Promise(setImmediate);
  assert.equal(f.comments, 1, 'the explicit resume still owns release when another read was already pending');
  t.mock.timers.tick(30); await new Promise(setImmediate);
  assert.equal((await later.completion).ok, true);
  assert.equal(f.dispatches, 1);
});

test('cancel after a lost first ACK verifies the same active session and waits for native stop proof', async t => {
  const stop = deferred(), f = await fixture(t, {
    dispatch: async () => { throw Error('Unknown ACK'); }, stop: () => stop.promise,
  });
  t.after(() => stop.resolve({ ok: true, data: { ok: true } }));
  f.setStatus('running');
  await f.handle.submit('Hello', []).completion;
  f.handle.cancel();
  assert.equal(f.handle.updateQueue('', 'resume').recovering, true);
  await until(() => f.calls.some(row => row.op === 'job.stop'));
  assert.equal(f.calls.find(row => row.op === 'job.session').input.ref, f.ref);
  assert.equal(f.calls.find(row => row.op === 'job.stop').input.ref, f.ref);
  stop.resolve({ ok: true, data: { ok: true } }); await new Promise(setImmediate);
  assert.equal(f.handle.snapshot().execution.recoveryRequired, true, 'a stop ACK alone is not terminal proof');
  assert.equal(f.handle.inFlight(), true);
  f.setStatus('stopped'); f.handle.updateQueue('', 'resume');
  await until(() => !f.handle.snapshot().execution.recoveryRequired);
  assert.equal(f.handle.inFlight(), false);
  assert.equal(Boolean(busy(f.handle)), false);
  f.setStatus('done');
  assert.equal((await f.handle.submit('Explicit follow-up', []).completion).ok, true);
  assert.equal(f.dispatches, 1); assert.equal(f.comments, 1);
});

test('a cancelled unknown admission can be proved terminal without publishing its old transcript', async t => {
  const f = await fixture(t, { dispatch: async () => { throw Error('Unknown ACK'); } });
  await f.handle.submit('Hello', []).completion;
  f.handle.cancel();
  f.setRead(async () => ({ ok: true, data: { ok: true, ref: f.ref, status: 'done',
    items: [{ seq: 1, kind: 'say', text: 'Cancelled old output' }] } }));
  f.handle.updateQueue('', 'resume');
  await until(() => f.calls.some(row => row.op === 'job.session'));
  await until(() => !f.handle.snapshot().execution.recoveryRequired);
  assert.doesNotMatch(JSON.stringify(f.handle.snapshot().messages), /Cancelled old output/);
  assert.equal(f.calls.filter(row => row.op === 'job.stop').length, 0);
  assert.equal(f.handle.inFlight(), false);
});

test('a cancelled unknown admission stays fenced when verification still cannot find it', async t => {
  const f = await fixture(t, { dispatch: async () => { throw Error('Unknown ACK'); } });
  f.setRead(async () => ({ ok: true, data: { ok: false, error: 'Not found' } }));
  await f.handle.submit('Hello', []).completion;
  f.handle.cancel(); f.handle.updateQueue('', 'resume');
  await until(() => f.calls.some(row => row.op === 'job.session'));
  assert.equal(f.handle.snapshot().execution.recoveryRequired, true);
  assert.equal(f.handle.inFlight(), true);
  assert.equal(f.calls.filter(row => row.op === 'job.stop').length, 0);
  assert.equal(f.dispatches, 1);
});

test('all 501 recovered events and the native status remain fenced until pagination is applied', async t => {
  const ack = deferred(), secondPage = deferred(), f = await fixture(t, { dispatch: () => ack.promise });
  let reads = 0;
  f.setRead(async input => {
    if (++reads === 1) {
      assert.equal(input.since, 0);
      return { ok: true, data: { ok: true, ref: f.ref, status: 'running', seq: 501,
        items: Array.from({ length: 500 }, (_, index) => ({ seq: index + 1, kind: 'sys', text: 'History ' + index })) } };
    }
    assert.equal(input.since, 500);
    return secondPage.promise;
  });
  const first = f.handle.submit('Hello', []), later = f.handle.submit('Dependent request', []);
  ack.reject(Error('Unknown ACK')); await first.completion;
  f.handle.updateQueue('', 'resume');
  await until(() => reads === 2);
  assert.equal(f.handle.snapshot().execution.recoveryRequired, true);
  assert.equal(f.handle.updateQueue('', 'resume').recovering, true);
  await new Promise(setImmediate);
  assert.equal(f.comments, 0);
  secondPage.resolve({ ok: true, data: { ok: true, ref: f.ref, status: 'running', seq: 501,
    items: [{ seq: 501, kind: 'say', text: 'Current native activity' }] } });
  await until(() => f.handle.snapshot().status === 'streaming');
  assert.equal(f.comments, 0);
  f.setRead(null); f.setStatus('done');
  await until(() => f.handle.snapshot().status === 'idle');
  assert.equal(f.comments, 0, 'completion after earlier active verification still requires a fresh explicit resume');
  f.handle.updateQueue('', 'resume'); assert.equal((await later.completion).ok, true);
  assert.equal(f.dispatches, 1); assert.equal(f.comments, 1);
});

test('a definitely unwritten follow-up preserves its native session and permits a fresh explicit comment', async t => {
  let comments = 0;
  const f = await fixture(t, { comment: async () => {
    if (++comments === 1) throw Object.assign(Error('Runner is not running'), { code: 'RUNNER_NOT_RUNNING' });
    return { ok: true, data: { ok: true } };
  } });
  assert.equal((await f.handle.submit('First', []).completion).ok, true);
  await new Promise(setImmediate);
  const failed = await f.handle.submit('Unsent follow-up', []).completion;
  assert.equal(failed.ok, false); assert.equal(failed.retrySafe, true);
  await new Promise(setImmediate);
  assert.equal(f.handle.snapshot().execution.recoveryRequired, false);
  assert.equal(Boolean(busy(f.handle)), false);
  const retry = f.handle.submit('New explicit follow-up', []);
  assert.equal(retry.queued, false);
  assert.equal((await retry.completion).ok, true);
  assert.equal(f.dispatches, 1); assert.equal(f.comments, 2);
  assert.deepEqual(f.calls.filter(row => row.op === 'job.comment').map(row => row.input.text), ['Unsent follow-up', 'New explicit follow-up']);
});

for (const repeatCancel of [false, true]) test('terminal proof waits for the outstanding stop receipt before a fresh turn' + (repeatCancel ? ' after repeated cancel' : ''), async t => {
  const stop = deferred(), f = await fixture(t, {
    dispatch: async () => { throw Error('Unknown ACK'); }, stop: () => stop.promise,
  });
  t.after(() => stop.resolve({ ok: true, data: { ok: true } }));
  f.setStatus('running'); await f.handle.submit('Hello', []).completion;
  f.handle.cancel(); f.handle.updateQueue('', 'resume');
  await until(() => f.calls.some(row => row.op === 'job.stop'));
  f.setStatus('done'); f.handle.updateQueue('', 'resume');
  await until(() => f.handle.snapshot().execution.terminalConfirmed);
  assert.equal(f.handle.snapshot().execution.recoveryRequired, true);
  assert.equal(f.handle.inFlight(), true);
  assert.equal(Boolean(busy(f.handle)), true);
  if (repeatCancel) f.handle.cancel();
  const next = f.handle.submit('Fresh user instruction', []);
  assert.equal(next.queued, true);
  assert.equal(f.comments, 0, 'the old same-ref stop must settle before a new comment can launch');
  stop.resolve({ ok: true, data: { ok: true } });
  assert.equal((await next.completion).ok, true);
  assert.equal(f.calls.filter(row => row.op === 'job.stop').length, 1);
  assert.equal(f.dispatches, 1); assert.equal(f.comments, 1);
});

test('a definite stop refusal can retire a settled stop after native terminal proof', async t => {
  const stop = deferred(), f = await fixture(t, {
    dispatch: async () => { throw Error('Unknown ACK'); }, stop: () => stop.promise,
  });
  t.after(() => stop.resolve({ ok: true, data: { ok: true } }));
  f.setStatus('running'); await f.handle.submit('Hello', []).completion;
  f.handle.cancel(); f.handle.updateQueue('', 'resume');
  await until(() => f.calls.some(row => row.op === 'job.stop'));
  f.setStatus('done'); f.handle.updateQueue('', 'resume');
  await until(() => f.handle.snapshot().execution.terminalConfirmed);
  stop.resolve({ ok: true, data: { ok: false, error: 'It is no longer running' } });
  await new Promise(setImmediate);
  assert.equal(f.handle.snapshot().execution.recoveryRequired, false);
  assert.equal(f.handle.inFlight(), false);
  assert.equal((await f.handle.submit('Fresh user instruction', []).completion).ok, true);
  assert.equal(f.dispatches, 1); assert.equal(f.comments, 1);
});

test('a timed-out stop remains uncertain even when a separate observation is terminal', async t => {
  const stop = deferred(), f = await fixture(t, {
    dispatch: async () => { throw Error('Unknown ACK'); }, stop: () => stop.promise,
  });
  t.after(() => stop.resolve({ ok: true, data: { ok: true } }));
  f.setStatus('running'); await f.handle.submit('Hello', []).completion;
  f.handle.cancel(); f.handle.updateQueue('', 'resume');
  await until(() => f.calls.some(row => row.op === 'job.stop'));
  f.setStatus('done'); f.handle.updateQueue('', 'resume');
  await until(() => f.handle.snapshot().execution.terminalConfirmed);
  stop.reject(Error('Stop receipt timed out')); await new Promise(setImmediate);
  assert.equal(f.handle.snapshot().execution.recoveryRequired, true);
  assert.equal(f.handle.inFlight(), true);
  assert.equal(f.handle.submit('Fresh user instruction', []).queued, true);
  assert.equal(f.comments, 0);
});

test('a queued recovery timer cannot publish cancelled output after stop verification succeeds', async t => {
  const stop = deferred(), f = await fixture(t, {
    dispatch: async () => { throw Error('Unknown ACK'); }, stop: () => stop.promise,
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let status = 'running';
  f.setRead(async () => ({ ok: true, data: { ok: true, ref: f.ref, status,
    items: [{ seq: 1, kind: 'say', text: 'Cancelled private output' }] } }));
  await f.handle.submit('Hello', []).completion;
  f.handle.cancel(); f.handle.updateQueue('', 'resume'); await new Promise(setImmediate);
  assert.equal(f.calls.filter(row => row.op === 'job.stop').length, 1);
  status = 'done'; f.handle.updateQueue('', 'resume'); await new Promise(setImmediate);
  stop.resolve({ ok: true, data: { ok: true } }); await new Promise(setImmediate);
  assert.equal(f.handle.snapshot().execution.recoveryRequired, false);
  const reads = f.calls.filter(row => row.op === 'job.session').length;
  t.mock.timers.tick(10000); await new Promise(setImmediate);
  assert.equal(f.calls.filter(row => row.op === 'job.session').length, reads);
  assert.doesNotMatch(JSON.stringify(f.handle.snapshot().messages), /Cancelled private output/);
});

test('a second stop cannot replace the ownership of an earlier uncertain stop operation', async t => {
  const stop = deferred(); let stops = 0;
  const f = await fixture(t, { dispatch: async () => { throw Error('Unknown ACK'); },
    stop: () => ++stops === 1 ? stop.promise : { ok: true, data: { ok: true } },
  });
  t.after(() => stop.resolve({ ok: true, data: { ok: true } }));
  f.setStatus('running'); await f.handle.submit('Hello', []).completion;
  f.handle.cancel(); f.handle.updateQueue('', 'resume');
  await until(() => stops === 1);
  stop.reject(Error('The first stop receipt timed out')); await new Promise(setImmediate);
  f.handle.updateQueue('', 'resume'); await new Promise(setImmediate);
  assert.equal(stops, 1, 'another stop receipt cannot certify the previous unknown stop operation');
  f.setStatus('done'); f.handle.updateQueue('', 'resume');
  await until(() => f.handle.snapshot().execution.terminalConfirmed);
  assert.equal(f.handle.snapshot().execution.recoveryRequired, true);
  assert.equal(f.handle.inFlight(), true);
  assert.equal(f.handle.submit('Fresh user instruction', []).queued, true);
  assert.equal(f.comments, 0);
  assert.equal(f.dispatches, 1);
});
