'use strict';
// Supplementary native smoke: a fresh per-user install while a machine install exists.
// Reads the isolated allusers report; never resolves or changes production SoduWork entries.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const updater = require('../main/client-updater');
const delay = ms => new Promise(r => setTimeout(r, ms));
async function run(file, args, extra) {
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, windowsHide: true, stdio: 'ignore' });
    child.once('error', reject); child.once('exit', resolve);
  });
}
async function main() {
  const reportFile = path.resolve(process.argv[2]);
  const report = JSON.parse(await fs.readFile(reportFile, 'utf8'));
  const { root, installed, setup } = report;
  assert.equal(path.dirname(root), os.tmpdir());
  assert.match(path.basename(root), /^soduwork-update-e2e-/);
  assert.equal(report.mode, 'allusers');
  assert.ok(installed.startsWith(root + path.sep) && setup.startsWith(root + path.sep));
  const fresh = path.join(root, '全新用户 SoduWork ' + Date.now());
  await fs.mkdir(fresh);
  await fs.writeFile(path.join(fresh, '.soduwork-e2e-owned'), 'isolated');
  const receipt = path.join(fresh, '.e2e-launched.json');
  const env = { SODUWORK_UPDATE_E2E_PROFILE: path.join(root, 'profile'), SODUWORK_UPDATE_E2E_OUTPUT: receipt };
  const started = Date.now();
  assert.equal(await run(setup, ['/S', '/currentuser', '/D=' + fresh], env), 0);
  assert.equal(await fs.readFile(path.join(fresh, '.soduwork-install-mode'), 'utf8'), 'CurrentUser');
  const entry = path.join(fresh, 'SoduWork.exe');
  async function launched() {
    for (let i = 0; i < 2400; i++) {
      try {
        const data = JSON.parse(await fs.readFile(receipt, 'utf8'));
        const active = await fs.readFile(path.join(fresh, '.soduwork-active'), 'utf8');
        assert.equal(data.exe, path.join(fresh, '.soduwork-versions', active, 'SoduWork.exe'));
        return data;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await delay(50);
    }
    throw Error('Automatic relaunch timed out');
  }
  assert.equal(await run(entry, [], env), 0);
  await launched();
  const tests = [{ name: 'fresh current-user install and launch alongside machine install', elapsedMs: Date.now() - started }];
  await fs.rm(receipt);
  const helper = path.join(root, 'fresh-helper.vbs');
  await fs.writeFile(helper, updater._updateHelperScript(), 'ascii');
  await updater._launchUpdateHelper(helper, { ...process.env, ...env,
    SODUWORK_HELPER_READY: path.join(root, require('node:crypto').randomUUID() + '.ready'), SODUWORK_OLD_PID: '2147483647',
    SODUWORK_APP: entry, SODUWORK_INSTALLER: setup, SODUWORK_INSTALL_DIR: fresh, SODUWORK_INSTALL_MODE: 'CurrentUser',
  });
  const reopened = await launched();
  assert.ok(reopened.args.includes('--updated'));
  assert.equal(await fs.readFile(path.join(fresh, '.soduwork-install-mode'), 'utf8'), 'CurrentUser');
  const script = String.raw`[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);$result=@();foreach($h in @('HKCU','HKLM')){Get-ChildItem -LiteralPath ($h+':\Software\Microsoft\Windows\CurrentVersion\Uninstall') | ForEach-Object {$x=Get-ItemProperty -LiteralPath $_.PSPath;if($x.UninstallString -like ('*'+$env:SODUWORK_TEST_ROOT+'\*')){$p=Get-ItemProperty -LiteralPath ($h+':\Software\'+$_.PSChildName);$result+=@{hive=$h;location=$p.InstallLocation}}}};$result|ConvertTo-Json -Compress`;
  const query = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, encoding: 'utf8', env: { ...process.env, SODUWORK_TEST_ROOT: root } });
  assert.equal(query.status, 0, query.stderr);
  const rows = JSON.parse(query.stdout);
  assert.ok(rows.some(row => row.hive === 'HKCU' && row.location === fresh));
  assert.ok(rows.some(row => row.hive === 'HKLM' && row.location === installed));
  tests.push({ name: 'automatic current-user update preserves both install scopes', ...reopened });
  await fs.writeFile(path.join(path.dirname(reportFile), 'scope-report.json'), JSON.stringify({ root, fresh, tests }, null, 2));
  console.log(JSON.stringify({ fresh, tests }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
