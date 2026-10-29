'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { apply } = require('../main/conversation/task-output-batch.cjs');

test('an invalid output batch cannot execute an earlier valid operation or a session control', async () => {
  const calls = [], handle = { appendTaskMessage: (...args) => calls.push(args) };
  for (const operations of [null, [{ method: 'close', args: [] }],
    [{ method: 'appendTaskTool', args: Array(8) }], [{ method: 'appendTaskRuntimeEvent', args: Array(8) }],
    [{ method: 'appendTaskMessage', args: Array(9) }],
    [{ method: 'appendTaskMessage', args: ['assistant', 'valid'] }, { method: 'submit', args: [] }]]) {
    await assert.rejects(apply(handle, operations), /Invalid task output batch/);
  }
  assert.deepEqual(calls, []);
});

test('batch acknowledgement waits for each real output mutation in its original order', async () => {
  const calls = []; let release, acknowledged = false;
  const handle = {
    async appendTaskMessage(text) { calls.push(text); await new Promise(resolve => { release = resolve; }); },
    appendTaskTool(tool) { calls.push(tool); },
  };
  const done = apply(handle, [{ method: 'appendTaskMessage', args: ['first'] },
    { method: 'appendTaskTool', args: ['second'] }]).then(value => { acknowledged = true; return value; });
  await Promise.resolve(); assert.equal(acknowledged, false); assert.deepEqual(calls, ['first']);
  release(); assert.deepEqual(await done, { ok: true }); assert.deepEqual(calls, ['first', 'second']);
});
