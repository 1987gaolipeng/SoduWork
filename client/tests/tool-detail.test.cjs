'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const stream = require('../main/pi-session/event-stream');
const detail = require('../main/pi-session/tool-detail');
const windowed = require('../main/pi-session/snapshot-window');
const { createHandler } = require('../main/pi-session/tool-detail-ipc');
const cloud = require('../main/conversation/cloud-conversation-view');
const live = require('../main/conversation/task-live-output');
const text = 'const value = "完整文件内容";\n'.repeat(25000);
function start(acc, id, args) {
  acc.push({ type: 'tool_execution_start', toolCallId: id, toolName: 'write', args });
}
function finish(acc, id, result = 'Written') {
  acc.push({ type: 'tool_execution_end', toolCallId: id, toolName: 'write', result: { content: [{ type: 'text', text: result }] } });
}
test('live snapshot omits large file bodies but native receipts stay byte-exact', () => {
  const acc = stream.create();
  for (let i = 0; i < 20; i++) { start(acc, 'w' + i, { content: text, path: '中文/' + i + '.js' }); finish(acc, 'w' + i); }
  const snapshot = acc.uiSnapshot();
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 16000);
  assert.equal(snapshot.tools[0].args.path, '中文/0.js');
  assert.equal(snapshot.tools[0].detailsDeferred, true);
  assert.equal(acc.state.tools[0].args.content, text);
  assert.equal(acc.snapshot().tools[0].args.content, text);
  assert.equal(detail.find(acc.state.tools, 'w0').args.content, text);
  assert.equal(detail.find(acc.state.tools, 'missing'), null);
  assert.equal(acc.uiSnapshot().tools[0].detailVersion, snapshot.tools[0].detailVersion);
});
test('running, completed, edited and same-length result changes invalidate detail versions', () => {
  const tool = { id: 'w', name: 'edit', state: 'running', updatedAt: 1,
    args: { path: 'x.js', edits: [{ oldText: text, newText: text + 'end' }] }, result: 'A'.repeat(30000) };
  const first = detail.project(tool);
  const same = windowed.limitSnapshot({ tools: [{ ...tool }] }).tools[0];
  assert.equal(same.detailVersion, first.detailVersion);
  tool.result = 'B'.repeat(30000);
  const second = detail.project(tool); assert.notEqual(second.detailVersion, first.detailVersion);
  tool.state = 'done'; assert.notEqual(detail.project(tool).detailVersion, second.detailVersion);
  assert.equal(tool.args.edits[0].newText, text + 'end');
  assert.ok(JSON.stringify(first).length < 9000);
});
test('small tool metadata survives the generic runtime projection unchanged', () => {
  const tool = { id: 'r', name: 'read', args: { path: 'file.md', offset: 10 }, result: 'small', after: 2 };
  const actual = windowed.limitSnapshot({ tools: [tool] }).tools[0];
  assert.deepEqual(actual.args, tool.args); assert.equal(actual.result, tool.result);
  assert.equal(actual.detailsDeferred, undefined);
});
test('receipt IPC checks window/session scope and returns full read output', async () => {
  const win = { isDestroyed: () => false }, frame = {}, sender = { mainFrame: frame };
  const tool = { id: 'read-id', result: text }, handle = { attachedWindow: win, toolDetail: id => id === tool.id ? tool : null };
  let current = handle;
  const request = createHandler({ session: { get: ref => ref === 'mine' ? current : null }, BrowserWindow: { fromWebContents: value => value === sender ? win : null } });
  const event = { sender, senderFrame: frame };
  assert.equal((await request(event, 'mine', tool.id)).tool.result, text);
  assert.equal((await request(event, 'other', tool.id)).ok, false);
  assert.equal((await request({ sender, senderFrame: {} }, 'mine', tool.id)).ok, false);
  assert.equal((await request(event, 'mine', 'missing')).ok, false);
  handle.toolDetail = async () => { current = null; return tool; };
  assert.equal((await request(event, 'mine', tool.id)).ok, false);
});
function cloudFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-perf-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const record = { transferId: 'batch', sessionId: 's', taskId: 't', remoteState: 'running' };
  const make = () => cloud.create({ app: { getPath: () => root }, ref: 'r', record,
    saved: { cwd: root, adapterId: 'pi', snapshot: { messages: [] } } });
  return { root, record, make };
}
test('one cloud event page writes and notifies once, with ordered replay and complete file receipts', t => {
  const f = cloudFixture(t), handle = f.make(), output = live.create(handle, 't');
  let notifications = 0, writes = 0;
  handle.on(() => notifications++);
  const original = fs.appendFileSync;
  fs.appendFileSync = (...args) => { writes++; return original(...args); };
  try {
    const page = [{ seq: 1, kind: 'say', text: 'Preparing' },
      { seq: 2, kind: 'do', tool: 'write', callId: 'w', arguments: { path: 'x.js', content: text } },
      { seq: 3, kind: 'out', tool: 'write', callId: 'w', text: 'Saved' },
      { seq: 4, kind: 'say', text: 'Finished' }];
    output.consume('ex', page); output.consume('ex', page);
    assert.equal(writes, 1); assert.equal(notifications, 1);
    assert.equal(handle.uiSnapshot(), handle.uiSnapshot());
    assert.equal(handle.uiSnapshot().tools[0].detailsDeferred, true);
    const id = handle.snapshot().tools[0].id;
    assert.equal(handle.toolDetail(id).args.content, text);
    handle.close();
    const reopened = f.make();
    assert.deepEqual(reopened.snapshot().messages.map(m => m.blocks[0].text), ['Preparing', 'Finished']);
    assert.equal(reopened.toolDetail(id).args.content, text);
    assert.equal(reopened.snapshot().tools[0].state, 'done');
    reopened.close();
  } finally { fs.appendFileSync = original; }
});
test('failed cloud journal write does not advance cursor or lose the retry and final receipt', t => {
  const f = cloudFixture(t), handle = f.make(), output = live.create(handle, 't');
  const page = [{ seq: 1, kind: 'do', tool: 'read', callId: 'r', arguments: { path: 'x.md' } },
    { seq: 2, kind: 'out', tool: 'read', callId: 'r', text }, { seq: 3, kind: 'say', text: 'Done' }];
  const original = fs.appendFileSync;
  fs.appendFileSync = () => { throw Error('disk unavailable'); };
  try { assert.throws(() => output.consume('ex', page), /disk unavailable/); }
  finally { fs.appendFileSync = original; }
  assert.equal(output.answers(), 0); assert.equal(handle.snapshot().tools.length, 0);
  output.consume('ex', page);
  assert.equal(output.answers(), 1);
  const tool = handle.uiSnapshot().tools[0];
  assert.equal(tool.state, 'done'); assert.equal(tool.detailsDeferred, true);
  assert.equal(handle.toolDetail(tool.id).result, text);
  f.record.remoteState = 'stopped';
  assert.equal(handle.inFlight(), false); assert.equal(handle.uiSnapshot().toolPreparations.length, 0);
  handle.close();
});

