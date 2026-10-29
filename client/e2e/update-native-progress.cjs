'use strict';

// Real NSIS observer window, with only a disposable directory and a held lock.
// Does not run an installer, touch registry, or interact with a SoduWork process.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { getMakeNsisPath } = require('app-builder-lib/out/toolsets/windows');

async function main() {
  assert.equal(process.platform, 'win32', 'This checks the actual Windows native window');
  const client = path.resolve(__dirname, '..');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-native-progress-'));
  const output = path.resolve(process.argv[2] || path.join(client, '../outputs/client-update-progress/native.json'));
  const report = { startedAt: new Date().toISOString(), fixtureRoot: root, installationExecuted: false };
  const baseline = process.argv.includes('--baseline');
  try {
    const compiler = await getMakeNsisPath();
    const executable = path.join(root, 'observer.exe');
    const compile = spawnSync(compiler.path, ['/V2', '/INPUTCHARSET', 'UTF8',
      '/DSODUWORK_LAUNCHER_OUT=' + executable, '/DSODUWORK_ICON=' + path.join(client, 'icon.ico'),
      path.join(client, baseline ? 'e2e/fixtures/launcher-1.12.53.nsi' : 'build/launcher.nsi')], { encoding: 'utf8', windowsHide: true,
      env: { ...process.env, ...compiler.env }, timeout: 30000 });
    assert.equal(compile.status, 0, compile.stdout + compile.stderr);
    report.compiled = true;
    const stub = path.join(root, 'payload.nsi');
    await fs.mkdir(path.join(root, '.soduwork-versions/test'), { recursive: true });
    await fs.writeFile(stub, `Unicode true\nName "Isolated payload"\nRequestExecutionLevel user\nSilentInstall silent\nOutFile "${path.join(root, '.soduwork-versions/test/SoduWork.exe')}"\nSection\nFileOpen $0 "$EXEDIR\\opened" w\nFileWrite $0 "opened"\nFileClose $0\nSectionEnd\n`);
    const payload = spawnSync(compiler.path, ['/V2', stub], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...compiler.env } });
    assert.equal(payload.status, 0, payload.stdout + payload.stderr);
    await fs.writeFile(path.join(root, '.soduwork-active'), 'test');
    await fs.writeFile(path.join(root, '.soduwork-versions/test/.soduwork-release'), 'fixture');
    const script = path.join(root, 'native.ps1');
    // Windows PowerShell 5 requires a BOM to interpret Chinese UTF-8 literals.
    await fs.writeFile(script, '\uFEFF' + await fs.readFile(path.join(__dirname, 'update-native-progress.ps1'), 'utf8'));
    const runUi = (extraArgs = [], outputSuffix = '') => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', script, '-FixtureRoot', root, '-Observer', executable, '-Screenshot', output + outputSuffix + '.png', ...(baseline ? ['-Baseline'] : []), ...extraArgs],
    { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    const result = runUi();
    report.exitCode = result.status;
    report.stdout = result.stdout;
    report.stderr = result.stderr;
    assert.equal(result.status, 0, result.stdout + result.stderr);
    report.checks = JSON.parse(result.stdout.trim());
    /* The client renders the observer in its own locale (SODUWORK_UPDATE_LANG).
       Exercise the English strings of the same compiled launcher, including
       the runtime window title, on a second fixture root. */
    const englishResult = runUi(['-Lang', 'en-US'], '-en');
    report.englishExitCode = englishResult.status;
    report.englishStdout = englishResult.stdout;
    report.englishStderr = englishResult.stderr;
    assert.equal(englishResult.status, 0, englishResult.stdout + englishResult.stderr);
    report.englishChecks = JSON.parse(englishResult.stdout.trim());
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.error = String(error.stack || error);
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(report, null, 2));
    // Only this mkdtemp-owned directory; never the actual installation root.
    await fs.rm(root, { recursive: true, force: true });
  }
  console.log('Native update phases passed: ' + output);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
