'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createRunnerRuntimeAdapter, getRunnerSessionDetails } = require('../main/agent-runtime/runner-adapter');
const catalog = require('../main/agent-runtime/runtime-catalog');
const { createBindings } = require('../main/conversation/task-bindings');

async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-interrupted-task-'));
  const app = { getPath: () => root }, ref = 'archived-native-ref', calls = [];
  createBindings(app, ref).bind('task-one', 'Original requirement');
  let reply = { ok: true, data: { ok: true, status: 'interrupted', items: [], ref } }, intercept;
  const runtime = { async rpc(op, params) {
    calls.push({ op, params });
    if (op === 'runtime.detect') return { ok: true, data: {} };
    if (op === 'job.session') return intercept ? intercept(params) : reply;
    if (op === 'job.stop') return { ok: true, data: { ok: true } };
    if (op === 'job.comment') return options.allowSend
      ? { ok: true, data: { ok: true, ref } }
      : { ok: false, error: 'Fixture refuses a competing send' };
    throw Error(op);
  } };
  const adapter = createRunnerRuntimeAdapter({ app, runnerRuntime: runtime,
    runtimeSpec: catalog.runtime(options.adapterId || 'qwen'),
    modelConfig: { fetchModel: async () => ({ ok: true, model: { id: 'fixture' } }) } });
  const session = await adapter.resumeSession({ identity: {}, native: { runner: { openOptions: {
    app, identity: {}, cwd: root, ref: 'restored-view', ...(options.fresh ? {} : { resumePath: ref }),
  } } } });
  const handle = getRunnerSessionDetails(session).handle;
  t.after(async () => { await session.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  for (let n = 0; !options.fresh && handle.inFlight() && n < 100; n++)
    await new Promise(resolve => setTimeout(resolve, 5));
  return { session, handle, ref, calls, setReply: value => { reply = value; },
    intercept: value => { intercept = value; } };
}

test('restored Qwen and Harness2 handles recover only bound tasks with fresh terminal proof', async t => {
  for (const adapterId of ['qwen', 'harness2']) {
    const f = await fixture(t, { adapterId });
    assert.equal(typeof f.handle.claimInterruptedTask, 'function');
    assert.equal(await f.handle.claimInterruptedTask('unrelated'), null);
    const before = f.calls.filter(row => row.op === 'job.session').length;
    const token = await f.handle.claimInterruptedTask('task-one');
    assert.equal(typeof token, 'string');
    assert.equal(f.calls.filter(row => row.op === 'job.session').length, before + 1);
    assert.equal(await f.handle.claimInterruptedTask('task-one'), null);
    assert.equal(f.handle.releaseInterruptedTask('task-one', 'wrong'), false);
    assert.equal(f.handle.releaseInterruptedTask('task-one', token), true);
    assert.equal(typeof await f.handle.claimInterruptedTask('task-one'), 'string');
    assert.equal(f.calls.filter(row => ['job.dispatch', 'job.comment'].includes(row.op)).length, 0);
  }
});

test('active, ambiguous, permission-waiting and unreachable native execution cannot be claimed', async t => {
  const f = await fixture(t);
  for (const status of ['running', 'queued', 'dispatching', 'waiting-permission', 'unknown', '']) {
    f.setReply({ ok: true, data: { ok: true, ref: f.ref, status } });
    assert.equal(await f.handle.claimInterruptedTask('task-one'), null, status);
  }
  for (const reply of [{ ok: false, error: 'offline' },
    { ok: true, data: { ok: false, status: 'interrupted' } },
    { ok: true, data: { status: 'interrupted', ref: 'another-ref' } },
    { ok: true, data: { status: 'interrupted', pendingPermissions: [{ requestId: 'pending' }] } }]) {
    f.setReply(reply); assert.equal(await f.handle.claimInterruptedTask('task-one'), null);
  }
  f.intercept(() => { throw Error('offline'); });
  assert.equal(await f.handle.claimInterruptedTask('task-one'), null);
  f.intercept(null);
  f.setReply({ ok: true, data: { ok: true, status: 'interrupted', ref: f.ref } });
  assert.equal(typeof await f.handle.claimInterruptedTask('task-one'), 'string',
    'failed proofs release their reservations so a later confirmed stop can recover');
});

test('only a resumed handle can claim; a new task execution and disposal remain fenced', async t => {
  const fresh = await fixture(t, { fresh: true });
  fresh.handle.bindTask('task-one', 'Same label');
  assert.equal(await fresh.handle.claimInterruptedTask('task-one'), null);
  const f = await fixture(t);
  f.handle.taskExecutionChanged({ taskId: 'task-one', status: 'failed' });
  assert.equal(await f.handle.claimInterruptedTask('task-one'), null);
  const closed = await fixture(t);
  await closed.session.dispose();
  assert.equal(await closed.handle.claimInterruptedTask('task-one'), null);
});

test('claim checks are exclusive and disposal during a pending proof cancels reservation', async t => {
  const f = await fixture(t);
  let finish;
  f.intercept(() => new Promise(resolve => { finish = resolve; }));
  const first = f.handle.claimInterruptedTask('task-one');
  assert.equal(await f.handle.claimInterruptedTask('task-one'), null);
  await f.session.dispose();
  finish({ ok: true, data: { ok: true, status: 'interrupted', ref: f.ref } });
  assert.equal(await first, null);
});

test('a turn that starts and finishes while proof is pending invalidates the old claim', async t => {
  const f = await fixture(t, { allowSend: true });
  let finish;
  f.intercept(params => params.limit === 1
    ? new Promise(resolve => { finish = resolve; })
    : { ok: true, data: { ok: true, status: 'done', items: [], ref: f.ref } });
  const pending = f.handle.claimInterruptedTask('task-one');
  const sent = f.session.send({ text: 'A separate explicit follow-up' });
  assert.equal(sent.accepted, true);
  assert.equal((await sent.completion).ok, true);
  assert.equal(f.handle.inFlight(), false, 'the new turn has already settled');
  finish({ ok: true, data: { ok: true, status: 'interrupted', ref: f.ref } });
  assert.equal(await pending, null, 'a terminal response for the previous generation is stale');
  f.intercept(null);
  assert.equal(typeof await f.handle.claimInterruptedTask('task-one'), 'string');
});
