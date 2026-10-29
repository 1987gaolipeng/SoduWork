'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPublisher, apply } = require('./process-projection');

const message = (id, text = 'Conversation message ' + id) => ({ id: 'message-' + id,
  role: id % 2 ? 'assistant' : 'user', blocks: [{ kind: 'text', text }] });
const emptyTarget = () => ({ revision: 0, messages: [], tools: [], data: null });

function fixture(count = 0) {
  const state = { messages: Array.from({ length: count }, (_, id) => message(id)), tools: [], status: 'idle',
    execution: { running: false, queue: [], turnQueue: { activeTaskId: '' } } };
  const sent = [], target = emptyTarget();
  let reads = 0;
  const handle = { ref: 'runtime-projection-test', sessionId: 'native-session', adapterId: 'pi',
    cwd: '/isolated/workspace', taskRef: 'task-one', taskIds: ['task-one'],
    model: { id: 'isolated-model', label: 'Isolated fixture', key: 'fixture-proxy-secret', mcpKey: 'fixture-mcp-secret' },
    snapshot() { reads++; return structuredClone(state); },
    status: () => state.status, inFlight: () => state.execution.running,
    historyRow: snapshot => ({ id: 'native-session', count: snapshot.messages.length, title: 'Preserved conversation' }),
    goalView: () => ({ intent: 'conversation' }), resumeLocation: () => '/isolated/session.jsonl' };
  const publisher = createPublisher(handle, packet => {
    // Real transports clone messages. Sharing test references would hide a
    // broken patch by allowing later runtime mutations to change the target.
    const copied = structuredClone(packet); sent.push(copied); apply(target, copied);
  });
  return { state, sent, target, handle, publisher, get reads() { return reads; },
    publish(event = { kind: 'snapshot' }, raw = {}) { return publisher.publish(event, raw); } };
}

test('platform consumers retain the complete conversation beyond the renderer history window', () => {
  const f = fixture(240);
  f.state.messages[0] = message(0, 'Original requirements and acceptance criteria must remain available.');
  f.publish();
  assert.equal(f.target.messages.length, 240);
  assert.deepEqual(f.target.messages, f.state.messages);
  assert.equal(f.target.messages[0].blocks[0].text, 'Original requirements and acceptance criteria must remain available.');
  assert.equal(f.target.data.history.count, 240);
  assert.equal(f.target.messages.at(-1).id, 'message-239');
});

test('one streaming delta transports only the changed row and retains untouched message objects', () => {
  const f = fixture(1500);
  for (const item of f.state.messages) item.blocks[0].text = 'Historical context. '.repeat(25);
  f.publish();
  const original = f.target.messages[0], fullBytes = Buffer.byteLength(JSON.stringify(f.sent[0]));
  f.state.messages[1499].blocks[0].text += 'Visible new token.';
  f.publish({ kind: 'block' });
  const patch = f.sent.at(-1), patchBytes = Buffer.byteLength(JSON.stringify(patch));
  assert.deepEqual(patch.messages.changed.map(([index]) => index), [1499]);
  assert.equal(patch.data, null, 'a token does not repeat unchanged session metadata');
  assert.equal(f.target.messages[0], original, 'unchanged projection rows retain object identity');
  assert.deepEqual(f.target.messages, f.state.messages);
  assert.ok(patchBytes < fullBytes / 100, 'token traffic must not scale with the full transcript');
  assert.ok(patchBytes < 8192, 'one short token must remain a small IPC message');
});

test('shared raw snapshots publish their body once and retain all ordered control events', () => {
  const f = fixture(120), raw = {};
  for (const kind of ['tool-start', 'tool-end', 'message-end']) f.publish({ kind }, raw);
  assert.equal(f.reads, 1, 'the same immutable burst snapshot must only be captured once');
  assert.deepEqual(f.sent.map(packet => packet.event.kind), ['tool-start', 'tool-end', 'message-end']);
  assert.equal(f.sent.reduce((count, packet) => count + packet.messages.changed.length, 0), 120);
  assert.equal(f.sent.filter(packet => packet.data !== null).length, 1);
  assert.equal(f.target.revision, 3, 'control-only publications participate in the ordered stream');
  assert.equal(f.target.messages.length, 120);
});

test('a different raw snapshot remains an observable boundary even when its transcript is unchanged', () => {
  const f = fixture(3);
  f.publish({ kind: 'started' }, {}); f.publish({ kind: 'stopped' }, {});
  assert.equal(f.reads, 2);
  assert.equal(f.sent.length, 2);
  assert.deepEqual(f.sent[1].messages.changed, []);
  assert.deepEqual(f.sent[1].tools.changed, []);
  assert.equal(f.sent[1].data, null);
  assert.equal(f.sent[1].event.kind, 'stopped');
});

