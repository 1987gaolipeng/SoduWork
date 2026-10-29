'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const preview = require('../main/work-preview');

function fixture() {
  const events = new Map(), frames = new Map(), requests = [], commands = [], copied = [];
  const document = { activeElement: null };
  let frameId = 0, onState;
  const node = () => ({ dataset: {}, setAttribute() {}, classList: { toggle() {}, remove() {} } });
  const input = { value: '', title: '', readOnly: false,
    setCustomValidity(value) { this.validity = value; }, reportValidity() {},
    matches: selector => selector === '[data-wb-address]',
    focus() { document.activeElement = this; }, select() {}, blur() { document.activeElement = null; } };
  const form = { querySelector: () => input, closest: () => form };
  const body = node();
  let bodyHtml = '';
  Object.defineProperty(body, 'innerHTML', { get() { return bodyHtml; }, set(html) {
    bodyHtml = html;
    const tag = html.match(/<input data-wb-address[^>]*>/)?.[0];
    if (!tag) return;
    const decode = value => value.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    input.value = decode(tag.match(/ value="([^"]*)"/)?.[1] || '');
    input.title = decode(tag.match(/ title="([^"]*)"/)?.[1] || '');
    input.readOnly = /\sreadonly(?:\s|>)/.test(tag);
  } });
  const slot = { ...node(), getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 400 }) };
  const nodes = { '.ncw': node(), '.ncw-tabs': node(), '.ncw-body': body,
    '[data-wb-address]': input, '[data-wb-native]': slot };
  const root = { ...node(), offsetParent: {}, querySelector: selector => nodes[selector] || null,
    addEventListener(name, handler) { events.set(name, handler); } };
  const window = { document, navigator: { clipboard: { async writeText(value) { copied.push(value); } } },
    ChatWorkspaceSplit: { DEFAULT: 0.5, set() {}, bind: () => ({ dispose() {} }) },
    requestAnimationFrame(fn) { frames.set(++frameId, fn); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); },
    soduWorkAPI: { conversationSession: { artifactAction: async () => ({ ok: true, text: '' }) }, workPreview: {
      onState(callback) { onState = callback; return () => {}; },
      async show(payload) { requests.push(payload); return { ok: true }; }, hide() {}, destroy() {},
      command(id, action) { commands.push({ id, action }); },
    } },
  };
  const context = vm.createContext({ window, URL, setTimeout: () => 1, clearTimeout() {} });
  for (const file of ['chat-output-links.js', 'chat-dom-patch.js', 'panels-chat-tools.js',
    'chat-workspace-info.js', 'chat-workspace-controls.js', 'panels-chat-workspace.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/panels', file), 'utf8'), context, { filename: file });
  }
  const wb = window.ChatWorkbench;
  wb.bind(root, () => ({ ref: 'address-fixture', cwd: 'C:/work' }));
  const emit = (name, properties) => events.get(name)({ preventDefault() {}, stopPropagation() {}, ...properties });
  const click = (attribute, dataset = {}) => {
    const button = { ...node(), dataset, hasAttribute: name => name === attribute,
      closest: selector => selector === '.ncw-markdown a' ? null : button };
    emit('click', { target: button });
  };
  return { window, wb, root, body, input, requests, copied, commands, tabs: nodes['.ncw-tabs'], info: window.ChatWorkspaceInfo,
    state: value => onState({ tabId: requests.at(-1).tabId, ...value }),
    copy: () => click('data-wb-copy-location'), external: () => click('data-wb-nav', { wbNav: 'external' }),
    escape: () => emit('keydown', { target: input, key: 'Escape' }),
    submit: () => emit('submit', { target: form }),
    async flush() { for (const fn of [...frames.values()]) { frames.clear(); await fn(); } },
  };
}

