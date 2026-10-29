'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const vm = require('node:vm');
const path = require('node:path');

function fixture() {
  const storage = new Map(), reads = [], opened = [], sent = [];
  let owner = 'alice';
  const global = { document: { getElementById: () => null }, setTimeout: () => 1,
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    SoduWorkAPI: { taskStorageKey: () => owner,
      getTask: id => new Promise((resolve, reject) => reads.push({ id, resolve, reject })) } };
  global.window = global;
  vm.createContext(global);
  for (const name of ['chat-collaboration-store.js', 'chat-task-controller.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/panels', name), 'utf8'), global);
  }
  global.ChatCollaborationStore.upsertTask('draft', {
    taskId: 'requirement', title: 'Saved requirement', status: 'todo', adapterId: 'pi',
  });
  const ctx = { _sessionId: 'draft', _ref: '', _viewEpoch: 1,
    _sessionOptions: { adapterId: 'pi', modelName: 'chosen-model', reasoningEffort: 'high' },
    _snap: { status: 'idle', workOnly: true }, _collabTasks: new Map(), _collabStarts: new Set(),
    _collabPollTimer: 1, _render() {}, refreshHistory() {},
    _api: () => ({ bindTask: async () => ({ ok: true }) }),
    _ensure: async () => { opened.push({ ...ctx._sessionOptions }); ctx._ref = 'runtime'; return true; },
    _workModel: () => ctx._sessionOptions.modelName,
    _send: async (text, options) => { sent.push({ text, options }); return true; } };
  const controller = global.ChatTaskController.create(ctx);
  controller._restoreCollaboration('draft');
  return { ctx, controller, reads, opened, sent, owner: value => { owner = value; },
    start: options => controller._startTask(ctx._collabTasks.get('requirement').task, options) };
}

const task = extra => ({ id: 'requirement', title: 'Saved requirement', note: 'Full requirement details',
  status: 'todo', triageStage: 'ready', workRouting: {}, ...extra });

test('a restored index waits for full task data and preserves the draft model instead of its normalized empty model', async () => {
  const f = fixture();
  assert.equal(f.ctx._collabTasks.get('requirement').task.model, '', 'real index normalizes missing model');
  const first = f.start();
  assert.equal(f.opened.length, 0, 'index metadata must not initialize a runtime');
  assert.equal(await f.start(), false, 'the pending authority check also deduplicates clicks');
  assert.equal(f.reads.length, 2, 'one display read and one guarded execution read');
  f.reads[1].resolve(task());
  assert.equal(await first, true);
  assert.equal(f.opened.length, 1);
  assert.equal(f.opened[0].modelName, 'chosen-model');
  assert.equal(f.opened[0].reasoningEffort, 'high');
  assert.equal(f.sent[0].text, 'Full requirement details');
});

for (const [label, saved, options, expected] of [
  ['top-level normalized default', { model: '', reasoningEffort: '' }, {}, 'chosen-model'],
  ['saved explicit model', { model: 'saved-model' }, {}, 'saved-model'],
  ['saved execution default', { executionContext: { model: '' } }, {}, ''],
  ['saved execution model', { executionContext: { model: 'context-model' } }, {}, 'context-model'],
  ['requested default', { model: 'saved-model' }, { taskExecution: { model: '' } }, ''],
]) test(label + ' retains its intended precedence after index recovery', async () => {
  const f = fixture(), pending = f.start(options);
  assert.equal(f.opened.length, 0);
  f.reads[1].resolve(task(saved));
  assert.equal(await pending, true);
  assert.equal(f.opened[0].modelName, expected);
});

test('a failed index refresh preserves the draft and releases the start lock for retry', async () => {
  const f = fixture(), pending = f.start();
  assert.equal(f.reads.length, 2);
  f.reads[1].reject(Error('offline'));
  assert.equal(await pending, false);
  assert.equal(f.opened.length, 0);
  assert.equal(f.ctx._sessionOptions.modelName, 'chosen-model');
  assert.equal(f.ctx._collabStarts.size, 0);
  assert.match(f.ctx._taskOpenError, /offline/);
  const retry = f.start();
  f.reads[2].resolve(task());
  assert.equal(await retry, true);
  assert.equal(f.opened[0].modelName, 'chosen-model');
});

test('removing an indexed requirement while its start is waiting cancels that start', async () => {
  const f = fixture(), pending = f.start();
  f.ctx._collabTasks.get('requirement').queueRemoved = true;
  f.reads[1].resolve(task());
  assert.equal(await pending, false);
  assert.equal(f.opened.length, 0);
  assert.equal(f.ctx._collabStarts.size, 0);
  assert.equal(f.ctx._collabTasks.get('requirement').queueRemoved, true);
});

test('a delayed index read cannot follow a changed session id before view teardown', async () => {
  const f = fixture(), pending = f.start();
  f.ctx._sessionId = 'another-draft';
  f.reads[1].resolve(task());
  assert.equal(await pending, false);
  assert.equal(f.opened.length, 0);
});

for (const change of ['session', 'account']) test('late index authority response cannot affect another ' + change, async () => {
  const f = fixture(), pending = f.start(), priorStarts = f.ctx._collabStarts;
  assert.equal(f.reads.length, 2);
  if (change === 'session') { f.ctx._viewEpoch++; f.ctx._sessionId = 'new-draft'; }
  else f.owner('bob');
  f.ctx._sessionOptions = { adapterId: 'qwen', modelName: 'new-model' };
  f.ctx._collabStarts = new Set(['requirement']);
  f.reads[1].resolve(task({ model: 'old-saved-model' }));
  assert.equal(await pending, false);
  assert.equal(f.opened.length, 0);
  assert.equal(f.ctx._sessionOptions.modelName, 'new-model');
  assert.equal(priorStarts.size, 0);
  assert.equal(f.ctx._collabStarts.has('requirement'), true, 'old cleanup must not unlock the new view');
});

for (const result of [null, task({ id: 'wrong-task' }), task({ readOnly: true }), task({ canViewExecution: false })]) {
  test('an unavailable or mismatched task cannot start from the restored index: ' + JSON.stringify(result), async () => {
    const f = fixture(), pending = f.start();
    assert.equal(f.reads.length, 2);
    f.reads[1].resolve(result);
    assert.equal(await pending, false);
    assert.equal(f.opened.length, 0);
    assert.equal(f.ctx._sessionOptions.modelName, 'chosen-model');
  });
}

test('a full Hub task with no explicit model preserves the draft without an extra execution read', async () => {
  const f = fixture();
  const accepted = await f.controller._startTask(task({ model: '' }));
  assert.equal(accepted, true);
  assert.equal(f.opened[0].modelName, 'chosen-model');
  assert.equal(f.reads.length, 2, 'only initial display and the final binding refresh read the task');
});
