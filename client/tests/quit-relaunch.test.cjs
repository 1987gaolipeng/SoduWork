'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const quitRelaunch = require('../main/quit-relaunch.cjs');
const fileOpen = require('../main/file-open.cjs');

function fakeApp() {
  const app = new EventEmitter();
  app.relaunches = [];
  app.relaunch = options => { app.relaunches.push(options); };
  return app;
}

test('a launch while the app is running is not deferred', () => {
  const app = fakeApp();
  const state = quitRelaunch.create(app);
  assert.equal(state.deferLaunch(), false);
  app.emit('will-quit');
  assert.equal(app.relaunches.length, 0);
});

test('a launch after a confirmed quit schedules exactly one relaunch', () => {
  const app = fakeApp();
  const state = quitRelaunch.create(app);
  state.markQuitting();
  assert.equal(state.deferLaunch(), true);
  assert.equal(state.deferLaunch(), true);
  assert.equal(app.relaunches.length, 0, 'wait for the end of cleanup to collect later requests');
  app.emit('before-quit'); app.emit('before-quit'); app.emit('will-quit'); app.emit('will-quit');
  assert.equal(app.relaunches.length, 1);
});

test('main.js marks user quits and checks them before reopening a window', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const quit = source.slice(source.indexOf('function _quitSoduWork('));
  assert.match(quit.slice(0, quit.indexOf('\n}')), /_quitRelaunch\.markQuitting\(\)/);
  const handler = source.slice(source.indexOf("app.on('second-instance'"));
  const body = handler.slice(0, handler.indexOf('openDeskWindow'));
  assert.ok(body.indexOf('_quitRelaunch.deferLaunch(files)') >= 0, 'second-instance must defer during quit');
  assert.ok(body.indexOf('_quitRelaunch.deferLaunch(files)') < body.indexOf('_fileOpen.enqueue'),
    'files from a launch during quit must not be queued into the exiting process');
});

test('confirmed quit without another launch never schedules a restart', () => {
  const app = fakeApp(), state = quitRelaunch.create(app);
  state.markQuitting(); app.emit('will-quit');
  assert.deepEqual(app.relaunches, []);
});

test('multiple launches retain distinct files once and preserve source/profile arguments', () => {
  const app = fakeApp();
  const oldFile = path.resolve('old.txt'), a = path.resolve('space 中文.txt'), b = path.resolve('second.txt');
  const argv = ['electron', '--user-data-dir', path.resolve('profile'), path.resolve('client'), '--soduwork-open-file', oldFile];
  const state = quitRelaunch.create(app, { argv });
  state.markQuitting(); state.deferLaunch([a]); state.deferLaunch([a, b]); state.deferLaunch();
  app.emit('will-quit');
  const args = app.relaunches[0].args;
  assert.deepEqual(args.slice(0, argv.length - 1), argv.slice(1));
  assert.deepEqual(fileOpen.commandFiles(['electron', ...args], process.cwd(), false), [a, b]);
});

test('plain relaunch overrides original files and replaces an earlier handoff', () => {
  const old = path.resolve('old.txt');
  const first = ['electron', ...fileOpen.relaunchArgs(['electron', 'app', '--soduwork-open-file', old], [old])];
  const app = fakeApp(), state = quitRelaunch.create(app, { argv: first });
  state.markQuitting(); state.deferLaunch(); app.emit('will-quit');
  const args = app.relaunches[0].args;
  assert.equal(args.filter(a => a === '--soduwork-relaunch-files').length, 1);
  assert.deepEqual(fileOpen.commandFiles(['electron', ...args], process.cwd(), false), []);
});

test('handoff only accepts bounded absolute paths and malformed data never opens an old file', () => {
  const old = path.resolve('old.txt');
  for (const payload of ['{', 'null', '{}', JSON.stringify(['relative', '--inspect', 'bad\nfile', old])]) {
    const files = fileOpen.commandFiles(['app', old, '--soduwork-relaunch-files', payload], process.cwd());
    assert.deepEqual(files, payload.startsWith('[') ? [old] : []);
  }
  const app = fakeApp(), state = quitRelaunch.create(app);
  state.markQuitting();
  state.deferLaunch(Array.from({ length: 20 }, (_, i) => path.resolve('file-' + i)));
  state.deferLaunch([old]); app.emit('will-quit');
  assert.equal(fileOpen.commandFiles(['app', ...app.relaunches[0].args], process.cwd()).length, 20);
});

test('real second-instance handler passes trusted file requests into the deferred restart', () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const handler = source.slice(source.indexOf("  app.on('second-instance'"), source.indexOf('  _fileOpen.fromCommand'));
  const app = fakeApp(); app.isPackaged = true;
  const state = quitRelaunch.create(app);
  let queued = 0, opened = 0;
  vm.runInNewContext(handler, { app, _quitRelaunch: state, _fileOpenModule: fileOpen,
    _linuxStartup: { focusRecovery: () => false }, _fileOpen: { enqueue: files => { queued += files.length; return files.length; } },
    openDeskWindow: () => opened++, console });
  const file = path.resolve('new.txt');
  state.markQuitting();
  app.emit('second-instance', {}, ['app', '--untrusted-switch'], process.cwd(),
    { soduworkOpenFiles: { version: 1, files: [file] } });
  assert.equal(queued, 0); assert.equal(opened, 0);
  app.emit('will-quit');
  assert.deepEqual(fileOpen.commandFiles(['app', ...app.relaunches[0].args], process.cwd()), [file]);
  assert.ok(!app.relaunches[0].args.includes('--untrusted-switch'));
});
