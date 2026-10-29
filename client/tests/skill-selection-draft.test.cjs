'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const read = name => fs.readFileSync(path.join(__dirname, '../components/panels', name), 'utf8');
function element() {
  const events = new Map(), classes = new Set();
  return { value: '', selectionStart: 0, innerHTML: '', dataset: {}, style: {},
    classList: { add: name => classes.add(name), remove: name => classes.delete(name),
      contains: name => classes.has(name), toggle: (name, on) => on ? classes.add(name) : classes.delete(name) },
    setAttribute() {}, removeAttribute() {}, appendChild() {}, contains() { return false; },
    addEventListener(name, fn) { events.set(name, fn); },
    dispatchEvent(event) { events.get(event.type)?.(event); return true; },
    setSelectionRange(start) { this.selectionStart = start; }, focus() {},
  };
}
function fixture(storage = new Map()) {
  const input = element(), host = element(), notices = [];
  const document = { createElement: element, addEventListener() {}, getElementById: () => input };
  const localStorage = { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  const global = { document, localStorage, Event, setTimeout, clearTimeout, petSay: text => notices.push(text) };
  global.window = global;
  for (const file of ['compose-candidate-navigation.js', 'panels-compose-skills.js', 'chat-draft-recovery.js']) vm.runInNewContext(read(file), global);
  const ctx = { _draftKey: 'chat-A', _draftStorageKey: 'fixture-drafts', _draftStorageLoaded: false,
    _draftStorageTimer: 0, _draftScopeEpoch: 0, _viewEpoch: 0, _conversationDrafts: new Map(),
    _failedConversationDrafts: new Map(), _submissionDrafts: new Map(), _ref: 'ref-A',
    _runtimeBusy: () => false, _mount: () => ({ querySelector: () => input }), _render() {} };
  ctx._skillPicker = global.ComposeSkills.create({ input, host, onChange() { ctx._rememberConversationDraft?.(); } });
  Object.assign(ctx, global.ChatDraftRecovery.create(ctx));
  return { input, ctx, global, storage, notices, finish: () => ctx._flushConversationDrafts() };
}

test('restored picked skills survive catalog loading and loss of availability until freshly validated', () => {
  const f = fixture();
  f.ctx._skillPicker.restore?.(['company-research']);
  assert.deepEqual(Array.from(f.ctx._skillPicker.selected()), ['company-research']);
  f.ctx._skillPicker.setItems([{ name: 'company-research', selectable: true }]);
  f.ctx._skillPicker.setItems([]);
  assert.deepEqual(Array.from(f.ctx._skillPicker.selected()), ['company-research']);
  f.ctx._skillPicker.setError('offline');
  assert.deepEqual(Array.from(f.ctx._skillPicker.selected()), ['company-research']);
  f.ctx._skillPicker.consume(['company-research']);
  assert.deepEqual(Array.from(f.ctx._skillPicker.selected()), []);
  f.finish();
});

test('selected-only and text-plus-skill drafts persist in the existing row and restore independently of body markers', () => {
  const storage = new Map(), f = fixture(storage);
  f.input.value = '#1 写作文\n#2 去AI味';
  f.ctx._skillPicker.restore?.(['company-research']);
  f.ctx._rememberConversationDraft(); f.finish();
  assert.deepEqual(JSON.parse(storage.get('fixture-drafts'))[0].skills, ['company-research']);
  assert.equal(JSON.parse(storage.get('fixture-drafts'))[0].text, '#1 写作文\n#2 去AI味');
  const reopened = fixture(storage);
  reopened.ctx._restoreConversationDraft('chat-A');
  assert.equal(reopened.input.value, '#1 写作文\n#2 去AI味');
  assert.deepEqual(Array.from(reopened.ctx._skillPicker.selected()), ['company-research']);
  reopened.input.value = ''; reopened.ctx._rememberConversationDraft(); reopened.finish();
  const emptyReopened = fixture(storage); emptyReopened.ctx._restoreConversationDraft('chat-A');
  assert.equal(emptyReopened.input.value, '');
  assert.deepEqual(Array.from(emptyReopened.ctx._skillPicker.selected()), ['company-research']);
  emptyReopened.ctx._clearConversationDraftScope(); emptyReopened.finish();
  assert.deepEqual(Array.from(emptyReopened.ctx._skillPicker.selected()), []);
  assert.equal(storage.has('fixture-drafts'), false);
});

test('old text-only drafts never recover skills from the body', () => {
  const storage = new Map([['fixture-drafts', JSON.stringify([{ key: 'chat-A', text: '#web-audit 核对报告', updatedAt: 1 }])]]);
  const f = fixture(storage); f.ctx._restoreConversationDraft('chat-A');
  assert.equal(f.input.value, '#web-audit 核对报告');
  assert.deepEqual(Array.from(f.ctx._skillPicker.selected()), []); f.finish();
});

test('failed send restores picked metadata and text, without overriding a new selected skill', () => {
  const f = fixture(), draft = { text: '#1 写作文', files: [], plugins: [], skills: ['company-research'] };
  f.ctx._restoreFailedDraft(draft);
  assert.equal(f.input.value, '#1 写作文');
  assert.deepEqual(Array.from(f.ctx._skillPicker.selected()), ['company-research']);
  f.input.value = ''; f.ctx._skillPicker.restore(['web-audit']);
  f.ctx._restoreFailedDraft(draft);
  assert.equal(f.input.value, '');
  assert.deepEqual(Array.from(f.ctx._skillPicker.selected()), ['web-audit']);
  f.finish();
});

test('opening the new-conversation entry restores its picked skill draft without persisting a reset between save and restore', () => {
  let pickerClosures = 0;
  const f = fixture(), panel = element(); panel.querySelector = () => f.input;
  f.global.global = f.global;
  Object.assign(f.global, { _panel: () => panel, _accessConsent: null, _chatOpenSeq: 0,
    _composeViewSeq: 0, _pluginResolveSeq: 0, _pluginSelectSeq: 0, _pluginResolveBusy: false,
    _pluginSelectError: '', _pluginSelectTask: Promise.resolve(), _entryContextPrompts: [],
    _setupRevision: 0, _accessExplicit: false, _workspace: {}, _usedAtts: [], _attachments: null,
    _pluginMention: null, _intent: null, _loadSetup() {}, setTab() {},
    _closeRequirementPicker() { pickerClosures++; },
    ComposeSurface: { newSessionWorkspace: () => ({}) },
    NativeChat: { rememberDraft: (...args) => f.ctx._rememberConversationText(...args),
      rememberComposerDraft: (...args) => f.ctx._rememberConversationDraft(...args),
      restoreComposerDraft: (...args) => f.ctx._restoreConversationDraft(...args),
      getDraft: key => f.ctx._conversationDraftText(key), getDraftSkills: key => f.ctx._conversationDraftSkills(key),
      clearDraft: key => f.ctx._clearConversationDraft(key), reset() {}, hasSession: () => false },
  });
  const source = read('panels-compose.js');
  vm.runInNewContext(read('compose-surface.js'), f.global);
  const surface = f.global.ComposeSurface.create(f.global);
  for (const key of ['_rememberComposeDraft', '_restoreComposeDraft', '_clearComposeDraft']) f.global[key] = surface[key];
  f.global.ComposeSurface.newSessionWorkspace = () => ({});
  vm.runInNewContext(source.slice(source.indexOf('  function openComposePanel(payload)'), source.indexOf('  function closeComposePanel()')), f.global);
  f.global._skillPicker = f.global.ComposeSkills.create({ input: f.input, host: element(),
    onChange: () => f.global._rememberComposeDraft() });
  f.input.value = '#1 写作文\n#2 去AI味';
  f.global._skillPicker.restore(['company-research']);
  assert.equal(f.global.openComposePanel({ newSession: true }), true);
  assert.equal(pickerClosures, 1, 'the previous requirement picker closes before restoring the new draft');
  assert.equal(f.input.value, '#1 写作文\n#2 去AI味');
  assert.deepEqual(Array.from(f.global._skillPicker.selected()), ['company-research']);
  assert.deepEqual(Array.from(f.ctx._conversationDraftSkills('new')), ['company-research']);
  assert.equal(f.global.openComposePanel({ newSession: true, prefill: '/login is ordinary text' }), true);
  assert.equal(pickerClosures, 2, 'prefilled entry also dismisses the previous requirement picker');
  assert.equal(f.input.value, '/login is ordinary text');
  assert.deepEqual(Array.from(f.global._skillPicker.selected()), []);
  f.finish();
});
