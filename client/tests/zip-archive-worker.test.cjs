'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { randomBytes } = require('node:crypto');
const archive = require('../main/conversation/zip-archive');
const { createPickFolderHandler } = require('../main/pi-session/mate-message-ipc');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-zip-worker-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('real worker keeps the event loop responsive and preserves archive bytes and website detection', async t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>site</h1>');
  fs.writeFileSync(path.join(root, 'payload.bin'), randomBytes(8 * 1024 * 1024));
  const expected = archive.createZip(root);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  try {
    const result = await archive.createZipAsync(root);
    assert.deepEqual(Buffer.from(result.base64, 'base64'), expected.data);
    assert.equal(result.website, true); assert.equal(result.files, 2);
    assert.ok(ticks > 0, 'file reads, compression and CRC must not monopolize the main event loop');
  } finally { clearInterval(timer); }
});

test('worker excludes junctions/dependencies and propagates missing, empty and size-limit failures', async t => {
  const root = fixture(t), outside = fixture(t);
  await assert.rejects(archive.createZipAsync(path.join(root, 'absent')), /ENOENT/);
  await assert.rejects(archive.createZipAsync(root), /no shareable files/);
  fs.writeFileSync(path.join(outside, 'private.txt'), 'must not be shared');
  fs.symlinkSync(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'node_modules', 'ignored.js'), 'ignored');
  fs.writeFileSync(path.join(root, 'visible.txt'), 'shared');
  const result = await archive.createZipAsync(root);
  assert.equal(result.files, 1); assert.equal(result.website, false);
  fs.writeFileSync(path.join(root, 'too-large.bin'), Buffer.alloc(archive.MAX_BYTES + 1));
  await assert.rejects(archive.createZipAsync(root), /24 MB/);
});

function controlledPool() {
  const workers = [];
  class Worker extends EventEmitter {
    constructor() { super(); workers.push(this); }
    unref() {}
  }
  const ctx = { require: id => id === 'node:worker_threads' ? { Worker, isMainThread: true } : require(id),
    module: { exports: {} }, __filename: 'worker-fixture', setTimeout, clearTimeout, Buffer };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main/conversation/zip-archive-worker.js'), 'utf8'), ctx);
  return { create: ctx.module.exports.create, workers };
}

test('pool bounds active and queued workers; cancellation never frees a still-running native worker slot', async () => {
  const { create, workers } = controlledPool(), abort = new AbortController();
  const jobs = [create('active', { signal: abort.signal }), ...Array.from({ length: 9 }, (_, i) => create('job-' + i))];
  jobs.forEach(job => job.catch(() => {}));
  assert.equal(workers.length, 2);
  await assert.rejects(create('overflow'), error => error.code === 'ZIP_BUSY');
  abort.abort(); await assert.rejects(jobs[0], error => error.code === 'ABORT_ERR');
  assert.equal(workers.length, 2);
  for (let i = 0; i < 10; i++) {
    workers[i].emit('message', { result: { base64: '', files: 1 } });
    assert.equal(workers.length, Math.min(10, i + 2), 'slot remains occupied until exit');
    workers[i].emit('exit', 0);
  }
  await Promise.allSettled(jobs);
  assert.equal(workers.length, 10);
});

test('native folder picker uses worker metadata and cancels when its owner closes', async () => {
  const owner = new EventEmitter(); owner.isDestroyed = () => false;
  const handler = createPickFolderHandler({ BrowserWindow: { fromWebContents: () => owner },
    dialog: { showOpenDialog: async () => ({ filePaths: ['folder'] }) },
    shareArchive: { createZipAsync: async (root, { signal }) => {
      assert.equal(root, 'folder');
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () =>
        reject(Object.assign(Error('canceled'), { code: 'ABORT_ERR' }))));
    } } });
  const result = handler({ sender: {} }); await Promise.resolve();
  owner.emit('closed');
  assert.equal((await result).canceled, true); assert.equal(owner.listenerCount('closed'), 0);
});

test('queued and already-canceled jobs do not start workers or consume future slots', async () => {
  const { create, workers } = controlledPool(), abort = new AbortController();
  const first = create('one'), second = create('two');
  const queued = create('queued', { signal: abort.signal });
  abort.abort(); await assert.rejects(queued, error => error.code === 'ABORT_ERR');
  await assert.rejects(create('canceled', { signal: abort.signal }), error => error.code === 'ABORT_ERR');
  workers[0].emit('message', { result: {} }); workers[0].emit('exit', 0);
  workers[1].emit('message', { result: {} }); workers[1].emit('exit', 0);
  await Promise.all([first, second]); assert.equal(workers.length, 2);
});

test('native folder picker returns the existing transport shape without scanning twice', async () => {
  const handler = createPickFolderHandler({ BrowserWindow: { fromWebContents: () => null },
    dialog: { showOpenDialog: async () => ({ filePaths: ['folder'] }) },
    shareArchive: { createZipAsync: async () => ({ name: 'folder.zip', size: 3, files: 2,
      base64: 'YWJj', website: true }) } });
  const result = await handler({ sender: {} });
  assert.equal(result.ok, true); assert.equal(result.data, 'YWJj'); assert.equal(result.files, 2);
  assert.equal(result.website, true); assert.equal(result.preview.status, 'zip_only');
});
