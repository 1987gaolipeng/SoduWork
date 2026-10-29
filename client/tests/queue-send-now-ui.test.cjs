'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
function fixture(update) {
  const calls = [], notices = [], host = { dataset: {}, classList: { add() {}, toggle() {} } };
  const globals = { window: null, document: { activeElement: null }, petSay: message => notices.push(message) };
  globals.window = globals;
  vm.runInNewContext(fs.readFileSync(require.resolve('../components/panels/chat-send-queue.js'), 'utf8'), globals);
  const ctx = { _ref: 'chat-a', _viewEpoch: 1, _localQueue: [], _collabTasks: new Map(),
    _collabEntries: () => [], esc: value => String(value || ''), _mount: () => ({ querySelector: () => host }),
    _snap: { execution: { queue: [{ id: 'first', text: 'Next', attachments: ['brief.png'] }, { id: 'second', text: 'Later' }],
      queueImmediate: { supported: true, available: true, pending: false } } },
    _api: () => ({ updateQueue: async (...args) => { calls.push(args); return update(...args); } }),
  };
  const queue = globals.ChatSendQueue.create(ctx);
  ctx._render = () => queue._renderQueue(ctx._mount());
  return { ctx, queue, calls, notices, globals, render: () => { ctx._render(); return host.innerHTML; } };
}

test('queued messages expose an explained send-now action; tasks and unsupported runtimes do not', () => {
  const f = fixture(() => ({ ok: true }));
  f.ctx._snap.execution.queue.push({ id: 'task', text: 'Task', taskId: 'task-a' });
  assert.equal((f.render().match(/data-queue-action="send-now"/g) || []).length, 2);
  assert.match(f.render(), /aria-label="引导"/);
  assert.doesNotMatch(f.render(), /排队中|class="nqueue-state"/);
  assert.match(f.render(), /aria-label="待发送队列"/);
  assert.match(f.render(), /data-queue-action="remove"/);
  assert.match(f.render(), /停止当前回复，立即发送这条消息；其余消息继续排队/);
  f.ctx._snap.execution.queueImmediate.available = false;
  f.ctx._snap.execution.queueImmediate.reason = '当前任务正在执行';
  assert.match(f.render(), /title="当前任务正在执行"[^>]* disabled/);
  delete f.ctx._snap.execution.queueImmediate;
  assert.doesNotMatch(f.render(), /data-queue-action="send-now"/);
});

test('send now uses the original queue identity once and preserves the queue until acknowledged', async () => {
  let resolve;
  const f = fixture(() => new Promise(done => { resolve = done; }));
  const snapshot = f.ctx._snap;
  const pending = f.queue._queueAction('send-now', 'first');
  assert.equal(f.ctx._snap, snapshot);
  assert.match(f.render(), /aria-busy="true"/);
  await f.queue._queueAction('send-now', 'first');
  await f.queue._queueAction('send-now', 'second');
  await f.queue._queueAction('remove', 'first');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], ['chat-a', 'first', 'send-now', '']);
  resolve({ ok: true, snapshot: { execution: { queue: [snapshot.execution.queue[1]] } } });
  await pending;
  assert.equal(f.ctx._snap.execution.queue[0].id, 'second');
  assert.doesNotMatch(f.render(), /aria-busy="true"/);
});

test('failure leaves text and attachments queued, then allows a retry', async () => {
  let failure = true;
  const f = fixture(async () => { if (failure) throw Error('Stop not acknowledged'); return { ok: true }; });
  const snapshot = f.ctx._snap;
  await f.queue._queueAction('send-now', 'first');
  assert.equal(f.ctx._snap, snapshot);
  assert.equal(f.ctx._snap.execution.queue[0].attachments[0], 'brief.png');
  assert.deepEqual(f.notices, ['Stop not acknowledged']);
  failure = false;
  await f.queue._queueAction('send-now', 'first');
  assert.equal(f.calls.length, 2);
});

