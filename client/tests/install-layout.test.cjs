'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { installRoot, launchPath } = require('../main/install-layout');
test('legacy/dev runtime keeps its actual executable', () => {
  const executable = path.resolve('legacy/SoduWork.exe');
  assert.equal(installRoot(executable), path.dirname(executable));
  assert.equal(launchPath(executable), executable);
});
test('versioned runtime uses stable external entry without changing Runner executable', () => {
  const root = path.resolve('中文 SoduWork');
  const executable = path.join(root, '.soduwork-versions/ns123.tmp/SoduWork.exe');
  const exists = p => [path.join(root, '.soduwork-active'), path.join(root, 'SoduWork.exe')].includes(p);
  assert.equal(installRoot(executable, exists), root);
  assert.equal(launchPath(executable, exists), path.join(root, 'SoduWork.exe'));
  assert.equal(launchPath(executable, () => false), executable);
});


test('versioned runtime prefers the SoduWork launcher and falls back to SoduWork', () => {
  const root = path.resolve('中文 SoduWork');
  const executable = path.join(root, '.soduwork-versions/ns124.tmp/SoduWork.exe');
  const exists = p => [path.join(root, '.soduwork-active'), path.join(root, 'SoduWork.exe')].includes(p);
  assert.equal(installRoot(executable, exists), root);
  assert.equal(launchPath(executable, exists), path.join(root, 'SoduWork.exe'));
});

test('first-migration fallback still relaunches through the stable entry', () => {
  const root = path.resolve('legacy-recovery');
  const exists = p => [path.join(root, '.soduwork-launcher'), path.join(root, 'SoduWork.exe')].includes(p);
  assert.equal(launchPath(path.join(root, 'SoduWork.previous.exe'), exists), path.join(root, 'SoduWork.exe'));
});


test('updater installation scope is a closed enum; legacy and malformed markers use registry detection', () => {
  const { installMode } = require('../main/install-layout');
  assert.equal(installMode(process.execPath, () => 'all'), 'all');
  assert.equal(installMode(process.execPath, () => 'CurrentUser'), 'CurrentUser');
  assert.equal(installMode(process.execPath, () => '/D=other'), '');
  assert.equal(installMode(process.execPath, () => { throw Error('missing'); }), '');
});
