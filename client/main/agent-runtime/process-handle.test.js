'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createProcessHandle } = require('./process-handle');
const { createPublisher } = require('./process-projection');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(options = {}) {
  const state = { status: 'idle', statusText: 'Ready', pendingUi: null,
    messages: Array.from({ length: 140 }, (_, id) => ({ id: 'message-' + id, role: id % 2 ? 'assistant' : 'user',
      blocks: [{ kind: 'text', text: 'Preserved conversation ' + id }] })), tools: [],
    execution: { running: false, stopped: false, paused: false, queue: [], turnQueue: { paused: false, activeTaskId: '' } } };
  const calls = [], properties = [], closed = [], releases = [];
  const proxy = createProcessHandle({ ref: 'process-handle-test',
    confirmStopped: options.confirmStopped,
    invoke: async (ref, method, args, config) => {
      calls.push({ ref, method, args, config });
      return options.invoke ? options.invoke(method, args) : { ok: true };
    },
    setProperty: async (...args) => { properties.push(args); return true; },
    release: () => releases.push('released'), onClose: ref => closed.push(ref) });
  const runtime = { ref: 'process-handle-test', sessionId: 'native-history-id', adapterId: 'pi', displayName: 'Pi',
    cwd: '/isolated/workspace', startedAt: 1, skills: ['isolated-skill'], taskIds: ['task-one'], taskRef: 'task-one',
    goal: { intent: 'goal', goal: 'Preserve facts' }, model: { id: 'isolated-model', key: 'never-project' },
    snapshot: () => structuredClone(state), status: () => state.status,
    inFlight: () => state.execution.running || state.execution.queue.length > 0,
    historyRow: snapshot => ({ id: 'native-history-id', title: 'Isolated history', count: snapshot.messages.length, state: state.status }),
    goalView: () => ({ mode: 'goal', intent: 'goal', goal: 'Preserve facts' }), resumeLocation: () => '/isolated/history.jsonl' };
  const packets = [], publisher = createPublisher(runtime, packet => {
    const copy = structuredClone(packet); packets.push(copy); proxy.update(copy);
  });
  return { ...proxy, state, runtime, calls, properties, closed, releases, packets,
    publish(event = { kind: 'snapshot' }, raw = {}) { return publisher.publish(event, raw); } };
}

test('synchronous platform reads retain full conversation and session metadata without RPC', () => {
  const f = fixture(); f.publish();
  const snapshot = f.handle.snapshot();
  assert.equal(typeof snapshot.then, 'undefined'); assert.equal(snapshot.messages.length, 140);
  assert.equal(snapshot.messages[0].id, 'message-0');
  assert.equal(f.handle.uiSnapshot().messages.length, 80);
  assert.equal(f.handle.uiSnapshot().history.totalMessages, 140);
  assert.equal(f.handle.uiSnapshot({ messageLimit: 120 }).messages.length, 120);
  assert.equal(f.handle.cwd, f.runtime.cwd); assert.equal(f.handle.sessionId, 'native-history-id');
  assert.deepEqual(f.handle.skills, ['isolated-skill']); assert.deepEqual(f.handle.taskIds, ['task-one']);
  assert.equal(f.handle.model.id, 'isolated-model'); assert.equal(f.handle.model.key, undefined);
  assert.equal(f.handle.historyRow().count, 140); assert.equal(f.handle.goalView().goal, 'Preserve facts');
  assert.equal(f.handle.resumeLocation(), '/isolated/history.jsonl');
  assert.equal(f.handle.status(), 'idle'); assert.equal(f.handle.inFlight(), false);
  assert.deepEqual(f.calls, []);
});

test('submit waits for actual remote admission while its completion remains independently pending', async () => {
  const admission = deferred(), completion = deferred();
  const f = fixture({ invoke: method => method === 'submit' ? admission.promise : { ok: true } });
  f.publish(); let admitted = false, finished = false;
  const submitted = f.handle.submit('Execute once', [], { taskId: 'task-one' }).then(value => { admitted = true; return value; });
  await Promise.resolve(); assert.equal(admitted, false);
  admission.resolve({ accepted: true, queued: true, queueId: 'native-queue', position: 2, completion: completion.promise });
  const receipt = await submitted;
  assert.equal(receipt.accepted, true); assert.equal(receipt.queueId, 'native-queue'); assert.equal(receipt.position, 2);
  receipt.completion.then(() => { finished = true; });
  await Promise.resolve(); assert.equal(finished, false, 'admission must not invent execution completion');
  completion.resolve({ ok: true, receipt: 'verified-end' });
  assert.deepEqual(await receipt.completion, { ok: true, receipt: 'verified-end' });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, 'submit');
  assert.equal(f.calls[0].args[2].taskId, 'task-one');
});

