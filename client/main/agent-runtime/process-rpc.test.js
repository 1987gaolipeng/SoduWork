'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { MessageChannel } = require('node:worker_threads');
const { createRpcPeer, RPC_NAMESPACE, RpcError } = require('./process-rpc');

const turn = () => new Promise(resolve => setImmediate(resolve));
function pair(t, leftOptions = {}, rightOptions = {}) {
  const { port1, port2 } = new MessageChannel();
  const packets = [];
  const left = createRpcPeer({ ...leftOptions, send(packet) { packets.push(packet); port1.postMessage(packet); } });
  const right = createRpcPeer({ ...rightOptions, send(packet) { packets.push(packet); port2.postMessage(packet); } });
  port1.on('message', left.receive); port2.on('message', right.receive);
  t.after(() => { left.close(); right.close(); port1.close(); port2.close(); });
  return { left, right, packets };
}

test('RPC carries structured data through real MessagePorts in both directions', async t => {
  const { left, right } = pair(t, { handlers: { sum: (a, b) => a + b } }, { handlers: { echo: value => value } });
  const original = {
    empty: undefined, text: '中文', number: NaN, infinity: Infinity, negativeZero: -0, large: 12345678901234567890n,
    bytes: new Uint8Array([3, 4, 5]), typed: new Uint32Array([100000, 4294967295]),
    buffer: Buffer.from([8, 9]), raw: new Uint8Array([7, 6]).buffer,
    view: new DataView(new Uint8Array([1, 2]).buffer), date: new Date('2026-10-18T00:00:00Z'),
    expression: /test/gi, mapping: new Map([['key', new Set([1, 2])]]),
    error: new RpcError('DATA_ERROR', 'error as data'),
  };
  assert.deepEqual(await left.call('echo', [original]), original);
  assert.equal(await right.call('sum', [20, 22]), 42);
  assert.deepEqual(await left.call('echo', [new Uint8Array([1, 2, 3, 4]).subarray(1, 3)]), new Uint8Array([2, 3]));
});

test('callbacks are bidirectional capabilities and can themselves receive callbacks', async t => {
  const { left } = pair(t, {}, { handlers: {
    async nested(callback) { return callback(7, async value => value * 3); },
  } });
  assert.equal(await left.call('nested', [async (number, twice) => (await twice(number)) + 1]), 22);
});

test('long-running executor callbacks have a separate timeout from command admission', async t => {
  let complete;
  const completion = new Promise(resolve => { complete = resolve; });
  const { left } = pair(t, {}, { timeoutMs: 5, callbackTimeoutMs: 0,
    handlers: { begin: callback => ({ accepted: true, completion: callback() }) } });
  const accepted = await left.call('begin', [() => completion]);
  await new Promise(resolve => setTimeout(resolve, 20));
  complete({ ok: true });
  assert.deepEqual(await accepted.completion, { ok: true });
});

test('acceptance returns immediately while nested completion remains independent', async t => {
  let complete;
  const completion = new Promise(resolve => { complete = resolve; });
  const { left, right } = pair(t, {}, { handlers: {
    submit: () => ({ accepted: true, queued: true, queueId: 'turn-1', nested: { completion } }),
  } });
  const accepted = await left.call('submit');
  assert.equal(accepted.accepted, true); assert.equal(accepted.queueId, 'turn-1');
  let settled = false; accepted.nested.completion.then(() => { settled = true; });
  await turn(); assert.equal(settled, false);
  complete({ ok: true, answer: 'ready' });
  assert.deepEqual(await accepted.nested.completion, { ok: true, answer: 'ready' });
  await turn(); assert.equal(left.stats().promises, 0); assert.equal(right.stats().exported, 0);
});

test('already-settled nested promises and their errors preserve completion order', async t => {
  const error = Object.assign(new Error('executor exited'), { code: 'EXECUTOR_EXIT' });
  const { left } = pair(t, {}, { handlers: {
    accept: () => ({ accepted: true, completion: Promise.resolve({ ok: true }) }),
    fail: () => { const completion = Promise.reject(error); completion.catch(() => {}); return { accepted: true, completion }; },
  } });
  assert.deepEqual(await (await left.call('accept')).completion, { ok: true });
  const accepted = await left.call('fail');
  await assert.rejects(accepted.completion, { name: 'Error', code: 'EXECUTOR_EXIT', message: 'executor exited' });
});

