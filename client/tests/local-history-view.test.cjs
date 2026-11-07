'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../main/conversation/local-history-view.cjs');
function source(items, format = 'messages', pageSize = 20) {
  let reads = 0;
  return { reads: () => reads, async read(id, { after }) {
    reads++;
    return { format, items: items.slice(after, after + pageSize),
      nextCursor: after + pageSize < items.length ? after + pageSize : null };
  } };
}
test('late delta of an evicted stream never becomes a duplicate partial message', async () => {
  const items = Array.from({ length: 130 }, (_, i) => ({ id: String(i), streamId: 's' + i,
    role: 'assistant', text: 'prefix-' + i, delta: false }));
  items.push({ id: '131', streamId: 's0', role: 'assistant', text: '-tail', delta: true });
  const f = source(items, 'events');
  const view = await create({ row: { id: 'native' }, read: f.read });
  assert.equal(view.snapshot().history.totalMessages, 130);
  assert.equal(view.snapshot().messages.length, 100);
  assert.equal(view.snapshot().messages.some(row => row.id === 's0'), false);
  await view.loadHistory({ messageLimit: 150 });
  assert.equal(view.snapshot().messages[0].text, 'prefix-0-tail');
  assert.equal(view.snapshot().history.totalMessages, 130);
  assert.equal(view.snapshot().history.truncated, false);
  await view.close();
});
test('expanded windows use indexed pages rather than rescanning all prior messages', async () => {
  const items = Array.from({ length: 10000 }, (_, i) => ({ id: String(i), role: 'user', text: 'message-' + i }));
  const f = source(items, 'messages', 200), view = await create({ row: { id: 'large' }, read: f.read });
  assert.equal(f.reads(), 50);
  assert.equal(view.snapshot().messages[0].text, 'message-9900');
  await view.loadHistory({ messageLimit: 200 });
  assert.equal(f.reads(), 51);
  assert.equal(view.snapshot().messages[0].text, 'message-9800');
  await Promise.all([view.loadHistory({ messageLimit: 400 }), view.loadHistory({ messageLimit: 600 })]);
  assert.equal(view.snapshot().messages.length, 600);
  assert.equal(view.snapshot().history.messageStart, 9400);
  assert.equal(f.reads(), 56);
  await view.close();
});
test('byte-bound eviction never resurrects a message without its original delta prefix', async () => {
  const items = Array.from({ length: 110 }, (_, i) => ({ id: String(i), streamId: 's' + i,
    role: 'assistant', text: 'x'.repeat(100000), delta: false }));
  items.push({ id: '111', streamId: 's0', role: 'assistant', text: 'late-tail', delta: true });
  const f = source(items, 'events'), view = await create({ row: { id: 'large-bytes' }, read: f.read });
  await view.loadHistory({ messageLimit: 200 });
  const snapshot = view.snapshot();
  assert.equal(snapshot.messages.some(row => row.text === 'late-tail'), false);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot.messages)) < 8 * 1024 * 1024);
  assert.equal(snapshot.history.messageIndices.length, snapshot.messages.length);
  assert.equal(snapshot.history.totalMessages, 110);
  await view.close();
});
test('an oversized message fails explicitly while its source remains readable', async () => {
  const items = [{ id: 'large', role: 'user', blocks: [{ text: 'x'.repeat(2 * 1024 * 1024) }] }];
  const f = source(items);
  await assert.rejects(create({ row: { id: 'large' }, read: f.read }), /单条历史消息过大/);
  assert.equal((await f.read('large', { after: 0 })).items[0].blocks[0].text.length, 2 * 1024 * 1024);
});
