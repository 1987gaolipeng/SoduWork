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

const readPng = 'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAAKklEQVR4nGP8z0AdwEQlcxhGDSIMRsOIMBgNI8JgNIwIg9EwIgwGXxgBAHuqAS9ARg1/AAAAAElFTkSuQmCC';
const readImage = (data = readPng, mimeType = 'image/png') => ({ type: 'image', mimeType, data });
function imageRead(content, name = 'read') {
  const acc = stream.create();
  acc.push({ type: 'tool_execution_start', toolCallId: 'read-image', toolName: name,
    args: { path: '/outside/deleted/image.png' } });
  acc.push({ type: 'tool_execution_end', toolCallId: 'read-image', toolName: name,
    result: { content: [{ type: 'text', text: 'Read image file [image/png]' }, ...content] } });
  return acc;
}

test('read image pixels stay in the receipt while every UI projection defers even tiny images', () => {
  const acc = imageRead([readImage()]);
  const raw = acc.state.tools[0];
  assert.equal(raw.result, 'Read image file [image/png]');
  assert.deepEqual(raw.readImages, [{ mimeType: 'image/png', data: readPng }]);
  assert.deepEqual(acc.snapshot().tools[0].readImages, raw.readImages);
  for (const projected of [acc.uiSnapshot().tools[0], windowed.limitSnapshot(acc.snapshot()).tools[0]]) {
    assert.equal(projected.readImages, undefined);
    assert.equal(projected.readImageCount, 1);
    assert.equal(projected.detailsDeferred, true);
    assert.doesNotMatch(JSON.stringify(projected), new RegExp(readPng.slice(0, 40)));
    assert.ok(JSON.stringify(projected).length < 2000);
    assert.equal(projected.result, raw.result);
  }
  const first = detail.project(raw);
  assert.equal(detail.project(raw).detailVersion, first.detailVersion);
  raw.readImages = [{ mimeType: 'image/png', data: 'YWJjZA==' }];
  assert.notEqual(detail.project(raw).detailVersion, first.detailVersion);
  assert.equal(detail.project({ ...raw, detailsDeferred: true }).readImages, undefined);
});

test('history replays the original read image even when the native path no longer exists', () => {
  const seed = require('../main/pi-session/history-seed');
  const acc = stream.create();
  const messages = [{ role: 'assistant', content: [{ type: 'toolCall', id: 'historical-read',
    name: 'read', arguments: { path: '/outside/deleted/image.png' } }] },
  { role: 'toolResult', toolCallId: 'historical-read', toolName: 'read',
    content: [{ type: 'text', text: 'Read image file [image/png]' }, readImage()] }];
  seed.seed(acc, { state: { messages } });
  const tool = detail.find(acc.state.tools, 'historical-read');
  assert.deepEqual(tool.readImages, [{ mimeType: 'image/png', data: readPng }]);
  assert.equal(tool.args.path, '/outside/deleted/image.png');
  assert.equal(tool.result, 'Read image file [image/png]');
  assert.equal(acc.uiSnapshot().tools[0].readImages, undefined);
  assert.equal(acc.uiSnapshot().tools[0].readImageCount, 1);
});

test('read image validation accepts only bounded inline image bytes and never URL references', () => {
  const { IMAGE_BYTES, MAX_FILES } = require('../main/pi-session/attachments');
  const invalid = [readImage('https://example.invalid/image.png'), readImage('file:///private/image.png'),
    readImage('data:image/png;base64,' + readPng), readImage(readPng, 'text/html'),
    readImage(readPng, 'image/png\" onerror=\"alert(1)'), readImage('===='), readImage('a===')];
  const invalidTool = imageRead(invalid).state.tools[0];
  assert.equal(invalidTool.readImages, undefined);
  assert.equal(invalidTool.result, 'Read image file [image/png]');
  const many = imageRead(Array.from({ length: MAX_FILES + 1 }, () => readImage())).state.tools[0];
  assert.equal(many.readImages.length, MAX_FILES);
  assert.equal(many.readImagesTruncated, true);
  const part = Buffer.alloc(IMAGE_BYTES / 2 + 1, 12).toString('base64');
  const combined = imageRead([readImage(part), readImage(part)]).state.tools[0];
  assert.equal(combined.readImages.length, 1, 'the 20 MB limit applies to the whole receipt');
  assert.equal(combined.readImagesTruncated, true);
  assert.equal(detail.project(combined).readImages, undefined);
  assert.equal(detail.project(combined).readImageCount, 1);
});

