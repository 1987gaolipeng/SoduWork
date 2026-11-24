'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { create } = require('../main/pi-session/session-handle');
const history = require('../main/pi-session/history-state');
const { openReply } = require('../main/pi-session/open-reply');
const titles = require('../main/conversation/titles');

function handle(id, ephemeral) {
  const ctx = { ref: id, opts: { ephemeral }, taskBinding: { taskIds: [], taskBindings: [] }, goal: {},
    shared: { _messageTitle: history.messageTitle, _presenceState: history.presenceState,
      snapshotWindow: require('../main/pi-session/snapshot-window') },
    piSession: { sessionId: id }, prep: { model: {} },
    acc: { state: { messages: [], tools: [] } },
    updatedAt: 100, turnQueue: { size: () => 0 }, effectiveCwd: 'node-workspace',
    _snapshot: () => ({ status: 'streaming', messages: [{ role: 'user', text: 'Run the workflow' }] }),
  };
  ctx.handle = create(ctx);
  return { ctx, handle: ctx.handle };
}

test('an active ephemeral Pi child never becomes a sidebar conversation or presence row', () => {
  const parent = handle('parent', false), child = handle('workflow-pi:node', true);
  child.ctx.inFlight = true;
  child.ctx._snapshot = () => { throw Error('private child transcript must not be read for history'); };
  assert.equal(child.handle.historyRow(), null);
  assert.equal(child.handle.historyRow({ status: 'streaming', messages: [{ role: 'user', text: 'child input' }] }), null);
  const disk = [{ id: 'parent', title: 'Run the workflow', path: 'parent.jsonl', at: 50, count: 1 }];
  const rows = history.mergeHistory(disk, [parent.handle, child.handle]);
  assert.equal(rows.length, 1); assert.equal(rows[0].id, 'parent'); assert.equal(rows[0].path, 'parent.jsonl');
  child.ctx.inFlight = false;
  assert.deepEqual(history.mergeHistory(disk, [parent.handle, child.handle]), rows);
});

test('normal newly opened Pi conversations still appear in live history without an archive row', () => {
  for (const ephemeral of [false, undefined]) {
    const { handle: visible } = handle('normal', ephemeral);
    const rows = history.mergeHistory([], [visible]);
    assert.equal(rows.length, 1); assert.equal(rows[0].title, 'Run the workflow');
    assert.equal(rows[0].id, 'normal'); assert.equal(rows[0].live, true);
  }
});


test('an unsent task review title does not create a phantom history entry', () => {
  const f = handle('review-draft', false);
  f.ctx.taskTitle = 'Requirement with the same title';
  f.handle.taskRef = 'requirement';
  f.ctx._snapshot = () => ({ status: 'idle', messages: [] });
  assert.equal(f.handle.historyRow(), null);
  assert.deepEqual(history.mergeHistory([], [f.handle]), []);
  assert.equal(f.handle.historyRow({ status: 'idle', messages: [{ role: 'user', text: 'Review this delivery' }] }).id, 'review-draft');
});

test('unsent composer titles and saved renames remain visible without publishing history rows', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-draft-title-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const app = {getPath: () => root};
  for (const assigned of [false, true]) {
    const f = handle('draft-' + assigned, false);
    f.ctx.displayTitle = assigned ? 'Assigned report' : 'Project workspace';
    if (assigned) { f.ctx.taskTitle = 'Assigned report'; f.handle.taskRef = 'requirement'; }
    f.ctx._snapshot = () => ({status: 'idle', messages: []});
    assert.equal(f.handle.historyRow(), null);
    assert.equal(openReply(app, f.handle).title, f.ctx.displayTitle);
    assert.deepEqual(history.mergeHistory([], [f.handle]), []);
    f.ctx.displayTitle = 'Updated live title';
    assert.equal(openReply(app, f.handle).title, 'Updated live title');
    titles.save(app, f.handle.sessionId, 'My chosen name');
    assert.equal(openReply(app, f.handle).title, 'My chosen name');
    assert.deepEqual(history.mergeHistory([], [f.handle]), []);
    f.ctx._snapshot = () => ({status: 'idle', messages: [{role: 'user', text: 'Submit this request'}]});
    assert.equal(history.mergeHistory([], [f.handle]).length, 1);
    assert.equal(openReply(app, f.handle).title, 'My chosen name');
  }
});

