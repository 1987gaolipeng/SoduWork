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

test('attachment transport metadata never leaks into automatic conversation titles', () => {
  const contract = require('../main/pi-session/attachment-contract');
  const raw = contract.augment('整理附件', [{ name: '步骤.md', path: 'inputs/步骤.md' }]);
  assert.equal(helpers.title({ firstMessage: raw }), '整理附件');
  assert.equal(helpers.title({ userTitle: raw }), raw.replace(/\s+/g, ' ').trim().slice(0, 40));
  const literal = '示例\n\n' + contract.START + '\n{"example":true}\n' + contract.END;
  assert.equal(helpers.title({ firstMessage: literal }), literal.replace(/\s+/g, ' ').trim().slice(0, 40));
});

test('legacy persisted titles with truncated attachment metadata recover from the archived first request', () => {
  const contract = require('../main/pi-session/attachment-contract');
  const firstMessage = contract.augment('整理两份附件并输出结论', [
    { name: '步骤.md', path: 'inputs/步骤.md' },
    { name: '资料.docx', path: 'inputs/资料.docx' },
  ]);
  const polluted = '整理两份附件并输出结论 ' + contract.START + ' {"files":[{';
  assert.equal(helpers.repairPersistedTitle(polluted, firstMessage), '整理两份附件并输出结论');
  assert.equal(helpers.repairPersistedTitle('用户输入 ' + contract.START + ' example', '另一条请求'),
    '用户输入 ' + contract.START + ' example');
});

test('live titles hide a truncated attachment envelope when no archive reference is available', () => {
  const contract = require('../main/pi-session/attachment-contract');
  const polluted = '把更好的复何汉及 ' + contract.START + ' {"files":[{';
  assert.equal(helpers.title({ firstMessage: polluted }), '把更好的复何汉及');
  const literal = '用户示例 ' + contract.START + ' {"fuzzy":true}';
  assert.equal(helpers.title({ firstMessage: literal }), literal.slice(0, 40));
});

test('legacy persisted titles with truncated plugin metadata recover from the archived first request', () => {
  const connector = require('../main/pi-session/connector-context.cjs');
  const plugins = require('../main/pi-session/plugin-context');
  const firstMessage = plugins.augment(connector.augment('你好', 'private connector guide'), [
    { pluginId: 'fixture', name: 'Fixture', context: 'private plugin guide' },
  ]);
  const polluted = '你好 ' + plugins.START + ' {"plugins"';
  assert.equal(helpers.repairPersistedTitle(polluted, firstMessage), '你好');
  assert.equal(helpers.repairPersistedTitle('用户输入 ' + plugins.START + ' example', '另一条请求'),
    '用户输入 ' + plugins.START + ' example');
});

test('legacy persisted titles with truncated connector metadata recover from the archived first request', () => {
  const connector = require('../main/pi-session/connector-context.cjs');
  const firstMessage = connector.augment('整理连接器数据', 'private connector guide');
  const polluted = '整理连接器数据 ' + connector.START + ' {"runtimeGuide"';
  assert.equal(helpers.repairPersistedTitle(polluted, firstMessage), '整理连接器数据');
  assert.equal(helpers.repairPersistedTitle('用户输入 ' + connector.START + ' example', '另一条请求'),
    '用户输入 ' + connector.START + ' example');
});

test('visible title cleanup removes every valid nested transport envelope without touching literal text', () => {
  const attachments = require('../main/pi-session/attachment-contract');
  const connector = require('../main/pi-session/connector-context.cjs');
  const plugins = require('../main/pi-session/plugin-context');
  const nested = attachments.augment(
    connector.augment(plugins.augment('多层材料请求', [
      { pluginId: 'fixture', name: 'Fixture', context: 'private plugin guide' },
    ]), 'private connector guide'),
    [{ name: '步骤.md', path: 'inputs/步骤.md' }],
  );
  assert.equal(helpers.title({ firstMessage: nested }), '多层材料请求');
  const literal = '用户示例 ' + attachments.START + ' example ' + attachments.END;
  assert.equal(helpers.title({ firstMessage: literal }), literal.slice(0, 40));
});

test('material context after attachments and connectors cannot pollute the title', () => {
  const attachments = require('../main/pi-session/attachment-contract');
  const connector = require('../main/pi-session/connector-context.cjs');
  const material = require('../main/pi-session/input-context.cjs');
  const raw = material.augment(
    connector.augment(
      attachments.augment('真实用户标题', [{ name: '资料.md', path: 'inputs/资料.md' }]),
      'private connector guide',
    ),
    '<soduwork-conversation-input-understanding>evidence</soduwork-conversation-input-understanding>',
  );
  assert.equal(helpers.title({ firstMessage: raw }), '真实用户标题');
  const polluted = '真实用户标题 ' + material.START + ' {"context":"partial';
  assert.equal(helpers.repairPersistedTitle(polluted, '真实用户标题'), '真实用户标题');
});

test('visible title projection returns an empty value for protocol-only text', () => {
  const connector = require('../main/pi-session/connector-context.cjs');
  const plugins = require('../main/pi-session/plugin-context');
  const raw = connector.augment(plugins.augment('', [
    { pluginId: 'fixture', name: 'Fixture', context: 'private instructions' },
  ]), 'private connector instructions');
  assert.equal(helpers.visibleTitleText(raw), '');
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
