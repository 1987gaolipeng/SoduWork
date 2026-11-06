'use strict';
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const contract = require('./release-artifacts.cjs');
const { run, soduworkBaseline } = require('./acceptance-common.cjs');
const { verifySignature } = require('./macos-signature.cjs');
async function unpack(file, format, destination, { execute = run, mountRoot = os.tmpdir(), legacyBaseline } = {}) {
  await fs.mkdir(destination, { recursive: true });
  if (format === 'dmg') {
    await execute('hdiutil', ['verify', file]);
    // Each extraction owns a fresh mount outside the installation test tree.
    // A failed detach must not be traversed by main()'s recursive temp cleanup.
    const mount = await fs.mkdtemp(path.join(mountRoot, 'soduwork-mac-acceptance-mount-'));
    let extractionError;
    try {
      await execute('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, file]);
      const apps = (await fs.readdir(mount)).filter(name => name.endsWith('.app'));
      assert.equal(apps.length, 1);
      await execute('ditto', [path.join(mount, apps[0]), path.join(destination, apps[0])]);
    } catch (error) { extractionError = error; }
    try {
      await execute('hdiutil', ['detach', mount]);
      // Never recursively remove a mount: only an empty, detached directory.
      await fs.rmdir(mount);
    } catch (error) {
      throw new AggregateError([extractionError, error].filter(Boolean),
        'DMG mount cleanup failed; retained for inspection: ' + mount);
    }
    if (extractionError) throw extractionError;
  } else await execute('ditto', ['-x', '-k', file, destination]);
  const apps = (await fs.readdir(destination)).filter(name => name.endsWith('.app'));
  assert.equal(apps.length, 1);
  const app = path.join(destination, apps[0]);
  const executable = await execute('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', path.join(app, 'Contents/Info.plist')]);
  assert.equal(path.basename(executable), executable);
  const signature = await verifySignature({ file, app, execute, legacyBaseline });
  return { app, binary: path.join(app, 'Contents/MacOS', executable), signature };
}
async function main() {
  assert.equal(process.platform, 'darwin');
  const arch = process.argv?.[2];
  const record = await contract.verify('macos', arch);
  const output = path.join(contract.root, 'release-evidence/macos', arch || ''); await fs.mkdir(output, { recursive: true });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-mac-acceptance-'));
  const checks = [];
  try {
    for (const item of record.artifacts) {
      const name = item.arch + '-' + item.format;
      const current = path.join(temp, name); await fs.mkdir(current);
      const previous = await soduworkBaseline('macos-' + item.arch + '-dmg', current);
      const installed = path.join(current, 'installed');
      const profile = path.join(current, 'soduwork-acceptance-profile-' + name);
      const upgradeProfile = previous ? path.join(current, 'soduwork-acceptance-profile-upgrade-' + name) : profile;
      let app = await unpack(path.join(contract.dist, item.name), item.format, installed);
      assert.match(await run('lipo', ['-archs', app.binary]), item.arch === 'x64' ? /x86_64/ : /arm64/);
      assert.match(await run('lipo', ['-archs', path.join(app.app, 'Contents/Resources/runner/soduwork-runner')]),
        item.arch === 'x64' ? /x86_64/ : /arm64/, 'Bundled Runner architecture must match the target Mac');
      async function smoke(label, version, mode, data = profile) {
        await run(process.execPath, [path.join(__dirname, 'installed-client-smoke.cjs'), app.binary,
          installed, data, path.join(output, name + '-' + label + '.json'), version, mode]);
      }
      await smoke('fresh', record.version, 'write'); await smoke('restart', record.version, 'read');
      await fs.rm(installed, { recursive: true });
      app = await unpack(previous.path, 'dmg', installed, { legacyBaseline: previous });
      const oldSignature = app.signature;
      await smoke('old', previous.version, 'write', upgradeProfile);
      await fs.rm(installed, { recursive: true });
      app = await unpack(path.join(contract.dist, item.name), item.format, installed);
      await smoke('upgrade', record.version, 'read', upgradeProfile);
      await fs.rm(installed, { recursive: true });
      assert.equal(await fs.readFile(path.join(profile, 'acceptance-sentinel.txt'), 'utf8'), 'preserve-install-acceptance-data');
      checks.push({ name, ok: true, oldVersion: previous.version, oldSignature });
    }
    await contract.acceptance('macos', checks, [
      'Isolated app copies; no Gatekeeper quarantine/notarization or drag-and-drop UI certification.',
      'Mock Keychain in isolated test profiles; no system Keychain authorization or credential migration certification.',
    ], arch);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}
module.exports = { unpack };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
