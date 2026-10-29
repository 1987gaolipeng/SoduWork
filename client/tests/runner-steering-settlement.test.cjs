'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createTurnQueue } = require('../main/pi-session/turn-queue');
const create = require('../main/agent-runtime/runner-queue-immediate').create;
const tick = () => new Promise(resolve => setImmediate(resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture(t, timeoutMs = 500) {
  const queue = createTurnQueue(), stops = [], events = [];
  let finish, drains = 0, polls = 0, pollReply = () => {};
  const active = queue.add({ text: 'active' });
  const running = queue.run(queue.take(), () => new Promise(resolve => { finish = resolve; }));
  const later = queue.add({ text: 'later' }), selected = queue.add({ text: 'guide',
    attachments: [{ path: '/isolated/note.txt' }], options: { pluginIds: ['fixture-plugin'], modelName: 'fixture-model' } });
  const state = { started: true, dispatchReady: true, status: 'streaming', runnerRef: 'isolated', timer: null };
  const control = create({ state, queue, timeoutMs,
    runtime: { rpc(op, value) {
      assert.equal(op, 'job.stop'); assert.equal(value.ref, 'isolated');
      return new Promise((resolve, reject) => { stops.push({ resolve, reject }); });
    } }, emit(event) { events.push(event); }, async poll() { polls++; await pollReply(); }, drain() { drains++; } });
  t.after(async () => {
    control.cancel();
    stops.forEach(stop => stop.resolve({ ok: true, data: { ok: true } }));
    finish({ ok: true, cancelled: true }); await running; await tick();
    clearTimeout(state.timer);
  });
  return { state, queue, control, active, selected, later, stops, events,
    finish, ack(index = 0) { stops[index].resolve({ ok: true, data: { ok: true } }); },
    onPoll(reply) { pollReply = reply; },
    terminal() { state.status = 'aborted'; finish({ ok: true, cancelled: true }); },
    counts() { return { drains, polls }; }, order() { return queue.view().map(row => row.text); } };
}

test('Runner stop ACK plus failed terminal polling must not accept guidance or drain the next message', async t => {
  const f = fixture(t);
  const request = f.control.send(f.selected.id); await tick(); f.ack(); await tick();
  f.state.status = 'unreachable';
  f.finish({ ok: false, reason: 'Terminal polling lost its connection' });
  const result = await request;
  assert.equal(result.ok, false); assert.match(result.reason, /停止尚未确认/);
  assert.deepEqual(f.order(), ['later', 'guide']);
  assert.equal(f.control.view().pending, false); assert.equal(f.control.blocked(), true);
  assert.equal(f.control.resume().ok, false); assert.equal(f.counts().drains, 0);
});

test('Runner cancellation settles the guide immediately and late ACK/completion cannot clear a newer stop', async t => {
  const f = fixture(t, 1000);
  const request = f.control.send(f.selected.id); await tick();
  f.control.cancel();
  const result = await Promise.race([request, delay(100).then(() => ({ timedOut: true }))]);
  assert.equal(result.cancelled, true, 'cancel must not wait for the old RPC or timeout');
  assert.deepEqual(f.order(), ['later', 'guide']);
  f.state.stopPending = 'newer-stop'; f.ack();
  f.finish({ ok: true, cancelled: true }); await f.active.completion; await tick();
  assert.equal(f.state.stopPending, 'newer-stop'); assert.equal(f.state.timer, null);
  assert.equal(f.counts().polls, 0); assert.equal(f.counts().drains, 0);
  assert.deepEqual(f.order(), ['later', 'guide']);
});

test('Runner ACK without any terminal times out with original queue and payload intact', async t => {
  const f = fixture(t, 25);
  const request = f.control.send(f.selected.id); await tick(); f.ack();
  assert.equal((await request).ok, false);
  assert.deepEqual(f.order(), ['later', 'guide']); assert.equal(f.control.view().pending, false);
  assert.equal(f.control.resume().ok, false); assert.equal(f.counts().drains, 0);
  assert.deepEqual(f.queue.find(f.selected.id).options.pluginIds, ['fixture-plugin']);
  assert.equal(f.queue.find(f.selected.id).attachments[0].path, '/isolated/note.txt');
  f.terminal(); await f.active.completion; await tick();
  assert.equal(f.counts().drains, 0, 'late terminal cannot secretly send a timed-out guide');
  assert.equal(f.queue.state().paused, true, 'late stop cannot hide the guidance timeout pause');
  assert.match(f.queue.state().reason, /停止尚未确认/);
  assert.equal(f.control.resume().ok, true, 'confirmed terminal permits an explicit recovery');
});

test('late ACK releases only its own expired stop token so a confirmed terminal can be retried', async t => {
  const f = fixture(t, 25);
  const request = f.control.send(f.selected.id); await tick();
  assert.equal((await request).ok, false);
  assert.ok(f.state.stopPending); assert.equal(f.control.resume().ok, false);
  f.terminal(); await f.active.completion;
  f.ack(); await tick();
  assert.equal(f.state.stopPending, false);
  assert.equal(f.state.timer, null, 'expired ACK must not start new polling');
  assert.equal(f.counts().drains, 0);
  assert.equal(f.control.resume().ok, true);
  assert.deepEqual(f.order(), ['later', 'guide']);
  assert.equal((await f.control.send(f.selected.id)).ok, true);
  await tick(); assert.equal(f.counts().drains, 1);
});

test('confirmed Runner stop and terminal release the selected original message exactly once', async t => {
  const f = fixture(t);
  const request = f.control.send(f.selected.id);
  assert.equal(f.control.send(f.selected.id), request);
  await tick(); f.ack(); await tick(); assert.equal(f.counts().drains, 0);
  f.terminal(); assert.equal((await request).ok, true); await tick();
  assert.equal(f.counts().drains, 1); assert.deepEqual(f.order(), ['guide', 'later']);
  assert.equal(f.queue.find(f.selected.id), f.selected);
});

test('retry after lost terminal polling explicitly stops and polls once before releasing the queue', async t => {
  const f = fixture(t);
  const request = f.control.send(f.selected.id); await tick(); f.ack(); await tick();
  f.state.status = 'unreachable'; f.finish({ ok: false, reason: 'Runner disconnected' });
  assert.equal((await request).ok, false);
  clearTimeout(f.state.timer); f.state.timer = null;
  assert.equal(f.queue.active(), null);
  const before = f.counts().polls;
  f.onPoll(async () => { f.state.status = 'aborted'; });
  const retry = f.control.send(f.selected.id); await tick();
  assert.equal(f.stops.length, 2, 'unknown remote terminal needs another explicit stop request');
  assert.equal(f.counts().drains, 0); f.ack(1);
  assert.equal((await retry).ok, true); await tick();
  assert.equal(f.counts().polls, before + 1);
  assert.equal(f.counts().drains, 1); assert.deepEqual(f.order(), ['guide', 'later']);
  assert.equal(f.state.stopPending, false);
});

test('retry whose real poll still reports running keeps guidance unaccepted and all rows retained', async t => {
  const f = fixture(t);
  f.state.status = 'unreachable'; f.finish({ ok: false, reason: 'Connection lost' });
  await f.active.completion;
  // This is a new explicit guide attempt after the original reply failed.
  f.queue.resume(); f.onPoll(async () => { f.state.status = 'streaming'; });
  const request = f.control.send(f.selected.id); await tick(); f.ack();
  assert.equal((await request).ok, false); assert.equal(f.counts().drains, 0);
  assert.equal(f.counts().polls, 1); assert.deepEqual(f.order(), ['later', 'guide']);
});
