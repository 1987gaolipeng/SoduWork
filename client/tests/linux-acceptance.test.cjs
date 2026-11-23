'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../tools/github/accept-linux.cjs'), 'utf8');
test('Linux packages install the libsecret client required by Electron safeStorage', () => {
  const { build } = require('../package.json');
  assert.ok(build.deb.depends.includes('libsecret-1-0'));
  assert.ok(build.rpm.depends.includes('libsecret'));
});
async function exercise(firstRelease, overrides = {}) {
  const calls = [], reads = [], errors = [], version = '1.13.15';
  let checks;
  const state = { platform: 'linux', exitCode: undefined };
  const contract = {
    root: '/fixture', dist: '/fixture/dist',
    verify: async () => ({ version, defaultHubUrl: 'https://hub.example.test',
      artifacts: ['deb', 'rpm', 'tar.gz'].map(format => ({ name: `candidate.${format}`, format })) }),
    read: async file => {
      reads.push(file);
      if (path.basename(file) !== 'result.json') {
        return { defaultHubUrl: path.basename(file) === 'old.json' ? undefined :
          (overrides.defaultHubUrl ?? 'https://hub.example.test'),
          secureStorage: { backend: 'gnome_libsecret', roundTrip: true, ...overrides.secureStorage } };
      }
      return { ok: true, version, upgraded: !firstRelease, reinstalled: firstRelease,
        oldVersion: firstRelease ? '' : '1.13.14', nodeShimExecutable: true,
        credentialProviderDependencyVerified: path.basename(path.dirname(file)) !== 'ubuntu22-tgz',
        rpmSignatureVerified: path.basename(path.dirname(file)).endsWith('-rpm'),
        legacyUnsignedRpmBaseline: !firstRelease && !!overrides.legacy && path.basename(path.dirname(file)).endsWith('-rpm'),
        upgradeDependencyResolutionVerified: false, ...overrides.result };
    },
    acceptance: async (_platform, rows) => { checks = rows; },
  };
  const modules = {
    'node:fs/promises': { mkdtemp: async () => '/fixture/packages', mkdir: async () => {}, copyFile: async () => {}, rm: async () => {} },
    'node:path': path.posix, 'node:os': { tmpdir: () => '/fixture', userInfo: () => ({ uid: 12001 }) },
    'node:assert/strict': assert, 'node:crypto': require('node:crypto'),
    '../ci/release-artifacts.cjs': contract,
    '../ci/acceptance-common.cjs': { run: async (...args) => { calls.push(args); },
      soduworkBaseline: async key => firstRelease ? null : { path: `/fixture/${key}`, version: '1.13.14',
        ...(overrides.legacy && key.endsWith('-rpm') ? { rpmSignature: 'legacy-unsigned', sha256: 'a'.repeat(64) } : {}) } },
  };
  await vm.runInNewContext(source, { process: state, require: name => modules[name],
    console: { error: error => errors.push(error) } });
  return { calls, reads, errors, state, checks };
}

for (const firstRelease of [true, false]) test(`Linux acceptance preserves ${firstRelease ? 'first release reinstall' : 'upgrade'} evidence`, async () => {
  const { calls, reads, errors, state, checks } = await exercise(firstRelease);
  assert.deepEqual(errors, []);
  assert.equal(state.exitCode, undefined);
  assert.equal(checks.length, 5);
  assert.ok(checks.some(row => row.name === 'fedora45-rpm'));
  for (const row of checks) {
    assert.equal(row.upgraded, !firstRelease);
    assert.equal(row.reinstalled, firstRelease);
    assert.equal(row.secureStorageBackend, 'gnome_libsecret');
    assert.equal(row.credentialProviderDependencyVerified, row.name !== 'ubuntu22-tgz');
    assert.equal(row.upgradeDependencyResolutionVerified, false);
    assert.equal(row.rpmSignatureVerified, row.name.endsWith('-rpm'));
    assert.deepEqual(reads.filter(file => path.basename(path.dirname(file)) === row.name).map(file => path.basename(file)),
      ['result.json', 'fresh.json', 'restart.json', ...(firstRelease ? [] : ['old.json']), 'restored.json']);
  }
  for (const [, args] of calls.filter(([, args]) => args[0] === 'create')) {
    assert.equal(args[args.indexOf('--cap-add') + 1], 'IPC_LOCK');
    assert.equal(args.includes('--privileged'), false);
    assert.ok(args.includes('/fixture/client/package.json:/client/package.json:ro'));
    assert.ok(args.includes('/fixture/client/main/default-hub.cjs:/client/main/default-hub.cjs:ro'));
    assert.ok(args.includes('SODUWORK_DEFAULT_HUB_URL=https://hub.example.test'));
  }
  const verifies = calls.filter(([, args]) => args[0] === 'exec' && args[4] === 'verify');
  assert.equal(verifies.length, 5);
  for (const [, args] of verifies) {
    assert.equal(args.at(-1), '-');
    assert.equal(args.at(-2), firstRelease ? '-' : '1.13.14');
    if (firstRelease) assert.equal(args.at(-3), '-');
  }
  assert.equal(calls.filter(([, args]) => args[0] === 'rm').length, 5);
});

test('legacy RPM upgrade exception is hash pinned, RPM only and recorded without waiving candidate signing', async () => {
  const { calls, checks, errors } = await exercise(false, { legacy: true });
  assert.deepEqual(errors, []);
  for (const row of checks) {
    assert.equal(row.legacyUnsignedRpmBaseline, row.name.endsWith('-rpm'));
    assert.equal(row.oldSha256, row.name.endsWith('-rpm') ? 'a'.repeat(64) : undefined);
    if (row.name.endsWith('-rpm')) assert.equal(row.rpmSignatureVerified, true);
  }
  for (const [, args] of calls.filter(([, args]) => args[0] === 'exec' && args[4] === 'verify'))
    assert.equal(args.at(-1), args[5] === 'rpm' ? 'a'.repeat(64) : '-');
  const failed = await exercise(false, { legacy: true, result: { rpmSignatureVerified: false } });
  assert.equal(failed.state.exitCode, 1);
  assert.equal(failed.checks, undefined);
});

test('Linux acceptance cannot report success without RPM signature evidence', async () => {
  const { errors, state, checks } = await exercise(true, { result: { rpmSignatureVerified: false } });
  assert.equal(errors.length, 1);
  assert.equal(state.exitCode, 1);
  assert.equal(checks, undefined);
});

test('Linux acceptance rejects missing package dependencies and insecure phase evidence', async () => {
  for (const overrides of [
    { result: { credentialProviderDependencyVerified: false } },
    { result: { upgradeDependencyResolutionVerified: true } },
    { secureStorage: { backend: 'basic_text' } },
    { secureStorage: { roundTrip: false } },
    { defaultHubUrl: 'https://service.soduwork.ai' },
  ]) {
    const { calls, errors, state, checks } = await exercise(true, overrides);
    assert.equal(errors.length, 1);
    assert.equal(state.exitCode, 1);
    assert.equal(checks, undefined);
    assert.equal(calls.filter(([, args]) => args[0] === 'rm').length, 1);
  }
});