test('partial batch disk failure remains recoverable without duplicated or missing cloud messages', t => {
  const f = cloudFixture(t), handle = f.make(), output = live.create(handle, 't');
  const page = [1, 2, 3].map(seq => ({ seq, kind: 'say', text: 'message-' + seq }));
  const original = fs.appendFileSync;
  fs.appendFileSync = (file, data, options) => {
    const newline = data.indexOf('\n', 1);
    original(file, data.slice(0, newline + 9), options);
    throw Error('partial write');
  };
  try { assert.throws(() => output.consume('ex', page), /partial write/); }
  finally { fs.appendFileSync = original; }
  output.consume('ex', page); handle.close();
  const reopened = f.make();
  assert.deepEqual(reopened.snapshot().messages.map(m => m.blocks[0].text), ['message-1', 'message-2', 'message-3']);
  reopened.close();
});

test('bounded multi-edit summaries retain the true change count and full native edits', () => {
  const tool = { id: 'many-edits', name: 'edit', state: 'done', args: { path: 'x.js',
    edits: Array.from({ length: 250 }, (_, i) => ({ oldText: 'a' + i, newText: 'b' + i })) } };
  const projected = detail.project(tool);
  assert.equal(projected.detailsDeferred, true);
  assert.equal(projected.detailSummary.editCount, 250);
  assert.equal(projected.args.edits.length, 100);
  assert.equal(tool.args.edits.length, 250);
});

test('legacy local consumers retain per-event cursor commits when a later event fails', () => {
  const messages = []; let fail = true;
  const output = live.create({ appendTaskMessage(_role, value) {
    if (fail && value === 'second') throw Error('later event failed');
    messages.push(value);
  } }, 't');
  const page = ['first', 'second', 'third'].map((text, i) => ({ seq: i + 1, kind: 'say', text }));
  assert.throws(() => output.consume('r', page), /later event failed/);
  fail = false; output.consume('r', page);
  assert.deepEqual(messages, ['first', 'second', 'third']);
  assert.equal(output.answers(), 3);
});

test('cloud snapshot cache distinguishes default and explicit history bounds', t => {
  const f = cloudFixture(t), handle = f.make();
  handle.appendTaskBatch(Array.from({ length: 300 }, (_, i) => ({ method: 'appendTaskTool',
    args: [{ type: 'tool_execution_start', toolCallId: 'tool-' + i, toolName: 'read', args: { path: 'file-' + i } }, 't'] })));
  assert.equal(handle.uiSnapshot({ messageLimit: 160 }).tools.length, 300);
  assert.equal(handle.uiSnapshot({ messageLimit: 160, toolLimit: 160 }).tools.length, 160);
  assert.equal(handle.uiSnapshot({ messageLimit: 160, toolLimit: 40 }).tools.length, 40);
  assert.equal(handle.uiSnapshot({ messageLimit: 160, toolLimit: 0 }).tools.length, 300);
  assert.equal(handle.uiSnapshot().tools.length, 160);
  handle.close();
});