test('address presentation decodes Chinese filenames, query text and fragments once', () => {
  const { displayAddress } = fixture().info;
  const raw = 'http://127.0.0.1:4173/SoduWork-' + encodeURIComponent('中文方案😀') + '.html?q=' + encodeURIComponent('结果') + '#' + encodeURIComponent('章节');
  const readable = 'http://127.0.0.1:4173/SoduWork-中文方案😀.html?q=结果#章节';
  assert.equal(displayAddress(raw), readable);
  assert.equal(displayAddress(readable), readable);
  assert.equal(new URL(readable).href, raw);
  assert.equal(displayAddress('file:///C:/work/%E4%B8%AD.html'), 'C:/work/中.html');
  assert.equal(displayAddress('file:///C:/work/%E4%B8%AD%20%23%25.html?q=%23%3F#part'), 'C:/work/中 #%.html?q=%23%3F#part');
});

test('copying a public document resolves its real location and a late result cannot copy from a previous tab', async () => {
  const f = fixture(), file = { artifactId: 'art_doc', name: 'report.md', relative: 'report.md', kind: 'document' };
  let resolve, requests = 0;
  f.window.soduWorkAPI.conversationSession.artifactAction = async (_ref, id, action) => {
    assert.equal(id, file.artifactId);
    if (action === 'location') { requests++; return new Promise(done => { resolve = done; }); }
    return { ok: true, text: '# Report' };
  };
  f.wb.render(f.root, { messages: [], tools: [] }, [file]);
  f.wb.openOutput(file.artifactId); await f.flush();
  f.copy(); await Promise.resolve();
  assert.equal(requests, 1);
  resolve({ ok: true, path: 'C:/work/report.md' });
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(f.copied.at(-1), 'C:/work/report.md');
  f.copy(); await Promise.resolve();
  f.wb.openLink('https://example.test/next');
  resolve({ ok: true, path: 'C:/work/report.md' });
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(f.copied.length, 1, 'a delayed old-tab location response must not overwrite the clipboard');
});

test('copying rejects stale file versions and account owners and does not invent remote file locations', async () => {
  const f = fixture(), file = { artifactId: 'art_doc', name: 'report.md', relative: 'report.md', kind: 'document', at: 1, size: 12 };
  let resolve, calls = 0, owner = 'account-a';
  f.window.SoduWorkAPI = { taskStorageKey: () => owner };
  f.window.soduWorkAPI.conversationSession.artifactAction = async (_ref, _id, action) => {
    if (action === 'location') { calls++; return new Promise(done => { resolve = done; }); }
    return { ok: true, text: '# Report' };
  };
  f.wb.render(f.root, { messages: [], tools: [] }, [file]);
  f.wb.openOutput(file.artifactId); await f.flush();
  f.copy(); await Promise.resolve();
  f.wb.render(f.root, { messages: [], tools: [] }, [{ ...file, at: 2 }]);
  resolve({ ok: true, path: 'C:/work/report.md' });
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(f.copied.length, 0);
  f.copy(); await Promise.resolve();
  owner = 'account-b';
  resolve({ ok: true, path: 'C:/work/report.md' });
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(f.copied.length, 0, 'an owner change invalidates in-flight path resolution');
  const remote = { ...file, taskId: 'remote-task', attachmentId: 'remote-attachment' };
  f.wb.render(f.root, { messages: [], tools: [] }, [remote]);
  f.copy();
  assert.equal(calls, 2, 'copy must not resolve an unmaterialized remote item as a local artifact');
  assert.equal(f.copied.length, 0);
});

test('reserved bytes, double encodings, malformed UTF-8 and hidden characters stay encoded', () => {
  const { displayAddress } = fixture().info;
  const values = [
    '%2F%3F%23%25%26%3D%40%3A%5C%20%00%0A%7F', '%2f%3f%23',
    '%25E4%25B8%25AD', '%252F', '%E4%B8', '%E4%Q8%AD', '%FF', '%80', '%C0%AF',
    '%ED%A0%80', '%F4%90%80%80', '%E2%80%AE', '%E2%80%8B', '%C2%A0', '%C2%85', '%',
  ];
  for (const value of values) {
    const url = 'https://example.test/' + value;
    assert.equal(displayAddress(url), url, value);
  }
  assert.equal(displayAddress('https://%E4%B8%AD.example/%E6%96%87'), 'https://%E4%B8%AD.example/文');
  assert.equal(displayAddress('原名%E4%B8%AD.html'), '原名%E4%B8%AD.html');
});

