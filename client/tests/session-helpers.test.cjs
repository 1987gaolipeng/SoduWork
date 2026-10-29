const assert = require('node:assert/strict');
const test = require('node:test');
const helpers = require('../main/pi-session/session-helpers');

test('internal context is removed before automatic title truncation while literal examples stay visible', () => {
  const connector = require('../main/pi-session/connector-context.cjs');
  const plugins = require('../main/pi-session/plugin-context');
  const raw = connector.augment(plugins.augment('短标题', [
    { pluginId: 'fixture', name: 'Fixture', context: 'private-plugin-guide' },
  ]), 'private-connector-guide');
  for (const firstMessage of [raw, [{ type: 'text', text: raw }], { text: raw }]) {
    assert.equal(helpers.title({ firstMessage }), '短标题');
  }
  for (const literal of [
    '示例 ' + connector.START + 'example' + connector.END,
    '示例\n\n' + connector.START + '\n{"example":true}\n' + connector.END,
    '示例\n\n' + connector.START + '\n{"runtimeGuide":"example"}\n' + connector.END + '\n继续解释',
  ]) assert.equal(helpers.title({ firstMessage: literal }), literal.replace(/\s+/g, ' ').trim().slice(0, 40));
  for (const key of ['userTitle', 'customTitle']) {
    assert.equal(helpers.title({ [key]: raw, firstMessage: 'ignored' }), raw.replace(/\s+/g, ' ').trim().slice(0, 40));
  }
});

test('session helper keeps the first request as the stable conversation title', () => {
  assert.equal(helpers.title({ name: 'later', firstMessage: '  first   request  ' }), 'first request');
  assert.equal(helpers.title({
    firstMessage: [{ type: 'text', text: 'block title' }, { type: 'image', path: 'ignored' }],
  }), 'block title');
  assert.equal(helpers.title({ firstMessage: {}, name: '' }), '\u672a\u547d\u540d\u5bf9\u8bdd');
});

test('session helper returns the latest visible assistant text for review', () => {
  assert.equal(helpers.lastAssistantText({ messages: [
    { role: 'assistant', blocks: [{ kind: 'text', text: 'first' }] },
    { role: 'tool', blocks: [{ kind: 'text', text: 'tool' }] },
    { role: 'assistant', blocks: [{ kind: 'text', text: 'latest' }] },
  ] }), 'latest');
  assert.equal(helpers.lastAssistantText({ messages: [] }), '');
});

test('session helper turns runtime loading failures into actionable product errors', () => {
  assert.match(helpers.explain(new Error('ERR_MODULE_NOT_FOUND')), /pi/);
  assert.match(helpers.explain(new Error('markAsUncloneable missing')), /Electron 35/);
  assert.match(helpers.explain(new Error('boom')), /boom/);
});
