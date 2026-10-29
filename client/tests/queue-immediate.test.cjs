'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createTurnQueue } = require('../main/pi-session/turn-queue');
const create = require('../main/pi-session/queue-immediate').create;
const tick = () => new Promise(resolve => setImmediate(resolve));

test('priority keeps the original payload and promise, waits for stop and settlement, and consumes once', async () => {
  const queue = createTurnQueue(); let stop, finish, drains = 0;
  const active = queue.add({ text: 'A' }); queue.run(queue.take(), () => new Promise(resolve => { finish = resolve; }));
  const later = queue.add({ text: 'C' });
  const options = { modelName: 'chosen', pluginIds: ['p'], submissionId: 'same-id' }, attachment = { path: '/fixture/note' };
  const selected = queue.add({ text: 'B', attachments: [attachment], options });
  const immediate = create({ queue, unavailable: () => '', interrupt: () => new Promise(resolve => { stop = resolve; }),
    changed() {}, drain: () => { drains++; } });
  const request = immediate.send(selected.id);
  assert.equal(immediate.send(selected.id), request); await tick();
  assert.equal(immediate.locked(selected.id), true); assert.equal(immediate.view().available, false);
  stop(); await tick(); assert.equal(drains, 0, 'stop request alone never releases the queue');
  finish({ ok: true, cancelled: true }); assert.equal((await request).ok, true); await tick();
  assert.equal(drains, 1); assert.equal(await active.completion.then(x => x.cancelled), true);
  assert.equal(queue.take(), selected); assert.equal(selected.attachments[0], attachment);
  assert.deepEqual(selected.options, options); assert.equal(queue.take(), later);
  assert.equal((await immediate.send(selected.id)).ok, false);
});

test('failed or timed-out stop retains all rows, restores order and blocks automatic or resumed draining', async () => {
  for (const timeout of [false, true]) {
    const queue = createTurnQueue(); let finish, drains = 0;
    const active = queue.add({ text: 'A' }); queue.run(queue.take(), () => new Promise(resolve => { finish = resolve; }));
    const c = queue.add({ text: 'C' }), b = queue.add({ text: 'B' });
    const immediate = create({ queue, unavailable: () => '', interrupt: () => timeout ? new Promise(() => {}) : Promise.reject(Error('offline')),
      changed() {}, drain() { drains++; }, timeoutMs: 20 });
    assert.equal((await immediate.send(b.id)).ok, false);
    finish({ ok: true, cancelled: true }); await active.completion; await tick();
    assert.deepEqual(queue.view().map(x => x.id), [c.id, b.id]);
    assert.equal(immediate.blocked(), true); assert.equal(immediate.view().pending, false); assert.equal(drains, 0);
    queue.resume(); assert.equal(immediate.blocked(), true, 'a generic queue resume cannot bypass uncertain termination');
  }
});

test('tasks, goals, stale items and unavailable executors cannot be promoted or stopped', async () => {
  const queue = createTurnQueue(); let stopped = 0;
  const task = queue.add({ text: 'task', options: { taskId: 'task-1' } }), message = queue.add({ text: 'message' });
  let reason = '';
  const immediate = create({ queue, unavailable: () => reason, interrupt() { stopped++; }, changed() {}, drain() {} });
  assert.equal((await immediate.send(task.id)).ok, false); assert.equal((await immediate.send('stale')).ok, false);
  reason = 'Task active'; assert.equal((await immediate.send(message.id)).ok, false);
  assert.equal(stopped, 0); assert.deepEqual(queue.view().map(x => x.id), [task.id, message.id]);
});

test('explicit cancellation invalidates pending immediate dispatch and never restores removed rows', async () => {
  const queue = createTurnQueue(); let stop, drains = 0;
  const row = queue.add({ text: 'B' });
  const immediate = create({ queue, unavailable: () => '', interrupt: () => new Promise(resolve => { stop = resolve; }), changed() {}, drain() { drains++; } });
  const request = immediate.send(row.id); await tick(); immediate.cancel(); queue.clear(); stop();
  assert.equal((await request).cancelled, true); await tick(); assert.equal(queue.size(), 0); assert.equal(drains, 0);
});

test('late Runner stop acknowledgement cannot reset a newer stop or restart polling after cancellation', async () => {
  const queue = createTurnQueue(); let resolveStop, finish, polls = 0, drains = 0;
  const active = queue.add({ text: 'A' }); queue.run(queue.take(), () => new Promise(resolve => { finish = resolve; }));
  const selected = queue.add({ text: 'B' });
  const state = { started: true, dispatchReady: true, status: 'streaming', runnerRef: 'isolated', timer: null };
  const immediate = require('../main/agent-runtime/runner-queue-immediate').create({ state, queue,
    runtime: { rpc: () => new Promise(resolve => { resolveStop = resolve; }) },
    emit() {}, poll() { polls++; }, drain() { drains++; } });
  const request = immediate.send(selected.id); await tick();
  immediate.cancel(); state.disposed = true; state.stopPending = 'newer-stop'; queue.clear();
  resolveStop({ ok: true, data: { ok: true } }); finish({ ok: true, cancelled: true });
  assert.equal((await request).cancelled, true); await active.completion; await tick();
  assert.equal(state.stopPending, 'newer-stop'); assert.equal(state.timer, null);
  assert.equal(polls, 0); assert.equal(drains, 0); assert.equal(queue.size(), 0);
});
