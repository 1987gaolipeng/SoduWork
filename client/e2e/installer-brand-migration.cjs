'use strict';
// Real NSIS transactions and Electron versions, with unique registry IDs,
// shortcut names and private data. Never stop or modify a business installation.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { build, Platform, Arch } = require('./fixtures/isolated-installer-build.cjs');
const { getMakeNsisPath } = require('app-builder-lib/out/toolsets/windows');
const { UUID } = require('builder-util-runtime');
const client = path.resolve(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => String(value).replaceAll('$', '$$').replaceAll('"', '$\\"');
function ps(script, extra = {}) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);$ErrorActionPreference='Stop';" + script],
    { env: { ...process.env, ...extra }, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
async function run(exe, args, extra = {}) {
  const env = { ...process.env, ...extra }; delete env.ELECTRON_RUN_AS_NODE;
  // NSIS requires its final /D= path unquoted, including embedded spaces.
  const child = spawn(exe, args, { env, windowsHide: true, stdio: 'ignore',
    windowsVerbatimArguments: args.some(arg => arg.startsWith('/D=')) });
  const timeout = setTimeout(() => child.kill(), 120000);
  try { return await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }); }
  finally { clearTimeout(timeout); }
}
async function main() {
  assert.equal(process.platform, 'win32');
  const root = process.env.SODUWORK_E2E_REUSE || await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-update-e2e-brand-'));
  assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('soduwork-update-e2e-brand-'));
  const prior = process.env.SODUWORK_E2E_REUSE ? JSON.parse(await fs.readFile(path.join(root, 'dist-builder.json'), 'utf8')) : null;
  const stamp = prior ? prior.appId.split('.').at(-1) : crypto.randomBytes(8).toString('hex');
  const appId = 'com.soduwork.update.e2e.brand.' + stamp;
  const legacyGuid = prior ? /SODUWORK_LEGACY_APP_GUID "([a-f0-9-]+)"/.exec(await fs.readFile(path.join(root, 'migration.nsh'), 'utf8'))[1] : crypto.randomUUID();
  const newGuid = UUID.v5(appId, UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3'));
  const oldName = 'SoduWork Migration E2E ' + stamp, newName = 'SoduWork Migration E2E ' + stamp;
  const app = path.join(root, 'app'), dist = path.join(root, 'dist'), installed = path.join(root, '升级 中文');
  const profile = path.join(root, 'profile'), receipt = path.join(root, 'opened.json');
  const env = { SODUWORK_MIGRATION_PROFILE: profile, SODUWORK_MIGRATION_RECEIPT: receipt };
  const checks = [], skipped = []; let setup;
  const canWriteMachine = ps("try{$k=[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('Software',$true);$k.Dispose();'True'}catch{'False'}") === 'True';
  const query = (hive, guid) => ps("$p=$env:SODUWORK_KEY;if(Test-Path -LiteralPath $p){(Get-ItemProperty -LiteralPath $p).InstallLocation}",
    { SODUWORK_KEY: `${hive}:\\Software\\${guid}` });
  const uninstallKey = (hive, guid) => ps("Test-Path -LiteralPath $env:SODUWORK_KEY",
    { SODUWORK_KEY: `${hive}:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}` });
  const links = JSON.parse(ps("ConvertTo-Json -InputObject @([Environment]::GetFolderPath('DesktopDirectory'),[Environment]::GetFolderPath('Programs')) -Compress"));
  const linkTarget = file => ps("if(Test-Path -LiteralPath $env:SODUWORK_LINK){(New-Object -ComObject WScript.Shell).CreateShortcut($env:SODUWORK_LINK).TargetPath}", { SODUWORK_LINK: file });
  async function launch(file, expected) {
    await fs.rm(receipt, { force: true });
    assert.equal(await run(file, [], env), 0);
    for (let i = 0; i < 200 && !syncFs.existsSync(receipt); i++) await delay(50);
    const opened = JSON.parse(await fs.readFile(receipt, 'utf8'));
    assert.equal(opened.version, expected); assert.equal(opened.profile, profile);
    assert.equal(opened.sentinel, 'preserved');
    await delay(150); return opened;
  }
  async function removeNew() {
    const uninstaller = path.join(installed, 'Uninstall SoduWorkMigrationE2E.exe');
    if (syncFs.existsSync(uninstaller)) {
      // Installer maintenance keeps its private Electron alive for ~30 seconds.
      // The real uninstaller correctly refuses to kill that work; wait for it.
      let remaining = 'True';
      for (let i = 0; i < 90 && remaining === 'True'; i++) {
        remaining = ps("[bool](Get-Process -Name SoduWorkMigrationE2E -ErrorAction SilentlyContinue | Where-Object {$_.Path -and $_.Path.StartsWith($env:SODUWORK_INSTALL+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)})", { SODUWORK_INSTALL: installed });
        if (remaining === 'True') await delay(500);
      }
      assert.equal(remaining, 'False', 'Fixture maintenance must finish before uninstall');
      const result = spawnSync(uninstaller, ['/S', '/currentuser', '_?=' + installed],
        { env: { ...process.env, ...env }, windowsHide: true, windowsVerbatimArguments: true, timeout: 60000 });
      assert.equal(result.status, 0, result.error?.message);
    }
  }
  await fs.mkdir(app, { recursive: true }); await fs.mkdir(profile, { recursive: true });
  await fs.writeFile(path.join(profile, 'sentinel.txt'), 'preserved');
  await fs.writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'soduwork-migration-e2e', version: '1.0.2', main: 'index.js', description: 'Isolated migration check' }));
  await fs.writeFile(path.join(app, 'index.js'), [
    "const {app}=require('electron'),fs=require('fs'),path=require('path');",
    "app.setPath('userData',process.env.SODUWORK_MIGRATION_PROFILE);",
    "app.whenReady().then(()=>{fs.writeFileSync(process.env.SODUWORK_MIGRATION_RECEIPT,JSON.stringify({version:app.getVersion(),exe:process.execPath,profile:app.getPath('userData'),sentinel:fs.readFileSync(path.join(app.getPath('userData'),'sentinel.txt'),'utf8')}));app.quit()});",
  ].join('\n'));
  const include = path.join(root, 'migration.nsh');
  await fs.writeFile(include, `!define SODUWORK_LEGACY_APP_GUID "${legacyGuid}"\n!include "${quote(path.join(client, 'build/installer.nsh'))}"\n`);
  const compiler = await getMakeNsisPath();
  function compile(file, args = []) {
    const result = spawnSync(compiler.path, ['/V2', '/INPUTCHARSET', 'UTF8', ...args, file],
      { env: { ...process.env, ...compiler.env }, windowsHide: true, encoding: 'utf8', timeout: 120000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  try {
    const result = await build({ targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64), projectDir: client,
      ...(prior ? { prepackaged: path.join(dist, 'win-unpacked') } : {}), config: {
      appId, productName: 'SoduWork', directories: { app, output: dist, buildResources: path.join(client, 'build') },
      electronDist: path.dirname(require('electron')), electronVersion: require('electron/package.json').version,
      files: ['index.js', 'package.json', '!node_modules/**'], extraResources: [],
      afterPack: path.join(__dirname, 'fixtures/brand-installer-prepare.cjs'), afterSign: path.join(__dirname, 'fixtures/brand-installer-prepare.cjs'),
      win: { target: ['nsis'], icon: path.join(client, 'icon.ico'), executableName: 'SoduWorkMigrationE2E', signAndEditExecutable: false },
      nsis: { include, artifactName: 'migration-setup.exe', oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true,
        createDesktopShortcut: true, createStartMenuShortcut: true, shortcutName: newName, runAfterFinish: false },
      compression: 'store', npmRebuild: false,
    } });
    setup = result.find(file => file.endsWith('.exe'));
    await removeNew();
    const legacyPayload = path.join(root, 'legacy-payload');
    await fs.cp(path.join(dist, 'win-unpacked'), legacyPayload, { recursive: true });
    await fs.rename(path.join(legacyPayload, 'SoduWork.exe'), path.join(legacyPayload, 'SoduWork.exe'));
    await fs.rm(path.join(legacyPayload, 'resources/app.asar'));
    await fs.mkdir(path.join(legacyPayload, 'resources/app'), { recursive: true });
    await fs.copyFile(path.join(app, 'index.js'), path.join(legacyPayload, 'resources/app/index.js'));
    await fs.writeFile(path.join(legacyPayload, 'resources/app/package.json'), JSON.stringify({ name: 'soduwork-migration-e2e', version: '1.0.1', main: 'index.js' }));
    const oldLauncher = path.join(root, 'old-launcher.exe');
    compile(path.join(__dirname, 'fixtures/launcher-1.12.53.nsi'), ['/DSODUWORK_LAUNCHER_OUT=' + oldLauncher, '/DSODUWORK_ICON=' + path.join(client, 'icon.ico')]);
    const legacySetup = path.join(root, 'legacy-setup.exe'), legacyNsi = path.join(root, 'legacy.nsi');
    await fs.writeFile(legacyNsi, [
      'Unicode true', 'RequestExecutionLevel user', 'SilentInstall silent', 'AutoCloseWindow true',
      'SetCompress off', `InstallDir "${quote(installed)}"`,
      `OutFile "${quote(legacySetup)}"`, '!include "LogicLib.nsh"',
      'Function .onInit', `StrCmp $INSTDIR "${quote(installed)}" +3`, 'SetErrorLevel 3', 'Quit', 'FunctionEnd',
      'Section', 'SetRegView 64', 'SetShellVarContext current',
      'SetOutPath "$INSTDIR\\.soduwork-versions\\old"', `File /r "${quote(legacyPayload)}\\*"`,
      'FileOpen $0 "$INSTDIR\\.soduwork-versions\\old\\.soduwork-release" w', 'FileWrite $0 "1.0.1"', 'FileClose $0',
      'SetOutPath "$INSTDIR"', `File /oname=SoduWork.exe "${quote(oldLauncher)}"`,
      'FileOpen $0 "$INSTDIR\\.soduwork-active" w', 'FileWrite $0 "old"', 'FileClose $0',
      'FileOpen $0 "$INSTDIR\\.soduwork-launcher" w', 'FileWrite $0 "1"', 'FileClose $0',
      'WriteUninstaller "$INSTDIR\\Uninstall SoduWork.exe"',
      `WriteRegStr HKCU "Software\\${legacyGuid}" InstallLocation "$INSTDIR"`,
      `WriteRegStr HKCU "Software\\${legacyGuid}" ShortcutName "${oldName}"`,
      `WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${legacyGuid}" UninstallString '"$INSTDIR\\Uninstall SoduWork.exe" /currentuser'`,
      `CreateShortCut "$DESKTOP\\${oldName}.lnk" "$INSTDIR\\SoduWork.exe"`,
      `CreateShortCut "$SMPROGRAMS\\${oldName}.lnk" "$INSTDIR\\SoduWork.exe"`, 'SectionEnd',
      'Section "Uninstall"', 'SectionEnd', '',
    ].join('\n'));
    compile(legacyNsi);
    assert.equal(await run(legacySetup, ['/S', '/D=' + installed], env), 0);
    await launch(path.join(installed, 'SoduWork.exe'), '1.0.1');
    assert.equal(query('HKCU', legacyGuid), installed);
    assert.equal(await run(setup, ['/S', '/currentuser', '--updated', '/D=' + installed], env), 0);
    await launch(path.join(installed, 'SoduWork.exe'), '1.0.2');
    await launch(path.join(installed, 'SoduWorkMigrationE2E.exe'), '1.0.2');
    for (const directory of links) {
      assert.equal(syncFs.existsSync(path.join(directory, oldName + '.lnk')), false);
      const target = linkTarget(path.join(directory, newName + '.lnk'));
      assert.ok(target === path.join(installed, 'SoduWork.exe') || target === path.join(installed, 'SoduWorkMigrationE2E.exe'));
      await launch(target, '1.0.2');
    }
    assert.equal(uninstallKey('HKCU', legacyGuid), 'False'); assert.equal(query('HKCU', legacyGuid), '');
    assert.equal(uninstallKey('HKCU', newGuid), 'True');
    checks.push('same-scope old/new entry and both shortcuts open 1.0.2; one uninstall record');
    await removeNew();
    for (const directory of links) for (const name of [oldName, newName]) assert.equal(syncFs.existsSync(path.join(directory, name + '.lnk')), false);
    assert.equal(uninstallKey('HKCU', newGuid), 'False');
    assert.equal(await fs.readFile(path.join(profile, 'sentinel.txt'), 'utf8'), 'preserved');
    checks.push('new uninstaller alone removes both generations and retains user data');
    const foreign = path.join(root, 'other-install');
    await fs.mkdir(foreign, { recursive: true }); await fs.mkdir(installed, { recursive: true });
    await fs.copyFile(oldLauncher, path.join(installed, 'SoduWork.exe'));
    const oldBytes = await fs.readFile(path.join(installed, 'SoduWork.exe'));
    const foreignCases = [['HKCU', foreign]];
    if (canWriteMachine) foreignCases.push(['HKLM', installed]);
    else skipped.push('machine-scope fixture: OS denied writable HKLM Software access');
    for (const [hive, location] of foreignCases) {
      ps("$k=$env:SODUWORK_KEY;New-Item -Path $k -Force|Out-Null;Set-ItemProperty -LiteralPath $k -Name InstallLocation -Value $env:SODUWORK_LOCATION;$u=$env:SODUWORK_UNINSTALL;New-Item -Path $u -Force|Out-Null;Set-ItemProperty -LiteralPath $u -Name UninstallString -Value ('\"'+$env:SODUWORK_LOCATION+'\\Uninstall SoduWork.exe\" '+$env:SODUWORK_SCOPE)",
        { SODUWORK_KEY: `${hive}:\\Software\\${legacyGuid}`, SODUWORK_LOCATION: location,
          SODUWORK_UNINSTALL: `${hive}:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${legacyGuid}`, SODUWORK_SCOPE: hive === 'HKLM' ? '/allusers' : '/currentuser' });
      assert.equal(await run(setup, ['/S', '/currentuser', '/D=' + installed], env), 0);
      assert.deepEqual(await fs.readFile(path.join(installed, 'SoduWork.exe')), oldBytes);
      assert.equal(query(hive, legacyGuid), location); assert.equal(uninstallKey(hive, legacyGuid), 'True');
      for (const key of [`${hive}:\\Software\\${legacyGuid}`, `${hive}:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${legacyGuid}`])
        ps("Remove-Item -LiteralPath $env:SODUWORK_KEY -Recurse -Force", { SODUWORK_KEY: key });
    }
    checks.push('different-directory legacy registration and entry remain untouched');
    if (canWriteMachine) checks.push('machine-scope legacy registration and entry remain untouched');
    console.log(JSON.stringify({ root, setup, checks, skipped }, null, 2));
  } catch (error) {
    console.error('Migration validation failed:', error); throw error;
  } finally {
    let cleanupError;
    try { await removeNew(); } catch (error) { cleanupError = error; }
    // Cleanup only uniquely generated fixture keys and shortcuts; no enumeration.
    for (const hive of (canWriteMachine ? ['HKCU', 'HKLM'] : ['HKCU'])) for (const guid of [legacyGuid, newGuid]) {
      assert.match(guid, /^[a-f0-9-]{36}$/);
      for (const key of [`${hive}:\\Software\\${guid}`, `${hive}:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}`])
        ps("if(Test-Path -LiteralPath $env:SODUWORK_KEY){Remove-Item -LiteralPath $env:SODUWORK_KEY -Recurse -Force}", { SODUWORK_KEY: key });
    }
    for (const directory of links) for (const name of [oldName, newName]) await fs.rm(path.join(directory, name + '.lnk'), { force: true });
    await fs.writeFile(path.join(root, 'migration-report.json'), JSON.stringify({ checks, skipped, setup, root }, null, 2));
    if (cleanupError) throw cleanupError;
  }
}
main().catch(error => { console.error(error); process.exit(1); });
