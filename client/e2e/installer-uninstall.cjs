'use strict';
// Follow installer-update.cjs after all compatibility checks that reuse it.
// Operates only on that run's generated product/GUID and temporary directories.
const fs = require('node:fs/promises'), sync = require('node:fs');
const path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { validateFixtureGuid } = require('./fixtures/isolated-installer-build.cjs');
async function run(file, args, env = process.env, verbatim = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, windowsVerbatimArguments: verbatim, env, stdio: 'ignore' });
    child.once('error', reject); child.once('exit', resolve);
  });
}
async function main() {
  assert.equal(process.platform, 'win32');
  const input = path.resolve(process.argv[2]);
  const data = JSON.parse(await fs.readFile(input, 'utf8'));
  const { root, installed, fresh, setup, guid, productName, executableName, mode, id } = data;
  assert.equal(path.dirname(root), os.tmpdir());
  assert.match(path.basename(root), /^soduwork-update-e2e-/);
  validateFixtureGuid(guid);
  const expectedName = 'SoduWorkE2E_' + guid.replaceAll('-', '').toLowerCase();
  assert.equal(productName, expectedName); assert.equal(executableName, expectedName);
  assert.match(id, /^com\.soduwork\.update\.e2e\./);
  assert.ok(['currentuser', 'allusers'].includes(mode));
  for (const dir of [installed, fresh]) assert.equal(path.dirname(path.resolve(dir)), root);
  assert.equal(path.dirname(setup), path.join(root, 'dist'));
  const config = JSON.parse(await fs.readFile(path.join(root, 'dist-builder.json'), 'utf8'));
  assert.equal(config.nsis.guid, guid); assert.equal(config.appId, id);
  assert.equal(config.productName, productName); assert.equal(config.win.executableName, executableName);
  const checks = [];
  async function idle() {
    const deadline = Date.now() + 120000;
    while (true) {
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `@(Get-CimInstance Win32_Process -Filter "Name='${executableName}.exe'").Count`],
        { windowsHide: true, encoding: 'utf8', timeout: 10000 });
      assert.equal(result.status, 0, result.stderr || String(result.error));
      if (Number(result.stdout.trim()) === 0) return;
      assert.ok(Date.now() < deadline, 'Isolated fixture/maintenance process did not naturally exit');
      await new Promise(done => setTimeout(done, 250));
    }
  }
  async function uninstall(dir, name) {
    assert.equal(path.dirname(dir), root);
    await idle();
    const uninstaller = path.join(dir, 'Uninstall ' + executableName + '.exe');
    await fs.access(uninstaller);
    const env = { ...process.env, NODE_OPTIONS: '--require=Z:\\missing-uninstall-injection.cjs', NODE_PATH: 'Z:\\missing-node-path' };
    delete env.ELECTRON_RUN_AS_NODE;
    const code = await run(uninstaller, ['/S', '/' + mode, '_?=' + dir], env, true);
    assert.equal(code, 0, 'Native uninstall failed');
    for (const name of [executableName + '.exe', 'resources', '.soduwork-versions', '.soduwork-retired']) {
      assert.equal(sync.existsSync(path.join(dir, name)), false, 'Uninstall left payload: ' + name);
    }
    checks.push({ name, directory: dir, code });
  }
  for (const dir of [installed, fresh]) {
    // The update test leaves two historical paths sharing one fixture identity.
    // Restore its second path with a real reinstall so the upstream uninstaller
    // resolves that location from its own registration, not a fabricated key.
    if (dir === fresh) assert.equal(await run(setup, ['/S', '/' + mode, '/D=' + dir]), 0);
    await uninstall(dir, 'native uninstall removes deep Unicode resources with contaminated host Node environment');
  }
  const failedMigration = path.join(root, 'failed-flat-migration');
  assert.equal(await run(setup, ['/S', '/' + mode, '/D=' + failedMigration]), 0);
  await idle();
  // Model the previous flat layout under the same already-registered identity.
  // The subsequent real update must reach CopyFiles(uninstaller), then fail its
  // active-pointer commit, preserving the original recovery Electron.
  await fs.cp(path.join(root, 'dist/win-unpacked'), failedMigration, { recursive: true, force: true });
  for (const marker of ['.soduwork-active', '.soduwork-launcher']) await fs.rm(path.join(failedMigration, marker));
  await fs.mkdir(path.join(failedMigration, '.soduwork-active.next'));
  assert.notEqual(await run(setup, ['/S', '/' + mode, '--updated', '/D=' + failedMigration]), 0);
  assert.equal(sync.existsSync(path.join(failedMigration, '.soduwork-active')), false);
  await fs.access(path.join(failedMigration, 'SoduWork.previous.exe'));
  assert.match(await fs.readFile(path.join(failedMigration, '.soduwork-update.log'), 'utf8'), /pointer-write-failed/);
  await uninstall(failedMigration, 'failed flat-layout migration uninstalls with its preserved original Electron');

  const historical = path.join(root, 'historical-active-name');
  assert.equal(await run(setup, ['/S', '/' + mode, '/D=' + historical]), 0);
  await idle();
  const active = await fs.readFile(path.join(historical, '.soduwork-active'), 'utf8');
  assert.match(active, /^ns[a-z0-9]+\.tmp$/i);
  await fs.rename(path.join(historical, '.soduwork-versions', active, executableName + '.exe'),
    path.join(historical, '.soduwork-versions', active, 'SoduWork.exe'));
  await uninstall(historical, 'historical active executable name remains uninstallable');
  assert.equal(await fs.readFile(path.join(root, 'profile/sentinel.txt'), 'utf8'), 'keep user data');
  const registryKeys = ['Software\\' + guid, 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\' + guid];
  const wrapper = await fs.readFile(config.nsis.include, 'utf8');
  registryKeys.push(...[...wrapper.matchAll(/!define SODUWORK_(?:FILE_VERB|OPEN_APP) "([^"]+)"/g)].map(match => match[1]));
  const hive = mode === 'allusers' ? 'HKLM' : 'HKCU';
  for (const key of registryKeys) for (const view of ['32', '64']) {
    const query = spawnSync('reg.exe', ['query', hive + '\\' + key, '/reg:' + view], { windowsHide: true, encoding: 'utf8' });
    assert.equal(query.status, 1, 'Fixture registry entry remains: ' + key);
  }
  const result = { ok: true, kind: 'isolated-native-uninstall', root, guid, productName, executableName, checks,
    profilePreserved: true, registryKeysRemoved: registryKeys, finishedAt: new Date().toISOString() };
  const output = path.join(path.dirname(input), 'uninstall-report.json');
  await fs.writeFile(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, output }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
