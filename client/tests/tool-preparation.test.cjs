'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const stream = require('../main/pi-session/event-stream');
const prep = require('../main/pi-session/tool-preparation');
const runtime = require('../main/agent-runtime/runner-messages');
const live = require('../main/conversation/task-live-output');
function delta(acc, id = 'write-1', path = '网站.html', content = 'x', name = 'write') {
  acc.push({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0,
    delta: content, partial: { content: [{ type: 'toolCall', id, name, arguments: { path, content } }] } } });
}
test('native argument streaming exposes one bounded filename before any tool runs', () => {
  const acc = stream.create(); acc.push({ type: 'agent_start' });
  delta(acc, 'write-1', '网站.html', 'x'.repeat(300000));
  const snap = acc.uiSnapshot();
  assert.equal(snap.tools.length, 0); assert.equal(acc.state.tools.length, 0);
  assert.equal(snap.toolPreparations[0].args.path, '网站.html');
  assert.ok(JSON.stringify(snap).length < 4000, 'file body must not cross IPC while generating');
  for (let i = 0; i < 100; i++) delta(acc);
  assert.equal(acc.snapshot().toolPreparations.length, 1);
  acc.push({ type: 'tool_execution_start', toolCallId: 'write-1', toolName: 'write', args: { path: '网站.html', content: 'real file' } });
  assert.equal(acc.snapshot().toolPreparations.length, 0);
  assert.equal(acc.snapshot().tools[0].id, 'write-1');
  acc.push({ type: 'tool_execution_end', toolCallId: 'write-1', toolName: 'write', result: { content: [{ type: 'text', text: 'written' }] } });
  assert.equal(acc.snapshot().tools[0].state, 'done');
});
test('only explicit native file operations produce preparation; paths never inferred from prose or commands', () => {
  const acc = stream.create();
  delta(acc, 'cmd', 'fake.html', 'echo write fake.html', 'bash');
  acc.push({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'Now writing fake.html' } });
  assert.deepEqual(prep.list(acc.state), []);
});
test('parallel calls, bounded history and terminal cleanup retain accurate identities', () => {
  for (const end of ['abort', 'error', 'aborted', 'length', 'agent_settled', 'auto_retry_start']) {
    const acc = stream.create();
    for (let i = 0; i < 100; i++) acc.push({ type: 'message_end', message: { role: 'user', content: 'request ' + i } });
    delta(acc, 'a', 'a.html'); delta(acc, 'b', 'b.html');
    assert.equal(acc.uiSnapshot({ messageLimit: 2 }).toolPreparations.length, 2);
    assert.ok(acc.uiSnapshot({ messageLimit: 2 }).toolPreparations.every(row => row.after < 2));
    acc.push({ type: 'tool_execution_start', toolCallId: 'a', toolName: 'write', args: {} });
    assert.deepEqual(prep.list(acc.state).map(row => row.id), ['b']);
    if (end === 'abort') acc.abort();
    else if (['error', 'aborted', 'length'].includes(end)) acc.push({ type: 'message_end', message: { role: 'assistant', stopReason: end } });
    else acc.push({ type: end });
    assert.deepEqual(prep.list(acc.state), []);
  }
});
test('cloud preparation and execution share IDs; cancel/replay do not invent tools or history', () => {
  const acc = stream.create(), messages = runtime.create(acc.state);
  const handle = { appendTaskRuntimeEvent: item => messages.apply(item, item.text), appendTaskTool: ev => acc.push(ev) };
  const bridge = live.create(handle, 'task-id');
  const start = { seq: 1, kind: 'tool-preparing', callId: 'a', tool: 'write', phase: 'preparing', arguments: { path: 'cloud.html', content: 'not public' } };
  bridge.consume('run', [start, start]);
  assert.equal(acc.state.messages.length, 0); assert.equal(acc.state.tools.length, 0);
  const id = acc.snapshot().toolPreparations[0].id;
  assert.deepEqual(acc.snapshot().toolPreparations[0].args, { path: 'cloud.html' });
  bridge.consume('run', [{ ...start, seq: 2, kind: 'do' }]);
  assert.equal(acc.snapshot().toolPreparations.length, 0); assert.equal(acc.state.tools[0].id, id);
  bridge.consume('run', [{ ...start, seq: 3, callId: 'b' }, { ...start, seq: 4, callId: 'b', phase: 'cancelled' }]);
  assert.equal(acc.snapshot().toolPreparations.length, 0); assert.equal(acc.state.tools.length, 1);
});

test('bundled Pi SDK exposes progress before the actual filesystem write and settles once', async () => {
  const result = await require('./fixtures/native-streamed-write.cjs')(async (stage, snap, state) => {
    if (stage === 'preparing' || stage === 'chunk') {
      assert.equal(state.exists, false); assert.equal(state.writes, 0); assert.equal(snap.tools.length, 0);
      assert.equal(snap.toolPreparations.length, 1); assert.ok(JSON.stringify(snap).length < 4000);
    } else if (stage === 'executing') {
      assert.equal(state.exists, false); assert.equal(snap.toolPreparations.length, 0);
      assert.equal(snap.tools[0].id, 'streamed-file');
    } else {
      assert.equal(state.exists, true); assert.equal(state.writes, 1); assert.equal(snap.tools.length, 1);
      assert.equal(snap.tools[0].state, 'done'); assert.equal(snap.toolPreparations.length, 0);
    }
  });
  assert.deepEqual(result, { bytes: 320000, writes: 1, tools: 1 });
});

