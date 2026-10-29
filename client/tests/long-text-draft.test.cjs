'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../components/panels/chat-draft-recovery.js'), 'utf8');

// The attachment controller owns the unforgeable File -> input text mapping.
// Keep the fixture at that public boundary so these tests isolate draft recovery.
function fixture(storage = new Map()) {
  const texts = new WeakMap(), events = [], notices = [], timers = new Map();
  let files = [], api;
  const input = { value: '', focus() {}, dispatchEvent() { api._rememberConversationDraft(); } };
  function textFile(text) {
    const file = new File([text], 'input.txt', { type: 'text/plain' });
    texts.set(file, text); return file;
  }
  const attachments = {
    files: () => files.slice(),
    submissionText: typed => files.map(file => texts.get(file) || '').join('') + String(typed || ''),
    clear() { files = []; api?._rememberConversationDraft(); },
    add(rows) { files.push(...rows); api?._rememberConversationDraft(); },
    foldInput() {
      if (Array.from(input.value).length <= 1500) return false;
      files.push(textFile(input.value)); input.value = '';
      api?._rememberConversationDraft(); return true;
    },
  };
  const ctx = {
    _ref: 'ref-a', _sessionId: 'a', _draftKey: 'a', _draftScopeEpoch: 0, _viewEpoch: 0,
    _conversationDrafts: new Map(), _failedConversationDrafts: new Map(), _submissionDrafts: new Map(),
    _draftStorageLoaded: false, _draftStorageTimer: 0, _draftStorageKey: 'drafts',
    _messageAttachments: attachments, _retryDraft: null, _snap: { status: 'idle' },
    _mount: () => ({ querySelector: () => input }), _runtimeBusy: () => false, _render() {},
  };
  const window = { ConversationAttachments: { inputText: file => texts.get(file) },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) } };
  vm.runInNewContext(source, { window, document: { getElementById: () => input }, Event: class {},
    setTimeout(fn) { const id = timers.size + 1; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    petSay: text => notices.push(text) });
  api = window.ChatDraftRecovery.create(ctx);
  function switchTo(key) {
    api._rememberConversationDraft(); ctx._draftKey = key; ctx._sessionId = key; ctx._ref = 'ref-' + key;
    api._restoreConversationDraft(); events.push(key);
  }
  return { api, ctx, input, attachments, storage, notices, textFile, switchTo };
}
const original = '  用户原始需求\r\n'.repeat(180) + '\n保留尾部 CSV 约束  ';

test('folded prompt plus later typing is mirrored as exact full text and restored once across chats', () => {
  const h = fixture(), reference = new File(['ordinary external text'], 'external.txt');
  h.attachments.add([h.textFile(original), reference]); h.input.value = '\n补充一句';
  h.switchTo('b'); h.input.value = 'B draft'; h.switchTo('a');
  assert.equal(h.attachments.submissionText(h.input.value), original + '\n补充一句');
  assert.equal(h.attachments.files().filter(file => file === reference).length, 1);
  assert.equal(h.attachments.files().length, 2, 'only one regenerated body card plus ordinary attachment');
  h.api._flushConversationDrafts();
  const saved = JSON.parse(h.storage.get('drafts')).find(row => row.key === 'a');
  assert.equal(saved.text, original + '\n补充一句');
  assert.doesNotMatch(h.storage.get('drafts'), /ordinary external text|external\.txt/);
  h.switchTo('b'); assert.equal(h.input.value, 'B draft');
});

test('a fresh window recreates folded input from the persistent logical text, never from an uploaded TXT', () => {
  const first = fixture();
  first.attachments.add([first.textFile(original)]); first.input.value = '\nwindow tail';
  first.api._rememberConversationDraft(); first.api._flushConversationDrafts();
  const restarted = fixture(first.storage); restarted.api._restoreConversationDraft();
  assert.equal(restarted.attachments.submissionText(restarted.input.value), original + '\nwindow tail');
  assert.equal(restarted.attachments.files().length, 1);
  restarted.attachments.clear(); restarted.input.value = '';
  restarted.attachments.add([Object.assign(new File([original], 'ordinary.txt'), { inputText: original, kind: 'text' })]);
  restarted.api._rememberConversationDraft(); restarted.api._flushConversationDrafts();
  assert.equal(restarted.api._conversationDraftText('a'), '');
  assert.equal(restarted.storage.has('drafts'), false, 'untrusted TXT bytes never become persisted instructions');
});

test('clearing account scope removes folded body, ordinary attachments, retry state and persistent text', () => {
  const h = fixture(); h.attachments.add([h.textFile(original), new File(['x'], 'private.txt')]);
  h.api._rememberConversationDraft(); h.api._flushConversationDrafts();
  h.ctx._retryDraft = { text: original, files: h.attachments.files(), plugins: [] };
  h.api._clearConversationDraftScope(); h.api._restoreConversationDraft();
  assert.equal(h.attachments.submissionText(h.input.value), '');
  assert.equal(h.attachments.files().length, 0); assert.equal(h.ctx._retryDraft, null);
  assert.equal(h.storage.has('drafts'), false);
});

