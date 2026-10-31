'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { validateFile, validateRuntimeManifest } = require('./validate-runtime-manifest.cjs');

const root = path.resolve(__dirname, '..');
const script = path.join(__dirname, 'validate-runtime-manifest.cjs');
const manifestFile = path.join(root, 'client/runtime-manifest.json');
const valid = () => JSON.parse(fs.readFileSync(manifestFile, 'utf8'));

test('the installed client manifest is the sole validation source', () => {
  assert.deepEqual(validateRuntimeManifest(valid()), []);
  assert.deepEqual(validateFile(), valid());
  assert.equal(valid().zeroPrerequisitePlatforms.includes('win32'), true);
  assert.equal(valid().zeroPrerequisitePlatforms.includes('darwin'), false);
  assert.equal(valid().zeroPrerequisitePlatforms.includes('linux'), false);
});

test('CLI default path is independent of the working directory', () => {
  const result = spawnSync(process.execPath, [script], { cwd: os.tmpdir(), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^OK /);
});

for (const value of [null, [], 'manifest', true, 1, {}]) {
  test(`malformed JSON value is rejected without crashing: ${JSON.stringify(value)}`, () => {
    const errors = validateRuntimeManifest(value);
    assert.ok(errors.length > 0);
    assert.ok(errors.every((error) => typeof error === 'string'));
  });
}

const cases = [
  ['unsupported schema', (m) => { m.schema = 'soduwork.client-runtime/v0'; }, /schema/],
  ['unknown key', (m) => { m.repair = { supported: true }; }, /repair/],
  ['undeclared dependency', (m) => { m.hostPrerequisites = ['python']; }, /hostPrerequisites/],
  ['online base install', (m) => { m.networkInstall = true; }, /networkInstall/],
  ['missing optional download policy', (m) => { delete m.optionalDownloads; }, /optionalDownloads/],
  ['unsupported platform', (m) => { m.supportedPlatforms.push('freebsd'); }, /unsupported platform/],
  ['duplicate platform', (m) => { m.supportedPlatforms.push('win32'); }, /duplicates/],
  ['null platform list', (m) => { m.supportedPlatforms = null; }, /supportedPlatforms/],
  ['zero prerequisites outside supported platforms', (m) => {
    m.supportedPlatforms = ['darwin'];
    m.bundled.runner.relativePaths = { darwin: m.bundled.runner.relativePaths.darwin };
  }, /must be supported/],
  ['missing bundled component', (m) => { m.bundled.python = false; }, /bundled.python/],
  ['invalid bundled payload', (m) => { m.bundled = []; }, /bundled must be an object/],
  ['missing runner', (m) => { m.bundled.runner = null; }, /bundled.runner must be an object/],
  ['optional runner', (m) => { m.bundled.runner.required = false; }, /runner.required/],
  ['system python runner', (m) => { m.bundled.runner.kind = 'system-python'; }, /runner.kind/],
  ['missing platform runner path', (m) => { delete m.bundled.runner.relativePaths.win32; }, /relativePaths.win32/],
  ['runner path traversal', (m) => { m.bundled.runner.relativePaths.win32 = '../python.exe'; }, /relativePaths.win32/],
  ['absolute runner path', (m) => { m.bundled.runner.relativePaths.win32 = 'C:\\Python\\python.exe'; }, /relativePaths.win32/],
];
for (const [name, change, expected] of cases) {
  test(`rejects ${name}`, () => {
    const manifest = valid();
    change(manifest);
    assert.match(validateRuntimeManifest(manifest).join('\n'), expected);
  });
}

test('CLI returns a failure for corrupt JSON and invalid declarations', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-runtime-contract-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'runtime-manifest.json');
  for (const data of ['{', 'null', JSON.stringify({ ...valid(), hostPrerequisites: ['node'] })]) {
    fs.writeFileSync(file, data);
    const result = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^runtime manifest:/);
    assert.doesNotMatch(result.stdout, /OK /);
  }
  const missing = spawnSync(process.execPath, [script, path.join(directory, 'missing.json')], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /ENOENT/);
});
