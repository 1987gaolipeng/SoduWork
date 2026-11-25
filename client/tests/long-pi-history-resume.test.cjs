'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { create } = require('../e2e/fixtures/resumed-pi.cjs');
const stream = require('../main/pi-session/event-stream');
const { seed } = require('../main/pi-session/history-seed');

function archived(entries, options) {
  const acc = stream.create();
  seed(acc, { state: {}, sessionManager: { getEntries: () => entries } }, options);
  return acc;
}
const user = content => ({ type: 'message', message: { role: 'user', content, timestamp: 1000 } });
const answer = text => ({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text }],
  completedAt: 2000, usage: { output: 7 }, stopReason: 'stop' } });

test('hidden control prompts and merged continuations keep their raw owners across the restart boundary', () => {
  const entries = [user('First'), answer('A'), user('<soduwork-internal-output-continue>'), answer('B'), user('Next'), answer('C')];
  const expected = archived(entries, { completeHistory: true }).uiSnapshot({ messageLimit: 10, messageEnd: 5 });
  const view = archived(entries, { maxMessages: 3, archivePages: true }).uiSnapshot({ messageLimit: 10, messageEnd: 5 });
  assert.deepEqual(view.history.messageIndices, [0, 1, 3, 4]);
  assert.deepEqual(view.messages, expected.messages);
  assert.deepEqual(view.turnMetrics, expected.turnMetrics);
});

test('an intermediate archive page preserves legacy internal goal visibility before any scope checkpoints', () => {
  const entries = [user('Visible goal'), ...Array.from({ length: 12 }, () => answer('Internal execution details'))];
  const acc = archived(entries, { archivePages: true, maxMessages: 3, internalGoal: true });
  for (const end of [5, 10, 13]) {
    const page = acc.uiSnapshot({ messageLimit: 2, messageEnd: end });
    assert.doesNotMatch(JSON.stringify(page.messages), /Internal execution details/);
  }
});

test('resuming a long native Pi archive keeps all turns available to bounded history pages', { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-long-pi-resume-'));
  const fixture = await create(root);
  t.after(async () => { await fixture.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const archive = fixture.sdk.SessionManager.open(fixture.resumePath);
  const base = Date.UTC(2026, 0, 1);
  const assistant = archive.getEntries().find(row => row.message?.role === 'assistant').message;
  archive.appendMessage({ role: 'user', content: 'Long tool turn', timestamp: base });
  for (let i = 0; i < 260; i++) {
    const id = 'archived-' + i, timestamp = base + i * 5;
    archive.appendMessage({ ...assistant, content: [{ type: 'toolCall', id, name: 'read', arguments: { path: 'file-' + i } }],
      stopReason: 'toolUse', timestamp, completedAt: timestamp + 1 });
    archive.appendMessage({ role: 'toolResult', toolCallId: id, toolName: 'read', isError: false,
      content: [{ type: 'text', text: 'Result ' + i }], timestamp: timestamp + 2 });
  }
  archive.appendMessage({ ...assistant, content: [{ type: 'text', text: 'Finished long tool turn' }],
    timestamp: base + 2000, completedAt: base + 2500 });
  for (let i = 0; i < 879; i++) {
    const timestamp = base + (i + 1) * 10000;
    archive.appendMessage({ role: 'user', content: 'Question ' + i, timestamp });
    archive.appendMessage({ ...assistant, content: [{ type: 'text', text: 'Answer ' + i }],
      timestamp, completedAt: timestamp + 2500 });
  }
  const saved = fs.readFileSync(fixture.resumePath, 'utf8');
  const handle = await fixture.open();
  const tail = handle.uiSnapshot();
  assert.equal(handle.snapshot().messages.length, 240);
  assert.equal(tail.history.totalMessages, 2022);
  assert.equal(tail.history.totalTools, 260);
  assert.equal(tail.messages.length, 80);
  assert.equal(tail.history.messageEnd, 2022);
  const first = handle.uiSnapshot({ messageLimit: 80, messageEnd: 80 });
  assert.match(first.messages[0].text, /Create an isolated report/);
  assert.equal(first.tools[0].id, 'archived-0');
  assert.equal(first.tools.at(-1).id, 'archived-76');
  const metric = first.turnMetrics.find(row => row.fromMessage === 2);
  assert.equal(metric.elapsedMs, 2500);
  assert.equal(metric.tokens, 261 * 8);
  assert.equal(fixture.requests.length, 0);
  const sent = await handle.submit('Follow up after restart', []).completion;
  assert.equal(sent.ok, true, sent.reason);
  assert.equal(handle.uiSnapshot().history.totalMessages, 2024);
  const crossing = handle.uiSnapshot({ messageLimit: 260, messageEnd: 2024 });
  assert.deepEqual(crossing.history.messageIndices, Array.from({ length: 260 }, (_, index) => 1764 + index));
  assert.match(JSON.stringify(crossing.messages.at(-1)), /Fixture complete/);
  const previous = handle.uiSnapshot({ messageLimit: 80, messageEnd: 80 });
  assert.deepEqual(previous.messages, first.messages);
  const handover = handle.snapshot({ completeHistory: true });
  assert.equal(handover.archiveWindow, undefined);
  assert.match(handover.messages[0].text, /Create an isolated report/);
  assert.match(JSON.stringify(handover.messages.at(-1)), /Fixture complete/);
  assert.equal(handover.tools.length, 260);
  assert.deepEqual(handover.tools[0].args, { path: 'file-0' });
  assert.match(handover.tools[0].result, /Result 0/);
  assert.ok(handle.snapshot().archiveWindow, 'reading the handover leaves the live mirror bounded');
  assert.equal(fixture.requests.length, 1);
  assert.match(JSON.stringify(fixture.requests[0].messages), /Long tool turn/);
  assert.ok(fs.readFileSync(fixture.resumePath, 'utf8').startsWith(saved));
});
