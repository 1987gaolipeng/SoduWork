'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = name => fs.readFileSync(path.join(__dirname, '../components/panels', name + '.js'), 'utf8');

function fixture(kind, picked) {
  const scope = { Event: class Event { constructor(type) { this.type = type; } }, console };
  scope.window = scope;
  for (const name of ['plugin-ui-host', 'compose-candidate-navigation', 'chat-plugin-mention-model',
    'chat-plugin-mention', 'panels-compose-work-actions', 'panels-chat-work-actions'])
    vm.runInNewContext(source(name), scope);
  scope.PluginUIHost.registerAction({ id: 'work.automation.create', command: '自动化', open() {} });
  scope.PluginUIHost.registerAction({ id: 'work.requirement.create', command: '需求', open() {} });
  const action = picked ? scope.PluginUIHost.actions().find(row => row.id === 'work.automation.create') : null;
  if (picked === 'unavailable') scope.PluginUIHost.unregisterAction(action.id);
  const input = { value: '', style: {}, dispatchEvent() {}, focus() {} };
  let opened, clearCount = 0;
  const mention = { action: () => action, commandText: text => scope.ChatPluginMention.commandText(action, text), clearAction() { clearCount++; } };
  scope.NativeChat = { prepare() {}, clearDraft() {}, openWorkAction: async (command, options) => { opened = { command, options }; return true; } };
  const route = (text, visibleText = text) => {
    input.value = visibleText;
    const o = { text, input, pluginMention: mention, mention, panel: { dataset: { stage: 'compose' } }, attachments: { analysis: async () => [] } };
    return kind === 'compose' ? scope.ComposeWorkActions.route(o)
      : scope.ChatWorkActions.route(o, { open: scope.NativeChat.openWorkAction });
  };
  return { route, input, opened: () => opened, clearCount: () => clearCount };
}

for (const kind of ['compose', 'chat']) {
  test(kind + ': unavailable explicit selection preserves the prompt instead of sending an ordinary turn', async () => {
    const text = '按选中的能力执行这条任务';
    const f = fixture(kind, 'unavailable'), result = await f.route(text);
    assert.equal(result.handled, true);
    assert.equal(result.accepted, false);
    assert.equal(f.input.value, text);
    assert.equal(f.opened(), undefined);
    assert.equal(f.clearCount(), 0);
  });
  for (const text of ['/自动化 每天执行 #1', '/需求 帮我分析 /login 路径', '#1 帮我写一篇500字的作文\n#2 帮我去AI味']) {
    test(kind + ': unselected slash/hash text reaches ordinary sending intact: ' + text.split('\n')[0], async () => {
      const f = fixture(kind, false), result = await f.route(text);
      assert.equal(result.handled, false);
      assert.equal(f.input.value, text);
      assert.equal(f.opened(), undefined);
      assert.equal(f.clearCount(), 0);
    });
  }
  test(kind + ': explicit picker selection owns routing and preserves slash/hash inside body', async () => {
    const text = '/需求 是需要分析的原文，/login 和 #1 保留。';
    const f = fixture(kind, true), result = await f.route(text);
    assert.equal(result.accepted, true);
    assert.equal(f.opened().command.id, 'work.automation.create');
    assert.equal(f.opened().command.text, text);
    assert.equal(f.input.value, '');
  });
  test(kind + ': a folded request uses its full original body while the composer remains empty', async () => {
    const text = '  #1 原始要求\r\n' + '要求'.repeat(900) + '\n  ';
    const f = fixture(kind, true), result = await f.route(text, '');
    assert.equal(result.accepted, true);
    assert.equal(f.opened().command.text, text);
    if (kind === 'chat') assert.equal(f.opened().command.parseText, text);
  });
}
