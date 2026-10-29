'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function candidate(prepare) {
  const events = [];
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, '../scripts/build-installer-candidate.cjs'), 'utf8');
  const requireFixture = name => {
    if (name === 'node:fs/promises') return { mkdir: async () => {
      events.push('snapshot'); throw Error('stop after preparation');
    } };
    if (name === 'electron-builder') return { build: () => { throw Error('must not package'); } };
    if (name === './prepare-runner.cjs') return { prepareRunner: () => {
      events.push('runner'); prepare();
    } };
    return require(name);
  };
  vm.runInNewContext(source, { require: requireFixture, module, process,
    __dirname: path.resolve(__dirname, '../scripts'), console });
  return { run: module.exports.main, events };
}

test('candidate builder compiles Runner before copying any sources or package resources', async () => {
  const c = candidate(() => {});
  await assert.rejects(c.run([path.resolve(__dirname, '../dist/candidate-test-output'), '1.2.3', path.resolve('electron.zip')]), /stop after preparation/);
  assert.deepEqual(c.events, ['runner', 'snapshot']);
});

test('candidate builder cannot use stale Runner bytes when source compilation fails', async () => {
  const c = candidate(() => { throw Error('Runner compilation failed'); });
  await assert.rejects(c.run([path.resolve(__dirname, '../dist/candidate-test-output'), '1.2.3', path.resolve('electron.zip')]), /Runner compilation failed/);
  assert.deepEqual(c.events, ['runner']);
});

test('invalid candidate arguments fail before Runner compilation', async () => {
  const c = candidate(() => {});
  await assert.rejects(c.run(['relative', 'not-version', 'relative']), /Usage/);
  assert.deepEqual(c.events, []);
});
