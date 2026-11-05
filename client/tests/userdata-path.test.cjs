'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { initializeUserData } = require('../main/userdata-path.cjs');

for (const existing of [false, true]) test(`SoduWork ${existing ? 'upgrade preserves its profile' : 'fresh install starts separately'}`, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-profile-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (existing) {
    fs.mkdirSync(path.join(root, 'SoduWork'));
    fs.writeFileSync(path.join(root, 'SoduWork', 'device-auth.json'), 'SoduWork-fixture');
  }
  let selected;
  const app = { getPath: key => { assert.equal(key, 'appData'); return root; },
    setPath: (key, value) => { assert.equal(key, 'userData'); selected = value; } };
  assert.equal(initializeUserData(app, {}), path.join(root, 'SoduWork'));
  assert.equal(selected, path.join(root, 'SoduWork'));
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


test('the canonical profile override is selected and created', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-profile-priority-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const current = path.join(root, 'current');
  let actual;
  const app = { getPath: () => { throw Error('must use explicit profile'); }, setPath: (_, value) => { actual = value; } };
  assert.equal(initializeUserData(app, { SODUWORK_USER_DATA: current }), current);
  assert.equal(actual, current);
  assert.equal(fs.existsSync(current), true);
});

test('source checkouts and distributions have stable independent profiles without reading installed credentials', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-source-profiles-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installed = path.join(root, 'SoduWork');
  fs.mkdirSync(installed); fs.writeFileSync(path.join(installed, 'device-auth.json'), 'installed-private-fixture');
  const app = checkout => ({ isPackaged: false, getAppPath: () => path.join(root, checkout),
    getPath: name => { assert.equal(name, 'appData'); return root; }, setPath() {} });
  const a = initializeUserData(app('checkout-a'), {});
  assert.equal(initializeUserData(app('checkout-a'), {}), a);
  const b = initializeUserData(app('checkout-b'), {});
  const global = initializeUserData(app('checkout-a'), {}, {
    ...require('../main/distribution.cjs').current(), distributionId: 'isolated-test', userDataName: 'Test Client',
  });
  assert.equal(new Set([a, b, global, installed]).size, 4);
  for (const directory of [a, b, global]) assert.equal(fs.existsSync(path.join(directory, 'device-auth.json')), false);
  assert.equal(fs.readFileSync(path.join(installed, 'device-auth.json'), 'utf8'), 'installed-private-fixture');
});

test('source startup rejects installed profile overrides before touching their configuration', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-source-reserved-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { isPackaged: false, getAppPath: () => path.join(root, 'checkout'), getPath: () => root,
    setPath: () => assert.fail('must reject before selecting installed data') };
  for (const name of ['SoduWork', 'soduwork']) {
    for (const suffix of ['', 'nested-dev']) {
      const directory = path.join(root, name, suffix);
      assert.throws(() => initializeUserData(app, { SODUWORK_USER_DATA: directory }), /独立数据目录/);
      assert.equal(fs.existsSync(directory), false);
    }
  }
  for (const name of ['explicit-development', 'SoduWork Development', 'soduwork-other']) {
    const isolated = path.join(root, name);
    app.setPath = (_key, directory) => assert.equal(directory, isolated);
    assert.equal(initializeUserData(app, { SODUWORK_USER_DATA: isolated }), isolated);
  }
});