test('custom codecs restore opaque handles and cannot be forged by ordinary objects or arrays', async t => {
  class Handle { constructor(id) { this.id = id; } }
  const codecs = {
    encodeSpecial: value => value instanceof Handle ? { tag: 'session-handle', data: { id: value.id } } : undefined,
    decodeSpecial(tag, data) { assert.equal(tag, 'session-handle'); return new Handle(data.id); },
  };
  const { left } = pair(t, codecs, { ...codecs, handlers: { echo: value => value } });
  const restored = await left.call('echo', [new Handle('session-1')]);
  assert.ok(restored instanceof Handle); assert.equal(restored.id, 'session-1');
  const spoof = { tag: 'session-handle', data: { id: 'spoof' }, callback: 'fake', value: ['function', 'fake:1'] };
  assert.deepEqual(await left.call('echo', [spoof]), spoof);
  assert.deepEqual(await left.call('echo', [['special', 'session-handle', ['object', []]]]), ['special', 'session-handle', ['object', []]]);
});

test('errors and unknown methods reject without invoking inherited handler properties', async t => {
  const { left } = pair(t, {}, { handlers: {
    explode() { throw Object.assign(new Error('denied'), { code: 'DENIED', status: 403, permissionRequired: true, retryable: false }); },
    remoteTimeout() { throw Object.assign(new Error('worker-side deadline'), { code: 'RPC_TIMEOUT' }); },
  } });
  await assert.rejects(left.call('explode'), { code: 'DENIED', message: 'denied', status: 403, permissionRequired: true, retryable: false });
  await assert.rejects(left.call('not-found'), { code: 'RPC_METHOD_NOT_FOUND' });
  await assert.rejects(left.call('toString'), { code: 'RPC_METHOD_NOT_FOUND' });
  await assert.rejects(left.call('remoteTimeout'), error =>
    error.code === 'RPC_TIMEOUT' && error.remote === true);
});

test('request timeout aborts the remote signal and ignores the late result', async t => {
  let remoteAborted = false, finish;
  const { left, right } = pair(t, {}, { handlers: {
    slow() { this.signal.addEventListener('abort', () => { remoteAborted = true; }); return new Promise(resolve => { finish = resolve; }); },
    ready: () => true,
  } });
  await assert.rejects(left.call('slow', [], { timeoutMs: 40 }), { code: 'RPC_TIMEOUT' });
  // A later request proves the ordered cancel has arrived at the remote peer.
  await left.call('ready'); assert.equal(remoteAborted, true);
  finish({ late: true }); await turn(); await turn();
  assert.equal(left.stats().pending, 0); assert.equal(right.stats().incoming, 0);
});

test('paused RPC deadlines exclude system suspension time and resume with their remaining budget', async t => {
  let finish, started = false, settled = false;
  const { left } = pair(t, {}, { handlers: {
    slow() { started = true; return new Promise(resolve => { finish = resolve; }); },
    ready: () => true,
  } });
  const pending = left.call('slow', [], { timeoutMs: 100 });
  while (!started) await turn();
  assert.equal(left.pauseTimeouts(), true);
  assert.equal(await left.call('ready', [], { timeoutMs: 20 }), true,
    'responses can settle while new deadlines remain paused');
  pending.finally(() => { settled = true; }).catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 140));
  assert.equal(settled, false, 'wall-clock sleep must not consume an active RPC deadline');
  assert.equal(left.resumeTimeouts(), true);
  finish({ ok: true });
  assert.deepEqual(await pending, { ok: true });
  assert.equal(left.pauseTimeouts(), true);
  assert.equal(left.pauseTimeouts(), false, 'pausing is idempotent');
  assert.equal(left.resumeTimeouts(), true);
  assert.equal(left.resumeTimeouts(), false, 'resuming is idempotent');
});

test('a late timer callback treats event-loop sleep as inactive time before enforcing the deadline', async t => {
  let now = 1000;
  const timers = [];
  const peer = createRpcPeer({
    now: () => now,
    timerDriftToleranceMs: 50,
    setTimeout(callback, delay) {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer); return timer;
    },
    clearTimeout(timer) { timer.cancelled = true; },
    send() {},
  });
  t.after(() => peer.close());
  const pending = peer.call('never-replies', [], { timeoutMs: 100 });
  const first = timers.shift();
  now = 5000; first.callback();
  assert.equal(peer.stats().pending, 1);
  const resumed = timers.shift();
  assert.equal(resumed.delay, 100, 'resume preserves the pre-sleep request budget');
  now += 100; resumed.callback();
  await assert.rejects(pending, { code: 'RPC_TIMEOUT' });
});

