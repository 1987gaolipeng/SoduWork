'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(values = new Map(), conversationId = 'chat-a') {
  const notices = [], sends = [], host = {
    innerHTML: '', dataset: {}, classList: { add() {}, toggle() {} },
  };
  const globals = {
    localStorage: { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) },
    document: { activeElement: null, getElementById: () => null },
    setTimeout: () => 1, clearTimeout() {}, petSay: text => notices.push(text), SoduWorkAPI: {},
  };
  globals.window = globals;
  vm.createContext(globals);
  for (const file of ['chat-collaboration-store.js', 'chat-task-controller.js', 'chat-send-queue.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/panels', file), 'utf8'), globals, { filename: file });
  }
  const ctx = {
    _sessionId: conversationId, _ref: conversationId, _viewEpoch: 1, _sessionOptions: { adapterId: 'pi' },
    _collabTasks: new Map(), _collabStarts: new Set(), _localQueue: [],
    _snap: { execution: { queue: [] } }, esc: String,
    _mount: () => ({ querySelector: () => host }),
    _render: () => ctx._renderQueue(ctx._mount()),
    _ensure: async () => true, refreshHistory() {},
    _send: async (text, options) => { sends.push({ text, options }); return true; },
  };
  const api = {
    bindTask: async () => ({ ok: true }),
    cancelQueued: async (_ref, id) => {
      ctx._snap.execution.queue = ctx._snap.execution.queue.filter(row => row.id !== id);
      return { ok: true, snapshot: ctx._snap };
    },
  };
  ctx._api = () => api;
  Object.assign(ctx, globals.ChatTaskController.create(ctx), globals.ChatSendQueue.create(ctx));
  const bind = id => ctx._bindCollaborationTask(id, 'Task ' + id, {
    persist: false, taskMeta: { id, title: 'Task ' + id, status: 'todo', description: 'Original brief ' + id },
  });
  const visible = id => host.innerHTML.includes('data-queue-row="task:' + id + '"');
  const remove = id => ctx._queueAction('remove', 'task:' + id, id);
  return { ctx, globals, store: globals.ChatCollaborationStore, values, host, notices, sends, api, bind, visible, remove };
}

test('unsent removal survives renderer restart and old session bindings without deleting the task', async () => {
  const a = fixture();
  a.bind('one'); a.bind('two');
  assert.ok(a.visible('one') && a.visible('two'));
  await a.remove('one');
  assert.equal(a.visible('one'), false);
  assert.ok(a.visible('two'));
  assert.equal(a.ctx._collabTasks.get('one').task.description, 'Original brief one');
  const b = fixture(a.values);
  b.ctx._restoreCollaboration('chat-a');
  b.bind('one'); b.bind('two');
  assert.equal(b.visible('one'), false, 'removed unsent task must not reappear');
  assert.ok(b.visible('two'));
  assert.ok(b.store.list('chat-a').some(row => row.taskId === 'one'), '原会话历史关联保留');
  assert.equal(b.store.findByTask('one'), null, '已释放的关联不再作为执行导航目标');
});

test('removal survives asynchronous metadata refresh and does not affect another conversation', async () => {
  const a = fixture(); a.bind('one'); await a.remove('one');
  a.globals.SoduWorkAPI.getTask = async id => ({ id, title: 'Refreshed', status: 'todo' });
  await a.ctx._loadCollabTask('one');
  a.ctx._setCollabEntryStatus(a.ctx._collabTasks.get('one'), 'todo');
  const b = fixture(a.values); b.bind('one');
  assert.equal(b.visible('one'), false);
  const c = fixture(a.values, 'chat-b'); c.bind('one');
  assert.ok(c.visible('one'));
});

test('explicit re-add/send clears removal, preserves the brief and survives the next restart', async () => {
  const a = fixture(); a.bind('one'); await a.remove('one');
  const b = fixture(a.values); b.bind('one');
  assert.equal(b.visible('one'), false);
  assert.equal(await b.ctx._startTask(b.ctx._collabTasks.get('one').task, { retry: true }), true);
  assert.equal(b.sends.length, 1);
  assert.equal(b.sends[0].text, 'Original brief one');
  assert.equal(b.sends[0].options.taskId, 'one');
  assert.ok(b.visible('one'));
  const c = fixture(a.values); c.bind('one');
  assert.ok(c.visible('one'), 'explicit re-add must not stay hidden');
});

test('storage failure keeps the unsent row visible and reports a retryable error', async () => {
  const a = fixture(); a.bind('one');
  a.globals.localStorage.setItem = () => { throw Error('QuotaExceededError'); };
  await a.remove('one');
  assert.ok(a.visible('one'), 'do not pretend removal was saved');
  assert.equal(a.notices.length, 1);
});

test('释放需求后不会再从任务或项目索引自动找回旧会话', async () => {
  const a = fixture(); a.bind('one'); await a.remove('one');
  assert.equal(a.store.findByTask('one'), null);
});

test('removal markers survive the metadata index limit and removal of the last metadata row', async () => {
  const a = fixture(); a.bind('one'); await a.remove('one');
  for (let i = 0; i < 40; i++) a.store.upsertTask('chat-a', { taskId: 'other-' + i, title: 'Other' });
  const b = fixture(a.values); b.bind('one');
  assert.equal(b.visible('one'), false, 'metadata eviction must not erase a removal');
  for (const row of b.store.list('chat-a')) b.store.removeTask('chat-a', row.taskId);
  const c = fixture(a.values); c.bind('one');
  assert.equal(c.visible('one'), false, 'a marker-only record must be retained');
});

test('native queue cancellation persists removal, while failed cancellation keeps it visible', async () => {
  const a = fixture(); a.bind('one');
  a.ctx._snap.execution.queue = [{ id: 'q1', taskId: 'one', text: 'Task brief' }];
  a.api.cancelQueued = async () => ({ ok: false, reason: 'Already running' });
  await a.ctx._queueAction('remove', 'q1', 'one');
  assert.equal(a.ctx._snap.execution.queue.length, 1);
  assert.equal(Boolean(a.ctx._collabTasks.get('one').queueRemoved), false);
  a.api.cancelQueued = async () => ({ ok: true, snapshot: { execution: { queue: [] } } });
  await a.ctx._queueAction('remove', 'q1', 'one');
  const b = fixture(a.values); b.bind('one');
  assert.equal(b.visible('one'), false);
});

test('cancel response from the old conversation cannot replace the newly opened snapshot', async () => {
  const a = fixture(); a.bind('one');
  a.ctx._snap.execution.queue = [{ id: 'q1', taskId: 'one', text: 'Task brief' }];
  let resolve;
  a.api.cancelQueued = () => new Promise(r => { resolve = r; });
  const pending = a.ctx._queueAction('remove', 'q1', 'one');
  a.ctx._ref = 'chat-b'; a.ctx._sessionId = 'chat-b'; a.ctx._viewEpoch++;
  const next = { execution: { queue: [{ id: 'keep', text: 'Other conversation' }] } };
  a.ctx._snap = next; a.ctx._collabTasks = new Map();
  resolve({ ok: true, snapshot: { execution: { queue: [] } } });
  await pending;
  assert.equal(a.ctx._snap, next);
  const b = fixture(a.values); b.bind('one');
  assert.equal(b.visible('one'), false);
});
