'use strict';
// Exercise the inherited-permission maintenance helper in an isolated directory
// that deliberately grants ordinary Users read/execute only. No installed app,
// production registry entry or real application data is changed.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  assert.equal(process.platform, 'win32');
  const base = process.env.ProgramFiles;
  assert.ok(path.isAbsolute(base));
  const root = path.join(base, 'SoduWork-Maintenance-E2E-' + crypto.randomUUID());
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = [
    "$ErrorActionPreference='Stop'",
    "if (-not ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Elevated test host required' }",
    '$acl=[Security.AccessControl.DirectorySecurity]::new()',
    '$acl.SetAccessRuleProtection($true,$false)',
    "foreach($sid in @('S-1-5-18','S-1-5-32-544')) {$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}",
    "$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow'))",
    'Set-Acl -LiteralPath $env:SODUWORK_MAINTENANCE_TEST_ROOT -AclObject $acl',
  ].join('\n');
  await fs.mkdir(root); // exclusive creation: never reuse a real install directory
  try {
    const acl = cp.spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, encoding: 'utf8', env: { ...process.env, SODUWORK_MAINTENANCE_TEST_ROOT: root } });
    assert.equal(acl.status, 0, acl.stderr);
    await fs.writeFile(path.join(root, '.soduwork-launcher'), '1');
    await fs.writeFile(path.join(root, '.soduwork-active'), 'ns001.tmp');
    await fs.writeFile(path.join(root, '.soduwork-previous'), 'ns002.tmp');
    for (const name of ['ns001.tmp', 'ns002.tmp', 'ns003.tmp']) {
      const dir = path.join(root, '.soduwork-versions', name);
      await fs.mkdir(dir, { recursive: true });await fs.writeFile(path.join(dir, '.soduwork-stage'), '1');
      await fs.writeFile(path.join(dir, 'sentinel.txt'), name);
    }
    const helper = path.join(root, '.soduwork-versions/ns001.tmp/.soduwork-prune.cjs');
    await fs.writeFile(helper, await fs.readFile(path.join(__dirname, '../build/prune-versions.cjs')));
    const start = Date.now();
    const trace = path.join(root, '.soduwork-maintenance-trace.log');
    const child = cp.spawn(process.execPath, [helper, '--schedule'], { windowsHide: true, stdio: 'ignore',
      env: { ...process.env, SODUWORK_MAINTENANCE_TRACE: '1' } });
    const done = new Promise((resolve, reject) => { child.on('exit', resolve);child.on('error', reject); });
    await new Promise((resolve, reject) => { child.once('spawn', resolve);child.once('error', reject); });
    const handoffMs = Date.now() - start;
    assert.ok(handoffMs < 3000, 'handoff must not wait for scheduled cleanup');
    const candidate = path.join(root, '.soduwork-versions/ns003.tmp');
    let completed = false;
    for (let i = 0; i < 240; i++) {
      const exists = await fs.access(candidate).then(() => true, () => false);
      const retired = await fs.readdir(path.join(root, '.soduwork-retired')).catch(() => null);
      if (!exists && retired?.length === 0) { completed = true;break; }
      await delay(250);
    }
    if (!completed) {
      const direct = cp.spawnSync(process.execPath, [helper, '--retire-only'], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
      console.error(JSON.stringify({ root, directCode: direct.status, stdout: direct.stdout, stderr: direct.stderr,
        trace: await fs.readFile(trace, 'utf8').catch(error => error.code),
        rootEntries: await fs.readdir(root), versions: await fs.readdir(path.join(root, '.soduwork-versions')) }));
    }
    assert.equal(completed, true, 'inherited elevated helper must retire and remove the old version');
    assert.equal(await done, 0);
    for (const name of ['ns001.tmp', 'ns002.tmp']) {
      assert.equal(await fs.readFile(path.join(root, '.soduwork-versions', name, 'sentinel.txt'), 'utf8'), name);
    }
    const result = { ok: true, scope: 'Inherited elevated helper with explicit Program Files ACL; ordinary Users have read/execute only.',
      root, handoffMs, maintenanceElapsedMs: Date.now() - start, activeAndPreviousPreserved: true };
    if (process.argv[2]) await fs.writeFile(path.resolve(process.argv[2]), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
    await delay(500); // the PowerShell finally block releases its maintenance handle
  } finally {
    assert.equal(path.dirname(root), base);
    assert.match(path.basename(root), /^SoduWork-Maintenance-E2E-[a-f0-9-]{36}$/);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
main().catch(error => { console.error(error);process.exitCode = 1; });
