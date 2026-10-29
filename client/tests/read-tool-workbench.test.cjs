'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(useCodeMirror = true) {
  const events = new Map(), frames = [], editors = [], requests = [], copied = [];
  const node = () => ({ dataset: {}, setAttribute() {}, classList: { toggle() {}, remove() {} } });
  const textarea = { value: '', readOnly: false, addEventListener() {} };
  const body = { ...node(), innerHTML: '' }, tabs = { ...node(), innerHTML: '' };
  const nodes = { '.ncw': node(), '.ncw-tabs': tabs, '.ncw-body': body,
    '[data-code-editor]': { querySelector: () => textarea } };
  const root = { ...node(), offsetParent: {}, querySelector: selector => nodes[selector] || null,
    addEventListener(name, handler) { events.set(name, handler); } };
  const sandbox = { document: { activeElement: null }, console, URL,
    navigator: { clipboard: { async writeText(value) { copied.push(value); } } },
    ChatWorkspaceSplit: { DEFAULT: 0.5, set() {}, bind: () => ({ dispose() {} }) },
    requestAnimationFrame(fn) { frames.push(fn); return frames.length; }, cancelAnimationFrame() {},
    setTimeout() { return 1; }, clearTimeout() {},
    soduWorkAPI: { conversationSession: {
      async readOutput(...args) { requests.push(['read', ...args]); return { ok: false, reason: 'File deleted' }; },
      async writeOutput(...args) { requests.push(['write', ...args]); return { ok: true }; },
    } },
  };
  if (useCodeMirror) sandbox.CodeMirror = { fromTextArea(area, options) {
    const editor = { value: area.value, options, getValue() { return this.value; }, on() {}, toTextArea() {} };
    editors.push(editor); return editor;
  } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const file of ['chat-output-links', 'chat-dom-patch', 'panels-chat-tools',
    'chat-workspace-info', 'chat-workspace-controls', 'panels-chat-workspace']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/panels', file + '.js'), 'utf8'), sandbox);
  }
  const wb = sandbox.ChatWorkbench;
  wb.bind(root, () => ({ ref: 'snapshot-fixture' }));
  const click = (attribute, dataset = {}) => {
    const button = { ...node(), dataset, hasAttribute: name => name === attribute,
      closest: selector => selector === '.ncw-markdown a' ? null : button };
    events.get('click')({ target: button, preventDefault() {}, stopPropagation() {} });
  };
  return { ...sandbox, wb, root, body, tabs, textarea, editors, requests, copied, click,
    flush() { while (frames.length) frames.shift()(); },
    open(id, text, file = '/outside/deleted/中文.html') {
      return sandbox.ChatTools.openSide({ id, name: 'read', state: 'done', args: { path: file }, result: text });
    } };
}

test('deleted and outside-workspace reads open an isolated readonly workbench snapshot without I/O', async () => {
  const f = fixture();
  assert.equal(f.open('read-1', '<h1>当时读取的内容</h1>'), true); f.flush();
  assert.equal(f.wb.state().open, true); assert.equal(f.wb.state().count, 0);
  assert.match(f.body.innerHTML, /data-read-snapshot/); assert.match(f.body.innerHTML, /读取时快照/);
  assert.doesNotMatch(f.body.innerHTML, /data-wb-code-save|data-wb-file-open|data-wb-library-upload/);
  assert.equal(f.editors.at(-1).value, '<h1>当时读取的内容</h1>');
  assert.equal(f.editors.at(-1).options.readOnly, 'nocursor');
  f.click('data-wb-code-copy'); await Promise.resolve();
  assert.deepEqual(f.copied, ['<h1>当时读取的内容</h1>']);
  f.click('data-wb-code-save'); await Promise.resolve();
  assert.deepEqual(f.requests, [], 'snapshot cannot read or write the filesystem');
});

test('same filename snapshots remain separate from writable tabs and newer output index contents', () => {
  const f = fixture(), file = 'same.html';
  assert.equal(f.wb.openPath(file, { change: { action: 'created', after: { text: 'live workspace' } } }), true);
  f.flush(); assert.equal(f.editors.at(-1).options.readOnly, false);
  const originalTabs = f.tabs.innerHTML;
  f.open('read-1', 'first receipt', file); f.flush();
  assert.notEqual(f.tabs.innerHTML, originalTabs); assert.equal(f.editors.at(-1).options.readOnly, 'nocursor');
  f.open('read-2', 'second receipt', file); f.flush();
  assert.equal((f.tabs.innerHTML.match(/role="tab"/g) || []).length, 3);
  assert.equal(f.editors.at(-1).value, 'second receipt');
  f.wb.render(f.root, { messages: [], tools: [] }, [{ name: file, relative: file, path: file, at: 100, size: 10 }]);
  f.flush(); assert.equal(f.editors.at(-1).value, 'second receipt');
  assert.equal(f.editors.at(-1).options.readOnly, 'nocursor');
  f.open('read-1', 'first receipt', file); f.flush();
  assert.equal(f.editors.at(-1).value, 'first receipt'); assert.equal(f.wb.state().count, 1);
});

test('fallback text editor is readonly and bounded snapshots disclose truncation', () => {
  const f = fixture(false);
  f.open('read-large', 'x'.repeat(240001)); f.flush();
  assert.equal(f.textarea.readOnly, true); assert.equal(f.textarea.value.length, 240000);
  assert.match(f.body.innerHTML, /仅显示本次工具返回的部分内容/);
  assert.doesNotMatch(f.body.innerHTML, /原生应用/);
  f.open('read-empty', ''); f.flush();
  assert.equal(f.textarea.value, ''); assert.equal(f.textarea.readOnly, true);
});
