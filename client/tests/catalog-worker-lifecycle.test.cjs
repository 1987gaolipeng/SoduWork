'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter, once } = require('node:events');
const { Worker } = require('node:worker_threads');
const file = path.resolve(__dirname, '../main/personal-plugin-catalog-worker.cjs');
const source = fs.readFileSync(file, 'utf8');
const app = id => ({ getPath: () => String(id), isPackaged: false });

function fixture(WorkerClass) {
  const workers = [], timers = new Map(); let clock = 0, serial = 0;
  class FakeWorker extends EventEmitter {
    constructor() { super(); workers.push(this); this.terminations = 0; }
    terminate() { this.terminations++; return Promise.resolve(1); }
    unref() { this.unreferenced = true; }
  }
  const context = { module: { exports: {} }, __filename: file, process: {},
    require: name => { assert.equal(name, 'node:worker_threads'); return { Worker: WorkerClass || FakeWorker, isMainThread: true }; },
    setTimeout: (fn, ms) => { const id = ++serial; timers.set(id, { fn, at: clock + ms }); return id; },
    clearTimeout: id => timers.delete(id) };
  vm.runInNewContext(source, context, { filename: file });
  return { catalog: context.module.exports.catalog, workers, timers,
    advance(ms) { clock += ms; for (const [id, row] of [...timers]) if (row.at <= clock && timers.delete(id)) row.fn(); } };
}

test('queue deadlines and asynchronous termination bound pressure without reusing occupied slots', async () => {
  const f = fixture();
  const first = f.catalog(app(0));
  for (let i = 0; i < 1000; i++) assert.equal(f.catalog(app(0)), first);
  const results = Promise.allSettled([first, ...Array.from({ length: 999 }, (_, n) => f.catalog(app(n + 1)))]);
  assert.equal(f.workers.length, 2);
  f.advance(30000);
  assert.ok(f.workers.every(w => w.terminations === 1 && w.unreferenced));
  const outcomes = await results;
  assert.equal(outcomes.filter(x => /timed out/.test(x.reason?.message)).length, 10);
  assert.equal(outcomes.filter(x => /busy/.test(x.reason?.message)).length, 990);
  for (let round = 0; round < 20; round++) {
    const retry = Promise.allSettled(Array.from({ length: 100 }, (_, n) => f.catalog(app(n))));
    f.advance(30000);
    assert.equal((await retry).every(x => x.status === 'rejected'), true);
    assert.equal(f.workers.length, 2, 'pending native termination must retain both physical slots');
    assert.equal(f.timers.size, 0);
  }
  const recovered = f.catalog(app('recovered'));
  f.workers[0].emit('message', { items: ['late'] });
  f.workers[0].emit('exit', 1);
  assert.equal(f.workers.length, 3);
  f.workers[2].emit('message', { items: ['fresh'] });
  f.workers[2].emit('exit', 0); f.workers[1].emit('exit', 1);
  assert.deepEqual(await recovered, ['fresh']);
  assert.equal(f.timers.size, 0);
});

test('queued work uses the original deadline and expired jobs never start', async () => {
  const f = fixture();
  const a = f.catalog(app('a')), b = f.catalog(app('b')), c = f.catalog(app('c'));
  const result = Promise.allSettled([a, b, c]);
  f.advance(29000);
  f.workers[0].emit('message', { items: [] }); f.workers[0].emit('exit', 0);
  assert.equal(f.workers.length, 3);
  f.advance(1000);
  assert.equal((await result).filter(x => x.status === 'rejected').length, 2);
  assert.equal(f.workers[2].terminations, 1);
  f.workers[1].emit('exit', 1); f.workers[2].emit('exit', 1);
});

test('constructor, error, empty exit and successful replies settle once and recover', async () => {
  const broken = fixture(class { constructor() { throw Error('constructor failed'); } });
  await assert.rejects(broken.catalog(app('a')), /constructor failed/);
  assert.equal(broken.timers.size, 0);
  const f = fixture();
  for (const kind of ['error', 'exit', 'message']) {
    const result = f.catalog(app('same'));
    const w = f.workers.at(-1);
    if (kind === 'message') w.emit('message', { error: 'read denied', code: 'EACCES' });
    else w.emit(kind, kind === 'error' ? Error('read failed') : 0);
    if (kind !== 'exit') w.emit('exit', 1);
    await assert.rejects(result, /read denied|read failed|worker exited/);
  }
  const result = f.catalog(app('same'));
  f.workers.at(-1).emit('message', { items: ['fresh'] });
  f.advance(30000);
  assert.equal(f.workers.at(-1).terminations, 1, 'a reply cannot disable the exit watchdog');
  f.workers.at(-1).emit('exit', 1);
  assert.deepEqual(await result, ['fresh']); assert.equal(f.timers.size, 0);
});

test('real spinning workers terminate and subsequent catalog work succeeds', { timeout: 15000 }, async t => {
  const keepAlive = setInterval(() => {}, 100);
  t.after(() => clearInterval(keepAlive));
  const workers = [];
  class SpinWorker extends Worker {
    constructor() {
      super(workers.length < 2 ? 'for (;;) {}' : "require('node:worker_threads').parentPort.postMessage({items:['recovered']})", { eval: true });
      workers.push(this);
    }
  }
  t.after(() => Promise.all(workers.map(w => w.terminate())));
  const f = fixture(SpinWorker);
  const outcomes = Promise.allSettled([f.catalog(app('a')), f.catalog(app('b'))]);
  await Promise.all(workers.map(w => once(w, 'online')));
  const exited = Promise.all(workers.map(w => once(w, 'exit')));
  f.advance(30000);
  assert.equal((await outcomes).every(x => /timed out/.test(x.reason.message)), true);
  await exited;
  assert.deepEqual(await f.catalog(app('c')), ['recovered']);
});
