'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const entry = require('../main/app-preflight-entry.cjs');
const { commandFiles } = require('../main/file-open.cjs');

test('packaged preflight never passes a worker script as an OS file to open', () => {
  const args = entry.launchArgs(true, path.resolve('resources/app.asar'));
  assert.deepEqual(args, [entry.SWITCH]);
  assert.deepEqual(commandFiles(['SoduWork.exe', ...args], process.cwd(), true), []);
  assert.deepEqual(entry.launchArgs(false, '/source/client'), ['/source/client', entry.SWITCH]);
});

test('preflight dispatch requires an explicit switch and isolated folder', () => {
  const loaded = [], load = name => loaded.push(name);
  assert.equal(entry.dispatch(['app.exe'], { APP_CANDIDATE_PREFLIGHT_FOLDER: 'temp' }, load), false);
  assert.throws(() => entry.dispatch(['app.exe', entry.SWITCH], {}, load), /directory/);
  assert.deepEqual(loaded, []);
  assert.equal(entry.dispatch(['app.exe', entry.SWITCH], { APP_CANDIDATE_PREFLIGHT_FOLDER: 'temp' }, load), true);
  assert.deepEqual(loaded, ['./app-candidate-preflight-worker.cjs']);
});

test('real main entry returns before any normal startup or single-instance side effects', () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const calls = [];
  const boot = vm.runInNewContext('(function(require){' + source + '\n})');
  boot(name => {
    calls.push(name);
    assert.equal(name, './main/app-preflight-entry.cjs', 'no normal desktop module may load');
    return { dispatch: () => true };
  });
  assert.deepEqual(calls, ['./main/app-preflight-entry.cjs']);
});
