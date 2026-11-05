'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const io = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const storage = require('../main/library-local-store.cjs');
const { execute } = require('../main/library-local-actions.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('native thumbnail timeout frees the caller but cannot exceed two native workers', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../main/library-thumbnail.cjs'), 'utf8');
  const timers = [], releases = [], exported = { exports: {} };
  vm.runInNewContext(source, { module: exported, Buffer,
    require: () => require('../main/library-index-cache.cjs'),
    setTimeout: callback => { const timer = { callback, unref() {} }; timers.push(timer); return timer; },
    clearTimeout: () => {},
  });
  let calls = 0;
  const store = { guard() {}, checkedFile: async () => ({ size: 100, mtimeMs: 1 }) };
  const image = { isEmpty: () => false, getSize: () => ({ width: 64, height: 64 }), toPNG: () => Buffer.from('png') };
  const native = { createThumbnailFromPath: async () => { calls++; await new Promise(resolve => releases.push(resolve)); return image; } };
  const first = exported.exports.create(store, 'one', native), second = exported.exports.create(store, 'two', native);
  await tick(); assert.equal(calls, 2);
  timers.slice().forEach(timer => timer.callback());
  assert.equal((await first).unavailable, true); assert.equal((await second).unavailable, true);
  const third = exported.exports.create(store, 'three', native);
  await tick(); assert.equal(calls, 2);
  releases.splice(0).forEach(resolve => resolve()); await tick();
  assert.equal(calls, 3); releases.splice(0).forEach(resolve => resolve());
  assert.equal((await third).data, Buffer.from('png').toString('base64'));
});

test('500 offscreen images make no reads; visible reads stay at four and closing cancels the queue', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../components/panels/panels-library.js'), 'utf8');
  const begin = source.indexOf('  let imageObserver,'), end = source.indexOf('  /*', begin);
  const nodes = Array.from({ length: 500 }, (_, i) => ({ dataset: { libraryImage: String(i) }, isConnected: true,
    parentElement: { querySelector: () => null }, getAttribute() { return this.src; } }));
  let observe, count = 0, active = 0, peak = 0;
  const releases = [], signals = [];
  const context = vm.createContext({ root: { querySelectorAll: () => nodes }, state: { items: nodes.map(n => ({ id: n.dataset.libraryImage })) },
    imageEpoch: 0, imageUrls: new Map(), imageLoads: new Map(), AbortController,
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    global: { IntersectionObserver: class { constructor(callback) { observe = callback; } observe() {} disconnect() {} },
      SoduWorkAPI: { readLibraryThumbnail: async (id, { signal }) => {
        count++; active++; peak = Math.max(peak, active); signals.push(signal);
        await new Promise(resolve => releases.push(resolve)); active--; return { blob: { size: 500 } };
      } } } });
  vm.runInContext(source.slice(begin, end) + '\nhydrateImageThumbnails();', context);
  await tick(); assert.equal(count, 0);
  observe(nodes.slice(0, 12).map(node => ({ target: node.parentElement, isIntersecting: true })));
  await tick(); assert.equal(count, 4);
  releases.splice(0).forEach(resolve => resolve()); await tick(); await tick();
  assert.equal(count, 8); assert.equal(peak, 4);
  vm.runInContext('resetImageLoading(true)', context);
  assert(signals.every(signal => signal.aborted));
  releases.splice(0).forEach(resolve => resolve()); await tick(); await tick();
  assert.equal(count, 8); assert.equal(context.imageUrls.size, 0);
});

test('folder counts scan metadata linearly and exclude trashed files', async () => {
  const folders = Array.from({ length: 5000 }, (_, i) => ({ id: 'f' + i, parentId: null, name: 'folder' + i }));
  const items = folders.map((folder, i) => ({ id: 'i' + i, folderId: folder.id, deletedAt: i === 0 ? 'today' : null }));
  let visits = 0;
  for (const rows of [items, folders]) rows.filter = function (fn) { return Array.prototype.filter.call(this, (...args) => { visits++; return fn(...args); }); };
  const result = await execute({}, { items, folders }, 'list', { scope: 'folders' });
  assert.equal(result.folders.length, 5000);
  assert.equal(result.folders.find(x => x.id === 'f0').itemCount, 0);
  assert.equal(result.folders.find(x => x.id === 'f1').itemCount, 1);
  assert(visits <= 15000, `unexpected repeated scans: ${visits}`);
});

test('index cache avoids rereads, isolates mutable copies, and notices external replacement', async t => {
  const root = await io.mkdtemp(path.join(os.tmpdir(), 'soduwork-library-cache-'));
  t.after(() => io.rm(root, { recursive: true, force: true }));
  let allowed = true;
  const store = storage.create({ getPath: () => root }, 'a'.repeat(32), () => { if (!allowed) throw Error('scope changed'); });
  const initial = await store.load(); await store.save(initial);
  const originalRead = io.readFile; let reads = 0;
  io.readFile = async (...args) => { reads++; return originalRead(...args); };
  t.after(() => { io.readFile = originalRead; });
  const first = await store.load(true); const second = await store.load(true);
  assert.equal(reads, 1); assert.equal(first, second); assert(Object.isFrozen(first.items));
  const mutable = await store.load(); mutable.schema = 2;
  assert.equal((await store.load()).schema, 1);
  const indexPath = path.join(store.root, 'index.json');
  await io.writeFile(indexPath + '.external', JSON.stringify({ ...initial, external: true }));
  await io.rename(indexPath + '.external', indexPath);
  assert.equal((await store.load()).external, true); assert.equal(reads, 2);
  await io.writeFile(indexPath, '{broken');
  await assert.rejects(store.load(), /索引损坏/);
  allowed = false; await assert.rejects(store.load(), /scope changed/);
});