test('workflow output capability and mutations cross the same process facade', async () => {
  const f = fixture(); f.runtime.taskMessageStreaming = true; f.publish();
  assert.equal(f.handle.taskMessageStreaming, true);
  await f.handle.appendTaskBatch([{ method: 'appendTaskMessage', args: ['assistant', 'Actual node reply'] }]);
  await f.handle.rememberWorkflowPlugin('local:workflow');
  assert.deepEqual(f.calls.map(row => row.method), ['appendTaskBatch', 'rememberWorkflowPlugin']);
});

test('a lost projection cannot confirm execution stop before the host has reclaimed resources', () => {
  let reclaimed = false;
  const f = fixture({ confirmStopped: () => reclaimed }); f.publish();
  f.interrupted(Error('worker lost'));
  assert.equal(f.handle.inFlight(), false); assert.equal(f.handle.executionStopped(), false);
  reclaimed = true; assert.equal(f.handle.executionStopped(), true);
});

test('send waits for execution completion and preserves explicit remote rejection without resubmission', async () => {
  const completion = deferred(); let admitted = true;
  const f = fixture({ invoke: () => admitted
    ? { accepted: true, queued: false, completion: completion.promise }
    : { accepted: false, result: { ok: false, reason: 'Task already active' } } });
  let settled = false;
  const sent = f.handle.send('Single operation').then(value => { settled = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  completion.resolve({ ok: true }); assert.deepEqual(await sent, { ok: true });
  admitted = false;
  assert.deepEqual(await f.handle.send('Do not replay'), { ok: false, reason: 'Task already active' });
  assert.deepEqual(f.calls.map(call => call.method), ['submit', 'submit']);
});

test('all control events sharing one raw snapshot reach independent observers in order', () => {
  const f = fixture(), raw = {}, events = [], stableSnapshots = [];
  f.handle.on(() => { throw Error('unrelated observer failure'); });
  const unsubscribe = f.handle.on((event, snapshot) => { events.push(event.kind); stableSnapshots.push(snapshot); });
  for (const kind of ['tool-start', 'tool-end', 'message-end']) f.publish({ kind }, raw);
  assert.deepEqual(events, ['tool-start', 'tool-end', 'message-end']);
  assert.ok(stableSnapshots.every(snapshot => snapshot.messages.length === 140));
  unsubscribe(); f.publish({ kind: 'settled' });
  assert.equal(events.length, 3);
});

test('Electron-only window and UI overlays stay local and survive new runtime metadata', () => {
  const f = fixture(), overlay = { inputAttachments: [{ path: '/local/input.md' }], selectedSkills: ['private-draft'] };
  const window = { isDestroyed: () => false, webContents: { send() {} } };
  f.handle.ui = overlay; f.handle.attachedWindow = window; f.handle.detached = false;
  f.publish(); f.runtime.skills = ['updated-skill']; f.publish();
  assert.equal(f.handle.ui, overlay); assert.equal(f.handle.attachedWindow, window); assert.equal(f.handle.detached, false);
  assert.deepEqual(f.handle.skills, ['updated-skill']);
  assert.deepEqual(f.properties, [], 'UI/window updates cannot become runtime writes');
  assert.deepEqual(f.calls, []);
  const wire = JSON.stringify(f.packets);
  assert.ok(!wire.includes('private-draft')); assert.ok(!wire.includes('/local/input.md'));
});

test('delivery capture registers one remote callback and unrelated decorations do not cross the boundary', async () => {
  const f = fixture(); let captures = 0;
  const capture = async () => { captures++; return { frozen: true }; };
  f.handle.captureDelivery = capture; f.handle.deliverySync = { state: 'saving' };
  await Promise.resolve();
  assert.equal(f.properties.length, 1);
  assert.deepEqual(f.properties[0].slice(0, 2), ['process-handle-test', 'captureDelivery']);
  assert.equal(f.properties[0][2], capture);
  assert.deepEqual(await f.properties[0][2](), { frozen: true }); assert.equal(captures, 1);
});

test('close is idempotent, releases ownership once, and rejects later commands without dispatch', async () => {
  const f = fixture(); f.publish();
  await Promise.all([f.handle.close(), f.handle.close()]);
  assert.deepEqual(f.calls.map(call => call.method), ['close']);
  assert.deepEqual(f.releases, ['released']); assert.deepEqual(f.closed, ['process-handle-test']);
  assert.equal(f.handle.inFlight(), false);
  for (const method of ['submit', 'cancel', 'updateQueue', 'setAccessPolicy', 'answerUi', 'appendTaskMessage']) {
    await assert.rejects(f.handle[method]('late'), error => error.code === 'RUNTIME_PROCESS_GONE');
  }
  assert.equal(f.calls.length, 1);
  const revision = f.handle.snapshot().messages.length;
  f.state.messages.push({ role: 'assistant', blocks: [] }); f.publish();
  assert.equal(f.handle.snapshot().messages.length, revision, 'late projections cannot resurrect a closed session');
});

test('crash freezes accepted history and rejects commands without retry or duplicated failure events', async () => {
  const f = fixture(); f.publish(); const before = structuredClone(f.handle.snapshot().messages), events = [];
  f.handle.on(event => events.push(event.kind));
  f.interrupted(Error('isolated process exited')); f.interrupted(Error('duplicate exit signal'));
  assert.equal(f.isLost(), true); assert.deepEqual(events, ['runtime-unavailable']);
  for (const method of ['submit', 'send', 'cancel', 'updateQueue', 'bindTask', 'snapshotAsync']) {
    await assert.rejects(f.handle[method]('late'), error => error.code === 'RUNTIME_PROCESS_GONE');
  }
  f.state.messages = []; f.publish();
  assert.deepEqual(f.handle.snapshot().messages, before);
  await f.handle.close(); assert.deepEqual(f.calls, [], 'a lost runtime is never recreated to close or retry work');
  assert.deepEqual(f.releases, ['released']);
});

test('interruption consistently stops local execution while retaining unconfirmed operations and queued prompts', () => {
  const f = fixture();
  f.state.status = 'streaming'; f.state.pendingUi = { kind: 'permission', id: 'expired-request' };
  f.state.execution = { running: true, paused: false, stopped: false,
    queue: [{ id: 'queued-one', text: 'Do this later, once.' }],
    turnQueue: { paused: false, activeTaskId: 'task-one', tasks: [{ taskId: 'task-one', status: 'running' }] },
    externalReceipts: [{ operationId: 'unconfirmed-write', status: 'uncertain' }] };
  f.state.tools = [{ id: 'unconfirmed-write', name: 'write', state: 'running', args: { path: 'report.md' } }];
  f.publish(); assert.equal(f.handle.inFlight(), true);
  f.interrupted(Error('Runtime unavailable'));
  const snapshot = f.handle.snapshot();
  assert.equal(f.handle.inFlight(), false); assert.equal(f.handle.status(), 'failed');
  assert.equal(snapshot.status, 'failed'); assert.equal(snapshot.runtimeUnavailable, true);
  assert.equal(snapshot.execution.running, false, 'the unavailable runtime cannot still claim active execution');
  assert.equal(snapshot.execution.paused, true); assert.equal(snapshot.execution.stopped, true);
  assert.equal(snapshot.execution.turnQueue.paused, true, 'remaining work must not implicitly resume');
  assert.deepEqual(snapshot.execution.queue, f.state.execution.queue);
  assert.deepEqual(snapshot.execution.externalReceipts, f.state.execution.externalReceipts);
  assert.notEqual(snapshot.tools[0].state, 'done', 'an unconfirmed write must never become a successful receipt');
  assert.equal(snapshot.pendingUi, null); assert.equal(snapshot.completion.completed, false);
  assert.equal(snapshot.completion.retryable, false);
});

test('synchronous compatibility output reads scan the local workspace without invoking execution', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-process-handle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'report.md'); fs.writeFileSync(file, '# Isolated report');
  const f = fixture(); f.runtime.cwd = root; f.runtime.startedAt = 0; f.publish();
  const files = f.handle.outputs(), indexed = f.handle.outputSnapshot();
  assert.ok(Array.isArray(files), 'legacy output listing remains synchronous');
  assert.equal(typeof indexed.then, 'undefined');
  assert.ok(files.some(item => item.path === file)); assert.ok(indexed.files.some(item => item.path === file));
  assert.deepEqual(f.calls, []);
});

test('asynchronous detail and output reads remain explicit worker requests', async () => {
  const f = fixture({ invoke: (method, args) => ({ method, args, source: 'runtime' }) });
  assert.equal((await f.handle.toolDetail('tool-one')).source, 'runtime');
  assert.equal((await f.handle.outputSnapshotAsync()).method, 'outputSnapshotAsync');
  assert.equal((await f.handle.snapshotAsync({ raw: true })).method, 'snapshot');
  assert.deepEqual(f.calls.map(call => call.method), ['toolDetail', 'outputSnapshotAsync', 'snapshot']);
});
