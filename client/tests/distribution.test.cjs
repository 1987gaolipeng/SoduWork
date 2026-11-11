"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const distribution = require('../main/distribution.cjs');
const endpoint = require('../main/hub-endpoint.cjs');
const { initializeUserData } = require('../main/userdata-path.cjs');
const { canonicalBytes, manifestPayload, validateManifest } = require('../main/client-update-contract');

function appFixture(t, isPackaged) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-self-hosted-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const wrapper = path.resolve(__dirname, '../e2e/packaged-runner.cjs');
  for (const id of ['stage', 'internal', 'cn', 'global']) {
    const profile = distribution.getProfile(id);
    const source = path.join(root, id, 'source'), payload = path.join(root, id, 'payload');
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(path.join(payload, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({
      productName: profile.productName, soduworkDistribution: profile,
    }));
    await asar.createPackage(source, path.join(payload, 'resources/app.asar'));
    const command = ['-e', 'console.log(JSON.stringify(require(process.argv[1]).runtimeArguments("probe.py", process.argv[2], "isolated-data", "task")))', wrapper, payload];
    const env = { ...process.env, SODUWORK_DISTRIBUTION: id };
    const actual = JSON.parse(execFileSync(process.execPath, command, { env, encoding: 'utf8' }));
    assert.deepEqual(actual, ['-X', 'utf8', 'probe.py', path.join(payload, 'resources/runner/soduwork-runner.exe'),
      payload, 'isolated-data', path.join(payload, profile.windowsExecutableName + '.exe')]);
    assert.throws(() => execFileSync(process.execPath, command, {
      env: { ...env, SODUWORK_DISTRIBUTION: id === 'cn' ? 'global' : 'cn' }, stdio: 'pipe',
    }), /another distribution/);
  }
});

test('public build profiles preserve internal identity and separate every cloud installation', () => {
  const profiles = ['internal', 'stage', 'cn', 'global'].map(distribution.getProfile);
  const internal = profiles[0];
  const packageInfo = require('../package.json');
  assert.equal(internal.appId, packageInfo.build.appId);
  assert.equal(internal.nsisGuid, packageInfo.build.nsis.guid);
  assert.equal(internal.linuxPackageName, packageInfo.build.deb.packageName);
  assert.deepEqual(internal.updateTrust, require('../update-trust.json'));
  for (const key of ['appId', 'nsisGuid', 'userDataName', 'windowsExecutableName', 'linuxPackageName']) {
    assert.equal(new Set(profiles.map(row => row[key])).size, 3, key);
  }
  assert.equal(new Set(profiles.map(row => row.hubOrigin)).size, 4);
  assert.deepEqual(profiles[1].updateTrust, internal.updateTrust);
  const keys = profiles.slice(2).flatMap(row => Object.keys(row.updateTrust.keys));
  assert.equal(new Set(keys).size, keys.length);
  assert.throws(() => distribution.selected({ SODUWORK_DISTRIBUTION: 'unknown' }), /Unknown/);
  assert.throws(() => distribution.selected({ SODUWORK_DISTRIBUTION: 'cn', SODUWORK_RELEASE_HUB_URL: profiles[3].hubOrigin }), /does not match/);
});

test('source integration harness cannot use any installed distribution data directory', () => {
  const root = path.resolve('fixture-app-data');
  for (const id of ['stage', 'internal', 'cn', 'global']) {
    const userData = path.join(root, distribution.getProfile(id).userDataName);
    const app = { isPackaged: false, getPath: key => key === 'appData' ? root : userData };
    assert.throws(() => endpoint.initialize(app, { SODUWORK_USER_DATA: userData,
      SODUWORK_TEST_HUB_URL: 'http://127.0.0.1:54321' }), /isolated/);
  }
});

