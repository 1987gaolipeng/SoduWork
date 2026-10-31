'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness(kind) {
  const nodes = new Map();
  function node(selector) {
    if (!nodes.has(selector)) {
      const listeners = new Map();
      nodes.set(selector, {
        value: '', style: {}, dataset: {},
        addEventListener(type, listener) {
          if (!listeners.has(type)) listeners.set(type, []);
          listeners.get(type).push(listener);
        },
        dispatch(event) { for (const listener of listeners.get(event.type) || []) listener(event); },
        querySelector: node,
      });
    }
    return nodes.get(selector);
  }
  const calls = [];
  let warmups = 0;
  const ctx = {
    _send: () => calls.push('send'), makeDraft: () => calls.push('draft'),
    _paintBar() {}, _rememberComposeDraft() {}, _loadModels() {},
    _loadCapabilities() {}, _loadSetup() {}, _bindSetup() {},
    _canStop: () => false,
    _loadMorePlugins: async () => { warmups++; },
  };
  const runtime = { window: null,
    document: { getElementById: id => node('#' + id), addEventListener() {} },
    WorkComposer: { bindMoreKeyboard() {}, bindScreenshot() {} },
    // The bindings consult the shared composer-tools globals; only the Enter
    // contract is under test here, so a minimal stub is enough.
    ChatTools: { composerHasPayload: () => false, paintSendButton() {} },
    /* compose-surface's recommendation slot retries with delay after a failed load; the sandbox
       has no timer, so stub it as a no-op to keep the pending promise from firing
       unhandledRejection after the test ends. */
    setTimeout() {}, clearTimeout() {},
  };
  runtime.window = runtime;
  const file = kind === 'chat' ? 'chat-composer-bindings.js' : 'compose-surface.js';
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels', file), 'utf8'), runtime);
  const api = kind === 'chat' ? runtime.ChatComposerBindings : runtime.ComposeSurface;
  api.create(ctx)._bind(node('root'));
  assert.equal(warmups, kind === 'compose' ? 1 : 0, 'compose binding warms the menu without submitting');
  return { calls, input: node(kind === 'chat' ? '#nchatInput' : '#cpInput') };
}

function enter(overrides = {}) {
  return { type: 'keydown', key: 'Enter', ctrlKey: false, metaKey: false, altKey: false,
    shiftKey: false, isComposing: false, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }, ...overrides };
}

for (const kind of ['chat', 'compose']) {
  test(kind + ': plain Enter keeps the existing composer submit path', () => {
    const { calls, input } = harness(kind), event = enter();
    input.dispatch(event);
    assert.deepEqual(calls, [kind === 'chat' ? 'send' : 'draft']);
    assert.equal(event.defaultPrevented, true);
  });

  test(kind + ': modifier Enter combinations do not retain a second send binding', () => {
    const { calls, input } = harness(kind);
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey']) {
      const event = enter({ [modifier]: true });
      input.dispatch(event);
      assert.equal(calls.length, 0, modifier + ' must be left to the configured shortcut or text input');
      assert.equal(event.defaultPrevented, false);
    }
  });

  test(kind + ': composition, picker-consumed Enter and unrelated keys never submit', () => {
    const { calls, input } = harness(kind);
    for (const event of [enter({ isComposing: true }), enter({ defaultPrevented: true }), enter({ key: 'a' })]) {
      input.dispatch(event);
    }
    assert.deepEqual(calls, []);
  });
}