test('toolbar keeps the complete readable address in its title and escapes markup', () => {
  const { info } = fixture();
  const address = 'http://localhost:4173/' + encodeURIComponent('很长的中文文件名'.repeat(12)) + '.html?q="<&';
  const html = info.browserToolbar({ tab: { kind: 'browser', url: address }, state: {}, location: address, address, libraryButton: '' });
  const readable = info.displayAddress(address).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  assert.ok(html.includes('value="' + readable + '" title="' + readable + '"'));
  assert.equal(html.includes('%E5%BE%88'), false);
});

test('native URL updates display Chinese while copy and external-open retain the real target', async () => {
  const f = fixture(), raw = 'http://127.0.0.1:4173/%E4%B8%AD%2F%E6%96%87.html?q=%23';
  assert.equal(f.wb.openLink(raw), true);
  assert.equal(f.input.value, 'http://127.0.0.1:4173/中%2F文.html?q=%23');
  await f.flush();
  assert.equal(f.requests[0].url, raw);
  const redirected = raw.replace('.html', '-%E6%96%B0.html');
  f.state({ url: redirected });
  assert.equal(f.input.value, 'http://127.0.0.1:4173/中%2F文-新.html?q=%23');
  assert.equal(f.input.title, f.input.value);
  f.copy(); await Promise.resolve();
  assert.deepEqual(f.copied, [redirected]);
  f.external();
  assert.equal(f.commands[0].action, 'external');
  assert.equal(f.commands[0].id, f.requests[0].tabId);
});

test('focused drafts survive native updates and Escape restores the latest readable URL', async () => {
  const f = fixture();
  f.wb.openLink('https://example.test/%E4%B8%AD'); await f.flush();
  f.input.focus(); f.input.value = 'https://example.test/尚未提交%2F';
  f.state({ url: 'https://example.test/%E6%96%B0' });
  assert.equal(f.input.value, 'https://example.test/尚未提交%2F');
  f.escape();
  assert.equal(f.input.value, 'https://example.test/新');
  assert.equal(f.input.title, f.input.value);
  assert.equal(f.window.document.activeElement, null);
});

test('unchanged submissions preserve original percent spelling and edits preserve URL delimiters', async () => {
  const f = fixture(), raw = 'https://example.test/%e4%b8%ad%2f%252F?q=%3f#%23';
  f.wb.openLink(raw); await f.flush();
  f.submit(); await f.flush();
  assert.equal(f.requests.at(-1).url, raw);
  f.input.value = 'https://example.test/中文%2F结果%252F?q=%3F#%23';
  f.submit(); await f.flush();
  const target = preview._normalizeAddress(f.requests.at(-1).url);
  assert.equal(target, 'https://example.test/%E4%B8%AD%E6%96%87%2F%E7%BB%93%E6%9E%9C%252F?q=%3F#%23');
});

test('HTML output addresses are readable without changing copied file ownership', async () => {
  const f = fixture(), file = { name: '中文.html', path: 'C:/work/中文.html', kind: 'website' };
  f.wb.openInput(file); await f.flush();
  assert.equal(f.requests.at(-1).kind, 'file');
  assert.equal(f.requests.at(-1).target, file.path);
  f.state({ url: 'http://127.0.0.1:4173/%E4%B8%AD%E6%96%87.html', displayUrl: 'file:///C:/work/%E4%B8%AD%E6%96%87.html' });
  assert.equal(f.input.value, file.path);
  f.copy(); await Promise.resolve();
  assert.deepEqual(f.copied, [file.path]);
});

