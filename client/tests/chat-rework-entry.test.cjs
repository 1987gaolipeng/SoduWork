'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../components/panels/chat-send-queue.js'), 'utf8');
const controllerSource = fs.readFileSync(path.join(__dirname, '../components/panels/chat-task-controller.js'), 'utf8');

// Match the NativeChat reset boundary: opening a replacement must invalidate
// the old view and clear its archive identity and options before _ensure runs.
function resetConversation() {
  this.resetCalls = (this.resetCalls || 0) + 1;
  this._viewEpoch++;
  this._ref = ''; this._sessionId = ''; this._snap = null; this._model = null;
  this._sessionOptions = {}; this._collabTasks.clear(); this._activeCollabTaskId = '';
  this._collaborationTaskId = ''; this._boundFromServer = false;
  this._openingTask = null; this._openingEpoch = -1;
  this._taskOpenPending = false; this._taskOpenError = '';
}

function fixture() {
  const host = { innerHTML: '', dataset: {}, classList: { add() {}, toggle() {} }, querySelector() { return null; } };
  const task = { id: 'task-1', title: '阳光总在风雨后主题小作文', status: 'doing', reviewRejected: true,
    workRouting: { reworkPending: { feedback: '结构太松散，AI味也有些浓' } } };
  const entry = { taskId: task.id, task, nativeTurn: true, controller: null };
  const ctx = {
    _mount: () => ({ querySelector: selector => selector === '#nchatQueue' ? host : null }),
    _collabEntries: () => [entry], _collabTasks: new Map([[task.id, entry]]),
    _collabEntryStatus: () => 'completed', _collabStarts: new Set(), _activeCollabTaskId: '',
    _snap: { execution: { queue: [], turnQueue: {} } }, _localQueue: [], _runtimeBusy: () => false,
    _esc: value => String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])),
    esc(value) { return this._esc(value); }, _sessionOptions: {}, _queueHistoryOpen: true,
  };
  const context = { window: {}, document: { activeElement: null } };
  vm.runInNewContext(source, context);
  return { queue: context.window.ChatSendQueue.create(ctx), ctx, host };
}

test('聊天里的已打回记录提供直接继续修正入口', () => {
  const { queue, ctx, host } = fixture();
  queue._renderQueue(ctx._mount());
  assert.match(host.innerHTML, /data-task-rework="task-1"/);
  assert.match(host.innerHTML, />继续修正</);
});

test('聊天里的继续修正入口经过统一导航并保留返修语义', async () => {
  const calls = [];
  const window = { openTaskConversation: (...args) => { calls.push(args); return Promise.resolve(true); } };
  vm.runInNewContext(controllerSource, { window });
  const task = { id: 'task-1', title: '阳光总在风雨后主题小作文' };
  const ctx = { _collabTasks: new Map([[task.id, { taskId: task.id, task }]]) };
  const controller = window.ChatTaskController.create(ctx);
  await controller._collabAction('rework-task', { taskId: task.id });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], task.id);
  assert.equal(calls[0][2].source, 'rework');
  assert.equal(calls[0][2].reworkSession, true);
  assert.equal(calls[0][2].forceNew, false);
});

test('续接原会话时把打回意见预填入当前输入框', async () => {
  const task = { id: 'task-1', title: '阳光总在风雨后主题小作文', status: 'doing',
    workRouting: { conversationTurn: { conversationId: 'session-1' },
      reworkPending: { feedback: '结构太松散，AI味也有些浓' } } };
  const input = { value: '', events: [], dispatchEvent(event) { this.events.push(event.type); } };
  const window = { SoduWorkAPI: { getTask: async () => task } };
  vm.runInNewContext(controllerSource, { window, SoduWorkAPI: window.SoduWorkAPI,
    Event: class Event { constructor(type) { this.type = type; } } });
  const ctx = { _collabTasks: new Map([[task.id, { taskId: task.id, task, queueState: 'completed' }]]),
    _collabStarts: new Set(), _sessionId: 'session-1', _ref: 'session-1', _viewEpoch: 1,
    _taskOpenSeq: 0, _sessionOptions: { adapterId: 'pi' }, _snap: { status: 'idle', messages: [] },
    _collaborationTaskId: task.id, _collaborationTask: task, _taskOpenPending: false,
    _render() {}, _mount: () => ({ querySelector: selector => selector === '#nchatInput' ? input : null }),
    _taskSnapshotIsStale: () => false, _api: () => ({}) };
  const controller = window.ChatTaskController.create(ctx);
  await controller._openTask(task.id, task.title, { source: 'rework', navigation: true,
    forceNew: false, reworkSession: true, task });
  assert.match(input.value, /结构太松散，AI味也有些浓/);
  assert.match(input.value, /禁止从头重做/);
});

