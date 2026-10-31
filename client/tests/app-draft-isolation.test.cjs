'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
test('new App drafts are isolated from the outer composer and each other, existing conversation drafts remain shared', () => {
  const storage = new Map();
  function create(appId) {
    const input = { value: '', dispatchEvent() {} }, ctx = { _draftKey: 'new', _conversationDrafts: new Map(),
      _failedConversationDrafts: new Map(), _draftStorageKey: 'drafts' };
    const window = { __deskPanel: appId ? 'chatbar' : 'workspace', location: { search: appId ? '?appDraft=' + encodeURIComponent(appId) : '' },
      localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) } };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../components/panels/chat-draft-recovery.js'), 'utf8'), {
      window, document: { getElementById: () => input }, Event: class {}, URLSearchParams, setTimeout: () => 1, clearTimeout() {},
    });
    const api = window.ChatDraftRecovery.create(ctx);
    return { input, api, ctx };
  }
  const outer = create(); outer.api._rememberConversationText('new', 'outer unfinished draft'); outer.api._flushConversationDrafts();
  const a = create('plugin:local:a'); a.api._restoreConversationDraft('new'); assert.equal(a.input.value, '');
  a.api._rememberConversationText('new', 'app A draft'); a.api._flushConversationDrafts();
  const b = create('plugin:local:b'); b.api._restoreConversationDraft('new'); assert.equal(b.input.value, '');
  const reopened = create('plugin:local:a'); reopened.api._restoreConversationDraft('new'); assert.equal(reopened.input.value, 'app A draft');
  const outsideAgain = create(); outsideAgain.api._restoreConversationDraft('new'); assert.equal(outsideAgain.input.value, 'outer unfinished draft');
  reopened.api._rememberConversationText('existing-id', 'conversation draft'); reopened.api._flushConversationDrafts();
  const elsewhere = create('plugin:local:b'); elsewhere.api._restoreConversationDraft('existing-id'); assert.equal(elsewhere.input.value, 'conversation draft');
});
