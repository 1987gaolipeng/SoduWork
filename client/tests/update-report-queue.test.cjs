'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createReportQueue } = require('../main/update-report-queue');

test('a slow progress request coalesces later progress while preserving terminal ordering', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; }), sent = [];
  const report = createReportQueue(async (state, percent) => {
    sent.push([state, percent]);if (sent.length === 1) await held;
  });
  const first = report('downloading', 0);
  await Promise.resolve(); await Promise.resolve();
  for (let i = 1; i < 100; i++) report('downloading', i);
  const done = report('downloaded', 100);
  const installing = report('installing', 100);
  assert.deepEqual(sent, [['downloading', 0]], 'no parallel or unbounded network requests');
  release();await Promise.all([first, done, installing]);
  assert.deepEqual(sent, [['downloading', 0], ['downloading', 99], ['downloaded', 100], ['installing', 100]]);
});

test('a later attempt cannot overwrite progress from before a lifecycle boundary', async () => {
  const sent = [];
  const report = createReportQueue(async (...event) => { sent.push(event); });
  const first = report('downloading', 5, { attempt: 'first' });
  const failed = report('failed', 5);
  const second = report('downloading', 10, { attempt: 'second' });
  await Promise.all([first, failed, second]);
  assert.deepEqual(sent, [['downloading', 5, { attempt: 'first' }], ['failed', 5, {}], ['downloading', 10, { attempt: 'second' }]]);
});

test('failed progress telemetry does not strand later lifecycle events', async () => {
  const sent = [];
  const report = createReportQueue(async state => {
    sent.push(state);if (state === 'downloading') throw Error('offline');return 'accepted';
  });
  const first = report('downloading', 10), next = report('downloaded', 100);
  await assert.rejects(first, /offline/);
  assert.equal(await next, 'accepted');
  assert.deepEqual(sent, ['downloading', 'downloaded']);
});
