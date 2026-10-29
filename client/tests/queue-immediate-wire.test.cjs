'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
test('real Pi aborts streaming, immediately sends selected original input, retains attachments and following queue without replaying a completed tool', { timeout: 45000 }, async t => {
  const f = await require('../e2e/fixtures/queue-send-now-sdk.cjs').create(); t.after(f.close);
  const first = f.handle.submit(f.text.first, []); await f.waitForHold('first');
  assert.equal(fs.readFileSync(f.output, 'utf8'), 'Native tool ran once'); const mtime = fs.statSync(f.output).mtimeMs;
  const later = f.handle.submit(f.text.later, [], { submissionId: 'later' });
  const now = f.handle.submit(f.text.now, [f.attachment], { submissionId: 'now' });
  assert.equal(f.handle.submit(f.text.now, [f.attachment], { submissionId: 'now' }).queueId, now.queueId);
  const edited = f.text.now + ' 使用最新修改的主题。';
  assert.equal(f.handle.updateQueue(now.queueId, 'edit', edited).ok, true);
  assert.equal(f.handle.snapshot().execution.queueImmediate.available, true);
  const sent = f.handle.updateQueue(now.queueId, 'send-now');
  assert.equal(f.handle.cancelQueued(now.queueId).ok, false);
  assert.equal(f.handle.updateQueue(now.queueId, 'edit', 'Must not replace input').ok, false);
  assert.equal((await sent).ok, true); assert.equal((await first.completion).cancelled, true);
  await f.waitForHold('now'); await f.until(f.firstClosed);
  assert.deepEqual(f.handle.snapshot().execution.queue.map(x => x.submissionId), ['later']);
  const immediate = f.received.find(x => x.kind === 'now');
  const input = immediate.body.messages.filter(x => x.role === 'user').map(x => typeof x.content === 'string'
    ? x.content : (x.content || []).map(part => part.text || '').join('\n')).at(-1);
  assert.match(input, /使用最新修改的主题/);
  assert.equal(f.handle.submit(f.text.now, [f.attachment], { submissionId: 'now' }).queueId, now.queueId);
  const files = JSON.parse(input.split('<soduwork-input-attachments>')[1].split('</soduwork-input-attachments>')[0]).files;
  assert.equal(files[0].path, f.note);
  assert.ok(immediate.body.messages.some(x => x.role === 'tool' && x.tool_call_id === 'write_once'));
  assert.equal(f.handle.snapshot().execution.modelRecovery, null);
  f.release('now'); assert.equal((await now.completion).ok, true); assert.equal((await later.completion).ok, true);
  assert.equal(f.received.filter(x => x.kind === 'now').length, 1); assert.equal(f.received.filter(x => x.kind === 'later').length, 1);
  const replay = f.handle.submit(f.text.now, [f.attachment], { submissionId: 'now' });
  assert.equal(replay.queueId, now.queueId); assert.equal((await replay.completion).ok, true);
  assert.equal(f.handle.snapshot().execution.queue.length, 0);
  assert.equal(fs.statSync(f.output).mtimeMs, mtime); assert.equal(f.handle.snapshot().tools.filter(x => x.name === 'write').length, 1);
  assert.equal((await f.handle.updateQueue(now.queueId, 'send-now')).ok, false);
});

test('real Pi active task stays uninterrupted when a queued ordinary message requests immediate send', { timeout: 45000 }, async t => {
  const f = await require('../e2e/fixtures/queue-send-now-sdk.cjs').create(); t.after(f.close);
  const receipts = [];
  const task = f.handle.submit(f.text.first, [], { taskId: 'active-task', afterTurn: value => receipts.push(value) });
  await f.waitForHold('first');
  const next = f.handle.submit(f.text.now, []);
  assert.equal(f.handle.snapshot().execution.queueImmediate.available, false);
  assert.equal((await f.handle.updateQueue(next.queueId, 'send-now')).ok, false);
  assert.equal(f.firstClosed(), false);
  assert.equal(f.handle.snapshot().execution.queue[0].id, next.queueId);
  f.handle.cancelQueued(next.queueId); f.release('first');
  assert.equal((await task.completion).ok, true); assert.deepEqual(receipts, ['completed']);
});
