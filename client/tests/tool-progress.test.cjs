'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const progress = require('../main/pi-session/tool-progress');
function step(state, id, args, text = 'result', extra = {}) {
  progress.observe(state, { type: 'tool_execution_start', toolCallId: id, toolName: 'read', args });
  progress.observe(state, { type: 'tool_execution_end', toolCallId: id, result: { content: [{ type: 'text', text }] }, ...extra });
}
test('reordered argument keys cannot hide exact repeated results', () => {
  const state = progress.create();
  step(state, 'first', { path: 'a', offset: 1 });
  for (let i = 0; i < progress.MAX_NO_PROGRESS; i++) step(state, String(i), { offset: 1, path: 'a' });
  assert.equal(progress.blocked(state), true);
});
test('genuine new output resets no-progress while unconfirmed empty or failed calls do not', () => {
  const state = progress.create();
  for (let i = 0; i < 15; i++) step(state, String(i), { path: String(i) }, '', i % 2 === 0 ? { isError: true } : {});
  assert.equal(state.noProgress, 15);
  step(state, 'changed', { path: 'a' }, 'new file contents');
  assert.equal(state.noProgress, 0);
  step(state, 'changed-again', { path: 'a' }, 'updated file contents');
  assert.equal(state.noProgress, 0);
});
test('late duplicate ends cannot count twice and fingerprints retain no payloads', () => {
  const state = progress.create();
  const end = { type: 'tool_execution_end', toolCallId: 'a', isError: true };
  progress.observe(state, { type: 'tool_execution_start', toolCallId: 'a', toolName: 'read', args: { path: 'secret' } });
  progress.observe(state, end); progress.observe(state, end);
  assert.equal(state.noProgress, 1);
  assert.equal(state.pending.size, 0);
  for (let i = 0; i < 300; i++) step(state, String(i), { path: 'private-' + i });
  assert.ok(state.recent.size <= 64);
  assert.ok([...state.recent].every(hash => /^[a-f0-9]{64}$/.test(hash)));
});
