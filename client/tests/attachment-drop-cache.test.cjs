const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

/*
 * Detect dropped-image MIME from content, repair missing extensions, and retain immediate
 * in-memory copies of temporary files. Reject unreadable input before it can enter the
 * send queue.
 */

function loadComponent(library) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'components', 'panels',
    'conversation-attachments.js'), 'utf8');
  const window = { URL: { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} } };
  if (library) window.LibraryTransfer = library;
  const context = {
    window,
    Blob, File, setTimeout, clearTimeout,
  };
  vm.runInNewContext(source, context);
  return context.window.ConversationAttachments;
}

function fakeTray() {
  return {
    innerHTML: '',
    classList: { add() {}, toggle() {}, remove() {} },
    addEventListener() {},
  };
}

function createPicker(api, options = {}) {
  const listener = () => {};
  const events = {}, tray = fakeTray();
  const picker = api.create({
    host: { addEventListener: (name, fn) => { events[name] = fn; }, classList: { add() {}, remove() {} } }, input: { addEventListener: listener },
    fileInput: { addEventListener: listener }, button: { addEventListener: listener },
    tray,
    say: (message) => options.say && options.say(message),
    librarySource: options.librarySource,
    onChange: () => {},
  });
  picker.drop = transfer => events.drop({ dataTransfer: transfer, preventDefault() {}, stopPropagation() {} });
  picker.tray = tray;
  return picker;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

test('draft identity survives hydration and native cloning but never merges distinct same-name files', async () => {
  const api = loadComponent(), picker = createPicker(api);
  const file = new File(['one'], 'same.txt', { lastModified: 1 });
  picker.add([file]); await tick();
  const cached = picker.files()[0];
  assert.notEqual(cached, file);
  assert.equal(api.fileIdentity(cached), file);
  picker.clear(); picker.add([cached], 'draft'); await tick();
  assert.equal(api.fileIdentity(picker.files()[0]), file);
  const distinct = new File(['two'], 'same.txt', { lastModified: 1 });
  assert.notEqual(api.fileIdentity(distinct), api.fileIdentity(cached));
  const native = { nativeReference: true, path: 'C:/fixture/reference.txt', name: 'reference.txt', size: 3 };
  picker.clear(); picker.addReferences([native]);
  const cloned = picker.files()[0];
  assert.notEqual(cloned, native);
  assert.equal(api.fileIdentity(cloned), native);
  picker.clear(); picker.addReferences([cloned]);
  assert.equal(api.fileIdentity(picker.files()[0]), native);
});

test('a dropped directory retains its original File and path without reading file bytes', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-folder-drop-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folderPath = path.join(root, 'work'), cwd = path.join(root, 'session');
  fs.mkdirSync(folderPath); fs.mkdirSync(cwd);
  const warnings = [], picker = createPicker(loadComponent(), { say: m => warnings.push(m) });
  let reads = 0;
  const folder = { name: 'work', type: '', size: 0, lastModified: 0,
    slice() { reads++; throw Error('EISDIR'); }, arrayBuffer() { reads++; throw Error('EISDIR'); } };
  picker.drop({ items: [{ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }), getAsFile: () => folder }], files: [folder] });
  await tick();
  assert.equal(picker.has(), true);
  assert.equal(picker.files()[0], folder);
  assert.equal(reads, 0);
  assert.deepEqual(warnings, []);
  assert.match(picker.tray.innerHTML, /文件夹/);
  const refs = await picker.refs({ pathForFile: file => file === folder ? folderPath : '' });
  assert.equal(refs[0].path, folderPath);
  const staged = await require('../main/pi-session/attachments').stage(cwd, refs);
  assert.equal(staged.files[0].kind, 'dir');
  assert.equal(staged.files[0].path, path.resolve(folderPath));
  assert.equal(staged.warnings.length, 0);
  assert.equal(fs.existsSync(path.join(cwd, '.soduwork-inputs')), false);
});

test('mixed folder/file drops keep the directory reference while caching the regular file', async () => {
  const warnings = [], picker = createPicker(loadComponent(), { say: m => warnings.push(m) });
  const folder = new File([], 'work.png', { type: 'image/png' });
  const file = new File(['ordinary text'], 'brief.txt', { type: 'text/plain' });
  picker.drop({ items: [folder, file].map(item => ({ kind: 'file', getAsFile: () => item,
    webkitGetAsEntry: () => ({ isDirectory: item === folder }) })), files: [folder, file] });
  await tick();
  assert.equal(picker.files().length, 2);
  assert.equal(picker.files()[0], folder);
  assert.notEqual(picker.files()[1], file);
  assert.deepEqual(warnings, []);
  assert.doesNotMatch(picker.tray.innerHTML, /<img/);
  const metadata = await picker.analysis();
  assert.equal(metadata[0].kind, 'dir');
  assert.equal(metadata[0].mode, 'metadata');
  assert.equal(metadata[1].text, 'ordinary text');
});

