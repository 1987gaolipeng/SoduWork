'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const read = name => fs.readFileSync(path.join(__dirname, '../components/panels', name), 'utf8');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(kind, { slowAnalysis = false } = {}) {
  const original = '/自动化 每天9点执行。' + '完整任务要求。'.repeat(300);
  const open = deferred(), analysis = deferred();
  let draft = original, current = true, restoredAtMount;
  const input = { value: original, style: {}, isConnected: true, listeners: [],
    addEventListener(type, listener) { if (type === 'input') this.listeners.push(listener); },
    dispatchEvent() { draft = this.value; this.listeners.forEach(listener => listener()); }, focus() {} };
  const chat = kind === 'compose' ? { ...input, value: '', listeners: [] } : input;
  const scope = { console: { error() {} }, Event: class Event { constructor(type) { this.type = type; } },
    document: { getElementById: id => id === 'nchatInput' ? chat : input } };
  scope.window = scope;
  vm.runInNewContext(read('plugin-ui-host.js'), scope);
  scope.PluginUIHost.registerAction({ id: 'work.automation.create', command: '自动化', open() {} });
  let openForm = () => open.promise;
  scope.NativeChat = { clearDraft() { draft = ''; }, rememberComposerDraft() { chat.dispatchEvent(); },
    prepare() { restoredAtMount = draft; chat.value = draft; }, openWorkAction: () => openForm() };
  vm.runInNewContext(read('panels-' + (kind === 'compose' ? 'compose' : 'chat') + '-work-actions.js'), scope);
  const options = { text: original, input, panel: { dataset: { stage: 'compose' } }, hasAttachments: slowAnalysis,
    attachments: { analysis: () => slowAnalysis ? analysis.promise : Promise.resolve([]) }, isCurrent: () => current };
  options[kind === 'compose' ? 'pluginMention' : 'mention'] = {
    action: () => scope.PluginUIHost.actions()[0],
  };
  const start = () => kind === 'compose' ? scope.ComposeWorkActions.route(options)
    : scope.ChatWorkActions.route(options, { open: () => openForm() });
  return { original, input, chat, options, start, scope, draft: () => draft, mountedDraft: () => restoredAtMount,
    changeScope() { current = false; }, setOpen(callback) { openForm = callback; },
    finish(value) { analysis.resolve([]); open.resolve(value); } };
}

for (const kind of ['compose', 'chat']) {
  test(kind + ': clear input and stored draft before awaiting attachment analysis or the form', async () => {
    const f = fixture(kind, { slowAnalysis: true }), pending = f.start();
    try {
      assert.equal(f.input.value, '');
      assert.equal(f.draft(), '');
    } finally { f.finish(true); await pending; }
  });
  test(kind + ': successful late form response preserves the next typed draft', async () => {
    const f = fixture(kind), pending = f.start();
    await Promise.resolve(); await Promise.resolve();
    f.chat.value = '新的补充'; f.chat.dispatchEvent();
    f.finish(true); await pending;
    assert.equal(f.chat.value, '新的补充');
    assert.equal(f.draft(), '新的补充');
  });
  test(kind + ': failure restores the submitted prompt when no newer draft exists', async () => {
    const f = fixture(kind), pending = f.start(); f.finish(false);
    const result = await pending;
    assert.equal(result.accepted, false);
    assert.equal(f.input.value, f.original);
    assert.equal(f.draft(), f.original);
  });
  test(kind + ': failure cannot replace a newer draft or another view', async () => {
    const f = fixture(kind), pending = f.start();
    await Promise.resolve(); await Promise.resolve();
    f.chat.value = '下一条任务'; f.chat.dispatchEvent(); f.changeScope();
    f.finish(false); await pending;
    assert.equal(f.chat.value, '下一条任务'); assert.equal(f.draft(), '下一条任务');
  });
  test(kind + ': older failed submission cannot resurrect text after a newer submission', async () => {
    const f = fixture(kind), first = deferred(), second = deferred(); let count = 0;
    f.setOpen(() => (++count === 1 ? first.promise : second.promise));
    const waitForOpen = async expected => {
      for (let i = 0; count < expected && i < 10; i++) await Promise.resolve();
      assert.equal(count, expected);
    };
    const a = f.start(); await waitForOpen(1);
    f.input.value = '/自动化 B'; f.input.dispatchEvent(); f.options.text = f.input.value;
    const b = f.start(); await waitForOpen(2);
    first.resolve(false); await a; second.resolve(true); await b;
    assert.equal(f.input.value, ''); assert.equal(f.draft(), '');
  });
  test(kind + ': typing then deleting while pending still invalidates old failure recovery', async () => {
    const f = fixture(kind), pending = f.start(); await Promise.resolve(); await Promise.resolve();
    f.chat.value = '下一条'; f.chat.dispatchEvent(); f.chat.value = ''; f.chat.dispatchEvent();
    f.finish(false); await pending;
    assert.equal(f.chat.value, ''); assert.equal(f.draft(), '');
  });
  test(kind + ': late success does not consume an action after intervening edits', async () => {
    const f = fixture(kind), action = { id: 'work.automation.create', command: '自动化' }; let cleared = false;
    f.options[kind === 'compose' ? 'pluginMention' : 'mention'] = {
      commandText: text => text, action: () => action, clearAction() { cleared = true; },
    };
    const pending = f.start(); await Promise.resolve(); await Promise.resolve();
    f.chat.value = '新的补充'; f.chat.dispatchEvent(); f.chat.value = ''; f.chat.dispatchEvent();
    f.finish(true); await pending; assert.equal(cleared, false);
  });
}

