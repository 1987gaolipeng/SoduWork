'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const live = require('../main/conversation/task-live-output');
const stream = require('../main/pi-session/event-stream');

for (const identified of [false, true]) {
  test(`retrying a failed ${identified ? 'mixed-version' : 'legacy'} result keeps its original tool`, () => {
    const acc = stream.create();
    let fail = true;
    const output = live.create({
      appendTaskTool(event) {
        if (event.type === 'tool_execution_end' && fail) throw Error('journal unavailable');
        acc.push(event);
      },
    }, 'task');
    output.consume('node', [{ seq: 1, kind: 'do', tool: 'bash' }]);
    const result = { seq: 2, kind: 'out', tool: 'bash', text: 'completed', ...(identified ? { callId: 'provider-id' } : {}) };
    assert.throws(() => output.consume('node', [result]), /journal unavailable/);
    assert.equal(acc.snapshot().tools[0].state, 'running');
    fail = false;
    output.consume('node', [result]);
    output.consume('node', [result]);
    const tools = acc.snapshot().tools;
    assert.equal(tools.length, 1);
    assert.equal(tools[0].id, 'task:task:node:1');
    assert.equal(tools[0].state, 'done');
    assert.equal(tools[0].result, 'completed');
  });
}

test('a failed result does not consume the next concurrent legacy tool', () => {
  const events = [];
  let fail = true;
  const output = live.create({ appendTaskTool(event) {
    if (event.type === 'tool_execution_end' && fail) throw Error('journal unavailable');
    events.push(event);
  } }, 'task');
  output.consume('node', [{ seq: 1, kind: 'do', tool: 'bash' }, { seq: 2, kind: 'do', tool: 'bash' }]);
  const first = { seq: 3, kind: 'out', tool: 'bash', text: 'first' };
  assert.throws(() => output.consume('node', [first]), /journal unavailable/);
  fail = false;
  output.consume('node', [first, { seq: 4, kind: 'out', tool: 'bash', text: 'second' }]);
  assert.deepEqual(events.filter(event => event.type === 'tool_execution_end').map(event => event.toolCallId),
    ['task:task:node:1', 'task:task:node:2']);
});
