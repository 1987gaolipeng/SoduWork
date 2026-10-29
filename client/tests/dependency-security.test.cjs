const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));

function parts(value) {
  return String(value || '').replace(/^[^0-9]*/, '').split(/[.-]/)
    .slice(0, 3).map((item) => Number.parseInt(item, 10) || 0);
}

function atLeast(value, minimum) {
  const left = parts(value);
  const right = parts(minimum);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return true;
}

test('packaged desktop dependencies keep the audited security baseline', () => {
  const electron = lock.packages['node_modules/electron']?.version;
  const builder = lock.packages['node_modules/electron-builder']?.version;
  const pi = lock.packages['node_modules/@earendil-works/pi-coding-agent']?.version;

  assert.ok(atLeast(electron, '44.9.1'), `Electron ${electron} is below 44.9.1`);
  assert.ok(atLeast(builder, '26.15.3'), `electron-builder ${builder} is below 26.15.3`);
  assert.ok(atLeast(pkg.devDependencies.electron, '44.9.1'));
  assert.match(pkg.devDependencies['electron-builder'], /26\.15\.3/);
  // SDK 1.4 has no internal shrinkwrap, so audited dependency overrides can take effect.
  assert.equal(pkg.dependencies['@earendil-works/pi-coding-agent'], '1.4.0');
  assert.equal(pi, '1.4.0');
  assert.equal(lock.packages['node_modules/@earendil-works/pi-coding-agent'].hasShrinkwrap, undefined);
  for (const [name, row] of Object.entries(lock.packages)) {
    if (name.endsWith('/undici')) {
      const minimum = { 6: '6.29.1', 7: '7.30.1', 8: '8.12.2' }[parts(row.version)[0]];
      assert.ok(minimum && atLeast(row.version, minimum), `${name}@${row.version} needs a reviewed Undici fix`);
    }
    if (name.endsWith('/fast-uri')) {
      const minimum = { 2: '2.4.8', 3: '3.1.9', 4: '4.2.3' }[parts(row.version)[0]];
      assert.ok(minimum && atLeast(row.version, minimum), `${name}@${row.version} needs a reviewed URI fix`);
    }
    if (row.dev) continue;
    if (name.endsWith('/brace-expansion')) assert.ok(atLeast(row.version, '5.0.12'));
  }
});
