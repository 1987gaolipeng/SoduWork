'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');

function fixture({ status = 'idle', pending = false, live = false } = {}) {
  const globals = { document: { getElementById: () => null }, setTimeout: () => 1 };
  globals.window = globals;
  vm.createContext(globals);
  for (const file of ['workspace/workspace-chat-history.js', 'workspace/workspace-chat-list.js',
    'panels/chat-task-controller.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../components', file), 'utf8'), globals,
      { filename: file });
  }
  const history = globals.WorkspaceChatHistory;
  let rows = [{ id: 'work-draft', title: 'Requirement discussion', workOnly: !live, state: 'idle' }];
  globals.WorkspaceShell = { upsertChat: row => { rows = history._upsertChatItems(rows, row); } };
  const ctx = { _sessionId: 'work-draft', _ref: live ? 'runtime-ref' : '', _viewEpoch: 1,
    _sessionOptions: { adapterId: 'pi' }, _snap: { status, workOnly: !live }, _pending: pending,
    _collabTasks: new Map(), _collabStarts: new Set(), _collabPollTimer: 1, _render() {} };
  const controller = globals.ChatTaskController.create(ctx);
  const list = globals.WorkspaceChatList.create({ active: 'create', activeChatId: ctx._sessionId,
    chatState: history.chatState, _chatUiKey: history._chatUiKey, CHAT_STATE: history.CHAT_STATE,
    wsT: (_key, fallback) => fallback });
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      dataset: {}, setAttribute() {}, querySelector: element,
    });
    return elements.get(selector);
  };
  const row = element('row');
  const paint = () => { list._paintChatRow(row, rows[0], false); return elements; };
  const bind = taskStatus => controller._bindCollaborationTask('requirement', 'Requirement', {
    persist: false, taskMeta: { id: 'requirement', status: taskStatus },
  });
  return { ctx, history, bind, paint, row: () => rows[0], refresh() {
    // Work-only archive history has no runtime state; it must not retain an
    // optimistic task status that falsely claims the Agent is executing.
    rows = history._reconcileChats(rows, [{ id: 'work-draft', title: 'Requirement discussion',
      workOnly: !live, at: Date.now() }]);
  } };
}

for (const status of ['todo', 'completed', 'cancelled']) {
  test('binding an idle ' + status + ' requirement keeps its conversation deletable after history refresh', () => {
    const f = fixture();
    assert.equal(f.bind(status), true);
    f.refresh();
    assert.equal(f.history.chatState(f.row()), 'completed');
    assert.equal(f.row().live, false);
    const elements = f.paint();
    assert.equal(elements.get('.ws-chat-delete').hidden, false);
    assert.equal(elements.get('.ws-chat-delete').disabled, false);
    assert.equal(elements.get('.ws-chat-archive').hidden, false);
    assert.doesNotMatch(elements.get('.ws-chat').className, /is-running|is-starting|is-pending/);
  });
}

for (const status of ['streaming', 'compacting', 'waiting-user', 'queued']) {
  test('adding an unsent requirement preserves active conversation status ' + status, () => {
    const f = fixture({ status, live: true });
    f.bind('todo');
    assert.equal(f.history.chatState(f.row()), f.history.chatState({ status }));
    assert.equal(f.row().live, true);
    const elements = f.paint();
    assert.equal(elements.get('.ws-chat-delete').hidden, true);
    assert.equal(elements.get('.ws-chat-delete').disabled, true);
  });
}

test('binding while a message is opening keeps deletion blocked until its actual status settles', () => {
  const f = fixture({ pending: true });
  f.bind('todo');
  assert.equal(f.history.chatState(f.row()), 'starting');
  assert.equal(f.paint().get('.ws-chat-delete').hidden, true);
});
