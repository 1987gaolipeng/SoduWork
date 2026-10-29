'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const stream = require('../main/pi-session/event-stream');

const user = sentAt => ({ role: 'user', text: 'question', sentAt, blocks: [], done: true });
const assistant = (output, completedAt, extra = {}) => ({ role: 'assistant', done: true,
  blocks: [{ kind: 'text', index: 0, text: 'answer', done: true }],
  usage: { input: 100, output, totalTokens: 100 + output }, completedAt, ...extra });
function stateOf(messages) { return Object.assign(stream._blank(), { messages }); }

test('turn metrics count raw continuations, hidden audit and usage-only receipts once', () => {
  const state = stateOf([user(1000), assistant(3, 2000),
    assistant(5, 3000, { scope: stream.SCOPES.GOAL_REVIEW }),
    assistant(7, 4000, { continuation: true }), assistant(2, 5000, { blocks: [] })]);
  state.auditHidden = [2];
  const snapshot = stream.snapshot(state, { messageLimit: 20 });
  assert.equal(snapshot.messages.length, 2, 'the presentation merged and hid raw receipts');
  assert.deepEqual(snapshot.turnMetrics,
    [{ fromMessage: 0, toMessage: 4, elapsedMs: 4000, tokens: 17 }]);
  assert.equal(snapshot.messages[1].usage.output, 7, 'ordinary message usage remains untouched');
  assert.equal(stream.snapshot(state).usageReceipts.length, 4, 'financial accounting remains separate');
});

test('bounded metrics retain absolute owners when history begins inside a turn', () => {
  const state = stateOf([user(1000), assistant(2, 2000), user(4000),
    assistant(3, 5000), assistant(5, 6000), user(7000), assistant(11, 9000)]);
  const snapshot = stream.snapshot(state, { messageLimit: 3 });
  assert.deepEqual(snapshot.history.messageIndices, [4, 5, 6]);
  assert.deepEqual(snapshot.turnMetrics, [
    { fromMessage: 2, toMessage: 4, elapsedMs: 2000, tokens: 8 },
    { fromMessage: 5, toMessage: 6, elapsedMs: 2000, tokens: 11 },
  ]);
  assert.equal(stream.snapshot(state, { messageLimit: 20 }).turnMetrics.length, 3);
});

test('full snapshots project receipt owners onto visible messages before runtime handoff', () => {
  const state = stateOf([user(1000), assistant(3, 2000),
    assistant(5, 3000, { scope: stream.SCOPES.GOAL_REVIEW }),
    assistant(7, 4000, { continuation: true }), assistant(2, 5000, { blocks: [] }),
    user(6000), assistant(11, 7000)]);
  state.auditHidden = [2];
  const full = stream.snapshot(state);
  assert.equal(full.history, undefined);
  assert.equal(full.messages.length, 4);
  assert.deepEqual(full.turnMetrics, [
    { fromMessage: 0, toMessage: 1, elapsedMs: 4000, tokens: 17 },
    { fromMessage: 2, toMessage: 3, elapsedMs: 1000, tokens: 11 },
  ]);
  assert.deepEqual(stream.snapshot(state, { messageLimit: 20 }).turnMetrics, [
    { fromMessage: 0, toMessage: 4, elapsedMs: 4000, tokens: 17 },
    { fromMessage: 5, toMessage: 6, elapsedMs: 1000, tokens: 11 },
  ]);
});

test('unknown receipts and incomplete turns stay unknown, without inventing timing', () => {
  const state = stateOf([user(1000), assistant(3, 2000, { usage: null }),
    user(3000), assistant(5, 0), user(5000), assistant(7, 6000, { done: false }),
    user(7000)]);
  assert.deepEqual(stream.snapshot(state).turnMetrics, [
    { fromMessage: 0, toMessage: 1, elapsedMs: 1000, tokens: null },
    { fromMessage: 2, toMessage: 3, elapsedMs: null, tokens: 5 },
    { fromMessage: 4, toMessage: 5, elapsedMs: null, tokens: null },
    { fromMessage: 6, toMessage: 6, elapsedMs: null, tokens: null },
  ]);
  const unknown = stateOf([user(0), assistant(0, 2000)]);
  assert.deepEqual(stream.snapshot(unknown).turnMetrics,
    [{ fromMessage: 0, toMessage: 1, elapsedMs: null, tokens: 0 }]);
});

