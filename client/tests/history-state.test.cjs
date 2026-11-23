'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const historyState = require('../main/pi-session/history-state');
const attachmentContract = require('../main/pi-session/attachment-contract');

test('live history titles strip attachment transport metadata', () => {
  const text = attachmentContract.augment('处理这个文件', [{ name: 'source.txt', path: 'inputs/source.txt' }]);
  assert.equal(historyState.messageTitle({ messages: [{ role: 'user', text }] }), '处理这个文件');
});

test('live history titles use the same plugin and connector cleanup as archived rows', () => {
  const connector = require('../main/pi-session/connector-context.cjs');
  const plugins = require('../main/pi-session/plugin-context');
  const text = connector.augment(plugins.augment('执行步骤', [
    { pluginId: 'fixture', name: 'Fixture', context: 'private instructions' },
  ]), 'private connector instructions');
  assert.equal(historyState.messageTitle({ messages: [{ role: 'user', text }] }), '执行步骤');
});

test('live history titles keep literal attachment tags when no valid envelope exists', () => {
  const text = '示例 ' + attachmentContract.START + 'literal';
  assert.equal(historyState.messageTitle({ messages: [{ role: 'user', text }] }), text.slice(0, 40));
});

test('live history titles remove a persisted attachment envelope truncated before its closing tag', () => {
  const text = '把更好的复何汉及 ' + attachmentContract.START + ' {"f';
  assert.equal(historyState.messageTitle({ messages: [{ role: 'user', text }] }), '把更好的复何汉及');
});

test('live history titles strip material context before attachment and connector envelopes', () => {
  const connector = require('../main/pi-session/connector-context.cjs');
  const material = require('../main/pi-session/input-context.cjs');
  const text = material.augment(
    connector.augment(attachmentContract.augment('真实标题', [{ name: 'source.txt', path: 'inputs/source.txt' }]),
      'private connector instructions'),
    'material evidence',
  );
  assert.equal(historyState.messageTitle({ messages: [{ role: 'user', text }] }), '真实标题');
});

const message = (role, extra = {}) => ({ type: 'message', message: { role, ...extra } });

test('archived turns cut off before the model finished are not completed', () => {
  const user = message('user', { content: [{ type: 'text', text: '下周末去杭州玩两天' }] });
  // The archive left by quitting mid-run: a tool call with no result.
  assert.equal(historyState.archivedTurnState([user,
    message('assistant', { stopReason: 'toolUse', content: [{ type: 'toolCall', name: 'bash' }] }),
    message('toolResult', { content: [{ type: 'text', text: '200 OK' }] }),
    message('assistant', { stopReason: 'toolUse', content: [
      { type: 'text', text: 'Wikimedia 可用。我再搜索灵隐寺……具体景点照片。' }, { type: 'toolCall', name: 'bash' }] }),
  ]), 'interrupted');
  assert.equal(historyState.archivedTurnState([user, message('assistant', { stopReason: 'toolUse' }),
    message('toolResult')]), 'interrupted', 'tool results the model never answered');
  assert.equal(historyState.archivedTurnState([user]), 'interrupted', 'an unanswered request');
  // Non-message entries (model changes, labels) after the cut-off do not hide it.
  assert.equal(historyState.archivedTurnState([user, message('assistant', { stopReason: 'toolUse' }),
    { type: 'model_change' }]), 'interrupted');
});

test('archived turns that ended normally or were stopped keep their state', () => {
  const user = message('user');
  assert.equal(historyState.archivedTurnState([user, message('assistant', { stopReason: 'stop' })]), 'idle');
  assert.equal(historyState.archivedTurnState([user, message('assistant', { stopReason: 'error' })]), 'unreachable');
  assert.equal(historyState.archivedTurnState([user, message('assistant', { stopReason: 'aborted' })]), 'aborted');
  assert.equal(historyState.archivedTurnState([]), 'idle');
  assert.equal(historyState.archivedTurnState(null), 'idle');
});

test('the sidebar shows interrupted archives as stopped, never completed', () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'components', 'workspace', 'workspace-chat-history.js'), 'utf8')
    .replace(/\}\)\(window\);?\s*$/, '})(window);'), context);
  const chatState = context.window.WorkspaceChatHistory.chatState;
  assert.equal(chatState({ state: 'interrupted' }), 'stopped');
  assert.equal(chatState({ state: 'aborted' }), 'stopped');
  assert.equal(chatState({ state: 'idle' }), 'completed');
});

test('session history rows carry the archived turn state', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'main', 'pi-session', 'session.js'), 'utf8');
  assert.match(source, /archivedState !== 'idle' \? \{ state: archivedState === 'interrupted' \? 'interrupted'/);
});