test('indexed HTML uses the trusted title and absolute address, tracks navigation and keeps real external URLs', async () => {
  const f = fixture(), file = { artifactId: 'art_site', name: 'index.html', relative: 'site/index.html', kind: 'website', title: 'Actual website title' };
  f.wb.render(f.root, { messages: [], tools: [] }, [file]);
  f.wb.openOutput(file.artifactId); await f.flush();
  assert.equal(f.requests.at(-1).kind, 'artifact');
  assert.match(f.tabs.innerHTML, /Actual website title/);
  const http = 'http://127.0.0.1:4173/index.html';
  f.state({ url: http, displayUrl: 'file:///C:/work/site/index.html' });
  assert.equal(f.input.value, 'C:/work/site/index.html');
  f.copy(); await Promise.resolve();
  assert.equal(f.copied.at(-1), 'C:/work/site/index.html');
  f.submit(); await f.flush();
  assert.equal(f.input.validity, '');
  assert.equal(f.requests.at(-1).kind, 'artifact', 'unchanged local address keeps its artifact owner');
  f.state({ url: http + '?q=2#chapter', displayUrl: 'file:///C:/work/site/index.html?q=2#chapter' });
  assert.equal(f.input.value, 'C:/work/site/index.html?q=2#chapter');
  f.copy(); await Promise.resolve();
  assert.equal(f.copied.at(-1), f.input.value);
  f.state({ url: 'https://example.test/next', displayUrl: '' });
  assert.equal(f.input.value, 'https://example.test/next');
  f.copy(); await Promise.resolve();
  assert.equal(f.copied.at(-1), 'https://example.test/next');
});

test('local address Enter before native readiness preserves its owner, and explicit navigation immediately replaces the address', async () => {
  const f = fixture(), file = { name: '中文 #%.html', path: 'C:/work/中文 #%.html', kind: 'website' };
  f.wb.openInput(file);
  f.submit(); await f.flush();
  assert.equal(f.input.validity, '');
  assert.equal(f.requests.at(-1).kind, 'file');
  f.state({ url: 'http://127.0.0.1:4173/index.html', displayUrl: 'file:///C:/work/%E4%B8%AD%E6%96%87%20%23%25.html' });
  f.input.value = 'https://example.test/replacement';
  f.submit();
  assert.equal(f.input.value, 'https://example.test/replacement');
  f.copy(); await Promise.resolve();
  assert.equal(f.copied.at(-1), 'https://example.test/replacement');
  await f.flush();
  assert.equal(f.requests.at(-1).kind, 'url');
  assert.equal(f.requests.at(-1).url, 'https://example.test/replacement');
});

test('a trusted website title can arrive without new file bytes and does not reload its native page', async () => {
  const f = fixture(), file = { artifactId: 'art_site', name: 'index.html', relative: 'index.html', kind: 'website', at: 10, size: 12 };
  f.wb.render(f.root, { messages: [], tools: [] }, [file]);
  f.wb.openOutput(file.artifactId); await f.flush();
  f.wb.render(f.root, { messages: [], tools: [] }, [{ ...file, title: 'Published website title' }]);
  assert.match(f.tabs.innerHTML, /Published website title/);
  await f.flush();
  assert.equal(f.requests.at(-1).kind, undefined, 'metadata alone must not reload the native page');
});

test('document and image toolbars show authorized absolute paths with their type icon, reusing the read result', async () => {
  for (const kind of ['document', 'image']) {
    const f = fixture(), name = kind === 'image' ? 'image.png' : 'report.md';
    const file = { artifactId: 'art_file', name, relative: name, kind, at: 10, size: 12 };
    let reads = 0, locations = 0;
    f.window.soduWorkAPI.conversationSession.artifactAction = async (_ref, _id, action) => {
      if (action === 'location') { locations++; return { ok: true, path: 'C:/work/' + name }; }
      reads++;
      return { ok: true, path: 'C:/work/' + name, text: '# Report', mimeType: 'image/png', data: 'aGVsbG8=' };
    };
    f.wb.render(f.root, { messages: [], tools: [] }, [file]); f.wb.openOutput(file.artifactId);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    assert.match(f.body.innerHTML, new RegExp('title="C:/work/' + name + '"'));
    assert.ok(f.body.innerHTML.includes(kind === 'image' ? f.info.ICONS.image : f.info.ICONS.file));
    for (let i = 0; i < 100; i++) f.wb.render(f.root, { messages: [], tools: [] }, [file]);
    f.copy(); await Promise.resolve();
    assert.equal(f.copied.at(-1), 'C:/work/' + name);
    assert.equal(reads, 1); assert.equal(locations, 0, 'reuse the authorized content response instead of another filesystem resolution');
    assert.equal(Object.hasOwn(file, 'path'), false, 'the public artifact remains opaque');
  }
});