test('output and thinking token semantics match the existing turn status metric', () => {
  const receipts = [
    { input: 100, output: 5, reasoning: 2, totalTokens: 107 },
    { input_tokens: 100, output_tokens: 9, output_tokens_details: { reasoning_tokens: 4 } },
    { input: 100, output: 7, cacheRead: 50, reasoning: 4, totalTokens: 161 },
    { output: 4, reasoning: 3 },
  ];
  const state = stateOf([user(1000), ...receipts.map((usage, index) =>
    assistant(0, 2000 + index * 1000, { usage }))]);
  assert.equal(stream.snapshot(state).turnMetrics[0].tokens, 34);
});

test('token-only snapshots reuse raw aggregation and terminal changes invalidate it', () => {
  let reads = 0;
  const earlier = assistant(3, 2000);
  Object.defineProperty(earlier, 'usage', { get() { reads++; return { output: 3 }; } });
  const tail = assistant(5, 0, { done: false });
  const state = stateOf([user(1000), earlier, tail]);
  const first = stream.snapshot(state, { messageLimit: 20 });
  const firstReads = reads;
  tail.blocks[0].text += ' more tokens';
  const second = stream.snapshot(state, { messageLimit: 20 });
  assert.equal(reads, firstReads, 'stream text does not reread historical receipts');
  assert.equal(first.turnMetrics, second.turnMetrics);
  tail.done = true; tail.completedAt = 4000;
  const third = stream.snapshot(state, { messageLimit: 20 });
  assert.deepEqual(third.turnMetrics, [{ fromMessage: 0, toMessage: 2, elapsedMs: 3000, tokens: 8 }]);
  assert.ok(reads > firstReads);
  tail.usage = { output: 7 }; state.usageRevision = 1;
  assert.equal(stream.snapshot(state, { messageLimit: 20 }).turnMetrics[0].tokens, 10);
  state.messages.push(user(5000), assistant(11, 6000));
  assert.equal(stream.snapshot(state, { messageLimit: 20 }).turnMetrics.length, 2);
  state.messages = [user(8000), assistant(13, 9000)];
  assert.equal(stream.snapshot(state, { messageLimit: 20 }).turnMetrics[0].tokens, 13);
});

test('an orphaned assistant window never fabricates a user-turn owner', () => {
  const state = stateOf([assistant(3, 2000), assistant(5, 3000)]);
  assert.deepEqual(stream.snapshot(state, { messageLimit: 1 }).turnMetrics, []);
});

test('an earlier active task paragraph completing invalidates cached unknown statistics', () => {
  const earlier = assistant(3, 0, { done: false });
  const state = stateOf([user(1000), earlier, assistant(5, 4000)]);
  assert.equal(stream.snapshot(state).turnMetrics[0].tokens, null);
  earlier.done = true; earlier.completedAt = 3000;
  assert.deepEqual(stream.snapshot(state).turnMetrics,
    [{ fromMessage: 0, toMessage: 2, elapsedMs: 3000, tokens: 8 }]);
});

test('native message-end events expose the recorded metrics without rewriting receipts', () => {
  const acc = stream.create();
  acc.push({ type: 'message_end', message: { role: 'user', content: 'question', sentAt: 1000 } });
  acc.push({ type: 'message_start' });
  acc.push({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'answer' } });
  assert.equal(acc.uiSnapshot({ messageLimit: 20 }).turnMetrics[0].tokens, null);
  const usage = { input: 100, output: 9, totalTokens: 109 };
  acc.push({ type: 'message_end', message: { role: 'assistant', usage, completedAt: 4000, stopReason: 'stop' } });
  assert.deepEqual(acc.uiSnapshot({ messageLimit: 20 }).turnMetrics,
    [{ fromMessage: 0, toMessage: 1, elapsedMs: 3000, tokens: 9 }]);
  assert.deepEqual(usage, { input: 100, output: 9, totalTokens: 109 });
  assert.equal(acc.snapshot().usageReceipts[0].usage, usage);
});