test('plain-text reads and image results from other tools retain their existing projection', () => {
  for (const acc of [imageRead([]), imageRead([readImage()], 'generate_image')]) {
    const tool = acc.state.tools[0], projected = acc.uiSnapshot().tools[0];
    assert.equal(tool.readImages, undefined);
    assert.equal(projected.readImageCount, undefined);
    assert.equal(projected.detailsDeferred, undefined);
    assert.equal(projected.result, 'Read image file [image/png]');
  }
});

test('read image details are available only to the attached window and recorded tool call', async () => {
  const acc = imageRead([readImage()]);
  const win = { isDestroyed: () => false }, frame = {}, sender = { mainFrame: frame };
  const handle = { attachedWindow: win, toolDetail: id => detail.find(acc.state.tools, id) };
  const request = createHandler({ session: { get: ref => ref === 'mine' ? handle : null },
    BrowserWindow: { fromWebContents: value => value === sender ? win : null } });
  const event = { sender, senderFrame: frame };
  assert.deepEqual((await request(event, 'mine', 'read-image')).tool.readImages,
    [{ mimeType: 'image/png', data: readPng }]);
  assert.equal((await request(event, 'mine', '/outside/deleted/image.png')).ok, false);
  assert.equal((await request(event, 'other', 'read-image')).ok, false);
  assert.equal((await request({ sender: {}, senderFrame: frame }, 'mine', 'read-image')).ok, false);
  assert.equal((await request({ sender, senderFrame: {} }, 'mine', 'read-image')).ok, false);
  handle.detached = true;
  assert.equal((await request(event, 'mine', 'read-image')).ok, false);
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
test('one cloud event page writes and notifies once, with ordered replay and complete file receipts', async t => {
  const f = cloudFixture(t), handle = await f.make(), output = live.create(handle, 't');
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
    const reopened = await f.make();
    assert.deepEqual(reopened.snapshot().messages.map(m => m.blocks[0].text), ['Preparing', 'Finished']);
    assert.equal(reopened.toolDetail(id).args.content, text);
    assert.equal(reopened.snapshot().tools[0].state, 'done');
    reopened.close();
  } finally { fs.appendFileSync = original; }
});
test('failed cloud journal write does not advance cursor or lose the retry and final receipt', async t => {
  const f = cloudFixture(t), handle = await f.make(), output = live.create(handle, 't');
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

test('partial batch disk failure remains recoverable without duplicated or missing cloud messages', async t => {
  const f = cloudFixture(t), handle = await f.make(), output = live.create(handle, 't');
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
  const reopened = await f.make();
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

test('cloud snapshot cache distinguishes default and explicit history bounds', async t => {
  const f = cloudFixture(t), handle = await f.make();
  handle.appendTaskBatch(Array.from({ length: 300 }, (_, i) => ({ method: 'appendTaskTool',
    args: [{ type: 'tool_execution_start', toolCallId: 'tool-' + i, toolName: 'read', args: { path: 'file-' + i } }, 't'] })));
  assert.equal(handle.uiSnapshot({ messageLimit: 160 }).tools.length, 300);
  assert.equal(handle.uiSnapshot({ messageLimit: 160, toolLimit: 160 }).tools.length, 160);
  assert.equal(handle.uiSnapshot({ messageLimit: 160, toolLimit: 40 }).tools.length, 40);
  assert.equal(handle.uiSnapshot({ messageLimit: 160, toolLimit: 0 }).tools.length, 300);
  assert.equal(handle.uiSnapshot().tools.length, 160);
  handle.close();
});
