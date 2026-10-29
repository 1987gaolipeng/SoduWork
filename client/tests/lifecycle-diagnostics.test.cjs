'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const diagnostics = require('../main/lifecycle-diagnostics');

function fixture(root, pid = 123) {
  const app = new EventEmitter();
  app.getPath = (name) => { assert.equal(name, 'userData'); return root; };
  app.getVersion = () => '9.8.7';
  app.whenReady = () => Promise.resolve();
  const processRef = new EventEmitter();
  processRef.pid = pid; processRef.ppid = 45; processRef.cwd = process.cwd;
  processRef.memoryUsage = () => ({ rss: 2000, heapUsed: 1000 });
  return { app, processRef };
}
async function rows(file) {
  return (await fsp.readFile(file, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

test('heartbeat samples CPU/resource counters without logging resource identities', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'soduwork-lifecycle-'));
  const { app, processRef } = fixture(root);
  let count = 0, monotonicMs = 1000;
  t.mock.method(performance, 'now', () => monotonicMs);
  processRef.cpuUsage = () => ({ user: count++ * 15000000, system: 0 });
  processRef.getActiveResourcesInfo = () => ['private-resource-name', 'PipeWrap'];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const journal = diagnostics.install({ app, processRef });
  monotonicMs += 60000;
  t.mock.timers.tick(60000);
  journal.dispose();
  const values = await rows(journal.journalPath);
  const heartbeat = values.find(row => row.event === 'heartbeat');
  assert.equal(heartbeat.cpuPercent, 25);
  assert.equal(heartbeat.activeResourceCount, 2);
  assert.equal(heartbeat.memoryHeapUsed, 1000);
  assert.doesNotMatch(JSON.stringify(values), /private-resource-name|PipeWrap/);
  assert.equal(count, 2);
});

test('records lifecycle events with strict privacy and unchanged rejection semantics', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'soduwork-lifecycle-'));
  const { app, processRef } = fixture(root);
  const journal = diagnostics.install({ app, processRef });
  assert.equal(processRef.listenerCount('unhandledRejection'), 0);
  journal.setExitReason('tray');
  app.emit('before-quit'); app.emit('will-quit'); app.emit('quit', {}, 0);
  journal.recordError('uncaught-exception-monitor', Object.assign(new Error('secret message'), { code: 'E_TEST' }));
  const hostile = {}; Object.defineProperties(hostile, { name: { get() { throw new Error('getter'); } }, stack: { get() { throw new Error('getter'); } } });
  assert.equal(journal.recordError('uncaught-exception-monitor', hostile), false);
  const contents = new EventEmitter(); contents.id = 91;
  app.emit('web-contents-created', {}, contents);
  contents.emit('unresponsive');
  contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 9 });
  await Promise.resolve();
  journal.dispose();
  const values = await rows(journal.journalPath);
  assert.equal(values[0].event, 'start');
  assert.ok(values.some((row) => row.event === 'ready'));
  assert.ok(values.some((row) => row.event === 'before-quit' && row.completed === false));
  assert.ok(values.some((row) => row.event === 'app-quit' && row.completed === true));
  const error = values.find((row) => row.event === 'uncaught-exception-monitor');
  assert.equal(error.errorName, 'Error'); assert.equal(error.errorCode, 'E_TEST');
  assert.match(error.stackLocation, /^lifecycle-diagnostics\.test\.cjs:[0-9]+:[0-9]+$/);
  assert.ok(values.some((row) => row.event === 'render-process-gone' && row.webContentsId === 91));
  const text = await fsp.readFile(journal.journalPath, 'utf8');
  assert.doesNotMatch(text, /secret message|https?:\/\//);
});

test('attributes independent runs and does not infer a previous crash', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'soduwork-lifecycle-'));
  const one = fixture(root, 1); const first = diagnostics.install(one); first.dispose();
  const two = fixture(root, 2); const second = diagnostics.install(two); second.dispose();
  const values = await rows(second.journalPath);
  const starts = values.filter((row) => row.event === 'start');
  assert.equal(starts.length, 2);
  assert.notEqual(starts[0].runId, starts[1].runId);
  assert.deepEqual([...new Set(starts.map((row) => row.pid))], [1, 2]);
  assert.equal(values.some((row) => row.event === 'previous-exit-unconfirmed'), false);
});

test('does not write when app path is unavailable', () => {
  const app = new EventEmitter(); app.getPath = () => { throw new Error('unavailable'); };
  const processRef = new EventEmitter(); processRef.pid = 7;
  const journal = diagnostics.install({ app, processRef });
  assert.equal(journal.journalPath, null); assert.equal(journal.record('ready'), false); journal.dispose();
});

test('skips a record when rotation fails and keeps one-megabyte bounds', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'soduwork-lifecycle-'));
  const { app, processRef } = fixture(root); const journal = diagnostics.install({ app, processRef });
  for (let i = 0; i < 4500; i += 1) journal.record('custom', { reason: 'tray' });
  await fsp.writeFile(journal.journalPath, Buffer.alloc(diagnostics.MAX_BYTES, 0x78));
  const original = fs.renameSync; fs.renameSync = () => { throw new Error('locked'); };
  try { assert.equal(journal.record('custom', { reason: 'tray' }), false); }
  finally { fs.renameSync = original; journal.dispose(); }
  assert.equal((await fsp.stat(journal.journalPath)).size, diagnostics.MAX_BYTES);
});



