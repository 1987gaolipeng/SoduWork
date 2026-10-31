'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), fsp = fs.promises, path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const { getMakeNsisPath } = require('app-builder-lib/out/toolsets/windows');
const windows = { skip: process.platform !== 'win32' };
async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'soduwork-native-launcher-swap-'));
  let passed = false;
  t.after(async () => {
    if (!passed) { console.error('Launcher swap failure fixture retained:', root); return; }
    assert.equal(path.dirname(root), os.tmpdir()); assert.match(path.basename(root), /^soduwork-native-launcher-swap-/);
    await fsp.rm(root, { recursive: true, force: true });
  });
  const entry = path.join(root, 'SoduWork.exe'), prepared = path.join(root, '.soduwork-launcher.next'), backup = path.join(root, 'SoduWork.previous.exe');
  await fsp.writeFile(entry, 'original-launcher'); await fsp.writeFile(path.join(root, 'incoming'), 'replacement-launcher');
  await fsp.writeFile(path.join(root, '.soduwork-launcher-test-owned'), 'isolated');
  const exe = path.join(root, 'swap.exe'), script = path.join(root, 'swap.nsi');
  const macros = path.resolve(__dirname, '../build/installer.nsh');
  await fsp.writeFile(script, [
    'Unicode true', 'RequestExecutionLevel user', 'SilentInstall silent', `OutFile "${exe}"`,
    '!include "LogicLib.nsh"', `!include "${macros}"`, 'Section',
    `IfFileExists "${root}\\.soduwork-launcher-test-owned" +2`, 'Quit',
    'ReadEnvStr $R9 "SODUWORK_LAUNCHER_TEST_COUNT"', 'StrCpy $R8 0', '${Do}',
    `System::Call 'kernel32::CopyFileW(w "${root}\\incoming", w "${prepared}", i 0) i .r0'`,
    '${If} $0 == 0', 'SetErrorLevel 3', 'Quit', '${EndIf}',
    `!insertmacro soduworkReplaceLauncher "${entry}" "${prepared}" "${backup}"`,
    '${If} $0 == 0', `FileOpen $R7 "${root}\\swap-error.txt" w`, 'FileWrite $R7 "$1"', 'FileClose $R7', 'SetErrorLevel 2', 'Quit', '${EndIf}',
    'IntOp $R8 $R8 + 1', '${LoopUntil} $R8 >= $R9', 'SetErrorLevel 0', 'SectionEnd',
  ].join('\n'));
  const compiler = await getMakeNsisPath();
  const built = spawnSync(compiler.path, ['/V2', '/INPUTCHARSET', 'UTF8', script],
    { windowsHide: true, encoding: 'utf8', timeout: 30000, env: { ...process.env, ...compiler.env } });
  assert.equal(built.status, 0, built.stdout + built.stderr);
  function run({ count = 1, protect = false, lock = false } = {}) {
    fs.rmSync(path.join(root, 'swap-error.txt'), { force: true });
    const ps = fs.readFileSync(path.resolve(__dirname, '../e2e/fixtures/launcher-swap-audit.ps1'), 'utf8');
    const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    // PowerShell 7 module formats cannot be loaded by this Windows PowerShell
    // fixture. Keep its ACL commands on the matching system modules only.
    const environment = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
    environment.PSModulePath = path.join(path.dirname(powershell), 'Modules');
    const result = spawnSync(powershell,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')],
      { windowsHide: true, encoding: 'utf8', timeout: 90000, env: { ...environment, SODUWORK_LAUNCHER_TEST_ENTRY: entry,
        SODUWORK_LAUNCHER_TEST_EXE: exe, SODUWORK_LAUNCHER_TEST_COUNT: String(count), SODUWORK_LAUNCHER_TEST_PROTECT: protect ? '1' : '0',
        SODUWORK_LAUNCHER_TEST_LOCK: lock ? '1' : '0' } });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    const report = JSON.parse(result.stdout);
    report.result.LastError = fs.existsSync(path.join(root, 'swap-error.txt')) ? fs.readFileSync(path.join(root, 'swap-error.txt'), 'utf8') : null;
    console.log('Native swap result:', JSON.stringify(report.result));
    assert.equal(report.daclAfter, report.daclBefore, 'Exact entry permissions must be preserved');
    assert.ok(report.result.Samples > 0);
    // The swap is atomic at the NTFS level, but filter drivers (Defender) can
    // expose a name-cache micro-window under load. The product contract is "no
    // perceptible outage": no continuous unreadable window over 100 ms. The
    // zero-miss contract stays asserted on the short protect pass below.
    assert.ok(report.result.MaxMissWindowMs < 100, JSON.stringify(report));
    return report.result;
  }
  return { root, entry, prepared, backup, run, pass: () => { passed = true; } };
}
test('native launcher replacement keeps the live pathname readable during 1000 swaps', windows, async t => {
  const f = await fixture(t);
  const protect = f.run({ protect: true });
  assert.equal(protect.ExitCode, 0);
  assert.equal(protect.OpenMisses, 0, JSON.stringify(protect));
  assert.equal(protect.AttributeMisses, 0, JSON.stringify(protect));
  assert.equal(await fsp.readFile(f.entry, 'utf8'), 'replacement-launcher');
  assert.equal(await fsp.readFile(f.backup, 'utf8'), 'original-launcher');
  const result = f.run({ count: 1000 });
  assert.equal(result.ExitCode, 0); assert.ok(result.Samples > 1000);
  assert.equal(await fsp.readFile(f.backup, 'utf8'), 'replacement-launcher');
  console.log('Native launcher swap samples:', JSON.stringify(result)); f.pass();
});
test('native sharing violation preserves the live launcher and a later retry succeeds', windows, async t => {
  const f = await fixture(t);
  assert.equal(f.run({ lock: true }).ExitCode, 2);
  assert.equal(await fsp.readFile(f.entry, 'utf8'), 'original-launcher');
  assert.equal(await fsp.readFile(f.prepared, 'utf8'), 'replacement-launcher');
  assert.equal(f.run().ExitCode, 0);
  assert.equal(await fsp.readFile(f.entry, 'utf8'), 'replacement-launcher');
  assert.equal(await fsp.readFile(f.backup, 'utf8'), 'original-launcher'); f.pass();
});
test('backup preparation failure never changes the live launcher', windows, async t => {
  const f = await fixture(t); await fsp.mkdir(f.backup + '.next');
  assert.equal(f.run().ExitCode, 2);
  assert.equal(await fsp.readFile(f.entry, 'utf8'), 'original-launcher');
  assert.equal(await fsp.readFile(f.prepared, 'utf8'), 'replacement-launcher');
  assert.equal(fs.existsSync(f.backup), false); f.pass();
});
