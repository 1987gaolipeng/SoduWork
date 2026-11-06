'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../main/pi-session/ipc.js'), 'utf8');
const renderer = require('./renderer-source.cjs').readFileSync(
  path.join(__dirname, '../components/panels/chat-task-controller.js'), 'utf8');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-binding-ipc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const identity = { hub: 'http://127.0.0.1:1', clientId: 'device' };
  identity.session = Buffer.from(JSON.stringify({ typ: 'device', uid: 'fixture-user', cid: identity.clientId,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.' + 'a'.repeat(64);
  const task = { id: 'task', title: 'Review this delivery', status: 'reviewing', ownerClientId: 'device',
    workRouting: { conversationTurn: { conversationId: 'conversation' } } };
  const context = { task, canDecide: true, approvalId: 'approval', artifactVersionId: 'v1',
    requirementVersion: 1, criteria: [{ id: 'c1', label: 'Meets the requirement' }], attachmentIds: [] };
  const app = { getPath: () => root }, calls = [], handlers = new Map();
  const handle = { sessionId: 'conversation', ref: 'native', cwd: root, taskIds: [],
    async bindTask(id) { this.taskIds = [id]; calls.push('bound'); return { ok: true }; },
    async submit(text, files, options) {
      await options.beforeTurn();
      assert.equal(options.taskId, undefined, 'review must not create a requirement execution receipt');
      assert.match(text, /Review this delivery/);
      assert.doesNotMatch(text, /artifactVersionId|criterion|本次固定交付版本/);
      assert.match(options.promptText, /本次固定交付版本：v1/);
      assert.match(options.promptText, /验收分析/);
      calls.push('sent');
      return { accepted: true, completion: Promise.resolve({ ok: true }) };
    } };
  const modules = {
    './skill-turn': require('../main/pi-session/skill-turn'),
    '../conversation/requirement-context': require('../main/conversation/requirement-context'),
    '../conversation/acceptance-session': require('../main/conversation/acceptance-session'),
    './app-mcp-grant.cjs': { nativePluginId: () => '', guardSend() {} },
    '../app-conversation-connection.cjs': { association: () => '' },
  };
  const main = vm.createContext({ require: name => { assert.ok(modules[name], name); return modules[name]; },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, app, path,
    session: { get: ref => ref === handle.ref ? handle : null },
    sendIdentityOf: async () => identity, identityOf: async () => identity,
    memories: { assertOwner() {} }, updateWorkloads: { guard: () => ({ ok: true }) },
    _cloudHandoff: { guard: () => false }, workDir: () => root, startReceipts: {},
    taskInput: { request: async () => task, prepare: async (owner, id, chat, submission, text, requested, runtime) => {
      calls.push('prepared');
      return require('../main/pi-session/acceptance-turn').prepare({ identity: owner, taskId: id,
        instruction: text, requested, runtime, request: async () => context });
    } },
    attachments: { stage: async () => ({ files: [], warnings: [] }) },
    pluginDebug: { guard: () => '', submitConversation: async () => null },
    BrowserWindow: {}, _publish() {}, _uiWindow: { snapshot: () => ({}) }, _contextSnapshot: () => ({}),
    _scheduleRelease() {}, console,
  });
  vm.runInContext(source.slice(source.indexOf("  ipcMain.handle('pi-session-bind-task'"),
    source.indexOf("  ipcMain.handle('pi-session-queue-cancel'")), main);
  const input = { value: '', dispatchEvent() {} };
  const window = { SoduWorkAPI: { getTask: async () => task, taskStorageKey: () => 'owner' } };
  vm.runInNewContext(renderer, { window, SoduWorkAPI: window.SoduWorkAPI, setTimeout: () => 1,
    Event: class Event { constructor(type) { this.type = type; } } });
  const ctx = { _collabTasks: new Map([[task.id, { taskId: task.id, task }]]), _collabStarts: new Set(),
    _sessionId: handle.sessionId, _ref: handle.ref, _viewEpoch: 1, _taskOpenSeq: 0, _collabPollTimer: 1,
    _collaborationTaskId: task.id, _collaborationTask: task, _boundFromServer: true,
    _snap: { status: 'idle', messages: [] }, _sessionOptions: { adapterId: 'pi' },
    _render() {}, _mount: () => ({ querySelector: () => input }),
    _api: () => ({ bindTask: (...args) => handlers.get('pi-session-bind-task')({}, ...args) }) };
  const controller = window.ChatTaskController.create(ctx);
  const send = (taskId = task.id) => handlers.get('pi-session-send')({}, handle.ref, input.value, [], {
    taskId, taskExecution: { acceptanceOnly: true, acceptanceExecutionSession: true, approvalId: 'approval' },
  });
  return { task, context, calls, handle, ctx, send, open: () => controller._openTask(task.id, task.title,
    { task, source: 'acceptance', acceptanceExecutionSession: true, approvalId: 'approval' }) };
}

test('reopening analysis repairs a renderer-only task association through native bind and send handlers', async t => {
  const f = fixture(t);
  const before = await f.send();
  assert.equal(before.ok, false);
  assert.match(before.reason, /原执行会话尚未绑定这项需求/);
  assert.deepEqual(f.calls, []);
  assert.equal(await f.open(), true, f.ctx._taskOpenError);
  const after = await f.send();
  assert.equal(after.ok, true, after.reason);
  assert.equal(after.accepted, true);
  assert.deepEqual(f.calls, ['bound', 'prepared', 'sent']);
  assert.equal(f.ctx._sessionOptions.acceptanceSession, false);
});

test('binding repair preserves task, execution-device, reviewer and pinned-approval send guards', async t => {
  for (const change of ['task', 'device', 'reviewer', 'approval']) {
    const f = fixture(t);
    assert.equal(await f.open(), true, f.ctx._taskOpenError);
    if (change === 'device') f.task.ownerClientId = 'other-device';
    if (change === 'reviewer') f.context.canDecide = false;
    if (change === 'approval') f.context.approvalId = 'new-approval';
    const result = await f.send(change === 'task' ? 'unrelated-task' : f.task.id);
    assert.equal(result.ok, false, change);
    assert.match(result.reason, { task: /尚未绑定/, device: /执行设备/,
      reviewer: /指定验收人/, approval: /验收单已变化/ }[change], change);
    assert.equal(f.calls[0], 'bound');
    assert.equal(f.calls.includes('sent'), false, change);
  }
});
