'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../components/panels/chat-draft-recovery.js'), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));

function harness(options = {}) {
  const storage = new Map(), notices = [], restored = [], timers = new Map();
  let picks = [], action = null, files = [];
  const input = { value: '', dispatchEvent() {}, focus() {} };
  const picker = {
    selected: () => picks,
    draft: () => picks,
    action: () => action,
    restore(rows) { picks = copy(rows); restored.push(copy(rows)); },
    clear() { picks = []; action = null; },
  };
  const ctx = {
    _ref: 'ref-a', _sessionId: 'a', _draftKey: 'a', _draftScopeEpoch: 0, _viewEpoch: 0,
    _conversationDrafts: new Map(), _failedConversationDrafts: new Map(), _submissionDrafts: new Map(),
    _draftStorageLoaded: true, _draftStorageTimer: 0, _draftStorageKey: 'drafts',
    _pluginMention: picker, _retryDraft: null, _snap: { status: 'idle', activePlugins: ['sent-plugin'] },
    _messageAttachments: { files: () => files, add: rows => {
      files.push(...rows); if (options.notifyAttachments) api._rememberConversationDraft();
    }, clear: () => { files = []; } },
    _mount: () => ({ querySelector: () => input }), _runtimeBusy: () => false, _render() {},
  };
  const window = { localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key) } };
  vm.runInNewContext(source, { window, document: { getElementById: () => input }, Event: class {},
    setTimeout(fn) { const key = timers.size + 1; timers.set(key, fn); return key; }, clearTimeout(key) { timers.delete(key); },
    petSay: value => notices.push(value) });
  const api = window.ChatDraftRecovery.create(ctx);
  function switchTo(key) {
    api._rememberConversationDraft();
    ctx._ref = ''; ctx._draftKey = key; ctx._sessionId = key; picks = []; action = null; files = [];
    input.value = api._conversationDraftText(key);
    // Block mount-time empty control callbacks from overwriting restored drafts.
    api._withConversationDraftRestore(() => api._rememberConversationDraft());
    api._restoreConversationDraft();
    ctx._ref = 'ref-' + key;
  }
  return { ctx, api, picker, input, storage, notices, restored, switchTo,
    pick(rows) { picks = rows; }, picks: () => picks, action(value) { action = value; },
    files(rows) { files = rows; }, getFiles: () => files };
}
const plugin = (pluginId, inputValues) => ({ pluginId, name: pluginId, ...(inputValues ? { inputValues } : {}) });
const failed = () => ({ text: 'failed request', plugins: [plugin('a', { roomId: 'original' })], files: [] });

test('unsent plugins and parameters survive A to B to A without borrowing active session plugins', () => {
  const h = harness(), draft = plugin('draft-a', { roomId: 'room-1', seats: 4, online: true });
  h.pick([draft]); h.input.value = 'unsent A'; h.files([{ name: 'A.txt' }]);
  h.switchTo('b');
  assert.deepEqual(h.picks(), [], 'runtime activePlugins must not refill a composer');
  h.pick([plugin('draft-b')]); h.input.value = 'unsent B';
  draft.inputValues.roomId = 'changed outside the saved draft';
  h.switchTo('a');
  assert.equal(h.input.value, 'unsent A');
  assert.deepEqual(h.picks(), [plugin('draft-a', { roomId: 'room-1', seats: 4, online: true })]);
  assert.equal(h.getFiles()[0].name, 'A.txt');
  h.switchTo('b');
  assert.equal(h.picks()[0].pluginId, 'draft-b');
});

test('plugin-only drafts survive switching and remain absent from persistent text storage', () => {
  const h = harness();
  h.pick([plugin('private-plugin', { roomId: 'private-room' })]);
  h.switchTo('b'); h.api._flushConversationDrafts();
  assert.equal(h.storage.size, 0);
  h.switchTo('a');
  assert.equal(h.input.value, ''); assert.equal(h.picks()[0].inputValues.roomId, 'private-room');
  h.input.value = 'ordinary text'; h.api._rememberConversationDraft(); h.api._flushConversationDrafts();
  assert.equal(JSON.parse(h.storage.get('drafts'))[0].text, 'ordinary text');
  assert.doesNotMatch(h.storage.get('drafts'), /private-plugin|private-room|inputValues/);
});

