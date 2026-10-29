'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { create } = require('../main/pi-session/ui-window');
const stream = require('../main/pi-session/event-stream');

function fixture() {
  const acc = stream.create();
  for (let i = 0; i < 220; i++) acc.push({ type: 'message_end', message: {
    role: 'user', content: [{ type: 'text', text: 'message-' + i }],
  } });
  acc.state.auditHidden = Array.from({ length: 20 }, (_, i) => i + 80);
  acc.state.tools = [{ id: 'older', after: 100, state: 'running', name: 'fixture' }];
  const win = { isDestroyed: () => false };
  const handle = { attachedWindow: win, detached: false, uiSnapshot: acc.uiSnapshot };
  return { acc, handle, win, windows: create() };
}

test('expanded runtime publications preserve filtered history and current older tool states without merging', () => {
  const { acc, handle, win, windows } = fixture();
  windows.request(handle, win, { messageLimit: 160 });
  const before = windows.snapshot(handle);
  assert.equal(before.history.messageStart, 60);
  assert.equal(before.messages.length, 140);
  assert.equal(before.tools[0].state, 'running');
  acc.state.tools[0] = { ...acc.state.tools[0], state: 'done', result: 'finished' };
  const after = windows.snapshot(handle);
  assert.equal(after.messages.length, 140);
  assert.equal(new Set(after.messages.map(row => row.text)).size, 140);
  assert.equal(after.tools[0].state, 'done');
  assert.equal(after.tools[0].result, 'finished');
  assert.equal(after.history.messageLimit, 160);
  assert.equal(after.history.messageIndices[20], 100);
});

test('window preferences are bounded, grow monotonically, and are isolated from other or closed windows', () => {
  const { handle, win, windows } = fixture();
  assert.equal(windows.request(handle, {}, { messageLimit: 2000 }), false);
  assert.equal(windows.snapshot(handle).history.messageStart, 140);
  windows.request(handle, win, { messageLimit: 160 });
  windows.request(handle, win, { messageLimit: 80 });
  assert.equal(windows.snapshot(handle).history.messageLimit, 160);
  windows.request(handle, win, { messageLimit: 90000, toolLimit: 90000 });
  assert.equal(windows.snapshot(handle).history.messageLimit, 2000);
  handle.attachedWindow = { isDestroyed: () => false };
  assert.equal(windows.snapshot(handle).history.messageLimit, 80);
  handle.attachedWindow = win; windows.reset(handle);
  assert.equal(windows.snapshot(handle).history.messageLimit, 80);
});

test('projection bookmarks identify the original message across hidden rows and merged continuations', () => {
  const { acc } = fixture();
  acc.state.messages[100] = { ...acc.state.messages[100], role: 'assistant', done: true,
    blocks: [{ index: 0, kind: 'text', text: 'assistant-100', done: true }] };
  acc.state.messages[101] = { ...acc.state.messages[101], role: 'assistant', continuation: true, done: true,
    blocks: [{ index: 0, kind: 'text', text: 'assistant-101', done: true }] };
  const snap = acc.uiSnapshot({ messageLimit: 160 });
  assert.equal(snap.messages.length, 139);
  assert.equal(snap.history.messageIndices.length, snap.messages.length);
  assert.equal(snap.history.messageIndices[20], 100);
  assert.equal(snap.history.messageIndices[21], 102);
});
