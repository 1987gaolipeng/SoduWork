'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const native = require('../main/conversation/native-agent-source.cjs');
const stream = require('../main/pi-session/event-stream');
const history = require('../main/pi-session/history-seed');
const child = { agentId: 'qwen', nodeKey: 'review', runId: 'flow-1' };
const assistant = text => ({ role: 'assistant', content: [{ type: 'text', text }] });

test('native Pi attribution survives live text/tools, archive writes and process-style reread', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-native-source-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl');
  const manager = { appendMessage(message, marker) {
    assert.equal(this, manager); assert.equal(marker, 'passed-through');
    fs.appendFileSync(file, JSON.stringify({ type: 'message', message }) + '\n'); return 'receipt';
  } };
  native.install(manager, 'pi'); const originalWrapper = manager.appendMessage;
  native.install(manager, 'pi'); assert.equal(manager.appendMessage, originalWrapper);
  const message = assistant('ordinary reply'), acc = stream.create();
  acc.push(native.event({ type: 'message_start', message }, 'pi'));
  acc.push(native.event({ type: 'message_update', assistantMessageEvent:
    { type: 'text_delta', contentIndex: 0, delta: 'ordinary reply' } }, 'pi'));
  assert.deepEqual(acc.snapshot().messages[0].sourceAgent, { agentId: 'pi' });
  acc.push(native.event({ type: 'tool_execution_start', toolCallId: 'read', toolName: 'read', args: { path: 'x.md' } }, 'pi'));
  assert.deepEqual(acc.snapshot().tools[0].sourceAgent, { agentId: 'pi' });
  assert.equal(manager.appendMessage(message, 'passed-through'), 'receipt');
  assert.equal(message.sourceAgent, undefined, 'native SDK input need not be mutable');
  manager.appendMessage({ ...assistant('workflow reply'), sourceAgent: child, taskOutputKey: 'child-1' }, 'passed-through');
  manager.appendMessage({ ...assistant('unknown imported task'), taskOutputKey: 'old-1' }, 'passed-through');
  const entries = fs.readFileSync(file, 'utf8').trim().split('\n').map(row => JSON.parse(row));
  assert.deepEqual(entries[0].message.sourceAgent, { agentId: 'pi' });
  assert.deepEqual(entries[1].message.sourceAgent, child);
  assert.equal(entries[2].message.sourceAgent, undefined);
  const resumed = stream.create();
  history.seed(resumed, { sessionManager: { getEntries: () => entries }, state: {} }, { nativeAgentId: 'pi' });
  assert.deepEqual(resumed.snapshot().messages.map(m => m.sourceAgent), [{ agentId: 'pi' }, child, undefined]);
});

test('known Pi native archive ownership enriches legacy output without guessing imported child sources', () => {
  const entries = [
    { role: 'user', content: 'request' },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'read', name: 'read', arguments: { path: 'x' } }] },
    { role: 'toolResult', toolCallId: 'read', toolName: 'read', content: [{ type: 'text', text: 'data' }] },
    assistant('legacy native reply'),
    { ...assistant('legacy remote task'), taskId: 'task-a' },
    { ...assistant('legacy task without id'), model: 'task-executor' },
    { ...assistant('actual child reply'), sourceAgent: child },
  ].map(message => ({ type: 'message', message }));
  const acc = stream.create(); history.seed(acc, { state: {}, sessionManager: { getEntries: () => entries } }, { nativeAgentId: 'pi' });
  const snap = acc.snapshot();
  assert.equal(snap.messages[0].sourceAgent, undefined);
  assert.deepEqual(snap.tools[0].sourceAgent, { agentId: 'pi' });
  const actual = snap.messages.filter(m => m.blocks.some(b => b.kind === 'text'));
  assert.deepEqual(actual.map(m => m.sourceAgent), [{ agentId: 'pi' }, undefined, undefined, child]);
  assert.equal(entries[3].message.sourceAgent, undefined, 'legacy archive is not rewritten during read');
});

test('native snapshot fallback keeps per-node sources and never reattributes task output to its parent', () => {
  const existing = { role: 'assistant', sourceAgent: child, blocks: [] };
  const snap = native.snapshot({ messages: [{ role: 'user', text: 'hi' }, { role: 'assistant', blocks: [] }, existing,
    { role: 'assistant', taskId: 'imported', blocks: [] }], tools: [
    { id: 'own-read' }, { id: 'task:child:read' }, { id: 'foreign', sourceAgent: child }],
    toolPreparations: [{ id: 'own-write' }] }, 'opencode');
  assert.equal(snap.messages[0].sourceAgent, undefined);
  assert.deepEqual(snap.messages[1].sourceAgent, { agentId: 'opencode' });
  assert.equal(snap.messages[2], existing); assert.equal(snap.messages[3].sourceAgent, undefined);
  assert.deepEqual(snap.tools.map(t => t.sourceAgent), [{ agentId: 'opencode' }, undefined, child]);
  assert.deepEqual(snap.toolPreparations[0].sourceAgent, { agentId: 'opencode' });
});

test('archive wrapper preserves write errors and never labels user input', () => {
  const error = new Error('disk full'); let saved;
  const manager = { appendMessage(value) { saved = value; if (value.role === 'assistant') throw error; } };
  native.install(manager, 'pi');
  const user = { role: 'user', content: 'message' }; manager.appendMessage(user);
  assert.equal(saved, user); assert.equal(saved.sourceAgent, undefined);
  assert.throws(() => manager.appendMessage(assistant('answer')), value => value === error);
});

test('projection whitelists existing metadata and does not replace an invalid claim with the parent', () => {
  const invalid = { role: 'assistant', sourceAgent: { agentId: 'unknown-runtime' }, blocks: [] };
  const extra = { role: 'assistant', sourceAgent: { ...child, token: 'private', icon: 'bad-uri' }, blocks: [] };
  const snap = native.snapshot({ messages: [invalid, extra], tools: [] }, 'pi');
  assert.equal(snap.messages[0].sourceAgent, undefined);
  assert.deepEqual(snap.messages[1].sourceAgent, child);
  assert.equal(invalid.sourceAgent.agentId, 'unknown-runtime', 'projection must not edit archived input');
});
