'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const sources = require('../main/conversation/agent-source.cjs');
const stream = require('../main/pi-session/event-stream');
const history = require('../main/pi-session/history-seed');
const live = require('../main/conversation/task-live-output');
const first = { agentId: 'pi', nodeKey: 'plan', nodeName: 'Plan', runId: 'run-one' };
const second = { agentId: 'opencode', nodeKey: 'build', nodeName: 'Build', runId: 'run-one' };

function piHandle() {
  const acc = stream.create(), entries = [], messages = [];
  const ctx = { ref: 'parent', taskBinding: { taskIds: [], taskBindings: [] }, goal: {},
    shared: { stream, attachmentContract: require('../main/pi-session/attachment-contract'),
      messageTime: require('../main/conversation/message-time') },
    prep: { model: { id: 'parent-model', api: 'openai-completions', provider: 'test' } },
    piSession: { sessionId: 'parent', sessionManager: {
      appendMessage(message) { entries.push(JSON.parse(JSON.stringify({ type: 'message', message }))); }
    }, agent: { state: { messages } } }, acc, _emit() {},
  };
  return { acc, entries, messages, handle: require('../main/pi-session/session-handle').create(ctx) };
}
function roundTrip(entries, options) {
  const restored = stream.create();
  history.seed(restored, { state: {}, sessionManager: { getEntries: () => entries } }, options);
  return restored;
}
function emitAnswer(acc, sourceAgent, text) {
  const message = { role: 'assistant', ...(sourceAgent ? { sourceAgent } : {}),
    content: [{ type: 'text', text }], stopReason: 'stop' };
  acc.push({ type: 'message_start', message }); acc.push({ type: 'message_end', message });
}

test('Agent provenance accepts catalogue IDs only and strips unchecked or oversized metadata', () => {
  assert.equal(sources.normalize({ agentId: 'model-pretending-to-be-pi' }), null);
  assert.equal(sources.normalize({ agentId: 'local:pi' }), null);
  assert.equal(sources.normalize('pi'), null);
  const value = sources.normalize({ ...first, nodeKey: 'k'.repeat(500), nodeName: '\u202ePlan\n' + 'x'.repeat(300),
    runId: 'r'.repeat(500), icon: 'javascript:bad', token: 'do-not-transport' });
  assert.equal(value.nodeKey.length, 120); assert.equal(value.nodeName.length, 160);
  assert.equal(value.runId.length, 120); assert.equal(value.nodeName.startsWith('Plan'), true);
  assert.equal(value.token, undefined); assert.equal(value.icon, undefined);
  assert.deepEqual(sources.fields(undefined), {});
});

test('live node text and tools retain actual Agent through Pi persistence, replay and bounded snapshots', () => {
  const { acc, handle, entries, messages } = piHandle();
  const a = live.create(handle, '', { sourceAgent: first, coalesceText: true });
  a.consume('one', [{ seq: 1, kind: 'do', callId: 'write', tool: 'write', arguments: { path: 'plan.md', content: 'x'.repeat(12000) } },
    { seq: 2, kind: 'out', callId: 'write', tool: 'write', text: 'written' },
    { seq: 3, kind: 'say', streamId: 's', text: 'Plan ', delta: true },
    { seq: 4, kind: 'say', streamId: 's', text: 'done', delta: true, done: true }]);
  const b = live.create(handle, '', { sourceAgent: second, coalesceText: true });
  b.consume('two', [{ seq: 1, kind: 'say', streamId: 's', text: 'Build done', delta: true }]); b.finish('two');
  const before = acc.uiSnapshot({ messageLimit: 10, toolLimit: 10 });
  assert.deepEqual(before.messages.map(x => x.sourceAgent), [first, second]);
  assert.deepEqual(before.tools[0].sourceAgent, first); assert.equal(before.tools[0].detailsDeferred, true);
  assert.equal(messages[0].sourceAgent.agentId, 'pi');
  assert.deepEqual(entries.filter(e => e.message.role === 'toolResult')[0].message.sourceAgent, first);
  const after = roundTrip(entries).uiSnapshot({ messageLimit: 10, toolLimit: 10 });
  assert.deepEqual(after.messages.filter(x => x.blocks.some(b => b.kind === 'text')).map(x => x.sourceAgent), [first, second]);
  assert.deepEqual(after.tools[0].sourceAgent, first);
  assert.equal(after.tools[0].result, 'written'); assert.equal(after.tools[0].detailsDeferred, true);
  const tail = roundTrip(entries, { maxMessages: 1 }).uiSnapshot({ messageLimit: 1 });
  assert.deepEqual(tail.messages[0].sourceAgent, second);
});

