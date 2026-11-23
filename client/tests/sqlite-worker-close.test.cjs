'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { create, createWorker } = require('../main/conversation/replica-store.cjs');

test('closing a full worker queue drains accepted replica writes before terminating', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-worker-close-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'history.sqlite');
  const worker = createWorker(file);
  // Queue all requests in the same turn so none of their replies has arrived.
  const writes = Array.from({ length: 256 }, (_, index) =>
    worker.register([{ id: `accepted-${index}`, title: `Conversation ${index}` }]));
  const overflow = worker.register([{ id: 'overflow' }]);
  const closing = worker.close();
  const [results, rejected, closed] = await Promise.all([
    Promise.allSettled(writes),
    Promise.allSettled([overflow]),
    Promise.allSettled([closing]),
  ]);
  assert.equal(rejected[0].status, 'rejected');
  assert.match(rejected[0].reason.message, /storage is busy/);
  assert.equal(closed[0].status, 'fulfilled', closed[0].reason?.message);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, writes.length);

  const reopened = create(file);
  try {
    for (let index = 0; index < writes.length; index++)
      assert.equal(reopened.get(`accepted-${index}`).title, `Conversation ${index}`);
    assert.equal(reopened.get('overflow'), null);
  } finally { reopened.close(); }
});
