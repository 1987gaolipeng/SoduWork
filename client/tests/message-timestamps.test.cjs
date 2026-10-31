'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const times = require('../main/conversation/message-time');
const stream = require('../main/pi-session/event-stream');
const pi = require('../main/pi-session/session');
const { createRunnerRuntimeAdapter, getRunnerSessionDetails } = require('../main/agent-runtime/runner-adapter');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let n = 0; n < 300; n++) { if (check()) return; await delay(10); } throw Error('Timed out'); }
const start = Date.parse('2026-09-01T12:00:00Z'), end = start + 31000;
test('Pi user sent time and assistant end time are distinct and visible in cached snapshots', t => {
  t.mock.method(Date, 'now', () => end);
  const acc = stream.create();
  const user = { role: 'user', timestamp: start + 1000, content: 'question' };
  times.stampPiEvent({ type: 'message_end', message: user }, start);
  acc.push({ type: 'message_end', message: user });
  acc.push({ type: 'message_start', message: { role: 'assistant', timestamp: start + 1000 } });
  acc.push({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'answer' } });
  assert.equal(acc.snapshot().messages.at(-1).completedAt, 0);
  const assistant = { role: 'assistant', timestamp: start + 1000 };
  acc.push({ type: 'message_end', message: assistant });
  assert.equal(assistant.completedAt, end, 'the same SDK message is ready for persistence');
  assert.equal(acc.snapshot().messages[0].sentAt, start);
  assert.equal(acc.snapshot().messages[1].completedAt, end);
  assert.equal(acc.snapshot().messages[1].completedAt, end, 'cached projection retains timing');
});
test('Pi user echo preserves the active submission identity for optimistic rendering', () => {
  const acc = stream.create();
  const user = { role: 'user', timestamp: start, content: 'question' };
  times.stampPiEvent({ type: 'message_end', message: user }, start, 'ui-submission-1');
  acc.push({ type: 'message_end', message: user });
  assert.equal(acc.snapshot().messages[0].submissionId, 'ui-submission-1');
});
test('Pi replay uses append-entry time and never fills unknown old history from reopen time', t => {
  t.mock.method(Date, 'now', () => end + 86400000);
  const entries = [
    { type: 'message', timestamp: new Date(start + 500).toISOString(), message: { role: 'user', timestamp: start, content: 'question' } },
    { type: 'message', timestamp: new Date(end).toISOString(), message: { role: 'assistant', timestamp: start + 1000, content: [{ type: 'text', text: 'answer' }] } },
    { type: 'message', message: { role: 'assistant', timestamp: start + 2000, content: [{ type: 'text', text: 'unknown old completion' }] } },
    { type: 'message', timestamp: new Date(end + 2000).toISOString(), message: { role: 'assistant', completedAt: end + 1000, timestamp: start, content: [{ type: 'text', text: 'explicit completion' }] } }
  ];
  const acc = stream.create();
  pi._seed(acc, { state: { messages: [] }, sessionManager: { getEntries: () => entries } });
  assert.equal(acc.snapshot().messages[0].sentAt, start);
  assert.equal(acc.snapshot().messages[1].completedAt, end);
  assert.equal(acc.snapshot().messages[2].completedAt, 0);
  assert.equal(acc.snapshot().messages[3].completedAt, end + 1000);
  assert.equal(entries[1].message.completedAt, undefined, 'replay never rewrites the old archive');
});
test('actual Pi SDK persists the observed message-end timestamp and reopens it unchanged', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-message-clock-'));
  const fixture = await require('../e2e/fixtures/access-sdk.cjs').create(root, 'standard', () => {}, { persist: true, reply: () => null });
  t.after(async () => { await fixture.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const acc = stream.create();
  fixture.session.subscribe(event => { times.stampPiEvent(event, start); acc.push(event); });
  await fixture.session.prompt('A fixture answer');
  const original = acc.snapshot().messages;
  assert.equal(original[0].sentAt, start);
  assert.ok(original[1].completedAt > start);
  const file = fixture.session.sessionManager.getSessionFile();
  const entries = fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  // SDK 1.4 also persists system/tool declarations as message entries.
  const stored = entries.filter(entry => entry.type === 'message' &&
    ['user', 'assistant'].includes(entry.message?.role));
  assert.equal(stored[0].message.sentAt, start);
  assert.equal(stored[1].message.completedAt, original[1].completedAt);
  const manager = fixture.sdk.SessionManager.open(file);
  const restored = stream.create();
  pi._seed(restored, { state: { messages: [] }, sessionManager: manager });
  assert.deepEqual(restored.snapshot().messages.map(m => [m.sentAt, m.completedAt]),
    original.map(m => [m.sentAt, m.completedAt]));
});
test('Runner echo, native output and controlled output journal preserve message times across reopen', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-runner-clock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let items = [], nextSeq = 0, sent;
  const runnerRuntime = { async rpc(op, payload) {
    if (op === 'job.comment') {
      sent = payload.sentAt;
      items.push({ seq: ++nextSeq, kind: 'user', text: payload.text, sentAt: sent, at: new Date(start + 5000).toISOString() },
        { seq: ++nextSeq, kind: 'say', text: 'native answer', at: new Date(end).toISOString() });
    }
    if (op === 'job.session') return { ok: true, data: { status: 'done', items, seq: nextSeq } };
    return { ok: true, data: { ok: true } };
  } };
  const adapter = createRunnerRuntimeAdapter({ app: { getPath: () => root }, runnerRuntime,
    modelConfig: { fetchModel: async () => ({ ok: true, model: { id: 'fixture', key: 'fixture' } }) } });
  const request = { native: { runner: { openOptions: { cwd: root, resumePath: 'clock-runner' } } } };
  const session = await adapter.resumeSession(request);
  t.after(() => session.dispose());
  const handle = getRunnerSessionDetails(session).handle;
  await until(() => handle.snapshot().status === 'idle');
  await session.send({ text: 'question', options: { sentAt: start } }).completion;
  assert.equal(sent, start);
  assert.equal(handle.snapshot().messages[0].sentAt, start);
  assert.equal(handle.snapshot().messages[1].completedAt, end);
  handle.appendTaskMessage('assistant', 'controlled result', [], '', 'controlled-1');
  const controlled = handle.snapshot().messages.at(-1).completedAt;
  assert.ok(controlled >= end);
  await session.dispose();
  const restored = await adapter.resumeSession(request);
  t.after(() => restored.dispose());
  const reopened = getRunnerSessionDetails(restored).handle;
  await until(() => reopened.snapshot().messages.length === 3);
  assert.equal(reopened.snapshot().messages[0].sentAt, start);
  assert.equal(reopened.snapshot().messages[1].completedAt, end);
  assert.equal(reopened.snapshot().messages[2].completedAt, controlled);
});
test('unknown Runner history and partial thoughts never invent a current completion time', () => {
  const helper = require('../main/agent-runtime/runner-messages');
  const state = { messages: [] }, messages = helper.create(state);
  messages.apply({ kind: 'thinking', streamId: 't', done: false, at: new Date(start).toISOString() }, 'working');
  assert.equal(state.messages[0].completedAt, undefined);
  messages.apply({ kind: 'thinking', streamId: 't', done: true, at: new Date(end).toISOString() }, 'finished');
  assert.equal(state.messages[0].completedAt, end);
  messages.finish();
  messages.apply({ kind: 'thinking', streamId: 'unknown', done: true }, 'old');
  assert.equal(state.messages[1].completedAt, 0);
});

