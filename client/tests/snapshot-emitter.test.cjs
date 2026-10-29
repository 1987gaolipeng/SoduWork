'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../main/pi-session/snapshot-emitter');

test('a token burst builds one latest snapshot, structural events keep kind order', async () => {
  let value = 0, builds = 0;
  const received = [];
  const emitter = create(() => { builds++; return value; }, new Set([(event, snap) => received.push([event.kind, snap])]), 5);
  for (let i = 0; i < 1000; i++) { value++; emitter.emit({ kind: 'block' }); }
  assert.equal(builds, 0);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(received, [['block', 1000]]);
  value++; emitter.emit({ kind: 'tool', partial: true });
  emitter.emit({ kind: 'settled' });
  await new Promise(resolve => setTimeout(resolve, 20));
  /* Deliver structural events in order while building the shared snapshot once. */
  assert.deepEqual(received.slice(1), [['tool', 1001], ['settled', 1001]]);
  assert.equal(builds, 2);
  emitter.dispose();
});

test('structural burst is rate limited: snapshot built once, every kind delivered', async () => {
  let builds = 0;
  const received = [];
  const emitter = create(() => { builds++; return {}; }, new Set([(event, snap) => received.push(event.kind)]), 5);
  for (let i = 0; i < 20; i++) emitter.emit({ kind: 'tool' });
  emitter.emit({ kind: 'settled' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(builds, 1);
  assert.equal(received.length, 21);
  assert.equal(received[0], 'tool');
  assert.equal(received.at(-1), 'settled');
  emitter.dispose();
});

test('closed sessions cancel delayed snapshots and ignore late provider events', async () => {
  let builds = 0;
  const emitter = create(() => { builds++; }, new Set(), 5);
  emitter.emit({ kind: 'block' }); emitter.dispose(); emitter.emit({ kind: 'settled' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(builds, 0);
});