test('switchable-conversation preserves null historyRow for unused and ephemeral Pi handles', async t => {
  const switchable = require('../main/agent-runtime/switchable-conversation');
  const { create: createStore } = require('../main/conversation/replica-store.cjs');
  const { create: createSharedHistory } = require('../main/conversation/shared-history.cjs');
  const { identity } = require('./helpers/platform-session-fixture.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-switchable-empty-'));
  const app = { getPath: () => root }, actor = identity();
  const store = createStore(path.join(root, 'history.sqlite'));
  const shared = createSharedHistory({
    app, store, identityOf: () => actor,
    session: { archivedConversation: async () => null, findBySessionId: () => null },
  });
  t.after(async () => { await shared.close(); fs.rmSync(root, { recursive: true, force: true }); });

  for (const [id, ephemeral, messages] of [
    ['unused-draft', false, []],
    ['ephemeral-child', true, [{ role: 'user', text: 'Hidden child turn' }]],
  ]) {
    const f = handle(id, ephemeral);
    f.ctx.listeners = new Set();
    f.ctx.piSession.sessionManager = { getSessionFile: () => '' };
    f.ctx._snapshot = () => ({ status: 'idle', messages });
    const wrapped = switchable.create({ raw: f.handle, options: { app, identity: actor, ref: 'chat-' + id } });
    assert.equal(wrapped.historyRow(), null);
    assert.equal(wrapped.historyRow(wrapped.snapshot()), null);
    shared.observe(wrapped, actor);
    await shared.capture(wrapped, actor);
    assert.equal(store.get(id), null);
    await wrapped.close();
    assert.equal(store.get(id), null);
  }

  const active = handle('real-turn', false);
  active.ctx.listeners = new Set();
  active.ctx.piSession.sessionManager = { getSessionFile: () => '' };
  let liveMessages = [];
  active.ctx._snapshot = () => ({ status: 'idle', messages: liveMessages });
  const wrappedActive = switchable.create({ raw: active.handle, options: { app, identity: actor, ref: 'chat-real-turn' } });
  assert.equal(wrappedActive.historyRow(), null);
  await shared.capture(wrappedActive, actor);
  assert.equal(store.get('real-turn'), null);
  liveMessages = [{ role: 'user', text: 'First real message' }];
  await shared.capture(wrappedActive, actor);
  const persisted = store.get('real-turn');
  assert.equal(persisted?.id, 'real-turn');
  assert.equal(persisted?.title, 'First real message');
  assert.equal(persisted?.cwd, 'node-workspace');
  await wrappedActive.close();
});

test('switchable-conversation retains segment metadata when a switched conversation has an empty active Pi segment', async t => {
  const switchable = require('../main/agent-runtime/switchable-conversation');
  const segments = require('../main/conversation/runtime-segments');
  const { identity } = require('./helpers/platform-session-fixture.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-switchable-segment-'));
  const app = { getPath: () => root }, actor = identity();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const f = handle('pi-next-seg', false);
  f.ctx.listeners = new Set();
  f.ctx.piSession.sessionManager = { getSessionFile: () => '' };
  f.ctx._snapshot = () => ({ status: 'idle', messages: [] });
  assert.equal(f.handle.historyRow(), null);

  const restored = {
    version: 1, id: 'public-switched', owner: segments.scope(actor),
    title: 'Preserved topic', cwd: root, originAdapter: 'qwen', at: 123456,
    prefix: { messages: [{ role: 'user', text: 'Preserved topic' }, { role: 'assistant', text: 'Qwen answer' }], tools: [] },
    segments: [{ sessionId: 'qwen-seg', adapterId: 'qwen', path: 'qwen-seg', usedHarnesses: ['qwen'] }],
    active: { sessionId: 'pi-next-seg', adapterId: 'pi', path: '', usedHarnesses: [] },
  };
  const wrapped = switchable.create({ raw: f.handle, restored, options: { app, identity: actor, ref: 'chat-switched' } });
  const row = wrapped.historyRow();
  assert.equal(row?.id, 'public-switched');
  assert.equal(row?.title, 'Preserved topic');
  assert.equal(row?.cwd, root);
  assert.equal(row?.at, 123456);
  assert.equal(row?.count, 2);
  assert.deepEqual(row?.usedHarnesses, ['qwen']);
  await wrapped.close();
});
