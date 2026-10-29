'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { initializeUserData } = require('../main/userdata-path.cjs');

for (const existing of [false, true]) test(`SoduWork ${existing ? 'upgrade preserves its profile' : 'fresh install starts separately'} without moving old profiles`, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-profile-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const brand of ['SoduWork', ...(existing ? ['SoduWork'] : [])]) {
    fs.mkdirSync(path.join(root, brand));
    fs.writeFileSync(path.join(root, brand, 'device-auth.json'), brand + '-fixture');
  }
  let selected;
  const app = { getPath: key => { assert.equal(key, 'appData'); return root; },
    setPath: (key, value) => { assert.equal(key, 'userData'); selected = value; } };
  assert.equal(initializeUserData(app, {}), path.join(root, 'SoduWork'));
  assert.equal(selected, path.join(root, 'SoduWork'));
  for (const brand of ['other-brand-dir']) {
    assert.equal(fs.readFileSync(path.join(root, brand, 'device-auth.json'), 'utf8'), brand + '-fixture');
  }
  assert.equal(fs.existsSync(path.join(selected, 'device-auth.json')), existing);
  if (existing) assert.equal(fs.readFileSync(path.join(selected, 'device-auth.json'), 'utf8'), 'SoduWork-fixture');
});
test('explicit isolated userData is retained and path setup failures stop startup', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-isolated-profile-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const app = { getPath: () => { throw Error('Unexpected default path lookup'); },
    setPath: (key, value) => { assert.equal(key, 'userData'); assert.equal(value, directory); } };
  assert.equal(initializeUserData(app, { SODUWORK_USER_DATA: directory }), directory);
  app.setPath = () => { throw Error('Invalid isolated profile'); };
  assert.throws(() => initializeUserData(app, { SODUWORK_USER_DATA: directory }), /Invalid isolated profile/);
});


test('explicit profile override wins over the default appData directory', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-profile-priority-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const current = path.join(root, 'current'), other = path.join(root, 'other');
  let actual;
  const app = { getPath: () => { throw Error('must use explicit profile'); }, setPath: (_, value) => { actual = value; } };
  assert.equal(initializeUserData(app, { SODUWORK_USER_DATA: current }), current);
  assert.equal(actual, current);
  assert.equal(fs.existsSync(current), true);
  assert.equal(fs.existsSync(other), false);
});
