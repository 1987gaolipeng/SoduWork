'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { isolateProfile } = require('../e2e/lib/isolated-profile.cjs');

test('Electron E2E gets independent application and Chromium storage on every invocation', t => {
  const paths = {};
  const app = { isReady: () => false, setPath: (key, value) => { paths[key] = value; } };
  const first = isolateProfile(app, 'profile-contract');
  const second = isolateProfile(app, 'profile-contract');
  t.after(() => {
    for (const item of [first, second]) {
      assert.equal(path.dirname(item.root), path.resolve(os.tmpdir()));
      assert.ok(path.basename(item.root).startsWith('soduwork-e2e-profile-contract-'));
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });
  assert.notEqual(first.root, second.root);
  assert.deepEqual(paths, { userData: second.userData, sessionData: second.sessionData });
  for (const item of [first, second]) {
    assert.equal(path.dirname(item.userData), item.root);
    assert.equal(path.dirname(item.sessionData), item.root);
    assert.notEqual(item.userData, item.sessionData);
    assert.ok(fs.statSync(item.userData).isDirectory());
    assert.ok(fs.statSync(item.sessionData).isDirectory());
  }
  fs.writeFileSync(path.join(first.userData, 'existing-setting'), 'first fixture only');
  assert.deepEqual(fs.readdirSync(second.userData), []);
});

test('profile setup refuses a late call or an unsafe fixture name before changing Electron paths', () => {
  let touched = false;
  const late = { isReady: () => true, setPath: () => { touched = true; } };
  assert.throws(() => isolateProfile(late, 'late'), /before Electron is ready/);
  for (const name of ['', '../outside', 'a/b', 'a\\b', undefined]) {
    assert.throws(() => isolateProfile({ ...late, isReady: () => false }, name), /explicit E2E profile name/);
  }
  assert.equal(touched, false);
});