test('restoring attachments cannot overwrite plugins or skills through synchronous change callbacks', () => {
  const h = harness({ notifyAttachments: true });
  let skills = ['report'];
  h.ctx._skillPicker = { selected: () => skills, restore(names) {
    skills = names.slice(); h.api._rememberConversationDraft();
  } };
  h.pick([plugin('draft-a', { roomId: 'room-1' })]); h.files([{ name: 'A.png' }]);
  h.api._rememberConversationDraft();
  h.pick([]); h.files([]); skills = [];
  h.api._restoreConversationDraft();
  assert.deepEqual(h.picks(), [plugin('draft-a', { roomId: 'room-1' })]);
  assert.deepEqual(Array.from(skills), ['report']);
  h.api._restoreConversationDraft();
  assert.deepEqual(h.picks(), [plugin('draft-a', { roomId: 'room-1' })]);
});

test('legacy selected fallback stores only safe plugin draft fields', () => {
  const h = harness(); delete h.picker.draft;
  h.pick([{ ...plugin('fallback'), context: 'hidden instructions', capabilities: { runtime: ['computer'] }, grant: 'secret' }]);
  h.switchTo('b'); h.switchTo('a');
  assert.deepEqual(h.picks(), [plugin('fallback')]);
});

test('consumed drafts and account changes cannot restore stale plugin selections', () => {
  const h = harness(); h.pick([plugin('a', { roomId: 'private' })]);
  h.api._rememberConversationDraft(); h.api._clearConversationDraft(); h.pick([]);
  h.switchTo('b'); h.switchTo('a'); assert.deepEqual(h.picks(), []);
  h.pick([plugin('new-a')]); h.api._rememberConversationDraft(); h.api._clearConversationDraftScope();
  h.switchTo('b'); h.switchTo('a'); assert.deepEqual(h.picks(), []);
});

for (const kind of ['different-plugin', 'different-parameters', 'action']) {
  for (const method of ['_restoreFailedDraft', '_restoreRetryDraft']) {
    test(method + ' preserves a new ' + kind + ' draft even without text', () => {
      const h = harness(), draft = failed();
      if (kind === 'action') h.action({ actionId: 'work.new' });
      else h.pick([plugin(kind === 'different-plugin' ? 'b' : 'a', { roomId: 'new-room' })]);
      const before = copy(h.picks()); h.ctx._retryDraft = draft;
      h.api._retainFailedConversationDraft('a', draft, 'failed receipt');
      h.api[method](draft);
      assert.equal(h.input.value, ''); assert.deepEqual(h.picks(), before);
      assert.equal(h.ctx._retryDraft, draft); assert.equal(h.restored.length, 0);
      assert.equal(h.api._conversationDraftText('a'), '');
      h.pick([]); h.action(null); h.api._restoreRetryDraft();
      assert.equal(h.input.value, draft.text); assert.deepEqual(h.picks(), draft.plugins);
      assert.equal(h.ctx._retryDraft, null);
    });
  }
}

test('a late failure cannot attach its text to a saved plugin-only draft in a background conversation', () => {
  const h = harness(); h.pick([plugin('new-a')]); h.switchTo('b');
  h.api._retainFailedConversationDraft('a', failed(), 'late failure');
  h.switchTo('a'); assert.equal(h.input.value, ''); assert.deepEqual(h.picks(), [plugin('new-a')]);
  h.api._restoreFailedDraft(failed()); assert.equal(h.input.value, ''); assert.deepEqual(h.picks(), [plugin('new-a')]);
});

test('an already restored draft remains recoverable with its original parameter values', () => {
  const h = harness(), draft = failed();
  h.ctx._retryDraft = draft; h.api._restoreFailedDraft(draft);
  h.api._restoreRetryDraft();
  assert.equal(h.input.value, draft.text); assert.deepEqual(h.picks(), draft.plugins);
  assert.equal(h.ctx._retryDraft, null);
});
