'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createTurnQueue } = require('../main/pi-session/turn-queue');

test('a retried submission keeps one queue identity, payload and completion before, during and after execution', async () => {
  const q = createTurnQueue();
  const payload = { text: '引导：改成红色主题', attachments: [{ name: 'design.png' }],
    options: { submissionId: 'same-delivery', modelName: 'picked', pluginIds: ['design'] } };
  const original = q.add(payload);
  const duplicate = q.add({ ...payload, text: 'a transport retry must not replace accepted input' });
  assert.equal(duplicate, original);
  assert.equal(q.size(), 1);
  let finish;
  const running = q.run(q.take(), () => new Promise(resolve => { finish = resolve; }));
  assert.equal(q.add(payload), original);
  assert.equal(q.state().activeSubmissionId, payload.options.submissionId);
  assert.equal(q.state().activeQueueId, original.id);
  finish({ ok: true }); await running;
  assert.equal(q.add(payload), original);
  assert.equal(q.size(), 0);
  assert.equal((await duplicate.completion).ok, true);
  assert.equal(original.text, payload.text);
  assert.equal(original.attachments[0].name, 'design.png');
  assert.equal(q.state().activeSubmissionId, '');
});

test('identical text in separate submissions is retained; explicit model recovery can retry a settled submission', async () => {
  const q = createTurnQueue();
  const first = q.add({ text: '继续', options: { submissionId: 'one' } });
  const second = q.add({ text: '继续', options: { submissionId: 'two' } });
  assert.notEqual(first.id, second.id);
  await q.run(q.take(), async () => ({ ok: false, reason: 'model unavailable' }));
  const retry = q.add({ text: first.text, options: { ...first.options, retry: true, modelRecovery: true } });
  assert.notEqual(retry.id, first.id);
  assert.equal(q.add({ text: first.text, options: retry.options }), retry);
  assert.deepEqual(q.view().map(row => row.id), [retry.id, second.id]);
  const cancelled = q.cancel(retry.id);
  assert.equal((await cancelled.completion).cancelled, true);
  assert.equal(q.add({ text: first.text, options: first.options }), retry, 'a late delivery must not resurrect a cancelled turn');
});
