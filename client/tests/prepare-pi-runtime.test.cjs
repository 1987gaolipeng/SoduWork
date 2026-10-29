'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { preparePiRuntime } = require('../scripts/prepare-pi-runtime.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-runtime-layout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packages = { '': {}, 'node_modules/@earendil-works/pi-coding-agent': { version: '1.4.0' } };
  function add(name, version, metadata = {}) {
    packages[name] = { version, ...metadata };
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }));
    fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = ' + JSON.stringify(version));
  }
  add('node_modules/@earendil-works/pi-coding-agent', '1.4.0');
  function run() {
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages }));
    return preparePiRuntime(root);
  }
  return { root, packages, add, run };
}

test('production staging preserves hoisted and nested versions and excludes build-only packages', t => {
  const f = fixture(t);
  f.add('node_modules/dependency', '2.0.0');
  f.add('node_modules/@earendil-works/pi-coding-agent/node_modules/dependency', '1.0.0');
  f.add('node_modules/build-only', '9.0.0', { dev: true });
  f.add('node_modules/@earendil-works/pi-coding-agent/node_modules/dev-only', '9.0.0', { dev: true });
  f.packages['node_modules/other-platform'] = { version: '1.0.0', optional: true };
  const { output } = f.run();
  const sdk = path.join(output, 'node_modules/@earendil-works/pi-coding-agent');
  assert.equal(require(path.join(sdk, 'node_modules/dependency')), '1.0.0');
  assert.equal(require(path.join(output, 'node_modules/dependency')), '2.0.0');
  assert.equal(fs.existsSync(path.join(output, 'node_modules/build-only')), false);
  assert.equal(fs.existsSync(path.join(sdk, 'node_modules/dev-only')), false);
  fs.writeFileSync(path.join(output, 'stale.js'), 'stale');
  f.run();
  assert.equal(fs.existsSync(path.join(output, 'stale.js')), false);
});

test('missing or mismatched required runtime dependencies fail before staging', t => {
  const f = fixture(t);
  f.packages['node_modules/missing'] = { version: '1.0.0' };
  assert.throws(f.run, /Missing locked runtime package/);
  f.add('node_modules/missing', '1.0.0');
  f.packages['node_modules/missing'].version = '2.0.0';
  assert.throws(f.run, /differs from lock/);
});

test('unsafe package paths and linked dependencies cannot enter runtime staging', t => {
  const f = fixture(t);
  f.packages['node_modules/../../outside'] = { version: '1.0.0' };
  assert.throws(f.run, /Unsupported runtime package path/);
  delete f.packages['node_modules/../../outside'];
  f.packages['node_modules/linked'] = { link: true };
  assert.throws(f.run, /Unsupported runtime package path/);
});
