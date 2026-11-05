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
          profile: { ...getProfile(), updateChannel }, platform, arch: 'x64', realpath: async () => '',
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
      assert.equal(args.at(-1), 'soduwork'); assert.equal(options.timeout, 5000);
      return owners[file] ? { stdout: owners[file] } : { error: Error('not installed') };
    }, ...extra };
}
test('Linux update format follows executable ownership, including parallel portable installs', async () => {
  const files = path.join(path.dirname(installed), 'resources/app.asar') + '\n' + installed + '\n';
  for (const [manager, format] of [['dpkg-query', 'deb'], ['rpm', 'rpm']]) {
    const config = deps({ [manager]: files });
    assert.equal((await target.query('1.2.3', config)).get('format'), format);
    config.execPath = portable;
    assert.equal(await target.installedLinuxFormat(config), 'tar.gz');
  }
  assert.equal(await target.installedLinuxFormat(deps()), 'tar.gz');
  assert.equal(await target.installedLinuxFormat(deps({ 'dpkg-query': files, rpm: files })), 'tar.gz');
  assert.equal(await target.installedLinuxFormat(deps({}, { exec: async () => { throw Error('timeout'); } })), 'tar.gz');
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
  const query = await target.query('1.2.3', deps({ rpm: installed + '\n' }));
  assert.throws(() => target.validateFormat({ artifact: { name: 'SoduWork-1.2.4-linux.deb' } }, query), /格式/);
  assert.doesNotThrow(() => target.validateFormat({ artifact: { name: 'SoduWork-1.2.4-linux.rpm' } }, query));
  for (const platform of ['win32', 'darwin']) {
    const params = await target.query('1.2.3', { platform, arch: 'x64' });
    assert.equal(params.has('format'), false);
    assert.equal(params.get('platform'), platform);
  }
});

test('update format probes only the package named by the local profile', async () => {
  for (const linuxPackageName of ['fixture-desktop', 'fixture-secondary']) {
    const profile = { ...require('../main/distribution.cjs').current(), linuxPackageName }, calls = [];
    const result = await target.query('1.13.3', deps({}, { profile, exec: async (file, args) => {
      calls.push(args.at(-1));
      return file === 'dpkg-query' ? { stdout: installed + '\n' } : { error: Error('not installed') };
    } }));
    assert.equal(result.get('format'), 'deb');
    assert.deepEqual(calls, [profile.linuxPackageName, profile.linuxPackageName]);
  }
});