test('原执行会话已删除时自动新建返修会话并完整承接上一轮交付', async () => {
  const task = { id: 'task-1', title: '阳光总在风雨后主题小作文', status: 'doing',
    workRouting: { conversationTurn: { conversationId: 'deleted-session' },
      reworkPending: { feedback: '补充不同人群练太极的好处' } },
    attachments: [{ id: 'latest-output', filename: '阳光总在风雨后主题小作文.md', role: 'output',
      sourceRef: 'conversation:latest', createdAt: '2026-10-19T01:00:00Z', evidenceMeta: { round: 2 } }] };
  const input = { value: '', events: [], dispatchEvent(event) { this.events.push(event.type); } };
  const opened = [];
  const window = { SoduWorkAPI: { getTask: async () => task, taskStorageKey: () => 'ops' } };
  vm.runInNewContext(controllerSource, { window, SoduWorkAPI: window.SoduWorkAPI,
    Event: class Event { constructor(type) { this.type = type; } }, setTimeout: () => 1 });
  const ctx = { _collabTasks: new Map(), _collabStarts: new Set(), _collabPollTimer: 1,
    _activeCollabTaskId: '', _sessionId: 'deleted-session', _ref: '', _viewEpoch: 1, _taskOpenSeq: 0,
    _sessionOptions: { adapterId: 'pi', cwd: 'D:/deleted-workspace' }, _snap: null, _boundFromServer: false,
    reset: resetConversation,
    _taskOpenPending: false, _render() {}, _mount: () => ({ querySelector: selector => selector === '#nchatInput' ? input : null }),
    _taskSnapshotIsStale: () => false, _api: () => ({ bindTask: async () => ({ ok: true }) }),
    async _ensure(chatId) {
      chatId = chatId || this._sessionId || undefined;
      opened.push(chatId || '');
      if (chatId === 'deleted-session') { this._snap = { status: 'error', sessionNotFound: true }; return false; }
      this._ref = 'new-ref'; this._sessionId = 'new-session'; this._snap = { status: 'idle', messages: [] }; return true;
    },
  };
  const controller = window.ChatTaskController.create(ctx);
  const result = await controller._openTask(task.id, task.title, { source: 'rework', navigation: true,
    forceNew: false, reworkSession: true, task });
  assert.equal(result, true);
  assert.deepEqual(opened, ['deleted-session', '']);
  assert.equal(ctx.resetCalls, 1);
  assert.equal(ctx._viewEpoch, 2);
  assert.equal(ctx._sessionOptions.cwd, undefined);
  assert.equal(ctx._sessionOptions.adapterId, 'pi');
  assert.equal(ctx._sessionOptions.reworkSession, true);
  assert.match(input.value, /补充不同人群练太极的好处/);
  assert.match(input.value, /附件 ID: latest-output/);
  assert.match(input.value, /禁止从头重做/);
});

