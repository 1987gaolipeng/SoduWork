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