test('a directory without a native path gets a directory-specific message rather than the cache warning', async () => {
  const warnings = [], picker = createPicker(loadComponent(), { say: m => warnings.push(m) });
  picker.add([new File([], 'work')], 'drop', ['dir']); await tick();
  assert.equal(picker.has(), true);
  const refs = await picker.refs({ pathForFile: () => '' });
  assert.equal(refs.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /文件夹.*work.*本地路径/);
  assert.doesNotMatch(warnings[0], /企业微信/);
});

test('restoring a failed send into another composer preserves the directory classification', async () => {
  const api = loadComponent(), warnings = [];
  const first = createPicker(api), retry = createPicker(api, { say: m => warnings.push(m) });
  const folder = new File([], 'work');
  first.add([folder], 'drop', ['dir']); await tick();
  const retained = first.files(); first.clear();
  retry.add(retained, 'retry'); await tick();
  assert.equal(retry.has(), true);
  assert.equal(retry.files()[0], folder);
  assert.match(retry.tray.innerHTML, /文件夹/);
  assert.deepEqual(warnings, []);
});

test('magic bytes identify images and documents without relying on extensions', () => {
  const api = loadComponent();
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2]);
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 1]);
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);
  const bmp = new Uint8Array([0x42, 0x4d, 0, 0]);
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 1]);
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
  const text = new Uint8Array([0x23, 0x20, 0xe9, 0x9c, 0x80]);
  assert.equal(api.sniffMime(png), 'image/png');
  assert.equal(api.sniffMime(jpeg), 'image/jpeg');
  assert.equal(api.sniffMime(gif), 'image/gif');
  assert.equal(api.sniffMime(webp), 'image/webp');
  assert.equal(api.sniffMime(bmp), 'image/bmp');
  assert.equal(api.sniffMime(zip), 'application/zip');
  assert.equal(api.sniffMime(pdf), 'application/pdf');
  assert.equal(api.sniffMime(text), '');
  assert.equal(api.sniffMime(new Uint8Array(0)), '');
});

test('a dropped extensionless WeCom cache image gains its real type, suffix and an in-memory copy', async () => {
  const api = loadComponent();
  const warnings = [];
  const picker = createPicker(api, { say: (m) => warnings.push(m) });
  const bytes = new Uint8Array(372 * 1024);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const source = new File([bytes], '8f67b781-3f86-49ab-9c2e-000000000000', { type: '' });

  picker.add([source], 'drop');
  await tick();

  assert.deepEqual(warnings, []);
  assert.equal(picker.names()[0], '8f67b781-3f86-49ab-9c2e-000000000000.png');
  const row = picker.files()[0];
  assert.equal(row.type, 'image/png');
  assert.notEqual(row, source); // Sending uses the memory copy rather than the source application's temporary file.
  const kept = new Uint8Array(await row.arrayBuffer());
  assert.equal(kept.length, bytes.length);
  assert.equal(kept[0], 0x89);
});

test('an unreadable virtual file is refused up front with a plain-language reason', async () => {
  const api = loadComponent();
  const warnings = [];
  const picker = createPicker(api, { say: (m) => warnings.push(m) });
  const gone = {
    name: '9a2b7c3d-1e4f-4a5b-8c6d-000000000000', type: '', size: 380928, lastModified: 0,
    slice: () => ({ arrayBuffer: async () => { throw new Error('file gone'); } }),
    arrayBuffer: async () => { throw new Error('file gone'); },
  };

  picker.add([gone], 'drop');
  await tick();

  assert.equal(picker.has(), false); // Rejected files never enter the attachment list or send queue.
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /9a2b7c3d/);
  assert.match(warnings[0], /企业微信临时缓存/);
  assert.match(warnings[0], /另存后拖入/);
});

test('normally named files keep their names and also get cached against cache eviction', async () => {
  const api = loadComponent();
  const warnings = [];
  const picker = createPicker(api, { say: (m) => warnings.push(m) });
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);
  const source = new File([bytes], '粘贴图片-20261012-071818.png', { type: 'image/png' });

  picker.add([source], 'paste');
  await tick();

  assert.deepEqual(warnings, []);
  assert.equal(picker.names()[0], '粘贴图片-20261012-071818.png');
  assert.equal(picker.files()[0].type, 'image/png');
  assert.equal(new Uint8Array(await picker.files()[0].arrayBuffer()).length, bytes.length);
});

