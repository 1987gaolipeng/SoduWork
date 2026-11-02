'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { withTaskAccessDefault } = require('../main/pi-session/task-access');

test('new task conversations use standard access on each supported runtime', () => {
  for (const adapterId of ['pi', 'opencode', 'codex-harness', 'qwen', 'codex', 'dsh']) {
    const source = { taskRef: 'new-task', taskSession: true, adapterId };
    assert.equal(withTaskAccessDefault(source).accessMode, 'standard', adapterId);
    assert.equal(source.accessMode, undefined);
  }
});

test('history, ordinary callers and explicit policies retain their existing semantics', () => {
  for (const source of [
    { taskRef: 't', taskSession: true, chatId: 'history' }, {},
    ...['readonly','full','standard'].map(accessMode=>({taskRef:'t',taskSession:true,accessMode})),
    ...['unknown-runtime'].map(adapterId=>({taskRef:'t',taskSession:true,adapterId})),
  ]) assert.equal(withTaskAccessDefault(source), source);
});
