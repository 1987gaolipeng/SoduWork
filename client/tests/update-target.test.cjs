'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path');
const target = require('../main/update-target.cjs');
// Linux probes are simulated, but path semantics still belong to the Node host.
const installed = path.resolve('fixture-installed', 'soduwork');
const portable = path.resolve('fixture-portable', 'soduwork');
test('update channel follows the bundled distribution on every platform', async () => {
  const { getProfile } = require('../main/distribution.cjs');
  for (const updateChannel of ['stable', 'beta']) {
    for (const platform of ['win32', 'darwin', 'linux']) {
      for (const version of ['1.13.11-beta.532', '1.13.11']) {
        const params = await target.query(version, {
          ...deps(), profile: { ...getProfile(), updateChannel }, platform, arch: 'x64',
          env: { SODUWORK_UPDATE_CHANNEL: updateChannel === 'beta' ? 'stable' : 'beta' },
        });
        assert.equal(params.get('channel'), updateChannel);
        assert.equal(params.get('current'), version);
      }
    }
  }
});
function deps(owners = {}, extra = {}) {
  return { platform: 'linux', execPath: installed, env: {},
    realpath: async file => file, exec: async (file, args, options) => {
      assert.equal(options.timeout, 5000);
      if (file === 'rpm') assert.deepEqual(args.slice(0, -1), ['-qf', '--qf', '%{NAME}\\n', '--']);
      else assert.deepEqual([file, ...args.slice(0, -1)], ['dpkg-query', '-S', '--']);
      return { stdout: owners[file] || '', error: owners[file] ? null : { code: 'ENOENT' } };
    }, ...extra };
}
test('Linux update format follows executable ownership, including parallel portable installs', async () => {
  for (const [manager, format, output] of [['dpkg-query', 'deb', 'soduwork:amd64: ' + installed], ['rpm', 'rpm', 'soduwork\n']]) {
    const config = deps({ [manager]: output });
    assert.equal((await target.query('1.2.3', config)).get('format'), format);
  }
  assert.equal(await target.installedLinuxFormat(deps({ 'dpkg-query': 'soduwork: ' + installed, rpm: 'another-app\n' },
    { execPath: portable })), 'tar.gz');
  assert.equal(await target.installedLinuxFormat(deps()), 'tar.gz');
  await assert.rejects(target.installedLinuxFormat(deps({ 'dpkg-query': 'soduwork: ' + installed, rpm: 'soduwork' })), /Conflicting/);
});
test('only missing tools and confirmed negative ownership permit archive fallback', async () => {
  const execPath = '/opt/Portable [2]/SoduWork?';
  const realpath = async () => execPath;
  const exec = async (file, args) => {
    if (file === 'rpm') {
      assert.equal(args.at(-1), execPath);
      return { error: { code: 1 }, stdout: 'file ' + execPath + ' is not owned by any package\n' };
    }
    assert.equal(args.at(-1), '/opt/Portable \\[2]/SoduWork\\?');
    return { error: { code: 1 }, stderr: 'dpkg-query: no path found matching pattern ' + args.at(-1) };
  };
  assert.equal(await target.installedLinuxFormat(deps({}, { realpath, exec })), 'tar.gz');
  for (const manager of ['rpm', 'dpkg-query']) {
    await assert.rejects(target.installedLinuxFormat(deps({}, { exec: async file => file === manager
      ? { error: { code: 1 }, stderr: 'package database is unavailable' } : { error: { code: 'ENOENT' } } })),
    /package database is unavailable/);
  }
  await assert.rejects(target.installedLinuxFormat(deps({}, { exec: async () => { throw Error('timeout'); } })), /timeout/);
  await assert.rejects(target.installedLinuxFormat(deps({}, { realpath: async () => { throw Error('unresolved executable'); } })), /unresolved executable/);
});
test('AppImage is selected only when the running binary belongs to its mounted app directory', async () => {
  const appDir = path.resolve('fixture-appimage');
  const config = deps({}, { env: { APPIMAGE: path.resolve('fixture.AppImage'), APPDIR: appDir },
    execPath: path.join(appDir, 'soduwork') });
  assert.equal(await target.installedLinuxFormat(config), 'appimage');
  config.execPath = portable;
  assert.equal(await target.installedLinuxFormat(config), 'tar.gz');
});
test('an older Hub ignoring format cannot make a client download a mismatched package', async () => {
  const query = await target.query('1.2.3', deps({ rpm: 'soduwork\n' }));
  assert.throws(() => target.validateFormat({ artifact: { name: 'SoduWork-1.2.4-linux.deb' } }, query), /格式/);
  assert.doesNotThrow(() => target.validateFormat({ artifact: { name: 'SoduWork-1.2.4-linux.rpm' } }, query));
  for (const platform of ['win32', 'darwin']) {
    const params = await target.query('1.2.3', { platform, arch: 'x64' });
    assert.equal(params.has('format'), false);
    assert.equal(params.get('platform'), platform);
  }
});

test('only an exact owner from the bundled distribution identifies a managed copy', async () => {
  for (const linuxPackageName of ['fixture-desktop', 'fixture-secondary']) {
    const profile = { ...require('../main/distribution.cjs').current(), linuxPackageName };
    for (const [owner, expected] of [[linuxPackageName, 'deb'], [linuxPackageName + '-other', 'tar.gz']]) {
      const result = await target.query('1.13.3', deps({ 'dpkg-query': owner + ':arm64: ' + installed }, { profile }));
      assert.equal(result.get('format'), expected);
    }
  }
});