test('原执行会话仍存在时复用原会话，并只带入最新交付批次的精确附件', async () => {
  const task = { id: 'task-1', title: '阳光总在风雨后主题小作文', status: 'doing',
    workRouting: { conversationTurn: { conversationId: 'execution-session' },
      reworkPending: { feedback: '补充不同人群练太极的好处' } },
    attachments: [
      { id: 'old-output', filename: '阳光总在风雨后主题小作文.md', role: 'output',
        sourceRef: 'conversation:old', createdAt: '2026-10-18T01:00:00Z', evidenceMeta: { round: 1 } },
      { id: 'latest-output', filename: '阳光总在风雨后主题小作文.md', role: 'output',
        sourceRef: 'conversation:latest', createdAt: '2026-10-19T01:00:00Z', evidenceMeta: { round: 2 } },
    ] };
  const input = { value: '', events: [], dispatchEvent(event) { this.events.push(event.type); } };
  const opened = [];
  const window = { SoduWorkAPI: { getTask: async () => task, taskStorageKey: () => 'ops' } };
  vm.runInNewContext(controllerSource, { window, SoduWorkAPI: window.SoduWorkAPI,
    Event: class Event { constructor(type) { this.type = type; } }, setTimeout: () => 1 });
  const ctx = { _collabTasks: new Map(), _collabStarts: new Set(), _collabPollTimer: 1,
    _activeCollabTaskId: '', _sessionId: '', _ref: '', _viewEpoch: 1, _taskOpenSeq: 0,
    _sessionOptions: { adapterId: 'pi' }, _snap: null, _boundFromServer: false,
    _taskOpenPending: false, _render() {}, _mount: () => ({ querySelector: selector => selector === '#nchatInput' ? input : null }),
    _taskSnapshotIsStale: () => false, _api: () => ({ bindTask: async () => ({ ok: true }) }),
    async _ensure(chatId) {
      opened.push(chatId || '');
      assert.equal(chatId, 'execution-session');
      this._ref = 'execution-ref'; this._sessionId = 'execution-session';
      this._snap = { status: 'idle', messages: [{text: '上一轮交付'}] }; return true;
    },
  };
  const controller = window.ChatTaskController.create(ctx);
  const result = await controller._openTask(task.id, task.title, { source: 'rework', navigation: true,
    forceNew: false, reworkSession: true, task });
  assert.equal(result, true);
  assert.deepEqual(opened, ['execution-session']);
  assert.match(input.value, /补充不同人群练太极的好处/);
  assert.match(input.value, /附件 ID: latest-output/);
  assert.doesNotMatch(input.value, /附件 ID: old-output/);
  assert.match(input.value, /交付批次: conversation:latest/);
  assert.match(input.value, /禁止从头重做/);
});

test('新返修会话在需求快照没有附件时也会读取附件清单并精确承接最新交付', async () => {
  const task = { id: 'task-1', title: '导出页返修', status: 'doing',
    workRouting: { conversationTurn: { conversationId: 'deleted-session' },
      reworkPending: { feedback: '补充空状态说明' } } };
  const input = { value: '', events: [], dispatchEvent(event) { this.events.push(event.type); } };
  const opened = [], listed = [];
  const window = { SoduWorkAPI: {
    getTask: async () => task,
    listAttachments: async id => { listed.push(id); return [
      { id: 'old-output', filename: '导出页.md', role: 'output', sourceRef: 'conversation:old', createdAt: '2026-10-18T01:00:00Z', evidenceMeta: { round: 1 } },
      { id: 'latest-output', filename: '导出页.md', role: 'output', sourceRef: 'conversation:latest', createdAt: '2026-10-19T01:00:00Z', evidenceMeta: { round: 2 } },
    ]; },
    taskStorageKey: () => 'ops',
  } };
  vm.runInNewContext(controllerSource, { window, SoduWorkAPI: window.SoduWorkAPI,
    Event: class Event { constructor(type) { this.type = type; } }, setTimeout: () => 1 });
  const ctx = { _collabTasks: new Map(), _collabStarts: new Set(), _collabPollTimer: 1,
    _activeCollabTaskId: '', _sessionId: 'deleted-session', _ref: '', _viewEpoch: 1, _taskOpenSeq: 0,
    _sessionOptions: { adapterId: 'pi', cwd: 'D:/deleted-workspace' }, _snap: null, _boundFromServer: false,
    reset: resetConversation,
    _taskOpenPending: false, _render() {}, _mount: () => ({ querySelector: selector => selector === '#nchatInput' ? input : null }),
    _taskSnapshotIsStale: () => false, _api: () => ({ bindTask: async () => ({ ok: true }) }),
    async _ensure(chatId) {
      chatId = chatId || this._sessionId || undefined;
      opened.push(chatId || '');
      if (chatId === 'deleted-session') { this._snap = { status: 'error', sessionNotFound: true }; return false; }
      this._ref = 'new-ref'; this._sessionId = 'new-session'; this._snap = { status: 'idle', messages: [] }; return true;
    },
  };
  const controller = window.ChatTaskController.create(ctx);
  const result = await controller._openTask(task.id, task.title, { source: 'rework', navigation: true,
    forceNew: false, reworkSession: true, task });
  assert.equal(result, true);
  assert.deepEqual(opened, ['deleted-session', '']);
  assert.equal(ctx.resetCalls, 1);
  assert.equal(ctx._viewEpoch, 2);
  assert.equal(ctx._sessionOptions.cwd, undefined);
  assert.equal(ctx._sessionOptions.reworkSession, true);
  assert.deepEqual(listed, ['task-1']);
  assert.match(input.value, /附件 ID: latest-output/);
  assert.doesNotMatch(input.value, /附件 ID: old-output/);
  assert.match(input.value, /补充空状态说明/);
});
