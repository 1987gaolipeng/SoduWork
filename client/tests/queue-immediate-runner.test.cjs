'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createRunnerRuntimeAdapter, getRunnerSessionDetails, _uuidV5 } = require('../main/agent-runtime/runner-adapter');
const catalog = require('../main/agent-runtime/runtime-catalog');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let n = 0; n < 500; n++) { if (check()) return; await delay(10); } throw Error('Runner fixture timed out'); }
async function harness(t, spec, failStop = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-immediate-runner-'));
  const app = { getPath: () => root }, calls = [], rows = [], cleanups = [], resolutions = [];
  const attachment = path.join(root, 'note.txt'); fs.writeFileSync(attachment, 'keep attachment');
  let status = 'idle', acknowledge, stopped = false, session, failure = '', failureKind = '', executionStartedAt = 0;
  const push = (kind, text) => rows.push({ seq: rows.length + 1, kind, text });
  const runtime = { async rpc(op, value) {
    calls.push({ op, value });
    if (op === 'runtime.detect') return { ok: true, data: {} };
    if (op === 'job.dispatch') {
      status = 'running'; push('user', value.ctx.conversationUserText);
      return { ok: true, data: { ref: _uuidV5('9af442c8-cd1d-4b91-a668-22da2b2635bf', value.dispatchId), ok: true } };
    }
    if (op === 'job.comment') {
      assert.equal(stopped, true, 'new turn cannot race the old process');
      push('user', value.text);
      status = value.text === 'B' ? 'running' : 'done';
      if (status === 'done') push('say', 'Done ' + value.text);
      return { ok: true, data: { ok: true, state: status } };
    }
    if (op === 'job.session') return { ok: true, data: { ok: true, status,
      error: failure || (status === 'stopped' ? '你把它叫停了' : ''), failureKind, executionStartedAt,
      items: rows.filter(x => x.seq > value.since) } };
    if (op === 'job.stop') {
      if (failStop) return { ok: false, error: 'Stop transport failed' };
      return await new Promise(resolve => { acknowledge = () => resolve({ ok: true, data: { ok: true } }); });
    }
    throw Error(op);
  } };
  const makeModel = name => ({ ok: true, model: { id: name || 'default-fixture', input: ['text'], key: 'synthetic', baseUrl: 'http://synthetic.invalid/v1' } });
  const adapter = createRunnerRuntimeAdapter({ app, runtimeSpec: spec, runnerRuntime: runtime,
    modelConfig: { fetchModel: async (_identity, name) => makeModel(name), fetchSelection: async (_identity, name) => makeModel(name) } });
  session = await adapter.createSession({ identity: {}, native: { runner: { openOptions: { app, cwd: root,
    ref: 'fixture-immediate-' + spec.id, resolvePlugins: async ids => {
      resolutions.push(ids);
      return { items: ids.map(pluginId => ({ pluginId, name: 'Fixture', version: '1', context: 'Retain plugin context', capabilities: {} })),
        grant: { cleanup: () => cleanups.push(...ids) } };
    } } } } });
  const handle = getRunnerSessionDetails(session).handle;
  t.after(async () => { acknowledge?.(); await session.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { handle, calls, resolutions, cleanups, attachment,
    actualStart() { executionStartedAt = Date.now() / 1000; },
    ack() { acknowledge(); }, get askedStop() { return Boolean(acknowledge); },
    terminal() { status = 'stopped'; stopped = true; },
    complete() { status = 'done'; push('say', 'Done B'); },
    fail(reason, kind = '') { status = 'failed'; failure = reason; failureKind = kind; },
  };
}

test('Runner native task start waits for child launch acknowledgement, not running admission', async t => {
  const f = await harness(t, catalog.runnerRuntimes()[0]); let starts = 0;
  const submission = f.handle.submit('repository requirement', [], {taskId: 'issue', onStarted: () => starts++});
  await until(() => f.calls.some(row => row.op === 'job.session'));
  assert.equal(starts, 0);
  f.actualStart(); await until(() => starts === 1);
  f.complete(); await submission.completion;
  assert.equal(starts, 1);
});

for (const spec of catalog.runnerRuntimes()) test(spec.id + ' immediate send waits for stop AND terminal polling and retains plugin/model/attachments/task queue', async t => {
  const f = await harness(t, spec), receipts = [];
  const states = []; f.handle.on((_event, snapshot) => states.push(snapshot.status));
  const first = f.handle.submit('A', []); await until(() => f.handle.snapshot().execution.queueImmediate.available);
  const later = f.handle.submit('C', [], { submissionId: 'later' });
  if (spec.modelMode !== 'account') assert.equal((await f.handle.selectModel('picked-model')).ok, true);
  const now = f.handle.submit('B', [{ path: f.attachment, name: 'note.txt' }], { pluginIds: ['fixture'], submissionId: 'now' });
  const task = f.handle.submit('Task D', [], { taskId: 'd', beforeTurn: () => receipts.push('start'), afterTurn: state => receipts.push(state) });
  const request = f.handle.updateQueue(now.queueId, 'send-now'); await until(() => f.askedStop);
  assert.equal(f.handle.cancelQueued(now.queueId).ok, false); assert.equal(f.handle.updateQueue(now.queueId, 'edit', 'wrong').ok, false);
  assert.equal(f.handle.updateQueue('', 'resume').ok, false);
  f.ack(); await delay(50);
  assert.equal(f.calls.some(x => x.op === 'job.comment'), false, 'stop ACK is not a terminal state');
  assert.deepEqual(f.resolutions, []);
  f.terminal(); assert.equal((await request).ok, true); assert.equal((await first.completion).cancelled, true);
  await until(() => f.calls.some(x => x.op === 'job.comment'));
  const sent = f.calls.find(x => x.op === 'job.comment').value;
  assert.equal(sent.text, 'B'); assert.equal(sent.localFiles[0].path, f.attachment);
  assert.match(sent.promptText, /Retain plugin context/); assert.deepEqual(f.resolutions, [['fixture']]);
  if (spec.modelMode !== 'account') assert.ok(JSON.stringify(sent.cfg).includes('picked-model'));
  else assert.equal(f.handle.snapshot().modelSelection.activeName, '', 'native account model selection remains unchanged');
  assert.deepEqual(f.handle.snapshot().execution.queue.map(x => x.id), [later.queueId, task.queueId]);
  f.complete(); assert.equal((await now.completion).ok, true); assert.equal((await later.completion).ok, true); assert.equal((await task.completion).ok, true);
  assert.deepEqual(f.calls.filter(x => x.op === 'job.comment').map(x => x.value.text), ['B', 'C', 'Task D']);
  assert.deepEqual(f.cleanups, ['fixture', 'fixture', 'fixture']); assert.deepEqual(receipts, ['start', 'completed']);
  assert.deepEqual(f.resolutions, [['fixture'], ['fixture'], ['fixture']],
    'later turns inherit the conversation selection but resolve and release their own authorization');
  for (const call of f.calls.filter(x => x.op === 'job.comment' && x.value.text !== 'B')) {
    assert.match(call.value.promptText || '', /Retain plugin context/);
  }
  assert.equal(states.includes('unreachable'), false, 'a real Runner stopped reason is not a runtime error');
  assert.equal((await f.handle.updateQueue(now.queueId, 'send-now')).ok, false);
});

test('Runner stop failure retains queue, permits explicit resume only after actual terminal state, even if failed target is removed', async t => {
  const f = await harness(t, catalog.runtime('opencode'), true);
  const first = f.handle.submit('A', []); await until(() => f.handle.snapshot().execution.queueImmediate.available);
  const later = f.handle.submit('C', []), now = f.handle.submit('B', []);
  assert.equal((await f.handle.updateQueue(now.queueId, 'send-now')).ok, false);
  assert.deepEqual(f.handle.snapshot().execution.queue.map(x => x.id), [later.queueId, now.queueId]);
  assert.equal(f.handle.updateQueue('', 'resume').ok, false);
  assert.equal(f.handle.cancelQueued(now.queueId).ok, true);
  f.terminal(); await first.completion; await delay(20);
  assert.equal(f.calls.some(x => x.op === 'job.comment'), false);
  assert.equal(f.handle.updateQueue('', 'resume').ok, true);
  assert.equal((await later.completion).ok, true); assert.equal((await now.completion).cancelled, true);
});

test('active Runner task cannot be interrupted by a queued ordinary message', async t => {
  const f = await harness(t, catalog.runtime('opencode'));
  const task = f.handle.submit('A', [], { taskId: 'active-task' });
  await until(() => f.calls.some(x => x.op === 'job.session'));
  const next = f.handle.submit('B', []);
  assert.equal(f.handle.snapshot().execution.queueImmediate.available, false);
  assert.equal((await f.handle.updateQueue(next.queueId, 'send-now')).ok, false);
  assert.equal(f.calls.some(x => x.op === 'job.stop'), false);
  f.handle.cancelQueued(next.queueId); f.terminal(); await task.completion;
});

test('real provider and execution-policy failures remain failures rather than being classified as user stops', async t => {
  for (const [reason, kind] of [['Provider connection failed', ''], ['Policy rejected the operation', 'execution_policy']]) {
    const f = await harness(t, catalog.runtime('opencode'));
    const first = f.handle.submit('A', []);
    await until(() => f.calls.some(x => x.op === 'job.session'));
    f.fail(reason, kind);
    assert.equal((await first.completion).ok, false);
    assert.equal(f.handle.snapshot().status, 'unreachable');
    assert.match(f.handle.snapshot().statusText, new RegExp(reason));
  }
});