test('refs skip an attachment that dies mid-flight and say which one and why', async () => {
  const api = loadComponent();
  const warnings = [];
  const picker = createPicker(api, { say: (m) => warnings.push(m) });
  const alive = new File([new Uint8Array([0x31, 0x32, 0x33])], '说明.txt', { type: 'text/plain' });
  picker.add([alive], 'drop');
  await tick();
  // Simulate a queued file removed by its source application before sending.
  const row = picker.files()[0];
  row.arrayBuffer = async () => { throw new Error('file gone'); };

  const refs = await picker.refs({ pathForFile: () => '' });

  assert.equal(refs.length, 0); // Skip the failed attachment without failing the entire message.
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /说明\.txt|读取失败/);
  assert.match(warnings[0], /企业微信临时缓存/);
});

/* Document-protection software can return ciphertext through the clipboard. Verify it is rejected
   with a user-facing message and is never sent or stored as an image or file. */
const esafenetBytes = () => {
  const bytes = new Uint8Array(4096);
  bytes.set([0xe0, 0xa8, 0x91, 0xe7, 0xd8, 0xf2, 0x05, 0xac], 0);
  bytes.set([0x45, 0x73, 0x61, 0x66, 0x65, 0x6e, 0x65, 0x74], 0x40); // "Esafenet"
  return bytes;
};

test('an Esafenet-encrypted clipboard image is refused up front with actionable guidance', async () => {
  const api = loadComponent();
  const warnings = [];
  const picker = createPicker(api, { say: (m) => warnings.push(m) });
  const source = new File([esafenetBytes()], '企业微信截图_17919498299630.png', { type: '' });

  picker.add([source], 'paste');
  await tick();

  assert.equal(picker.has(), false); // Rejected ciphertext enters neither attachments, send queue, nor library.
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /企业微信截图_17919498299630/);
  assert.match(warnings[0], /透明加密/);
  assert.match(warnings[0], /截图粘贴/);
});

test('an image-typed encrypted file is refused too, even after the paste rename', async () => {
  const api = loadComponent();
  const warnings = [];
  const picker = createPicker(api, { say: (m) => warnings.push(m) });
  const source = new File([esafenetBytes()], '企业微信截图_17919498299631.png', { type: 'image/png' });

  picker.add([source], 'paste');
  await tick();

  assert.equal(picker.has(), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /透明加密/);
});

test('a plain text file that merely mentions Esafenet is not treated as encrypted', async () => {
  const api = loadComponent();
  const warnings = [];
  const picker = createPicker(api, { say: (m) => warnings.push(m) });
  const text = 'Esafenet 是一种文档保护软件。\n' + '正文'.repeat(80);
  const source = new File([text], '说明.md', { type: 'text/markdown' });

  picker.add([source], 'drop');
  await tick();

  assert.equal(picker.has(), true);
  assert.deepEqual(warnings, []);
  assert.equal(picker.names()[0], '说明.md');
});

test('the library tracks the validated in-memory copy only after hydration, and never for refused rows', async () => {
  const tracked = [];
  const api = loadComponent({
    trackFile(file, options) {
      tracked.push({ file, options });
      return { status: 'new', listeners: new Set() };
    },
    fileStatus: () => '正在保存到资料库…',
  });
  const warnings = [];
  const picker = createPicker(api, { say: (m) => warnings.push(m) });
  const bytes = new Uint8Array(600);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const good = new File([bytes], '8f67b781-3f86-49ab-9c2e-000000000000', { type: '' });
  const encrypted = new File([esafenetBytes()], '企业微信截图_17919498299632.png', { type: '' });

  picker.add([good, encrypted], 'paste');
  await tick();

  assert.equal(picker.has(), true); // Retain valid files while rejecting ciphertext.
  assert.equal(picker.names()[0], '8f67b781-3f86-49ab-9c2e-000000000000.png');
  assert.equal(tracked.length, 1); // Register only valid files in the library.
  assert.notEqual(tracked[0].file, good); // Register the memory copy rather than the original clipboard file.
  assert.equal(tracked[0].options.name, '8f67b781-3f86-49ab-9c2e-000000000000.png');
  assert.equal(warnings.length, 1);
});

test('attachment hydration keeps the original conversation when the active source changes', async () => {
  const tracked = [];
  const api = loadComponent({
    trackFile(file, options) { tracked.push({ file, options }); return null; },
  });
  const source = { type: 'conversation', sessionId: 'first-session', conversationTitle: 'First conversation' };
  const picker = createPicker(api, { librarySource: () => source });
  const file = new File(['Original attachment'], 'note.txt', { type: 'text/plain' });
  picker.add([file], 'drop');
  source.sessionId = 'second-session';
  source.conversationTitle = 'Second conversation';
  await tick();
  assert.equal(tracked.length, 1);
  assert.notEqual(tracked[0].file, file, 'Upload the validated memory copy');
  assert.equal(tracked[0].options.librarySource.sessionId, 'first-session');
  assert.equal(tracked[0].options.librarySource.conversationTitle, 'First conversation');
});