for (const id of ['cn', 'global']) {
  test(`${id} first install and restart retain their own Hub and profile without importing internal data`, t => {
    const profile = distribution.getProfile(id);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-distribution-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'SoduWork'));
    fs.writeFileSync(path.join(root, 'SoduWork', 'device-auth.json'), 'internal-credentials');
    let userData;
    const app = { isPackaged: true, getPath: key => key === 'appData' ? root : userData,
      setPath: (_, value) => { userData = value; } };
    initializeUserData(app, {}, profile);
    assert.equal(userData, path.join(root, profile.userDataName));
    assert.equal(fs.existsSync(path.join(userData, 'device-auth.json')), false);
    fs.writeFileSync(path.join(userData, 'hub-endpoint.json'), JSON.stringify({ hub: distribution.getProfile('internal').hubOrigin }));
    const env = { SODUWORK_DISTRIBUTION: 'internal', SODUWORK_HUB_URL: 'https://other.invalid', SODUWORK_TEST_HUB_URL: 'http://127.0.0.1:9080' };
    for (let restart = 0; restart < 2; restart++) {
      assert.equal(endpoint.initialize(app, env, profile).hub, profile.hubOrigin);
      assert.equal(endpoint.prepare(app, distribution.getProfile('internal').hubOrigin).ok, false);
    }
    assert.equal(fs.readFileSync(path.join(root, 'SoduWork', 'device-auth.json'), 'utf8'), 'internal-credentials');
  });

  test(`${id} packaged metadata selects its environment even when process variables name another one`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-bundled-profile-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'main'));
    for (const file of ['main/distribution.cjs', 'distributions.json', 'update-trust.json']) {
      fs.copyFileSync(path.join(__dirname, '..', file), path.join(root, file));
    }
    const profile = distribution.getProfile(id);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ soduworkDistribution: profile }));
    const actual = JSON.parse(execFileSync(process.execPath, ['-e', 'console.log(JSON.stringify(require("./main/distribution.cjs").current()))'],
      { cwd: root, env: { ...process.env, SODUWORK_DISTRIBUTION: 'internal', SODUWORK_RELEASE_HUB_URL: 'https://other.invalid' } }));
    assert.deepEqual(actual, profile);
    assert.throws(() => distribution.fromMetadata({ ...profile, hubOrigin: 'https://other.invalid' }), /differs/);
    assert.throws(() => distribution.fromMetadata({ ...profile, updateTrust: distribution.getProfile('internal').updateTrust }), /differs/);
  });

  test(`${id} rejects update manifests signed for another distribution`, () => {
    const profile = distribution.getProfile(id);
    for (const other of ['stage', 'internal', 'cn', 'global'].filter(value => value !== id)) {
      const manifest = { schema: 1, version: '1.13.3', releaseId: '00000000-0000-4000-8000-000000000001', channel: 'stable',
        platform: 'win32', arch: 'x64', keyId: Object.keys(distribution.getProfile(other).updateTrust.keys)[0],
        artifact: { name: 'SoduWork-1.13.3-Setup.exe', size: 1048576, sha256: 'a'.repeat(64),
          url: '/api/v1/client-updates/artifacts/00000000-0000-4000-8000-000000000001' }, signature: Buffer.alloc(64).toString('base64') };
      assert.throws(() => validateManifest(manifest, profile.updateTrust, 'win32'), /不受信任/);
    }
  });
}

test('public identity comes from the existing package and accepts empty update trust', () => {
  const profile = distribution.current();
  const packageInfo = require('../package.json');
  assert.equal(profile.distributionId, 'self-hosted');
  assert.equal(profile.hubOrigin, 'http://127.0.0.1:18989');
  assert.equal(profile.websiteUrl, packageInfo.homepage || '');
  assert.equal(profile.appId, packageInfo.build.appId);
  assert.equal(profile.productName, packageInfo.productName);
  assert.equal(profile.userDataName, 'SoduWork');
  assert.equal(profile.workspaceName, 'SoduWork');
  assert.equal(profile.linuxPackageName, packageInfo.build.deb.packageName);
  assert.deepEqual(profile.updateTrust, require('../update-trust.json'));
  assert.deepEqual(profile.updateTrust.keys, {});
  assert.ok(Object.isFrozen(profile.updateTrust.keys));
  assert.deepEqual(distribution.fromMetadata(profile), profile);
  for (const id of ['internal', 'cn', 'global', 'unknown']) {
    assert.throws(() => distribution.selected({ SODUWORK_DISTRIBUTION: id }), /Unknown/);
  }
});