test('sixth appendTaskMessage model argument remains independent of seventh Agent provenance', () => {
  const { handle, entries, acc } = piHandle();
  handle.appendTaskMessage('assistant', 'answer', [], '', 'out-1', 'actual-model', second);
  assert.equal(entries[0].message.model, 'actual-model');
  assert.deepEqual(entries[0].message.sourceAgent, second);
  assert.deepEqual(acc.snapshot().messages[0].sourceAgent, second);
  handle.appendTaskMessage('assistant', 'plain old output', [], '', 'out-2', 'old-model');
  assert.equal(acc.snapshot().messages[1].sourceAgent, undefined);
});

test('continuation merges only the same node in the same run, never across runtimes or unmarked history', () => {
  for (const next of [second, { ...first, nodeKey: 'review' }, { ...first, runId: 'run-two' }, undefined]) {
    const acc = stream.create(); emitAnswer(acc, first, 'first');
    acc.push({ type: 'message_end', message: { role: 'user',
      content: require('../main/pi-session/output-continuation').continuationPrompt(1, 'length') } });
    emitAnswer(acc, next, 'next');
    assert.equal(acc.snapshot().messages.length, 2);
  }
  const acc = stream.create(); emitAnswer(acc, first, 'first');
  acc.push({ type: 'message_end', message: { role: 'user',
    content: require('../main/pi-session/output-continuation').continuationPrompt(1, 'length') } });
  emitAnswer(acc, first, 'continued');
  assert.equal(acc.snapshot().messages.length, 1);
  assert.deepEqual(acc.snapshot().messages[0].blocks.map(x => x.text), ['first', 'continued']);
  assert.deepEqual(acc.snapshot().messages[0].sourceAgent, first);
});

test('unmarked old messages and tool results get no inferred current Agent', () => {
  const entries = [
    { role: 'assistant', model: 'pi', content: [{ type: 'toolCall', id: 'old', name: 'read', arguments: { path: 'x' } }] },
    { role: 'toolResult', toolCallId: 'old', toolName: 'read', content: [{ type: 'text', text: 'old content' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'OpenCode says this' }] },
  ].map(message => ({ type: 'message', message }));
  const snap = roundTrip(entries).snapshot();
  assert.equal(snap.tools[0].sourceAgent, undefined);
  assert.equal(snap.messages.some(m => m.sourceAgent), false);
});

test('tool preparations preserve per-node attribution before the first assistant reply', () => {
  const { acc, handle } = piHandle();
  live.create(handle, '', { sourceAgent: second }).consume('prepare', [
    { seq: 1, kind: 'tool-preparing', callId: 'write', tool: 'write', arguments: { path: 'x.js' } }
  ]);
  assert.equal(acc.snapshot().messages.length, 0);
  assert.deepEqual(acc.uiSnapshot({ messageLimit: 1 }).toolPreparations[0].sourceAgent, second);
});

test('Runner parent persists node sources in its real journal and restores them on reopen', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-agent-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const { createRunnerRuntimeAdapter, getRunnerSessionDetails } = require('../main/agent-runtime/runner-adapter');
  const adapter = createRunnerRuntimeAdapter({ app: { getPath: () => root },
    runnerRuntime: { async rpc(op) { assert.equal(op, 'runtime.detect'); return { ok: true, data: {} }; } },
    modelConfig: { fetchModel: async () => ({ ok: true, model: { id: 'parent', name: 'parent', key: '', baseUrl: '' } }) },
  });
  const request = { identity: { clientId: 'fixture' }, native: { runner: { openOptions: { ref: 'source-fixture', cwd: root } } } };
  let session = await adapter.createSession(request);
  let handle = getRunnerSessionDetails(session).handle;
  const projection = live.create(handle, '', { sourceAgent: second });
  projection.consume('child', [{ seq: 1, kind: 'say', text: 'Implementation' },
    { seq: 2, kind: 'do', callId: 'read', tool: 'read', arguments: { path: 'plan.md' } },
    { seq: 3, kind: 'out', callId: 'read', tool: 'read', text: 'Plan' }]);
  assert.deepEqual(handle.snapshot().messages[0].sourceAgent, second);
  assert.deepEqual(handle.uiSnapshot({ messageLimit: 1 }).tools[0].sourceAgent, second);
  await session.dispose();
  session = await adapter.createSession(request); t.after(() => session.dispose());
  handle = getRunnerSessionDetails(session).handle;
  assert.deepEqual(handle.snapshot().messages[0].sourceAgent, second);
  assert.deepEqual(handle.uiSnapshot({ messageLimit: 1 }).tools[0].sourceAgent, second);
  assert.equal(handle.snapshot().tools[0].result, 'Plan');
});
