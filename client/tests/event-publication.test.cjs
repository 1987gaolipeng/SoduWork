'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { create, fields } = require('../main/pi-session/event-publication');
const { createStreamScheduler, STREAM_FLUSH_MS } = require('../main/pi-session/event-publication');

test('stream transport coalesces the latest state within one frame and cancels stale deltas on settlement', () => {
  const timers = new Map(), sent = [], delays = [];
  let id = 0;
  const scheduler = createStreamScheduler((context, event, snapshot) => sent.push([context, event.kind, snapshot]), {
    setTimer(fn, delay) { const key = ++id; timers.set(key, fn); delays.push(delay); return key; },
    clearTimer(key) { timers.delete(key); },
  });
  for (let i = 0; i < 1000; i++) scheduler.push('chat', { kind: 'block' }, i, 'owner');
  assert.deepEqual(delays, [STREAM_FLUSH_MS]); assert.equal(STREAM_FLUSH_MS, 16);
  assert.equal(sent.length, 0); timers.get(1)();
  assert.deepEqual(sent, [['owner', 'block', 999]]);
  scheduler.push('chat', { kind: 'block' }, 1000, 'owner');
  scheduler.push('chat', { kind: 'settled' }, 1001, 'owner');
  assert.equal(timers.has(2), false);
  assert.deepEqual(sent.at(-1), ['owner', 'settled', 1001]);
  scheduler.push('other', { kind: 'block' }, 1, 'other'); scheduler.clear();
  assert.equal(timers.has(3), false);
});

test('a structural burst transports one snapshot and all ordered event metadata', async () => {
  const calls = [], snapshot = { messages: ['synthetic'] }, context = {};
  const publisher = create((...args) => calls.push(args));
  for (const kind of ['tool', 'tool', 'ui', 'error', 'settled']) publisher.push('chat', { kind }, snapshot, context);
  assert.equal(calls.length, 0);
  await Promise.resolve();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], context);
  assert.equal(calls[0][2], snapshot);
  assert.deepEqual(calls[0][1].map(event => event.kind), ['tool', 'tool', 'ui', 'error', 'settled']);
});

test('different snapshots and sessions remain separate, preserving state order', async () => {
  const calls = [], waiting = {}, done = {};
  const publisher = create((context, events, snapshot) => calls.push([context, events[0].kind, snapshot]));
  publisher.push('a', { kind: 'ui' }, waiting, 'a');
  publisher.push('a', { kind: 'settled' }, done, 'a');
  publisher.push('b', { kind: 'tool' }, done, 'b');
  await Promise.resolve();
  assert.deepEqual(calls, [['a', 'ui', waiting], ['a', 'settled', done], ['b', 'tool', done]]);
});

test('capture runs once per snapshot before mutable session state advances', async () => {
  let current = 'waiting', captures = 0;
  const calls = [], waiting = {}, done = {};
  const publisher = create((context, events) => calls.push([context, events.map(event => event.kind)]), {
    capture() { captures++; return current; },
  });
  publisher.push('a', { kind: 'ui' }, waiting, {});
  publisher.push('a', { kind: 'tool' }, waiting, {});
  current = 'done';
  publisher.push('a', { kind: 'settled' }, done, {});
  await Promise.resolve();
  assert.equal(captures, 2);
  assert.deepEqual(calls, [['waiting', ['ui', 'tool']], ['done', ['settled']]]);
});

test('flushing before an ownership change preserves the original recipient', async () => {
  let owner = 'first'; const calls = [];
  const publisher = create((_context, events) => calls.push([owner, events[0].kind]));
  publisher.push('a', { kind: 'tool' }, {}, {});
  publisher.flush('a'); owner = 'second';
  publisher.push('a', { kind: 'settled' }, {}, {});
  await Promise.resolve();
  assert.deepEqual(calls, [['first', 'tool'], ['second', 'settled']]);
});

test('closing a session or quitting cancels queued transport without losing a reopened session', async () => {
  const calls = [], publisher = create((_context, events) => calls.push(events[0].kind));
  publisher.push('a', { kind: 'old' }, {}, {}); publisher.cancel('a');
  publisher.push('a', { kind: 'new' }, {}, {});
  await Promise.resolve(); assert.deepEqual(calls, ['new']);
  publisher.push('b', { kind: 'late' }, {}, {}); publisher.clear();
  await Promise.resolve(); assert.deepEqual(calls, ['new']);
});

test('batch metadata preserves errors/submissions but never copies provider blocks or private fields', () => {
  const event = { kind: 'error', reason: 'synthetic failure', failureKind: 'skill-selection', retrySafe: true,
    submissionId: 'draft', block: { text: 'private provider data' }, token: 'private token' };
  const snapshot = { execution: { turnQueue: { activeTaskId: 'task' } } };
  assert.deepEqual(fields(event, true, snapshot), { kind: 'error', reason: 'synthetic failure',
    failureKind: 'skill-selection', retrySafe: true, submissionId: 'draft', taskId: 'task' });
  assert.deepEqual(fields(event, false, snapshot), { kind: 'error', reason: 'synthetic failure',
    failureKind: '', retrySafe: false, submissionId: '', taskId: 'task' });
});

test('a failed publication does not crash the microtask or block another session', async () => {
  const received = [], publisher = create(context => { if (context === 'closed') throw Error('closed window'); received.push(context); });
  publisher.push('a', { kind: 'tool' }, {}, 'closed');
  publisher.push('b', { kind: 'settled' }, {}, 'open');
  await Promise.resolve(); assert.deepEqual(received, ['open']);
});