test('automatic output continuation only displays the final segment completion', t => {
  let now = end;
  t.mock.method(Date, 'now', () => now);
  const acc = stream.create();
  acc.push({ type: 'message_end', message: { role: 'user', content: 'continue answer' } });
  const answer = text => {
    acc.push({ type: 'message_start', message: { role: 'assistant' } });
    acc.push({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: text } });
  };
  answer('first');
  acc.push({ type: 'message_end', message: { role: 'assistant', stopReason: 'length' } });
  assert.equal(acc.snapshot().messages.at(-1).completedAt, end);
  acc.push({ type: 'message_end', message: { role: 'user',
    content: require('../main/pi-session/output-continuation').continuationPrompt(1, 'length') } });
  answer('second');
  assert.equal(acc.snapshot().messages.at(-1).completedAt, 0);
  now = end + 10000;
  acc.push({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } });
  assert.equal(acc.snapshot().messages.length, 2);
  assert.equal(acc.snapshot().messages.at(-1).completedAt, end + 10000);
});
test('goal final archive keeps its saved completion time instead of reopening time', () => {
  const finalizer = require('../main/conversation/goal-finalizer');
  const acc = stream.create();
  pi._seed(acc, { state: { messages: [] }, sessionManager: { getEntries: () => [
    { type: 'message', timestamp: new Date(start).toISOString(), message: { role: 'user', timestamp: start, content: 'Deliver the goal' } },
    { type: 'custom', customType: finalizer.ENTRY_TYPE, timestamp: new Date(end + 1000).toISOString(),
      data: { structured: { summary: 'done' }, rendered: 'Delivered answer', at: end } }
  ] } });
  assert.equal(acc.snapshot().messages.at(-1).completedAt, end);
});
test('Runner initial dispatch persists the optimistic send time separately from processing time', async t => {
  let payload;
  const adapter = createRunnerRuntimeAdapter({
    modelConfig: { fetchModel: async () => ({ ok: true, model: { id: 'fixture', key: 'fixture' } }) },
    runnerRuntime: { async rpc(op, value) {
      if (op === 'job.dispatch') { payload = value; return { ok: true, data: {} }; }
      if (op === 'job.session') return { ok: true, data: { status: 'done', items: [] } };
      return { ok: true, data: {} };
    } }
  });
  const session = await adapter.createSession({ native: { runner: { openOptions: { cwd: os.tmpdir(), ref: 'timed-dispatch' } } } });
  t.after(() => session.dispose());
  await session.send({ text: 'initial', options: { sentAt: start } }).completion;
  assert.equal(payload.ctx.conversationSentAt, start);
  assert.equal(session.snapshot().messages[0].sentAt, start);
});
