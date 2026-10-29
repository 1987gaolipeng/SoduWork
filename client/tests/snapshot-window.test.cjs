const test = require('node:test');
const assert = require('node:assert/strict');
const { limitSnapshot } = require('../main/pi-session/snapshot-window');

test('UI projection omits the full accounting archive while preserving runtime receipts', () => {
  const source = { messages: [], tools: [], usageReceipts: Array.from({ length: 10000 }, () => ({ usage: { input: 1 } })) };
  const view = limitSnapshot(source);
  assert.equal(Object.hasOwn(view, 'usageReceipts'), false);
  assert.equal(source.usageReceipts.length, 10000);
});

test('limitSnapshot keeps the tail and remaps tool positions', () => {
  const source = {
    status: 'idle',
    messages: Array.from({ length: 120 }, (_, index) => ({ role: 'user', text: String(index) })),
    tools: Array.from({ length: 120 }, (_, index) => ({ id: 't' + index, after: index, state: 'done' })),
  };
  const result = limitSnapshot(source, { messageLimit: 20, toolLimit: 40 });
  assert.equal(result.messages.length, 20);
  assert.equal(result.messages[0].text, '100');
  assert.equal(result.tools.length, 20);
  assert.equal(result.tools[0].after, 0);
  assert.equal(result.tools.at(-1).after, 19);
  assert.deepEqual(result.history, {
    truncated: true,
    totalMessages: 120,
    totalTools: 120,
    loadedMessages: 20,
    loadedTools: 20,
    messageStart: 100,
    messageLimit: 20, messageIndices: Array.from({ length: 20 }, (_, index) => 100 + index),
  });
});

test('limitSnapshot preserves running tools even when they are older than the message window', () => {
  const result = limitSnapshot({
    messages: Array.from({ length: 100 }, () => ({ role: 'assistant', blocks: [] })),
    tools: [{ id: 'running', after: 2, state: 'running' }, { id: 'done', after: 99, state: 'done' }],
  }, { messageLimit: 10, toolLimit: 10 });
  assert.deepEqual(result.tools.map((tool) => [tool.id, tool.after]), [['running', 0], ['done', 9]]);
});

test('event stream UI snapshots project only the recent tail while full state stays intact', () => {
  const stream = require('../main/pi-session/event-stream');
  const acc = stream.create();
  for (let index = 0; index < 1000; index += 1) {
    acc.push({ type: 'message_end', message: {
      role: 'user', content: [{ type: 'text', text: 'message-' + index }],
    }});
  }
  const ui = acc.uiSnapshot({ messageLimit: 40, toolLimit: 80 });
  assert.equal(ui.messages.length, 40);
  assert.match(JSON.stringify(ui), /message-999/);
  assert.doesNotMatch(JSON.stringify(ui), /message-0/);
  assert.equal(ui.history.totalMessages, 1000);
  assert.equal(acc.snapshot().messages.length, 1000);
});

const stream = require('../main/pi-session/event-stream');
const projectors = {
  native: (state, options) => stream.snapshot(state, options),
  external: (state, options) => limitSnapshot(state, options),
};

function windowState() {
  const state = stream._blank();
  state.messages = Array.from({ length: 100 }, (_, index) => ({ role: 'user',
    text: 'message-' + index, blocks: [], done: true }));
  return state;
}

for (const [name, project] of Object.entries(projectors)) {
  test(name + ' does not duplicate old running tools or overflow a saturated running budget', () => {
    const state = windowState();
    state.tools = [{ id: 'old', after: 2, state: 'running' },
      { id: 'done', after: 99, state: 'done' }];
    assert.deepEqual(project(state, { messageLimit: 10, toolLimit: 4 }).tools.map(tool => tool.id), ['old', 'done']);
    assert.deepEqual(project(state, { messageLimit: 10, toolLimit: 1 }).tools.map(tool => tool.id), ['old']);
  });

  test(name + ' tool window retains running calls once, prioritizes them, and obeys a full budget', () => {
    const state = windowState();
    state.tools = [
      { id: 'old-running', after: 2, state: 'running' },
      { id: 'current-running', after: 98, state: 'running' },
      { id: 'done-a', after: 99, state: 'done' },
      { id: 'done-b', after: 99, state: 'done' },
      { id: 'done-c', after: 99, state: 'done' },
    ];
    const result = project(state, { messageLimit: 10, toolLimit: 3 });
    assert.deepEqual(result.tools.map(tool => tool.id), ['old-running', 'current-running', 'done-c']);
    assert.equal(result.tools[0].after, 0, 'old running call stays before the visible history');
    assert.equal(result.tools[1].after, 8);
    assert.equal(state.tools.length, 5, 'the native transcript remains complete');
    assert.deepEqual(project(state, { messageLimit: 10, toolLimit: 1 }).tools.map(tool => tool.id),
      ['current-running'], 'a saturated running budget cannot append the whole completed tail');
  });

  test(name + ' projects only the retained tool receipts in a long single turn', () => {
    const state = windowState();
    let receiptReads = 0;
    state.tools = Array.from({ length: 2000 }, (_, index) => ({ id: 'call-' + index,
      after: 99, state: 'done', get args() { receiptReads++; return { path: 'file-' + index }; } }));
    const result = project(state, { messageLimit: 10, toolLimit: 8 });
    assert.deepEqual(result.tools.map(tool => tool.id),
      ['call-1992', 'call-1993', 'call-1994', 'call-1995', 'call-1996', 'call-1997', 'call-1998', 'call-1999']);
    assert.ok(receiptReads < 100, 'off-window receipts must not be projected: ' + receiptReads);
  });
}

test('native UI projection never visits messages outside its requested tail', () => {
  const state = windowState();
  let reads = 0;
  state.messages = new Proxy(state.messages, { get(target, key, receiver) {
    if (/^\d+$/.test(String(key))) reads++;
    return Reflect.get(target, key, receiver);
  } });
  const result = stream.snapshot(state, { messageLimit: 10, toolLimit: 8 });
  assert.equal(result.messages.length, 10);
  assert.deepEqual(result.history.messageIndices, [90, 91, 92, 93, 94, 95, 96, 97, 98, 99]);
  assert.ok(reads <= 25, 'history traversal should be bounded by the requested tail: ' + reads);
});