test('an explicit browser URL remains a service URL even when the main process knows a static file mapping', async () => {
  const f = fixture(), url = 'http://127.0.0.1:4173/app/route?q=%23#section';
  f.wb.openLink(url); await f.flush();
  f.state({ url, displayUrl: 'file:///C:/work/index.html?q=%23#section' });
  assert.equal(f.input.value, url);
  f.copy(); await Promise.resolve();
  assert.equal(f.copied.at(-1), url);
});

test('remote document content does not supply a local path, while local location caches expire with the file version', async () => {
  const f = fixture(), file = { artifactId: 'art_doc', name: 'report.md', relative: 'report.md', kind: 'document', at: 1 };
  let resolve;
  f.window.ChatOutputLinks.readPreview = async () => ({ ok: true, text: '# Report', path: 'C:/work/first.md' });
  f.wb.render(f.root, { messages: [], tools: [] }, [file]); f.wb.openOutput(file.artifactId);
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.match(f.body.innerHTML, /title="C:\/work\/first.md"/);
  f.window.ChatOutputLinks.readPreview = () => new Promise(done => { resolve = done; });
  f.wb.render(f.root, { messages: [], tools: [] }, [{ ...file, at: 2 }]);
  assert.doesNotMatch(f.body.innerHTML, /C:\/work\/first.md/);
  resolve({ ok: true, text: '# Updated', path: 'C:/work/current.md' });
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.match(f.body.innerHTML, /title="C:\/work\/current.md"/);
  f.wb.render(f.root, { messages: [], tools: [] }, [{ ...file, at: 3, taskId: 'task', attachmentId: 'attachment' }]);
  resolve({ ok: true, text: '# Remote', path: 'C:/other-machine/report.md' });
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.doesNotMatch(f.body.innerHTML, /C:\//);
  f.copy(); await Promise.resolve();
  assert.equal(f.copied.length, 0);
});

test('a rejected content read from a previous account cannot publish its private error path', async () => {
  const { create } = require('../components/panels/chat-workspace-controls');
  let owner = 'account-a', reject;
  const WB = {}, ctx = { WB, workScope: () => 'same-ref', context: () => ({ ref: 'same-ref' }),
    artifactKey: file => file.artifactId, sessionApi: () => ({}),
    previewOwner() { const started = owner; return () => started === owner; },
    links: { readPreview: () => new Promise((_resolve, fail) => { reject = fail; }) } };
  create(ctx).loadText({ file: { artifactId: 'art_doc', name: 'report.md' }, kind: 'markdown' });
  owner = 'account-b'; reject(Error('C:/private-old-account/report.md'));
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(WB.previewError, '');
});

test('explicit media links retain their signed address and copy it without native browser navigation', async () => {
  for (const mediaType of ['image', 'video']) {
    const f = fixture(), url = 'https://cdn.example.test/object?signature=a%2Fb&name=%E4%B8%AD';
    assert.equal(f.wb.openLink(url, { mediaType }), true);
    await f.flush();
    assert.deepEqual(f.requests, []);
    assert.equal(f.input.value, 'https://cdn.example.test/object?signature=a%2Fb&name=中');
    assert.equal(f.input.readOnly, true);
    f.copy(); await Promise.resolve(); assert.deepEqual(f.copied, [url]);
    f.wb.openLink('https://example.test/page'); await f.flush();
    assert.equal(f.requests.at(-1).url, 'https://example.test/page');
    assert.equal(f.input.readOnly, false);
  }
});

test('media viewing does not accept credential URLs or unsafe protocols', () => {
  const f = fixture();
  for (const url of ['https://user:password@example.test/file', 'javascript:alert(1)', 'data:image/png;base64,abcd']) {
    assert.equal(f.wb.openLink(url, { mediaType: 'image' }), false);
  }
});
