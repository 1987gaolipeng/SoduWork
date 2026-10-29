'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness(enter) {
  const calls = { opened: [], toasts: [] };
  const panel = { classList: { add() {} }, dataset: {}, querySelector: () => null };
  const context = { window: null, document: { getElementById: () => null }, setTimeout: fn => fn(),
    ComposeSurface: { create: () => ({ _panel: () => panel, _rememberComposeDraft() {} }) },
    petSay: message => calls.toasts.push(message),
    ComposeModelPicker: { value: () => ({ modelName: 'unsent-draft-model' }) },
    NativeChat: { refreshHistory() {}, enter: (...args) => { calls.opened.push(args); return enter(...args); },
      openTask: async () => true },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/panels/panels-compose.js'), 'utf8'), context);
  return { context, calls };
}

test('history resumes without the unsent composer model, Skills, attachments or workspace', async () => {
  const { context, calls } = harness(async () => true);
  assert.equal(await context.openComposePanel({ chatId: 'old-chat', chatTitle: '已保存的会话' }), true);
  assert.equal(calls.opened[0][0], '');
  assert.equal(calls.opened[0][1], 'old-chat');
  assert.equal(calls.opened[0][2].chatTitle, '已保存的会话');
  for (const key of ['modelName', 'skills', 'capabilities', 'attachments', 'cwd', 'contextPrompts']) {
    assert.equal(key in calls.opened[0][2], false, key + ' must not leak across conversations');
  }
});

test('task dispatch can prepare its host without navigation or session initialization', () => {
  const { context, calls } = harness(() => { throw Error('preparing must not start a session'); });
  const panel = context.prepareComposePanel();
  assert.ok(panel);
  assert.equal(panel.dataset.stage, undefined);
  assert.deepEqual(calls.opened, []);
});

test('failed ordinary history does not show a task collaboration toast', async () => {
  const { context, calls } = harness(async () => false);
  assert.equal(await context.openComposePanel({ chatId: 'old-chat' }), false);
  assert.deepEqual(calls.toasts, []);
});

test('thrown history errors identify conversation, not task', async () => {
  const { context, calls } = harness(async () => { throw Error('fixture failure'); });
  assert.equal(await context.openComposePanel({ chatId: 'old-chat' }), false);
  assert.match(calls.toasts[0], /打开对话失败/);
  assert.doesNotMatch(calls.toasts[0], /任务/);
});

test('explicit task navigation retains task-specific failure handling', async () => {
  const { context, calls } = harness(async () => false);
  assert.equal(await context.openComposePanel({ chatId: 'task-chat', taskSession: true, taskId: 'task-1' }), false);
  assert.match(calls.toasts[0], /协作会话暂时不可用/);
});

test('failed history can be retried with one navigation call', async () => {
  let attempts = 0;
  const { context, calls } = harness(async () => ++attempts > 1);
  assert.equal(await context.openComposePanel({ chatId: 'retry-chat' }), false);
  assert.equal(await context.openComposePanel({ chatId: 'retry-chat' }), true);
  assert.equal(calls.opened.length, 2);
  assert.deepEqual(calls.toasts, []);
});

test('a late history open cannot finish work for a newer clicked conversation', async () => {
  const pending = new Map();
  const { context, calls } = harness((...args) => new Promise(resolve => {
    pending.set(args[1], resolve);
  }));
  const first = context.openComposePanel({ chatId: 'first-chat' });
  const second = context.openComposePanel({ chatId: 'second-chat' });
  pending.get('second-chat')(true);
  assert.equal(await second, true);
  pending.get('first-chat')(true);
  assert.equal(await first, false);
  assert.deepEqual(calls.toasts, []);
});
