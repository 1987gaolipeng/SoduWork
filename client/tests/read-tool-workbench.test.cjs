'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jx1sAAAAASUVORK5CYII=';
const GIF = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const imageSources = html => Array.from(html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g), match => match[1]);
const writableActions = /data-wb-code-save|data-wb-file-open|data-wb-library-upload|data-wb-reference|data-wb-native-open/;
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(useCodeMirror = true, options = {}) {
  const events = new Map(), frames = [], editors = [], requests = [], copied = [], details = [], receipts = new Map();
  let ref = 'snapshot-fixture', scope = 'account-a', bodyWrites = 0, bodyHtml = '';
  const node = () => ({ dataset: {}, setAttribute() {}, replaceChildren() { this.innerHTML = ''; }, classList: { toggle() {}, remove() {} } });
  const textarea = { value: '', readOnly: false, addEventListener() {} };
  const body = { ...node(), innerHTML: '' }, tabs = { ...node(), innerHTML: '' };
  Object.defineProperty(body, 'innerHTML', { get: () => bodyHtml, set(value) { bodyWrites++; bodyHtml = value; } });
  const nodes = { '.ncw': node(), '.ncw-tabs': tabs, '.ncw-body': body,
    '[data-code-editor]': { querySelector: () => textarea } };
  const root = { ...node(), offsetParent: {}, contains: () => true, querySelector: selector => nodes[selector] || null,
    addEventListener(name, handler) { events.set(name, handler); } };
  const sandbox = { document: { activeElement: null }, console, URL,
    navigator: { clipboard: { async writeText(value) { copied.push(value); } } },
    ChatWorkspaceSplit: { DEFAULT: 0.5, set() {}, bind: () => ({ dispose() {} }) },
    requestAnimationFrame(fn) { frames.push(fn); return frames.length; }, cancelAnimationFrame() {},
    setTimeout() { return 1; }, clearTimeout() {},
    SoduWorkAPI: { taskStorageKey: () => scope },
    soduWorkAPI: { conversationSession: {
      async readOutput(...args) { requests.push(['read', ...args]); return { ok: false, reason: 'File deleted' }; },
      async writeOutput(...args) { requests.push(['write', ...args]); return { ok: true }; },
      async toolDetail(...args) {
        details.push(args);
        return options.toolDetail ? options.toolDetail(...args) : { ok: true, tool: receipts.get(args[1]) };
      },
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
  const bind = () => wb.bind(root, () => ({ ref }));
  bind();
  const click = (attribute, dataset = {}) => {
    const button = { ...node(), dataset, hasAttribute: name => name === attribute,
      closest: selector => selector === '.ncw-markdown a' ? null : button };
    events.get('click')({ target: button, preventDefault() {}, stopPropagation() {} });
  };
  return { ...sandbox, wb, root, body, tabs, textarea, editors, requests, copied, click, events, frames, details,
    get bodyWrites() { return bodyWrites; },
    tabIds() { return Array.from(tabs.innerHTML.matchAll(/data-wb-tab="([^"]+)"/g), match => match[1]); },
    switch(nextRef = 'another-session', nextScope = scope) { wb.reset(); ref = nextRef; scope = nextScope; bind(); },
    flush() { while (frames.length) frames.shift()(); },
    open(id, text, file = '/outside/deleted/中文.html') {
      return sandbox.ChatTools.openSide({ id, name: 'read', state: 'done', args: { path: file }, result: text });
    },
    openImage(id, images, file = '/outside/deleted/中文.png', extra = {}) {
      const tool = { id, name: 'read', state: 'done', args: { path: file },
        result: 'Read image file [image/png]', readImages: images, ...extra };
      receipts.set(id, tool);
      return sandbox.ChatTools.openSide(tool);
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

test('image read receipts preview their captured bytes without opening or rereading the file', async () => {
  const f = fixture();
  assert.equal(f.openImage('image-1', [{ mimeType: 'image/png', data: PNG }]), true); f.flush();
  assert.equal(f.wb.state().open, true); assert.equal(f.wb.state().count, 0);
  assert.deepEqual(imageSources(f.body.innerHTML), ['data:image/png;base64,' + PNG]);
  assert.match(f.body.innerHTML, /data-read-snapshot/);
  assert.match(f.body.innerHTML, /读取时快照/);
  assert.doesNotMatch(f.body.innerHTML, writableActions);
  assert.doesNotMatch(f.body.innerHTML, /data-code-editor|<textarea/);
  assert.equal(f.editors.length, 0, 'image receipts do not mount a source editor for the text marker');
  f.click('data-wb-code-save'); await Promise.resolve();
  assert.deepEqual(f.requests, [], 'the snapshot is independent of missing and outside-workspace paths');
});

test('multiple image receipts preserve image order and remain isolated across reads of the same path', () => {
  const f = fixture(), file = 'same.png';
  f.openImage('image-1', [{ mimeType: 'image/png', data: PNG }, { mimeType: 'image/gif', data: GIF }], file);
  f.flush();
  assert.deepEqual(imageSources(f.body.innerHTML), ['data:image/png;base64,' + PNG, 'data:image/gif;base64,' + GIF]);
  f.openImage('image-2', [{ mimeType: 'image/gif', data: GIF }], file); f.flush();
  assert.equal((f.tabs.innerHTML.match(/role="tab"/g) || []).length, 2);
  assert.deepEqual(imageSources(f.body.innerHTML), ['data:image/gif;base64,' + GIF]);
  f.wb.render(f.root, { messages: [], tools: [] }, [{ name: file, relative: file, path: file, at: 100, size: 10 }]);
  f.flush();
  assert.deepEqual(imageSources(f.body.innerHTML), ['data:image/gif;base64,' + GIF], 'a new live output cannot replace receipt bytes');
  f.openImage('image-1', [{ mimeType: 'image/png', data: PNG }, { mimeType: 'image/gif', data: GIF }], file);
  f.flush();
  assert.equal((f.tabs.innerHTML.match(/role="tab"/g) || []).length, 2);
  assert.deepEqual(imageSources(f.body.innerHTML), ['data:image/png;base64,' + PNG, 'data:image/gif;base64,' + GIF]);
  assert.deepEqual(f.requests, []);
});

test('invalid image payloads cannot become markup or file reads and valid sibling images still preview', () => {
  const f = fixture();
  const invalid = [null, { mimeType: 'image/png', data: '' }, { mimeType: 'text/html', data: 'PHNjcmlwdD4=' },
    { mimeType: 'image/png', data: 'https://example.invalid/image.png" onerror="alert(1)' }];
  f.openImage('invalid-images', invalid, 'missing.png', { readImageCount: invalid.length }); f.flush();
  assert.deepEqual(imageSources(f.body.innerHTML), []);
  assert.match(f.body.innerHTML, /图片暂时无法预览/);
  assert.doesNotMatch(f.body.innerHTML, /onerror|example\.invalid|<script/);
  assert.doesNotMatch(f.body.innerHTML, writableActions);
  f.openImage('mixed-images', [...invalid, { mimeType: 'image/png', data: PNG }]); f.flush();
  assert.deepEqual(imageSources(f.body.innerHTML), ['data:image/png;base64,' + PNG]);
  assert.deepEqual(f.requests, []);
});

test('missing image payloads report an unavailable snapshot and legacy text reads remain readonly', () => {
  const f = fixture();
  f.openImage('image-missing', [], 'missing.png', { readImageCount: 1 }); f.flush();
  assert.deepEqual(imageSources(f.body.innerHTML), []);
  assert.match(f.body.innerHTML, /图片暂时无法预览/);
  assert.deepEqual(f.requests, []);
  f.open('legacy-image-read', 'Read image file [image/png]', 'missing.png'); f.flush();
  assert.equal(f.editors.at(-1).value, 'Read image file [image/png]');
  assert.equal(f.editors.at(-1).options.readOnly, 'nocursor');
  assert.deepEqual(imageSources(f.body.innerHTML), []);
  assert.deepEqual(f.requests, []);
});

test('image decode failure stays inline across refresh without retrying file access or repainting in a loop', () => {
  const f = fixture();
  f.openImage('broken-image', [{ mimeType: 'image/png', data: 'bm90IGFuIGltYWdl' }]); f.flush();
  assert.equal(imageSources(f.body.innerHTML).length, 1, 'payload validation precedes browser image decoding');
  const error = { hidden: true }, row = { dataset: { readImageIndex: '0' }, querySelector: () => error };
  const image = { removed: false, closest: selector => selector === '[data-read-image-index]' ? row : null,
    remove() { this.removed = true; f.body.innerHTML = f.body.innerHTML.replace(/<img\b[^>]*>/, ''); } };
  f.events.get('error')({ target: image });
  assert.equal(image.removed, true); assert.equal(error.hidden, false);
  assert.equal(f.frames.length, 0, 'decoding failure does not queue another paint of the same broken image');
  f.wb.render(f.root, { messages: [], tools: [] }, []); f.flush();
  assert.deepEqual(imageSources(f.body.innerHTML), []);
  assert.match(f.body.innerHTML, /图片暂时无法预览/);
  assert.deepEqual(f.requests, []);
});

test('bounded image receipts disclose omitted images without exposing text editing actions', () => {
  const f = fixture();
  f.openImage('truncated-images', [{ mimeType: 'image/png', data: PNG }], 'photo.png', { readImagesTruncated: true });
  f.flush();
  assert.deepEqual(imageSources(f.body.innerHTML), ['data:image/png;base64,' + PNG]);
  assert.match(f.body.innerHTML, /仅显示本次工具返回的部分内容/);
  assert.doesNotMatch(f.body.innerHTML, /data-wb-code-copy|data-code-editor/);
  assert.doesNotMatch(f.body.innerHTML, writableActions);
  assert.deepEqual(f.requests, []);
});

test('unrelated file index updates retain image DOM instead of rebuilding base64 markup', () => {
  const f = fixture();
  f.openImage('stable-image', [{ mimeType: 'image/png', data: PNG }]); f.flush();
  const before = f.bodyWrites;
  for (let at = 1; at <= 3; at++) {
    f.wb.render(f.root, { messages: [], tools: [] }, [{ name: 'unrelated.txt', relative: 'unrelated.txt', at, size: at }]);
    f.flush();
  }
  assert.equal(f.bodyWrites, before, 'unrelated metadata must not replace image nodes or restart decoding');
  assert.match(f.body.innerHTML, /<img loading="lazy"/);
  assert.deepEqual(f.requests, []); assert.deepEqual(f.details, []);
});

function openSixImages(f) {
  for (let index = 1; index <= 6; index++) {
    f.openImage('image-' + index, [{ mimeType: 'image/png', data: PNG }], 'photo-' + index + '.png');
    f.flush();
  }
  return f.tabIds();
}

test('evicted image tabs stay open and reload their original receipt only when selected again', async () => {
  const f = fixture(), ids = openSixImages(f);
  assert.equal(ids.length, 6, 'cache pressure must never close user tabs');
  assert.deepEqual(f.details, [], 'opening snapshots does not read unrelated receipts');
  f.click('data-wb-tab', { wbTab: ids[0] }); f.flush();
  assert.match(f.body.innerHTML, /正在读取图片/);
  f.click('data-wb-tab', { wbTab: ids[0] }); await tick(); f.flush();
  assert.deepEqual(f.details, [['snapshot-fixture', 'image-1']], 'repeated activation shares the pending reload');
  assert.deepEqual(imageSources(f.body.innerHTML), ['data:image/png;base64,' + PNG]);
  assert.match(f.body.innerHTML, /photo-1\.png/);
  assert.equal(f.tabIds().length, 6);
  assert.deepEqual(f.requests, [], 'reload uses toolDetail, never a local file path');
});

test('inactive image bytes are bounded even before the tab count limit is reached', async () => {
  const f = fixture(), data = 'A'.repeat(16 * 1024 * 1024 + 1024);
  for (let index = 1; index <= 3; index++) {
    f.openImage('large-' + index, [{ mimeType: 'image/png', data }]); f.flush();
  }
  assert.equal(f.tabIds().length, 3);
  f.click('data-wb-tab', { wbTab: f.tabIds()[0] }); await tick(); f.flush();
  assert.deepEqual(f.details, [['snapshot-fixture', 'large-1']], 'two inactive UTF-16 image URLs exceed the 64 MB budget');
  assert.equal(imageSources(f.body.innerHTML)[0].length, 'data:image/png;base64,'.length + data.length);
  assert.deepEqual(f.requests, []);
});

test('failed receipt reloads show a retry action and do not automatically retry during stream updates', async () => {
  let attempt = 0;
  const f = fixture(true, { toolDetail: async (_ref, id) => ++attempt === 1 ? { ok: false } :
    { ok: true, tool: { id, readImages: [{ mimeType: 'image/png', data: PNG }] } } });
  const ids = openSixImages(f);
  f.click('data-wb-tab', { wbTab: ids[0] }); await tick(); f.flush();
  assert.match(f.body.innerHTML, /图片暂时无法预览/);
  assert.match(f.body.innerHTML, /data-wb-read-image-retry/);
  f.wb.render(f.root, { messages: [], tools: [] }, []); f.flush();
  f.click('data-wb-tab', { wbTab: ids[0] }); await tick();
  assert.equal(attempt, 1);
  f.click('data-wb-read-image-retry'); f.click('data-wb-read-image-retry'); await tick(); f.flush();
  assert.equal(attempt, 2);
  assert.deepEqual(imageSources(f.body.innerHTML), ['data:image/png;base64,' + PNG]);
  assert.deepEqual(f.requests, []);
});

test('a late evicted-image reload cannot cross conversation or account boundaries', async () => {
  for (const sameRef of [false, true]) {
    let finish;
    const f = fixture(true, { toolDetail: () => new Promise(resolve => { finish = resolve; }) });
    const ids = openSixImages(f);
    f.click('data-wb-tab', { wbTab: ids[0] }); await tick();
    f.switch(sameRef ? 'snapshot-fixture' : 'new-session', 'account-b');
    f.openImage('new-image', [{ mimeType: 'image/gif', data: GIF }]); f.flush();
    finish({ ok: true, tool: { id: 'image-1', readImages: [{ mimeType: 'image/png', data: PNG }] } });
    await tick(); f.flush();
    assert.deepEqual(imageSources(f.body.innerHTML), ['data:image/gif;base64,' + GIF]);
    assert.equal(f.tabIds().length, 1);
    assert.deepEqual(f.requests, []);
  }
});

test('closed or replaced image snapshots reject their pending receipt response', async () => {
  for (const close of [false, true]) {
    let finish;
    const f = fixture(true, { toolDetail: () => new Promise(resolve => { finish = resolve; }) });
    const ids = openSixImages(f);
    f.click('data-wb-tab', { wbTab: ids[0] }); await tick();
    if (close) f.click('data-wb-tab-close', { wbTabClose: ids[0] });
    f.openImage(close ? 'new-image' : 'image-1', [{ mimeType: 'image/gif', data: GIF }], 'photo-1.png'); f.flush();
    finish({ ok: true, tool: { id: 'image-1', readImages: [{ mimeType: 'image/png', data: PNG }] } });
    await tick(); f.flush();
    assert.deepEqual(imageSources(f.body.innerHTML), ['data:image/gif;base64,' + GIF]);
    assert.equal(f.tabIds().length, 6);
    assert.deepEqual(f.requests, []);
  }
});

test('a pending image reload respects manual pane closure and remains available when reopened', async () => {
  let finish;
  const f = fixture(true, { toolDetail: () => new Promise(resolve => { finish = resolve; }) });
  const ids = openSixImages(f);
  f.click('data-wb-tab', { wbTab: ids[0] }); await tick();
  f.click('data-wb-close');
  const writes = f.bodyWrites;
  finish({ ok: true, tool: { id: 'image-1', readImages: [{ mimeType: 'image/png', data: PNG }] } });
  await tick(); f.flush();
  assert.equal(f.wb.state().open, false);
  assert.equal(f.bodyWrites, writes, 'background completion does not repaint or reopen a closed pane');
  f.click('data-wb-open'); f.flush();
  assert.deepEqual(imageSources(f.body.innerHTML), ['data:image/png;base64,' + PNG]);
  assert.equal(f.details.length, 1);
  assert.deepEqual(f.requests, []);
});