test('late replies cannot overwrite another chat or newer runtime events', async () => {
  let resolve;
  const f = fixture(() => new Promise(done => { resolve = done; }));
  const sending = f.queue._queueAction('send-now', 'first');
  const fresh = { execution: { queue: [] } };
  f.ctx._snap = fresh;
  resolve({ ok: true, snapshot: { execution: { queue: [{ id: 'stale' }] } } });
  await sending;
  assert.equal(f.ctx._snap, fresh);
  f.ctx._snap = { execution: { queue: [{ id: 'second' }], queueImmediate: { supported: true, available: true } } };
  const other = f.queue._queueAction('send-now', 'second');
  f.ctx._ref = 'chat-b'; f.ctx._viewEpoch++;
  const nextChat = { execution: { queue: [{ id: 'unrelated' }] } }; f.ctx._snap = nextChat;
  resolve({ ok: false, reason: 'Old failure' }); await other;
  assert.equal(f.ctx._snap, nextChat); assert.deepEqual(f.notices, []);
});

test('unacknowledged local drafts and missing queue ids cannot send or duplicate content', async () => {
  const f = fixture(() => ({ ok: true }));
  f.ctx._localQueue = [{ id: 'local', text: 'Draft' }];
  await f.queue._queueAction('send-now', 'local');
  await f.queue._queueAction('send-now', 'missing');
  assert.equal(f.calls.length, 0);
});

test('late edit, reorder and remove replies cannot resurrect a message already consumed by steering', async () => {
  for (const action of ['edit', 'reorder', 'remove']) {
    let resolve;
    const response = new Promise(done => { resolve = done; });
    const f = fixture(() => response), old = f.ctx._snap;
    f.globals.document.getElementById = () => ({ value: 'changed content' });
    f.ctx._api = () => ({ updateQueue: () => response, cancelQueued: () => response });
    const operation = action === 'edit' ? f.queue._queueAction('save-edit', 'first')
      : action === 'reorder' ? f.queue._updateQueueOrder('first', 'before', 'second')
      : f.queue._cancelQueued('first');
    const latest = { execution: { queue: [], turnQueue: { activeQueueId: 'first' } } };
    f.ctx._snap = latest;
    resolve({ ok: true, snapshot: old }); await operation;
    assert.equal(f.ctx._snap, latest, action + ' must not roll back a newer runtime event');
  }
});

test('confirmed local placeholder stays consumed when steering starts before send acknowledgement', () => {
  const f = fixture(() => ({ ok: true }));
  f.ctx._localQueue = [{ id: 'local-1', submissionId: 's1', text: 'Next', attachments: ['brief.png'] }];
  f.ctx._snap.execution.queue[0].submissionId = 's1';
  assert.deepEqual(Array.from(f.queue._queueRows(), row => row.id), ['first', 'second']);
  f.ctx._snap = { execution: { queue: [] } };
  assert.equal(f.queue._queueRows().length, 0, 'accepted input cannot reappear as an unsent local message');
});

test('active submission identity reconciles a local placeholder even if its queued event was coalesced', () => {
  const f = fixture(() => ({ ok: true }));
  f.ctx._localQueue = [
    { id: 'local-1', submissionId: 's1', text: 'same text' },
    { id: 'local-2', submissionId: 's2', text: 'same text' },
  ];
  f.ctx._snap = { execution: { queue: [], turnQueue: { activeQueueId: 'running', activeSubmissionId: 's1' } } };
  assert.deepEqual(Array.from(f.queue._queueRows(), row => row.id), ['local-2']);
});

test('an older identical message cannot acknowledge a local draft still preparing its attachments', () => {
  const f = fixture(() => ({ ok: true }));
  f.ctx._snap.execution.queue[0].submissionId = 'older-send';
  f.ctx._localQueue = [{ id: 'local-new', text: 'Next', attachments: ['new.png'] }];
  assert.deepEqual(Array.from(f.queue._queueRows(), row => row.id), ['first', 'second', 'local-new']);
  assert.equal(f.ctx._localQueue[0].serverId, undefined);
});