test('AbortSignal cancels only its own request and rejects calls aborted before dispatch', async t => {
  let started = 0;
  const { left } = pair(t, {}, { handlers: {
    slow() { started++; return new Promise(() => {}); }, ready: () => true,
  } });
  const early = new AbortController(); early.abort();
  await assert.rejects(left.call('slow', [], { signal: early.signal }), { code: 'RPC_ABORTED' });
  const controller = new AbortController();
  const pending = left.call('slow', [], { signal: controller.signal });
  await left.call('ready'); controller.abort();
  await assert.rejects(pending, { code: 'RPC_ABORTED' });
  assert.equal(started, 1); assert.equal(await left.call('ready'), true);
});

test('close rejects pending calls, nested completions and subsequent operations', async t => {
  const { left } = pair(t, {}, { handlers: {
    hanging: () => new Promise(() => {}),
    accepted: () => ({ accepted: true, completion: new Promise(() => {}) }),
  } });
  const accepted = await left.call('accepted');
  const pending = left.call('hanging');
  const failure = new RpcError('WORKER_EXIT', 'runtime crashed');
  assert.equal(left.close(failure), true); assert.equal(left.close(), false);
  await assert.rejects(pending, { code: 'WORKER_EXIT' });
  await assert.rejects(accepted.completion, { code: 'WORKER_EXIT' });
  await assert.rejects(left.call('hanging'), { code: 'WORKER_EXIT' });
  assert.equal(left.notify('hanging'), false);
  assert.deepEqual(left.stats(), { closed: true, pending: 0, incoming: 0, exported: 0, functions: 0, promises: 0 });
});

test('explicit release revokes callbacks and frees the exporting peer reference', async t => {
  const { left, right } = pair(t, {}, { handlers: { callback: () => value => value + 1, ready: () => true } });
  const callback = await left.call('callback');
  assert.equal(await callback(2), 3); assert.equal(right.stats().exported, 1);
  assert.equal(left.release({ callback }), 1);
  await left.call('ready'); assert.equal(right.stats().exported, 0);
  await assert.rejects(callback(2), { code: 'RPC_REFERENCE_RELEASED' });
});

test('release of unresolved nested completion rejects it and removes both references', async t => {
  const { left, right } = pair(t, {}, { handlers: {
    accept: () => ({ completion: new Promise(() => {}) }), ready: () => true,
  } });
  const accepted = await left.call('accept'); left.release(accepted);
  await assert.rejects(accepted.completion, { code: 'RPC_REFERENCE_RELEASED' });
  await left.call('ready'); assert.equal(right.stats().exported, 0); assert.equal(left.stats().promises, 0);
});

test('exporter can revoke original callbacks without accumulating remote capabilities', async t => {
  let callback;
  const { left, right } = pair(t, {}, { handlers: {
    hold(value) { callback = value; return true; }, ready: () => true,
  } });
  const original = value => value + 1;
  await left.call('hold', [original]);
  assert.equal(right.stats().functions, 1); assert.equal(await callback(2), 3);
  assert.equal(left.release(original), 1); await left.call('ready');
  assert.equal(right.stats().functions, 0);
  await assert.rejects(callback(2), { code: 'RPC_REFERENCE_RELEASED' });
  await left.call('hold', [original]); assert.equal(await callback(3), 4);
});

test('an early completion is retained until its acceptance envelope is decoded', async t => {
  let left, right, response;
  const timers = [];
  left = createRpcPeer({
    timeoutMs: 0,
    setTimeout(callback, delay) {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer); return timer;
    },
    clearTimeout(timer) { timer.cancelled = true; },
    send: packet => queueMicrotask(() => right.receive(structuredClone(packet))),
  });
  right = createRpcPeer({ handlers: { accept: () => ({ accepted: true, completion: Promise.resolve({ ok: true }) }) },
    send(packet) {
      if (packet.type === 'response') response = structuredClone(packet);
      else if (packet.type === 'settle') {
        left.receive(structuredClone(packet));
        assert.equal(left.pauseTimeouts(), true);
        assert.equal(left.resumeTimeouts(), true);
        queueMicrotask(() => left.receive(response));
      } else queueMicrotask(() => left.receive(structuredClone(packet)));
    } });
  t.after(() => { left.close(); right.close(); });
  const accepted = await left.call('accept');
  assert.equal(accepted.accepted, true); assert.deepEqual(await accepted.completion, { ok: true });
  assert.equal(timers.length, 2, 'pause/resume rearms the buffered completion once');
  assert.equal(timers.every(timer => timer.cancelled), true, 'the injected timer is cancelled after decoding');
  assert.equal(left.stats().promises, 0);
});

