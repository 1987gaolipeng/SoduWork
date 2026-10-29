'use strict';

/*
 * Invalidate unanswered previous-turn UI requests at agent_start so completed
 * conversations do not remain waiting-user and block the queue.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const stream = require('../main/pi-session/event-stream');
const { createTurnQueue } = require('../main/pi-session/turn-queue');
const { resultState } = require('../main/pi-session/task-turn');

function startedAcc() {
  const acc = stream.create();
  acc.push({ type: 'agent_start' });
  return acc;
}

test('an unanswered ui request from an older turn no longer marks new turns as waiting', () => {
  const acc = startedAcc();
  acc.push({ type: 'extension_ui_request', method: 'confirm', id: 'ui-1', params: {} });
  assert.equal(acc.status(), 'waiting-user');
  acc.answerUi();
  assert.equal(acc.status(), 'streaming');

  /* Start a new user turn while a prior UI request remains unanswered. */
  const stale = startedAcc();
  stale.push({ type: 'extension_ui_request', method: 'confirm', id: 'ui-1' });
  assert.equal(stale.status(), 'waiting-user');
  stale.push({ type: 'agent_start' });
  assert.notEqual(stale.status(), 'waiting-user');

  /* A new UI request in the current turn must still suspend execution. */
  const live = startedAcc();
  live.push({ type: 'extension_ui_request', method: 'select', id: 'ui-2' });
  assert.equal(live.status(), 'waiting-user');
});

test('a completed turn with a stale pendingUi must not pause the send queue', () => {
  const queue = createTurnQueue();
  const acc = startedAcc();
  acc.push({ type: 'extension_ui_request', method: 'confirm', id: 'ui-old' });

  const item = queue.add({ text: '继续', options: {} });
  const result = queue.run(item, async () => {
    acc.push({ type: 'agent_start' });                 // Invalidate the previous turn's UI request.
    acc.push({ type: 'message_start', message: { role: 'assistant' } });
    acc.push({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '回答完毕', contentIndex: 0 } });
    acc.push({ type: 'message_end', message: { role: 'assistant', stopReason: 'end_turn' } });
    acc.push({ type: 'agent_settled' });
    return { ok: true, snapshot: acc.snapshot() };
  });

  return result.then(() => {
    assert.equal(resultState({ ok: true, snapshot: acc.snapshot() }), 'completed');
    assert.equal(queue.state().paused, false);
    assert.equal(queue.state().reason, '');
  });
});
