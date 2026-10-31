'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { readManifest, runnerPath, requiredFiles, verify } = require('../scripts/verify-runtime.cjs');

const root = path.resolve(__dirname, '..');

test('runtime manifest declares a zero-prerequisite client', () => {
  const manifest = readManifest(root);
  assert.deepEqual(manifest.hostPrerequisites, []);
  assert.equal(manifest.networkInstall, false);
  assert.equal(manifest.bundled.runner.required, true);
});

test('runner location is deterministic and never resolved from PATH', () => {
  assert.match(runnerPath(root, 'win32').replaceAll('\\', '/'), /resources\/runner\/soduwork-runner\.exe$/);
  assert.match(runnerPath(root, 'linux').replaceAll('\\', '/'), /resources\/runner\/soduwork-runner$/);
});

test('source checkout reports missing generated runner clearly', () => {
  assert.throws(() => verify(root, process.platform, { packaged: true }), /ENOENT/);
});
test('package gate rejects each missing component and accepts a complete resource tree', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-runtime-gate-'));
  t.after(() => { assert.equal(path.dirname(temp), os.tmpdir()); fs.rmSync(temp, { recursive: true, force: true }); });
  const resources = path.join(temp, 'resources');
  fs.mkdirSync(resources);
  const manifest = readManifest(root);
  fs.writeFileSync(path.join(resources, 'runtime-manifest.json'), JSON.stringify(manifest));
  const files = requiredFiles(manifest, 'win32');
  for (const relative of files) {
    const file = path.join(resources, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fixture');
  }
  assert.equal(verify(temp, 'win32', { packaged: true }).checkedFiles, files.length);
  for (const relative of files) {
    const file = path.join(resources, relative); fs.writeFileSync(file, '');
    assert.throws(() => verify(temp, 'win32', { packaged: true }), /missing or empty/);
    fs.writeFileSync(file, 'fixture');
  }
  manifest.hostPrerequisites = ['python'];
  fs.writeFileSync(path.join(resources, 'runtime-manifest.json'), JSON.stringify(manifest));
  assert.throws(() => verify(temp, 'win32', { packaged: true }), /hostPrerequisites/);
});
test('Windows npm survives electron-builder root node_modules filtering', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-node-copy-'));
  t.after(() => { assert.equal(path.dirname(temp), os.tmpdir()); fs.rmSync(temp, { recursive: true, force: true }); });
  const relative = '.runtime/node/node_modules/npm/bin/npm-cli.js';
  const source = path.join(temp, relative);
  fs.mkdirSync(path.dirname(source), { recursive: true }); fs.writeFileSync(source, 'npm entry');
  const pkg = require('../package.json');
  const mapping = pkg.build.win.extraResources.find(item => item.to === 'node/node_modules');
  assert.ok(mapping, 'npm requires an explicit resource root');
  const { FileMatcher, copyFiles } = require('app-builder-lib/out/fileMatcher');
  const output = path.join(temp, 'resources', mapping.to);
  await copyFiles([new FileMatcher(path.join(temp, mapping.from), output, value => value, mapping.filter)]);
  assert.equal(fs.readFileSync(path.join(output, 'npm/bin/npm-cli.js'), 'utf8'), 'npm entry');
});