for (const method of ['_restoreFailedDraft', '_restoreRetryDraft']) {
  test(method + ' restores the original body once even when the failed file snapshot contains its card', () => {
    const h = fixture(), reference = new File(['x'], 'reference.txt');
    const draft = { text: original, files: [h.textFile(original), reference], plugins: [], skills: [] };
    h.ctx._retryDraft = draft; h.api[method](draft);
    assert.equal(h.attachments.submissionText(h.input.value), original);
    assert.equal(h.attachments.files().length, 2);
    h.api._restoreFailedDraft(draft);
    assert.equal(h.attachments.submissionText(h.input.value), original, 'repeated restore must not duplicate body');
    assert.equal(h.attachments.files().length, 2);
    h.api._flushConversationDrafts();
    assert.equal(JSON.parse(h.storage.get('drafts'))[0].text, original);
  });
  for (const kind of ['body', 'ordinary-file']) {
    test(method + ' preserves a new ' + kind + ' draft with an empty textarea', () => {
      const h = fixture(), draft = { text: 'previous failed request', files: [], plugins: [], skills: [] };
      const current = kind === 'body' ? h.textFile(original) : new File(['new material'], 'new.txt');
      h.attachments.add([current]); h.ctx._retryDraft = draft;
      h.api._retainFailedConversationDraft('a', draft, 'late failure'); h.api[method](draft);
      assert.equal(h.input.value, ''); assert.equal(h.attachments.files()[0], current);
      assert.equal(h.ctx._retryDraft, draft); assert.ok(h.notices.length);
      assert.equal(h.api._conversationDraftText('a'), kind === 'body' ? original : '');
    });
  }
}

test('late failures do not inject text into an attachment-only draft saved in another chat', () => {
  const h = fixture(), reference = new File(['new material'], 'new.txt');
  h.attachments.add([reference]); h.switchTo('b');
  h.api._retainFailedConversationDraft('a', { text: 'old request', files: [], plugins: [] }, 'late failure');
  h.switchTo('a');
  assert.equal(h.input.value, ''); assert.deepEqual(h.attachments.files(), [reference]);
});

test('an extra pasted copy of the same attachment is a new draft and cannot be discarded by recovery', () => {
  const h = fixture(), file = new File(['same clipboard image'], 'same.png');
  const draft = { text: 'old request', files: [file], plugins: [] };
  h.attachments.add([file, file]); h.ctx._retryDraft = draft; h.api._restoreRetryDraft();
  assert.equal(h.ctx._retryDraft, draft); assert.equal(h.attachments.files().length, 2);
  assert.equal(h.input.value, ''); assert.ok(h.notices.length);
});

function realAttachmentFixture() {
  const listeners = new Map(), notices = [], timers = new Map();
  const input = { value: '', focus() {},
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    dispatchEvent(event) { for (const fn of listeners.get(event.type) || []) fn(event); } };
  const sandbox = { File, Blob, URL, Uint8Array, Event, Intl, document: { getElementById: () => input },
    setTimeout(fn) { const id = timers.size + 1; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    petSay: value => notices.push(value) };
  sandbox.window = sandbox; vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/panels/conversation-attachments.js'), 'utf8'), sandbox);
  vm.runInContext(source, sandbox);
  let api;
  const attachments = sandbox.ConversationAttachments.create({ input, onChange: () => api?._rememberConversationDraft() });
  const ctx = { _ref: 'ref-a', _sessionId: 'a', _draftKey: 'a', _draftScopeEpoch: 0, _viewEpoch: 0,
    _conversationDrafts: new Map(), _failedConversationDrafts: new Map(), _submissionDrafts: new Map(),
    _draftStorageLoaded: true, _messageAttachments: attachments, _retryDraft: null, _snap: { status: 'idle' },
    _mount: () => ({ querySelector: () => input }), _runtimeBusy: () => false, _render() {} };
  api = sandbox.ChatDraftRecovery.create(ctx);
  input.addEventListener('input', () => api._rememberConversationDraft());
  return { input, ctx, attachments, api, notices };
}
const hydrate = () => new Promise(resolve => setImmediate(resolve));
for (const kind of ['hydrated-file', 'native-reference']) {
  test('manual retry recognizes the same restored ' + kind + ' after controller copying', async () => {
    const h = realAttachmentFixture();
    const sourceFile = kind === 'native-reference'
      ? { nativeReference: true, name: 'reference.txt', path: 'C:/fixture/reference.txt', size: 3 }
      : new File(['ordinary reference'], 'reference.txt', { type: 'text/plain' });
    h.attachments.add([sourceFile]); await hydrate();
    const draft = { text: original, files: h.attachments.files(), plugins: [], skills: [] };
    h.attachments.clear(); h.ctx._retryDraft = draft;
    h.api._restoreFailedDraft(draft); await hydrate();
    h.api._restoreRetryDraft(); await hydrate();
    assert.equal(h.ctx._retryDraft, null, 'controller copies are not new user input');
    assert.equal(h.attachments.submissionText(h.input.value), original);
    assert.equal(h.attachments.files().length, 2);
    assert.deepEqual(h.notices, []);
  });
}

test('a separately selected file with the same metadata is still protected from a late recovery', async () => {
  const h = realAttachmentFixture();
  h.attachments.add([new File(['old'], 'same.txt', { type: 'text/plain', lastModified: 1 })]); await hydrate();
  const draft = { text: 'old failed request', files: h.attachments.files(), plugins: [], skills: [] };
  h.attachments.clear();
  h.attachments.add([new File(['new'], 'same.txt', { type: 'text/plain', lastModified: 1 })]); await hydrate();
  h.ctx._retryDraft = draft; h.api._restoreRetryDraft();
  assert.equal(h.ctx._retryDraft, draft); assert.equal(h.input.value, '');
  assert.equal(await h.attachments.files()[0].text(), 'new'); assert.ok(h.notices.length);
});

test('restoring a failed send retains two intentionally pasted copies of one ordinary file', async () => {
  const h = realAttachmentFixture(), file = new File(['reference'], 'pasted.txt', { type: 'text/plain', lastModified: 1 });
  const draft = { text: original, files: [file, file], plugins: [], skills: [] };
  h.api._restoreFailedDraft(draft); await hydrate();
  assert.equal(h.attachments.files().length, 3, 'one prompt card and both pasted references');
  assert.equal(h.attachments.submissionText(h.input.value), original);
});