test('notifications are ordered and cannot grow past the incoming concurrency limit', async t => {
  const observed = [], errors = [];
  const { left, right } = pair(t, {}, { limits: { incoming: 2 }, onError: error => errors.push(error), handlers: {
    record: value => { observed.push(value); },
    holding: () => new Promise(() => {}),
  } });
  left.notify('record', ['first']); left.notify('record', ['second']);
  await turn(); await turn(); assert.deepEqual(observed, ['first', 'second']);
  left.notify('holding'); left.notify('holding'); left.notify('holding');
  await turn(); await turn(); assert.equal(right.stats().incoming, 2);
  await assert.rejects(left.call('record', ['blocked']), { code: 'RPC_INCOMING_LIMIT' });
  assert.deepEqual(errors, []);
});

test('closing a peer aborts active notification handlers and clears their inventory', async t => {
  let aborted = false;
  const { left, right } = pair(t, {}, { handlers: {
    hold() { this.signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {}); },
    ready: () => true,
  } });
  left.notify('hold'); await left.call('ready');
  right.close(); assert.equal(aborted, true); assert.equal(right.stats().incoming, 0);
});

test('message, depth and reference limits fail explicitly and roll back partial exports', async t => {
  const { left } = pair(t, { limits: { depth: 6, nodes: 40, bytes: 1000, refs: 2 } }, { handlers: { echo: value => value } });
  const circular = {}; circular.self = circular;
  await assert.rejects(left.call('echo', [{ callback() {}, circular }]), { code: 'RPC_CYCLE' });
  assert.equal(left.stats().exported, 0);
  await assert.rejects(left.call('echo', ['x'.repeat(1000)]), { code: 'RPC_MESSAGE_LIMIT' });
  await assert.rejects(left.call('echo', [[[[[[[[1]]]]]]]]), { code: 'RPC_MESSAGE_LIMIT' });
  await assert.rejects(left.call('echo', [[() => {}, () => {}, () => {}]]), { code: 'RPC_REFERENCE_LIMIT' });
  assert.equal(left.stats().exported, 0);
  assert.equal(await left.call('echo', ['still alive']), 'still alive');
});

test('pending request limit is bounded and becomes available again after abort', async t => {
  const { left } = pair(t, { limits: { pending: 1 } }, { handlers: { hold: () => new Promise(() => {}), ready: () => true } });
  const controller = new AbortController();
  const pending = left.call('hold', [], { signal: controller.signal });
  await assert.rejects(left.call('ready'), { code: 'RPC_PENDING_LIMIT' });
  controller.abort(); await assert.rejects(pending, { code: 'RPC_ABORTED' });
  assert.equal(await left.call('ready'), true);
});

test('malformed packets cannot escape receive or alter Object.prototype', async t => {
  const { left } = pair(t, {}, { handlers: { echo: value => value } });
  assert.equal(left.receive({ namespace: 'another-protocol', type: 'response' }), false);
  assert.equal(left.receive({ namespace: RPC_NAMESPACE, type: 'bad' }), false);
  assert.equal(left.receive({ namespace: RPC_NAMESPACE, type: 'request', id: {} }), false);
  const poison = JSON.parse('{"__proto__":{"injected":true},"constructor":{"prototype":{"bad":true}}}');
  const result = await left.call('echo', [poison]);
  assert.deepEqual(result, poison); assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal({}.injected, undefined); assert.equal({}.bad, undefined);
});

test('transport failures reject immediately and close all future calls', async () => {
  const peer = createRpcPeer({ send() { throw Error('disconnected'); } });
  await assert.rejects(peer.call('open'), { code: 'RPC_TRANSPORT_CLOSED', message: 'disconnected' });
  await assert.rejects(peer.call('open'), { code: 'RPC_TRANSPORT_CLOSED' });
  assert.equal(peer.stats().pending, 0);
});
