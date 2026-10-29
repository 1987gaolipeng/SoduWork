'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

function json(name) {
  return JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
}

test('packaged client has one semantic version across all release manifests', () => {
  const pkg = json('package.json');
  const lock = json('package-lock.json');
  const renderer = json('version.json');

  assert.match(pkg.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(renderer.version, pkg.version);
});
