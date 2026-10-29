'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path'), { pathToFileURL } = require('node:url');
const { createWatch, install } = require('../main/windows-fs-watch-guard.cjs');

function fixture({ file = false, realDirectory } = {}) {
  const target = path.resolve('watch-fixture', file ? 'result.json' : 'watched');
  const directory = file ? path.dirname(target) : target;
  const state = { ino: 123n, dev: 5n, exists: true, error: '', time: 0, stats: 0, calls: [] };
  const watcher = new EventEmitter();
  watcher.close = () => { state.calls.push('close'); watcher.emit('close'); };
  watcher.ref = () => watcher; watcher.unref = () => watcher;
  const fs = {
    statSync(name, options) {
      state.stats++; assert.deepEqual(options, { bigint: true });
      if (!state.exists || state.error) throw Object.assign(Error('fixture'), { code: state.error || 'ENOENT' });
      return { ino: state.ino, dev: state.dev, isDirectory: () => !(file && name === target) };
    },
    realpathSync: () => realDirectory || directory,
    watch(...args) { state.args = args; return watcher; },
  };
  const original = fs.watch;
  const guarded = createWatch(original, { fs, now: () => state.time });
  watcher.on('error', error => state.calls.push(error.code));
  return { state, watcher, fs, guarded, original, target, directory };
}

test('watch forwards native options and returns the exact FSWatcher with its methods intact', () => {
  const f = fixture(), fn = () => {}, signal = new AbortController().signal;
  const options = { encoding: 'buffer', recursive: true, persistent: false, signal };
  const close = f.watcher.close, ref = f.watcher.ref, unref = f.watcher.unref;
  assert.equal(f.guarded(f.target, options, fn), f.watcher);
  assert.deepEqual(f.state.args, [f.target, options, fn]);
  assert.equal(f.watcher.close, close); assert.equal(f.watcher.ref, ref); assert.equal(f.watcher.unref, unref);
  assert.equal(f.watcher.ref(), f.watcher); assert.equal(f.watcher.unref(), f.watcher);
});

test('ordinary changes and a same-name child rename are delivered unchanged without excessive stat calls', () => {
  const f = fixture(), received = [];
  f.guarded(f.target).on('change', (...args) => received.push(args));
  const name = Buffer.from(path.basename(f.directory));
  f.watcher.emit('change', 'rename', name);
  for (let i = 0; i < 1000; i++) f.watcher.emit('change', 'change', 'result.json');
  assert.equal(received.length, 1001); assert.equal(received[0][1], name);
  assert.equal(f.state.stats, 2); assert.deepEqual(f.state.calls, []);
  f.state.time = 251; f.watcher.emit('change', 'change', 'next.json'); assert.equal(f.state.stats, 3);
});

test('deleted directories close their native watcher before one recoverable error', () => {
  const f = fixture(); f.guarded(f.target); f.state.exists = false;
  f.watcher.emit('change', 'rename', f.directory);
  f.watcher.emit('change', 'rename', f.directory);
  assert.deepEqual(f.state.calls, ['close', 'ENOENT']); assert.equal(f.watcher.listenerCount('change'), 0);
});

test('a same-path replacement invalidates a stale watcher even when the directory exists again', () => {
  const f = fixture(); f.guarded(f.target); f.state.ino++;
  f.watcher.emit('change', 'change', null);
  assert.deepEqual(f.state.calls, ['close', 'ESTALE']);
});

test('root rename bypasses the normal check throttle, including Windows namespace paths', () => {
  const f = fixture(); f.guarded(f.target); f.watcher.emit('change', 'change', 'one.json');
  f.watcher.emit('change', 'rename', Buffer.from('\\\\?\\' + f.directory));
  assert.deepEqual(f.state.calls, ['close', 'ESTALE']);
});

test('a symbolic-link watch recognizes the native absolute target directory event', () => {
  const actual = 'C:\\real\\watched', f = fixture({ realDirectory: actual });
  f.guarded(pathToFileURL(f.target));
  f.watcher.emit('change', 'rename', '\\\\?\\C:\\real\\watched');
  assert.deepEqual(f.state.calls, ['close', 'ESTALE']);
});

test('watching a file tracks its containing directory, so atomic file writes remain valid', () => {
  const f = fixture({ file: true }); f.guarded(Buffer.from(f.target));
  f.watcher.emit('change', 'rename', path.basename(f.target));
  assert.deepEqual(f.state.calls, []);
});

test('transient stat failures do not turn valid native events into invalidation errors', () => {
  const f = fixture(); f.guarded(f.target); f.state.error = 'EACCES';
  f.watcher.emit('change', 'change', 'one.json'); assert.deepEqual(f.state.calls, []);
  f.state.error = ''; f.state.time = 251; f.watcher.emit('change', 'change', 'two.json');
  assert.deepEqual(f.state.calls, []);
});

test('explicit native close removes the guard and does not add timers or change ref semantics', () => {
  const f = fixture(); f.guarded(f.target).close(); const before = f.state.stats;
  f.watcher.emit('change', 'rename', f.directory);
  assert.equal(f.state.stats, before); assert.deepEqual(f.state.calls, ['close']);
});

test('native argument validation errors remain unchanged', () => {
  const f = fixture(), error = new TypeError('original argument validation');
  const watch = createWatch(() => { throw error; }, { fs: f.fs });
  assert.throws(() => watch(null, { encoding: 'invalid' }), actual => actual === error);
});

test('installation is Windows-only and idempotent', () => {
  const f = fixture(); assert.equal(install({ fs: f.fs, platform: 'linux' }), false);
  assert.equal(f.fs.watch, f.original); assert.equal(install({ fs: f.fs, platform: 'win32' }), true);
  const first = f.fs.watch; assert.equal(install({ fs: f.fs, platform: 'win32' }), false);
  assert.equal(f.fs.watch, first);
});
