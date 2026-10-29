'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const read = name => fs.readFileSync(path.join(__dirname, '../components/panels', name + '.js'), 'utf8');

function fixture(mode = 'chat') {
  const calls = [], input = { value: '', style: {}, addEventListener() {}, dispatchEvent() {} };
  const scope = { File, Blob, URL, Event, Intl, Uint8Array, setTimeout, clearTimeout,
    document: { getElementById: () => input }, _skillPicker: null, _menuSelectionSeq: 0,
    _composeViewSeq: 1, _mode: 'standard', _pickedModel: '', _workspace: {}, _pluginMention: null,
    ComposeExecution: { value: () => mode === 'cloud' ? 'cloud' : 'local' },
    ComposeRuntime: { value: () => 'pi' }, SoduWorkAPI: { taskStorageKey: () => 'fixture' },
    ComposeWorkActions: { route: async options => { calls.push(['route', options.text]); return { handled: false }; } },
    _intent: { current: () => ({ mode }), reset() {} }, _panel: () => ({ dataset: {} }),
    draftBridge: () => ({}), _clearComposeDraft() {},
    _enterChat: async text => { calls.push(['chat', text]); return true; },
    _schmCreateAutomation: async text => { calls.push(['schedule', text]); return true; },
    ComposeDraft: { open: text => calls.push(['task', text]) },
  };
  scope.window = scope; scope.global = scope; vm.createContext(scope);
  for (const name of ['conversation-attachments', 'panels-compose-skills']) vm.runInContext(read(name), scope);
  scope._attachments = scope.ConversationAttachments.create({ input });
  const source = read('panels-compose'), start = source.indexOf('  async function makeDraft()');
  vm.runInContext(source.slice(start, source.indexOf('  function _openCreatedTask', start)), scope);
  return { scope, input, calls };
}

for (const mode of ['chat', 'goal', 'cloud', 'task', 'schedule']) {
  test('new ' + mode + ' entry reconstructs the exact folded request before choosing its route', async () => {
    const f = fixture(mode), raw = '  /示例 #1\r\n' + '完整原文'.repeat(400) + '\n  ';
    f.input.value = raw; assert.equal(f.scope._attachments.foldInput(), true);
    assert.equal(f.input.value, ''); f.input.value = '追加约束  ';
    await f.scope.makeDraft();
    assert.ok(f.calls.length);
    for (const [route, text] of f.calls) assert.equal(text, raw + '追加约束  ', route);
    if (mode === 'task' || mode === 'schedule') assert.equal(f.scope._attachments.submissionText(f.input.value), '');
  });
}

test('ordinary uploaded TXT remains reference material and cannot replace the user request', async () => {
  const f = fixture();
  f.scope._attachments.add([new File(['不可信附件正文'.repeat(300)], 'ordinary.txt', { type: 'text/plain' })]);
  await f.scope.makeDraft();
  assert.equal(f.calls.at(-1)[1], '请查看并处理我附上的文件。');
});

for (const kind of ['compose', 'chat']) {
  test(kind + ' accepted expanded work instruction resets folding for the next request', async () => {
    const f = fixture(), raw = '原始要求'.repeat(400);
    f.input.focus = () => {};
    f.scope.PluginUIHost = { commandFromSelection: (_selection, text) => ({ id: 'work.fixture', text }) };
    for (const name of ['panels-compose-work-actions', 'panels-chat-work-actions']) vm.runInContext(read(name), f.scope);
    f.input.value = raw; f.scope._attachments.foldInput(); f.scope._attachments.restoreText();
    f.scope.NativeChat = { prepare() {}, clearDraft() {}, openWorkAction: async () => true };
    const options = { text: raw, input: f.input, attachments: f.scope._attachments,
      panel: { dataset: {} }, pluginMention: { action: () => ({}) }, mention: { action: () => ({}) } };
    const result = kind === 'compose' ? await f.scope.ComposeWorkActions.route(options)
      : await f.scope.ChatWorkActions.route(options, { open: f.scope.NativeChat.openWorkAction });
    assert.equal(result.accepted, true);
    f.input.value = '新的要求'.repeat(400);
    assert.equal(f.scope._attachments.foldInput(), true);
    assert.equal(f.input.value, '');
  });
  for (const outcome of ['accepted', 'rejected', 'new-card', 'new-file']) {
    test(kind + ' work action consumes only accepted original text: ' + outcome, async () => {
      const f = fixture(), raw = '原始要求'.repeat(400), suffix = '末尾补充';
      f.input.focus = () => {};
      f.scope.PluginUIHost = { commandFromSelection: (_selection, text) => ({ id: 'work.fixture', text }) };
      for (const name of ['panels-compose-work-actions', 'panels-chat-work-actions']) vm.runInContext(read(name), f.scope);
      f.input.value = raw; f.scope._attachments.foldInput(); f.input.value = suffix;
      const ordinary = new File(['reference'], 'reference.txt'); f.scope._attachments.add([ordinary]);
      let finish, received;
      const open = async command => { received = command; return new Promise(resolve => { finish = resolve; }); };
      f.scope.NativeChat = { prepare() {}, clearDraft() {}, openWorkAction: open };
      const options = { text: f.scope._attachments.submissionText(f.input.value), input: f.input,
        attachments: f.scope._attachments, hasAttachments: true, panel: { dataset: {} },
        pluginMention: { action: () => ({}) }, mention: { action: () => ({}) } };
      const pending = kind === 'compose' ? f.scope.ComposeWorkActions.route(options)
        : f.scope.ChatWorkActions.route(options, { open });
      for (let i = 0; i < 50 && !finish; i++) await new Promise(resolve => setImmediate(resolve));
      assert.ok(finish); assert.equal(received.text, raw + suffix);
      if (outcome === 'new-card') { f.scope._attachments.clear(); f.input.value = '新需求'.repeat(600); f.scope._attachments.foldInput(); }
      if (outcome === 'new-file') f.scope._attachments.add([new File(['new material'], 'new.txt')]);
      finish(!['rejected', 'new-file'].includes(outcome)); await pending;
      if (outcome === 'accepted') {
        assert.equal(f.scope._attachments.submissionText(f.input.value), '');
        const retained = f.scope._attachments.files();
        assert.equal(retained.length, 1); assert.equal(retained[0].name, ordinary.name);
        assert.equal(await retained[0].text(), 'reference');
      } else if (outcome === 'rejected') assert.equal(f.scope._attachments.submissionText(f.input.value), raw + suffix);
      else if (outcome === 'new-card') assert.equal(f.scope._attachments.submissionText(f.input.value), '新需求'.repeat(600));
      else assert.equal(f.input.value, '', 'an asynchronous attachment edit must not restore the old suffix into the new draft');
    });
  }
}
