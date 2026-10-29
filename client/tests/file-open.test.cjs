'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { EventEmitter } = require('node:events'), { pathToFileURL } = require('node:url');
const { commandFiles, instanceData, instanceFiles, create, MAX_BYTES } = require('../main/file-open.cjs');
async function setup(t) {
  // Match the OS-resolved spelling (e.g. Windows TEMP versus Temp).
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-open-file-')));
  const handlers = new Map(), app = new EventEmitter();
  let ready = false, identity = 'a', reveals = 0;
  app.isReady = () => ready; app.isPackaged = false; app.getPath = () => root;
  const mainFrame = {}, sender = { mainFrame, isDestroyed: () => false, send() {},
    getURL: () => pathToFileURL(path.resolve(__dirname, '../desk.html')).href };
  const win = { isDestroyed: () => false, webContents: sender };
  const broker = create({ app, ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    getWorkspace: () => win, revealWorkspace: () => reveals++, identityOf: async () => identity, ownerOf: x => x });
  const call = (channel, ...args) => handlers.get('file-open-' + channel)({ sender, senderFrame: mainFrame }, ...args);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, app, broker, call, handlers, sender, ready: () => { ready = true; },
    identity: x => { identity = x; }, reveals: () => reveals };
}
test('launch arguments preserve Unicode, spaces and metacharacters without shell evaluation', () => {
  const file = path.resolve('材料 & draft #1.html');
  assert.deepEqual(commandFiles(['app.exe', '--soduwork-open-file', file, '--updated'], process.cwd()), [file]);
  assert.deepEqual(commandFiles(['electron', 'main.js', file], process.cwd(), false), [file]);
  assert.deepEqual(commandFiles(['app.exe', '--soduwork-open-file', 'relative.txt'], process.cwd()), [path.resolve('relative.txt')]);
  assert.deepEqual(commandFiles(['app.exe', '--updated', '--soduwork-open-file', '--inspect=9'], process.cwd()), []);
  assert.deepEqual(commandFiles(['app.exe', 'https://example.com'], process.cwd()), []);
});

test('second-instance preserves the requested file when Chromium reorders switches', () => {
  const file = path.resolve('中文 页面 & one.html'), entry = path.resolve('main.js');
  const original = ['electron.exe', entry, '--soduwork-open-file', file];
  const reordered = ['electron.exe', '--soduwork-open-file', '--allow-file-access-from-files', entry, file];
  const data = instanceData(original, process.cwd(), false);
  assert.deepEqual(commandFiles(reordered, process.cwd(), false), []);
  assert.deepEqual(instanceFiles(reordered, process.cwd(), false, data), [file]);
  assert.deepEqual(instanceFiles(['app.exe', '--soduwork-open-file', file], process.cwd()), [file]);
  assert.deepEqual(instanceFiles(reordered, process.cwd(), false), [], 'legacy input must not guess the entry point');
});

test('structured launch requests reject malformed input and never fall back to unrelated arguments', () => {
  const file = path.resolve('demo.html'), args = ['app.exe', '--soduwork-open-file', file];
  for (const request of [null, {}, { version: 2, files: [file] }, { version: 1, files: file }]) {
    assert.deepEqual(instanceFiles(args, process.cwd(), true, { soduworkOpenFiles: request }), []);
  }
  assert.deepEqual(instanceFiles(args, process.cwd(), true, { soduworkOpenFiles: {
    version: 1, files: [null, {}, 'relative.html', file + '\n', file, file],
  } }), [file]);
  const files = Array.from({length: 24}, (_, i) => path.resolve('file-' + i + '.html'));
  assert.equal(instanceFiles(args, process.cwd(), true, {soduworkOpenFiles:{version:1,files}}).length, 20);
  assert.deepEqual(instanceFiles(args, process.cwd(), false,
    instanceData(['electron.exe', path.resolve('main.js')], process.cwd(), false)), []);
});
test('cold OS request survives readiness, deduplicates and opens HTML at its real location', async t => {
  const h = await setup(t), file = path.join(h.root, '中文 页面.html');
  await fs.writeFile(file, '<h1>原文件</h1>');
  let prevented = false; h.app.emit('open-file', { preventDefault: () => { prevented = true; } }, file);
  h.broker.enqueue([file]); assert.ok(prevented); assert.equal(h.reveals(), 0);
  h.ready(); h.broker.signal(); assert.equal(h.reveals(), 1);
  const list = await h.call('list'); assert.equal(list.items.length, 1);
  const result = await h.call('claim', list.items[0].id);
  assert.equal(result.ok, true); assert.equal(result.preview, true);
  assert.equal(result.cwd, h.root); assert.equal(result.file.path, file);
  assert.equal(await fs.readFile(file, 'utf8'), '<h1>原文件</h1>');
  await h.call('ack', result.id); assert.deepEqual((await h.call('list')).items, []);
});
test('unsupported files are prepared once as bounded private attachments without extraction', async t => {
  const h = await setup(t), file = path.join(h.root, 'notes.zip'), bytes = Buffer.from([0, 1, 255, 42]);
  await fs.writeFile(file, bytes); h.broker.enqueue([file]);
  const id = (await h.call('list')).items[0].id;
  const results = await Promise.all([h.call('claim', id), h.call('claim', id)]);
  const r = results[0]; assert.equal(r.preview, false); assert.equal(r.cwd, '');
  assert.notEqual(r.file.path, file); assert.deepEqual(await fs.readFile(r.file.path), bytes);
  assert.equal(results[1].file.path, r.file.path);
  h.identity('b'); assert.equal((await h.call('claim', id)).ok, false);
  assert.deepEqual((await h.call('list')).items, [], 'another account cannot see the previous claimed file names');
});
test('unknown IDs, subframes and other windows cannot read an arbitrary path', async t => {
  const h = await setup(t);
  assert.equal((await h.call('claim', path.join(h.root, 'secret.txt'))).ok, false);
  assert.equal((await h.handlers.get('file-open-list')({ sender: h.sender, senderFrame: {} })).ok, false);
  assert.equal((await h.handlers.get('file-open-list')({ sender: { ...h.sender }, senderFrame: h.sender.mainFrame })).ok, false);
});
test('deleted paths, folders and oversized files report a recoverable error', async t => {
  const h = await setup(t), huge = path.join(h.root, 'large.txt');
  await fs.writeFile(huge, ''); await fs.truncate(huge, MAX_BYTES + 1);
  h.broker.enqueue([path.join(h.root, 'gone.txt'), h.root, huge]);
  for (const row of (await h.call('list')).items) {
    const r = await h.call('claim', row.id); assert.equal(r.ok, false); assert.ok(r.reason);
  }
  assert.equal((await h.call('list')).items.length, 3, 'failure remains retryable until acknowledged');
});
test('large text is prepared as an attachment instead of blocking the text renderer', async t => {
  const h = await setup(t), file = path.join(h.root, 'large.log.txt');
  await fs.writeFile(file, ''); await fs.truncate(file, 2 * 1024 * 1024 + 1);
  h.broker.enqueue([file]); const id = (await h.call('list')).items[0].id;
  const result = await h.call('claim', id);
  assert.equal(result.ok, true); assert.equal(result.preview, false);
  assert.equal((await fs.stat(result.file.path)).size, 2 * 1024 * 1024 + 1);
});