test('compose: mounting the native chat cannot restore the submitted prompt during parsing', async () => {
  const f = fixture('compose'), pending = f.start();
  await Promise.resolve(); await Promise.resolve();
  try { assert.equal(f.mountedDraft(), ''); assert.equal(f.chat.value, ''); }
  finally { f.finish(true); await pending; }
});

test('compose: consuming the old input card cannot erase text typed in the newly mounted chat', async () => {
  const f = fixture('compose');
  f.options.attachments.consumeInputText = () => { f.scope.NativeChat.clearDraft(); return true; };
  const pending = f.start();
  await Promise.resolve(); await Promise.resolve();
  f.chat.value = 'Next unsent request'; f.chat.dispatchEvent();
  f.finish(true); await pending;
  assert.equal(f.chat.value, 'Next unsent request');
  assert.equal(f.draft(), 'Next unsent request');
});

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this._text = ''; }
  set textContent(value) { this._text = value; this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  setAttribute(key, value) { this.attributes[key] = value; }
  appendChild(node) { this.children.push(node); return node; }
}

test('plugin turn prompt folds long input while preserving complete escaped text', () => {
  const scope = { document: { createElement: tag => new Element(tag) } }; scope.window = scope;
  vm.runInNewContext(read('plugin-ui-host.js').replace('global.PluginUIHost = {', 'global.PluginUIHost = { turnPrompt,'), scope);
  const root = { parentElement: { insertBefore() {} } };
  const text = '首部\n<script>这只是文本</script>\n' + '执行要求。'.repeat(5000) + '\n尾部校验';
  const bubble = scope.PluginUIHost.turnPrompt(root, text).children[0];
  const details = bubble.children.find(node => node.tagName === 'details');
  assert.ok(details, 'form prompt must use native disclosure');
  assert.equal(details.attributes.open, undefined, 'collapsed by default');
  const full = details.children.find(node => node.className === 'pui-prompt-full');
  assert.equal(full.textContent, text);
  assert.ok(details.textContent.includes('展开全文'));
});

test('short plugin turn prompts remain compact text', () => {
  const scope = { document: { createElement: tag => new Element(tag) } }; scope.window = scope;
  vm.runInNewContext(read('plugin-ui-host.js').replace('global.PluginUIHost = {', 'global.PluginUIHost = { turnPrompt,'), scope);
  const bubble = scope.PluginUIHost.turnPrompt({ parentElement: { insertBefore() {} } }, '简短要求').children[0];
  assert.equal(bubble.textContent, '简短要求'); assert.equal(bubble.children.length, 0);
});