test('bundled metadata cannot inject another Hub or update signing key', () => {
  const profile = distribution.current();
  assert.throws(() => distribution.fromMetadata({ ...profile, hubOrigin: 'https://another.example.test' }), /differs/);
  assert.throws(() => distribution.fromMetadata({ ...profile, updateTrust: { schema: 1,
    keys: { injected: crypto.randomBytes(32).toString('base64') } } }), /differs/);
  assert.throws(() => distribution.selected({ SODUWORK_RELEASE_HUB_URL: 'https://another.example.test' }), /does not match/);
});

test('self-hosted update channels are explicit, validated and bound to package identity', () => {
  const packageInfo = require('../package.json');
  const previous = packageInfo.soduworkUpdateChannel;
  try {
    delete packageInfo.soduworkUpdateChannel;
    const stable = distribution.getProfile();
    assert.equal(stable.updateChannel, 'stable');
    packageInfo.soduworkUpdateChannel = 'beta';
    const beta = distribution.getProfile();
    assert.equal(beta.updateChannel, 'beta');
    assert.notEqual(beta.configSha256, stable.configSha256);
    assert.deepEqual(distribution.fromMetadata(beta), beta);
    assert.throws(() => distribution.fromMetadata(stable), /differs/);
    packageInfo.soduworkUpdateChannel = 'unknown';
    assert.throws(() => distribution.getProfile(), /Invalid Client update channel/);
  } finally {
    if (previous === undefined) delete packageInfo.soduworkUpdateChannel;
    else packageInfo.soduworkUpdateChannel = previous;
  }
});

test('an otherwise valid signed manifest is rejected when public trust has no keys', () => {
  const signing = crypto.generateKeyPairSync('ed25519');
  const manifest = { schema: 1, version: '99.0.0', releaseId: '00000000-0000-4000-8000-000000000001',
    channel: 'stable', platform: 'win32', arch: 'x64', keyId: 'unregistered',
    artifact: { name: 'SoduWork-99.0.0-Setup.exe', size: 1048576, sha256: 'a'.repeat(64),
      url: '/api/v1/client-updates/artifacts/00000000-0000-4000-8000-000000000001' },
    signature: Buffer.alloc(64).toString('base64') };
  manifest.signature = crypto.sign(null, canonicalBytes(manifestPayload(manifest)), signing.privateKey).toString('base64');
  const fixtureTrust = { schema: 1, keys: { unregistered: signing.publicKey.export({ format: 'der', type: 'spki' })
    .subarray(-32).toString('base64') } };
  assert.equal(validateManifest(manifest, fixtureTrust, 'win32'), manifest);
  assert.throws(() => validateManifest(manifest, distribution.current().updateTrust, 'win32'), /不受信任/);
});

for (const isPackaged of [false, true]) test(`self-hosted ${isPackaged ? 'packaged' : 'source'} clients persist an editable Hub`, t => {
  const app = appFixture(t, isPackaged);
  assert.deepEqual(endpoint.initialize(app, {}), { hub: 'http://127.0.0.1:18989', editable: true, internalTest: false });
  assert.equal(endpoint.prepare(app, 'https://hub.example.test').ok, true);
  assert.equal(endpoint.initialize(app, {}).hub, 'https://hub.example.test');
  assert.equal(distribution.publicInfo().websiteUrl, '');
});
