'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildDefaultHub, bundledDefaultHub, DEFAULT_HUB_URL } = require('../main/default-hub.cjs');
const distribution = require('../main/distribution.cjs');

test('omitted and empty build settings retain AWS; explicit origins are normalized', () => {
  assert.equal(buildDefaultHub({}), DEFAULT_HUB_URL);
  assert.equal(buildDefaultHub({ SODUWORK_DEFAULT_HUB_URL: '' }), DEFAULT_HUB_URL);
  assert.equal(buildDefaultHub({ SODUWORK_DEFAULT_HUB_URL: 'https://HUB.example.test:443/' }), 'https://hub.example.test');
  assert.equal(buildDefaultHub({ SODUWORK_DEFAULT_HUB_URL: 'http://localhost:18989' }), 'http://localhost:18989');
  assert.equal(bundledDefaultHub({}), DEFAULT_HUB_URL);
});

test('invalid origins fail without echoing credentials or silently discarding paths', () => {
  for (const value of [' ', null, 42, 'hub.example.test', 'file:///tmp/hub', 'https://fixture:secret@hub.example.test',
    'https://@hub.example.test', 'https://hub.example.test/api', 'https://hub.example.test/.',
    'https://hub.example.test/%2e', 'https://hub.example.test/?token=secret', 'https://hub.example.test?',
    'https://hub.example.test#', 'https://hub.example.test\n', 'https://hub.example.test\\other']) {
    assert.throws(() => buildDefaultHub({ SODUWORK_DEFAULT_HUB_URL: value }), error => {
      assert.match(error.message, /Default Hub must/);
      assert.doesNotMatch(error.message, /secret|fixture/);
      return true;
    });
  }
  assert.throws(() => bundledDefaultHub({ soduworkDefaultHubUrl: '' }), /Default Hub must/);
});

function configuration(hub) {
  const result = spawnSync(process.execPath, ['-e',
    "console.log(JSON.stringify(require('./scripts/public-build-config.cjs')))"], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
    env: { ...process.env, SODUWORK_DEFAULT_HUB_URL: hub },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('builder configuration changes only the bundled default address', () => {
  const aws = configuration(''), custom = configuration('https://hub.example.test');
  assert.equal(aws.extraMetadata.soduworkDefaultHubUrl, DEFAULT_HUB_URL);
  assert.equal(custom.extraMetadata.soduworkDefaultHubUrl, 'https://hub.example.test');
  delete aws.extraMetadata.soduworkDefaultHubUrl;
  delete custom.extraMetadata.soduworkDefaultHubUrl;
  assert.deepEqual(custom, aws);
  const { extraMetadata, ...base } = custom;
  assert.deepEqual(base, require('../package.json').build);
  assert.deepEqual(extraMetadata, {});
});

test('build profile agrees with bundled metadata and retains identity and update trust', () => {
  const normal = distribution.selected({});
  const custom = distribution.selected({ SODUWORK_DEFAULT_HUB_URL: 'https://hub.example.test',
    SODUWORK_RELEASE_HUB_URL: 'https://hub.example.test' });
  assert.equal(custom.hubOrigin, 'https://hub.example.test');
  for (const key of Object.keys(normal).filter(key => !['hubOrigin', 'configSha256'].includes(key))) {
    assert.deepEqual(custom[key], normal[key], key);
  }
  assert.throws(() => distribution.selected({ SODUWORK_DEFAULT_HUB_URL: 'https://hub.example.test',
    SODUWORK_RELEASE_HUB_URL: DEFAULT_HUB_URL }), /does not match/);
});

test('a packaged custom default survives restart, ignores runtime overrides and respects saved selection', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-build-default-hub-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appRoot = path.join(root, 'app'), profile = path.join(root, 'profile');
  fs.mkdirSync(path.join(appRoot, 'main'), { recursive: true });
  fs.mkdirSync(profile);
  for (const name of ['default-hub.cjs', 'hub-endpoint.cjs', 'distribution.cjs']) {
    fs.copyFileSync(path.join(__dirname, '../main', name), path.join(appRoot, 'main', name));
  }
  fs.copyFileSync(path.join(__dirname, '../update-trust.json'), path.join(appRoot, 'update-trust.json'));
  const metadata = { ...require('../package.json'), ...configuration('https://hub.example.test').extraMetadata };
  fs.writeFileSync(path.join(appRoot, 'package.json'), JSON.stringify(metadata));
  const code = "const endpoint=require('./main/hub-endpoint.cjs');" +
    "const app={isPackaged:true,getPath:()=>process.env.FIXTURE_PROFILE};" +
    "console.log(JSON.stringify({connection:endpoint.initialize(app),profile:require('./main/distribution.cjs').current()}))";
  function launch() {
    const result = spawnSync(process.execPath, ['-e', code], { cwd: appRoot, encoding: 'utf8',
      env: { ...process.env, FIXTURE_PROFILE: profile, SODUWORK_DEFAULT_HUB_URL: 'https://runtime.invalid' } });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  for (let i = 0; i < 2; i++) {
    const actual = launch();
    assert.equal(actual.connection.hub, 'https://hub.example.test');
    assert.equal(actual.profile.hubOrigin, 'https://hub.example.test');
    assert.equal(actual.profile.appId, distribution.current().appId);
    assert.deepEqual(actual.profile.updateTrust, distribution.current().updateTrust);
  }
  fs.writeFileSync(path.join(profile, 'hub-endpoint.json'), JSON.stringify({ hub: 'https://saved.example.test' }));
  assert.equal(launch().connection.hub, 'https://saved.example.test');
});