test('controlled Pi tasks remove only their own abandoned preparation on every terminal outcome', () => {
  const acc = stream.create();
  const ctx = { shared: { stream }, ref: 'fixture', piSession: { sessionId: 'fixture' }, taskBinding: { taskIds: [], taskBindings: [] },
    goal: { intent: 'chat' }, prep: { model: {} }, acc, taskExecutions: new Map(), _emit() {} };
  const handle = require('../main/pi-session/session-handle').create(ctx);
  for (const status of ['completed', 'failed', 'stopped']) {
    for (const taskId of ['first', 'second']) handle.appendTaskRuntimeEvent({ kind: 'tool-preparing',
      callId: 'task:' + taskId + ':run:call:a', tool: 'write', arguments: { path: 'file.html' } }, taskId);
    handle.taskExecutionChanged({ taskId: 'first', status });
    assert.deepEqual(prep.list(acc.state).map(row => row.id), ['task:second:run:call:a']);
    assert.equal(acc.state.tools.length, 0);
  }
});

test('Runner controlled tasks receive preparation and clear stopped tasks without native settle events', async t => {
  const { createRunnerRuntimeAdapter, getRunnerSessionDetails } = require('../main/agent-runtime/runner-adapter');
  const adapter = createRunnerRuntimeAdapter({
    modelConfig: { fetchModel: async () => ({ ok: true, model: { id: 'fixture', key: 'fixture' } }) },
    runnerRuntime: { async rpc(op) { return { ok: true, data: op === 'job.session' ? { status: 'done', items: [] } : {} }; } },
  });
  const session = await adapter.resumeSession({ native: { runner: { openOptions: { cwd: require('node:os').tmpdir(), resumePath: 'preparation' } } } });
  t.after(() => session.dispose());
  const handle = getRunnerSessionDetails(session).handle;
  await new Promise(resolve => setTimeout(resolve, 20));
  live.create(handle, 't').consume('r', [{ seq: 1, kind: 'tool-preparing', callId: 'w', tool: 'write', arguments: { path: 'cloud.html' } }]);
  assert.equal(handle.snapshot().toolPreparations.length, 1);
  assert.equal(handle.snapshot().tools.length, 0);
  handle.taskExecutionChanged({ taskId: 't', status: 'stopped' });
  assert.deepEqual(handle.snapshot().toolPreparations, []);
});

test('reopened cloud drafts retain the same message anchor and disappear on remote stop', t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-preparing-cloud-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const record = { transferId: 'p', sessionId: 'p', taskId: 't', remoteState: 'running' };
  const make = () => require('../main/conversation/cloud-conversation-view').create({ app: { getPath: () => root },
    record, ref: 'cloud-p', saved: { adapterId: 'pi', snapshot: { messages: [], pendingUser: { role: 'user', text: 'write', blocks: [] } } } });
  let handle = make();
  live.create(handle, 't').consume('run', [{ seq: 1, kind: 'say', text: 'Preparing file' },
    { seq: 2, kind: 'tool-preparing', callId: 'a', tool: 'write', arguments: { path: 'cloud.html' } }]);
  assert.equal(handle.snapshot().toolPreparations[0].after, 1);
  handle.close(); handle = make();
  assert.equal(handle.snapshot().toolPreparations[0].after, 1);
  const output = live.create(handle, 't');
  output.consume('run', [{ seq: 3, kind: 'do', callId: 'a', tool: 'write', arguments: { path: 'cloud.html' } }]);
  assert.equal(handle.snapshot().tools[0].after, 1); assert.equal(handle.snapshot().toolPreparations.length, 0);
  output.consume('run', [{ seq: 4, kind: 'tool-preparing', callId: 'b', tool: 'write', arguments: { path: 'next.html' } }]);
  record.remoteState = 'stopped';
  assert.deepEqual(handle.snapshot().toolPreparations, []);
  record.remoteState = 'running';
  assert.deepEqual(handle.snapshot().toolPreparations, []);
  output.consume('run', [{ seq: 5, kind: 'tool-preparing', callId: 'c', tool: 'write', arguments: { path: 'orphan.html' } }]);
  handle.close(); handle = make();
  handle.appendTaskMessage('user', 'next', [], 't', 'next-turn');
  assert.deepEqual(handle.snapshot().toolPreparations, []); handle.close();
});

test('a named file tool appears before its path even when content is streamed first', () => {
  const acc = stream.create();
  acc.push({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0,
    partial: { content: [{ type: 'toolCall', id: 'a', name: 'write', arguments: { content: 'partial' } }] } } });
  assert.equal(acc.snapshot().toolPreparations.length, 1);
  assert.deepEqual(acc.snapshot().toolPreparations[0].args, {});
  delta(acc, 'a', 'resolved.html');
  assert.equal(acc.snapshot().toolPreparations.length, 1);
  assert.equal(acc.snapshot().toolPreparations[0].args.path, 'resolved.html');
});
