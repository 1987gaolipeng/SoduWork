'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

test('main conversation actions never redirect independent app sidebars; sidebar receipts still refresh history', async () => {
  const listeners = {}, pushed = [], navigation = [];
  let refreshed = 0;
  const NativeChat = { enter: async () => 'entered', send: async () => 'sent', reset: async () => 'reset',
    sessionInfo: () => ({ sessionId: 'main-conversation' }), refreshHistory: () => refreshed++ };
  const original = { ...NativeChat };
  const workPreview = { composerState: value => pushed.push(value),
    onComposerHello: fn => { listeners.hello = fn; },
    onComposerRefresh: fn => { listeners.refresh = fn; },
    onAppsManage: fn => { listeners.manage = fn; } };
  const window = { NativeChat, soduWorkAPI: { workPreview }, WorkspaceHost: { open: key => navigation.push(key) } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/app-composer-bridge.js'), 'utf8'), { window, NativeChat });
  listeners.hello?.({ tabId: 'app-one' }); listeners.hello?.({ tabId: 'app-two' });
  for (const action of ['enter', 'send', 'reset']) {
    assert.equal(NativeChat[action], original[action]);
    await NativeChat[action]();
  }
  assert.deepEqual(pushed, []);
  listeners.refresh(); assert.equal(refreshed, 1);
  listeners.manage(); assert.deepEqual(navigation, ['apps']);
});