test('appends, middle deletions and clearing history do not leave stale or missing messages', () => {
  const f = fixture(125); f.publish();
  f.state.messages.push(message(125, 'Final answer.')); f.publish({ kind: 'message-end' });
  assert.deepEqual(f.target.messages, f.state.messages);
  f.state.messages.splice(37, 3); f.publish();
  assert.deepEqual(f.target.messages, f.state.messages);
  assert.equal(f.target.messages[37].id, 'message-40');
  f.state.messages = []; f.publish();
  assert.deepEqual(f.target.messages, []);
  assert.equal(f.target.data.history.count, 0);
});

test('tool removal and reordering retain the true surviving execution receipts', () => {
  const f = fixture(2);
  f.state.tools = ['a', 'b', 'c'].map(id => ({ id, name: 'read', state: 'done', after: 1,
    args: { path: id + '.md' }, result: 'Receipt ' + id }));
  f.publish();
  f.state.tools = [f.state.tools[2], f.state.tools[0]]; f.publish();
  assert.deepEqual(f.target.tools.map(tool => [tool.id, tool.result]), [['c', 'Receipt c'], ['a', 'Receipt a']]);
  f.state.tools = []; f.publish(); assert.deepEqual(f.target.tools, []);
});

test('large tool source and result bodies stay deferred while file identity and raw receipts remain intact', () => {
  const f = fixture(2), source = 'UNABRIDGED_SOURCE_MARKER\n' + 'const value = 123;\n'.repeat(100000);
  const result = 'UNABRIDGED_RESULT_MARKER\n' + 'Large successful tool output.\n'.repeat(50000) + 'Confirmed ending.';
  f.state.tools = [{ id: 'large-write', name: 'write', state: 'done', after: 1,
    args: { content: source, path: '完整成果/report.js' }, result }];
  f.publish({ kind: 'tool-end' });
  const projected = f.target.tools[0], wire = JSON.stringify(f.sent[0]);
  assert.equal(projected.args.path, '完整成果/report.js');
  assert.equal(projected.detailsDeferred, true);
  assert.ok(projected.detailVersion, 'a consumer can identify the exact deferred receipt revision');
  assert.ok(projected.result.endsWith('Confirmed ending.'));
  assert.ok(Buffer.byteLength(wire) < 40000, 'multi-megabyte tool bodies cannot enter routine IPC snapshots');
  assert.ok(!wire.includes('UNABRIDGED_SOURCE_MARKER'));
  assert.ok(!wire.includes('UNABRIDGED_RESULT_MARKER'));
  assert.equal(f.state.tools[0].args.content, source);
  assert.equal(f.state.tools[0].result, result);
});

test('tool completion updates invalidate a deferred detail version without resending conversation history', () => {
  const f = fixture(100);
  f.state.tools = [{ id: 'long-running', name: 'read', state: 'running', args: { path: 'large.md' }, result: 'A'.repeat(32000) }];
  f.publish(); const version = f.target.tools[0].detailVersion;
  f.state.tools[0].state = 'done'; f.state.tools[0].result = 'B'.repeat(32000);
  f.publish({ kind: 'tool-end' });
  assert.equal(f.target.tools[0].state, 'done');
  assert.notEqual(f.target.tools[0].detailVersion, version);
  assert.deepEqual(f.sent.at(-1).messages.changed, []);
  assert.equal(f.sent.at(-1).tools.changed.length, 1);
  assert.ok(f.target.tools[0].result.endsWith('B'.repeat(100)));
});

test('model credential fields do not enter the projection or mutate the runtime model', () => {
  const f = fixture(1); f.publish();
  const wire = JSON.stringify(f.sent[0]);
  assert.ok(!wire.includes('fixture-proxy-secret'));
  assert.ok(!wire.includes('fixture-mcp-secret'));
  assert.equal(f.target.data.model.id, 'isolated-model');
  assert.equal(f.handle.model.key, 'fixture-proxy-secret');
  assert.equal(f.handle.model.mcpKey, 'fixture-mcp-secret');
});

test('duplicate, missing and invalid revisions are rejected before altering any accepted state', () => {
  const f = fixture(4); f.publish();
  const before = structuredClone(f.target);
  for (const revision of [0, 1, 3, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    const bad = { ...structuredClone(f.sent[0]), revision };
    assert.throws(() => apply(f.target, bad), error => error.code === 'RUNTIME_EVENT_GAP');
    assert.deepEqual(f.target, before);
  }
  f.state.messages.push(message(4)); f.publish();
  assert.equal(f.target.revision, 2); assert.equal(f.target.messages.length, 5);
});

test('a malformed later collection cannot partially alter the accepted projection', () => {
  const f = fixture(3); f.publish(); const before = structuredClone(f.target);
  const bad = { ref: f.handle.ref, revision: 2, data: null,
    messages: { length: 1, changed: [[0, message(999, 'Unaccepted replacement')]] },
    tools: { length: 1, changed: [[1, { id: 'out-of-range' }]] }, event: null };
  assert.throws(() => apply(f.target, bad));
  assert.deepEqual(f.target, before, 'packet validation must complete before any transcript collection changes');
  f.state.messages.push(message(3)); f.publish();
  assert.deepEqual(f.target.messages, f.state.messages, 'the next valid revision remains applicable after rejection');
});
