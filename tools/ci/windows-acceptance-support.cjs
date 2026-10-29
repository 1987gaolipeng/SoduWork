'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

function windowsPath(value) {
  assert.ok(typeof value === 'string' && path.win32.isAbsolute(value) && !/["\r\n\0]/.test(value),
    'Expected an absolute Windows path, received ' + JSON.stringify(value));
  return path.win32.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
}
function assertOwnedRoot(root, temporary = os.tmpdir()) {
  assert.equal(windowsPath(path.win32.dirname(root)), windowsPath(temporary));
  assert.match(path.win32.basename(root), /^(soduwork-install-acceptance-|soduwork-update-e2e-)[a-z0-9_-]+$/i);
}
function pendingUninstallers(names, active) {
  if (!active) return []; // _?= leaves the running uninstaller behind.
  const files = names.filter(name => /^Uninstall.*\.exe$/i.test(name));
  const current = files.find(name => name.toLowerCase() === 'uninstall soduwork.exe');
  return current ? [current] : files;
}
function processScript() {
  return "$root=[IO.Path]::GetFullPath($env:SODUWORK_ACCEPT_OWNED_ROOT).TrimEnd('\\')+'\\';" +
    "$rows=@(Get-CimInstance Win32_Process | ForEach-Object {" +
    "$owned=$_.ExecutablePath -and $_.ExecutablePath.StartsWith($root,[StringComparison]::OrdinalIgnoreCase);" +
    "if($owned -or $_.Name -match '^(SoduWork|SoduWork|SoduWork)\\.exe$'){" +
    "@{pid=$_.ProcessId;name=$_.Name;exe=$_.ExecutablePath;owned=[bool]$owned;" +
    "maintenance=[bool]($owned -and $_.CommandLine -match '\\.soduwork-prune\\.cjs')}}});" +
    "ConvertTo-Json -InputObject $rows -Compress";
}
function processes(root, ps) {
  assertOwnedRoot(root);
  return JSON.parse(ps(processScript(), { SODUWORK_ACCEPT_OWNED_ROOT: root }));
}
function waitForOwnedExit(root, ps, options = {}) {
  const now = options.now || Date.now;
  const sleep = options.sleep || (ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
  const timeout = options.timeout ?? 60000, started = now(), observed = new Map();
  while (true) {
    const active = processes(root, ps).filter(row => row.owned);
    for (const row of active) observed.set(row.pid, row);
    if (!active.length) return { waitedMs: now() - started, observed: [...observed.values()] };
    assert.ok(now() - started < timeout, 'Owned acceptance processes did not exit: ' + JSON.stringify(active));
    sleep(250);
  }
}
function stopOwnedProcesses(root, ps) {
  assertOwnedRoot(root);
  // Recovery only. Never kill by product name, and never ignore taskkill failure.
  const script = "$root=[IO.Path]::GetFullPath($env:SODUWORK_ACCEPT_OWNED_ROOT).TrimEnd('\\')+'\\';" +
    "$rows=@(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -and " +
    "$_.ExecutablePath.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)});" +
    "foreach($row in $rows){$live=Get-CimInstance Win32_Process -Filter ('ProcessId='+$row.ProcessId);" +
    "if($live -and $live.CreationDate -eq $row.CreationDate -and $live.ExecutablePath -eq $row.ExecutablePath){" +
    "& taskkill.exe /PID $row.ProcessId /T /F | Out-Null;$code=$LASTEXITCODE;" +
    "if($code -ne 0){$remaining=Get-Process -Id $row.ProcessId -ErrorAction SilentlyContinue;" +
    "if($code -ne 128 -or $remaining){throw ('Owned fixture taskkill failed: '+$code)}}}}";
  ps(script, { SODUWORK_ACCEPT_OWNED_ROOT: root });
  return waitForOwnedExit(root, ps, { timeout: 10000 });
}
module.exports = { assertOwnedRoot, pendingUninstallers, processes, waitForOwnedExit, stopOwnedProcesses };
