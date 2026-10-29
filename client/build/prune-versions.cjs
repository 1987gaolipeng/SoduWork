'use strict';
process.noAsar = true;
const fs = require('node:fs/promises');
const path = require('node:path');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const VERSION_NAME = /^ns[a-z0-9]+\.tmp$/i;
const RETIRED_NAME = /^ns[a-z0-9]+\.tmp-[a-f0-9-]{36}$/i;

async function inUse() {
  const script = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);$ErrorActionPreference='Stop';Get-CimInstance Win32_Process | Where-Object {$_.Name -match '^(SoduWork|soduwork-runner|node|python|pythonw|opencode|OpenConsole|winpty-agent)\\.exe$'} | Select-Object ExecutablePath,CommandLine | ConvertTo-Json -Compress";
  const result = childProcess.spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
  if (result.status !== 0) return null; // fail closed: never guess which payloads are in use
  try {
    const rows = result.stdout.trim() ? JSON.parse(result.stdout) : [];
    const list = Array.isArray(rows) ? rows : [rows];
    if (list.some(row => !row.ExecutablePath)) return null;
    return list.flatMap(row => [row.ExecutablePath, row.CommandLine || '']).map(s => s.toLowerCase());
  } catch (_) { return null; }
}
async function realDirectory(directory) {
  const stat = await fs.lstat(directory).catch(() => null);
  return !!stat?.isDirectory() && !stat.isSymbolicLink() &&
    (await fs.realpath(directory)).toLowerCase() === path.resolve(directory).toLowerCase();
}
async function canonicalInstallRoot(root) {
  const requested = path.resolve(root);
  const ancestry = [];
  // Long and 8.3 spellings may name the same installation. Resolve those only
  // after checking the supplied path's whole ancestry for links/junctions.
  for (let current = requested; ; current = path.dirname(current)) {
    const stat = await fs.lstat(current, { bigint: true }).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) return null;
    ancestry.push({ directory: current, device: stat.dev, inode: stat.ino });
    if (path.dirname(current) === current) break;
  }
  const canonical = await fs.realpath(requested).catch(() => null);
  if (!canonical) return null;
  const resolved = await fs.lstat(canonical, { bigint: true }).catch(() => null);
  if (!resolved?.isDirectory() || resolved.isSymbolicLink() ||
      resolved.dev !== ancestry[0].device || resolved.ino !== ancestry[0].inode) return null;
  // Resolving an alias cannot authorize a directory substituted while those
  // async checks were pending. Revalidate original ancestors before using it.
  for (const before of ancestry) {
    const stat = await fs.lstat(before.directory, { bigint: true }).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink() || stat.dev !== before.device || stat.ino !== before.inode) return null;
  }
  return canonical;
}
async function processPaths(active, root, requestedRoot) {
  const canonical = [];
  for (const text of active) {
    if (typeof text !== 'string') continue;
    // Read only literal absolute path tokens. Never execute or evaluate the
    // process command line; quoted argv can contain a short installation path.
    const tokens = [text, ...[...text.matchAll(/"([^"\r\n]+)"/g)].map(match => match[1]),
      ...[...text.matchAll(/(?:^|\s)((?:[a-z]:[\\/]|\\\\|\/\/)[^\s"]+)/gi)].map(match => match[1])];
    let unresolved = text;
    for (const token of new Set(tokens)) {
      if (!path.isAbsolute(token)) continue;
      const resolved = await fs.realpath(token).catch(() => '');
      if (!resolved) continue;
      canonical.push(resolved); unresolved = unresolved.split(token).join('');
    }
    // Unknown 8.3 spellings may still name an in-use payload. A failed alias
    // lookup never grants permission to clean up any candidate from this scan.
    if (process.platform === 'win32') {
      // The installation root alias was already verified by device/inode.
      // It remains recognizable even after an executable has been unlinked.
      unresolved = unresolved.replace(/\//g, '\\').toLowerCase()
        .split(requestedRoot.toLowerCase()).join(root.toLowerCase());
      if (/(?:^|[\\/\s"])[^\\/\s"]*~\d+(?:\.[^\\/\s"]+)?(?:[\\/]|(?=["\s]|$))/.test(unresolved)) return null;
    }
  }
  return [...active, ...canonical];
}
function usesCandidate(active, candidate, root, requestedRoot) {
  const aliases = [candidate, path.join(requestedRoot, path.relative(root, candidate))]
    .map(value => value.toLowerCase() + path.sep);
  return active.some(text => {
    const value = String(text).toLowerCase();
    const normalized = process.platform === 'win32' ? value.replace(/\//g, '\\') : value;
    return aliases.some(alias => normalized.includes(alias));
  });
}
async function pointers(root) {
  const current = (await fs.readFile(path.join(root, '.soduwork-active'), 'utf8')).trim();
  const previous = (await fs.readFile(path.join(root, '.soduwork-previous'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return ''; throw error;
  })).trim();
  if (!VERSION_NAME.test(current) || (previous && !VERSION_NAME.test(previous))) throw Error('Invalid active version');
  return [current, previous];
}
// The caller holds the native exclusive .soduwork-update.lock for this short phase.
// Move candidates out of the pointer namespace; expensive deletion follows only
// after the lock is released, so a subsequent update cannot activate these paths.
async function retire(root, running = null, onSnapshot = () => {}) {
  const requestedRoot = path.resolve(root);
  root = await canonicalInstallRoot(requestedRoot);
  if (!root) return [];
  // Only our managed version directories, never the install root or user data.
  const versions = path.join(root, '.soduwork-versions');
  const rootStat = await fs.lstat(root);
  const dirStat = await fs.lstat(versions);
  if (rootStat.isSymbolicLink() || dirStat.isSymbolicLink()) return [];
  await fs.access(path.join(root, '.soduwork-launcher'));
  const initial = await pointers(root).catch(() => null);
  if (!initial) return [];
  const candidates = [];
  for (const entry of await fs.readdir(versions, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^ns[a-z0-9]+\.tmp$/i.test(entry.name)) continue;
    if (initial.includes(entry.name)) continue;
    const candidate = path.join(versions, entry.name);
    const managed = await fs.access(path.join(candidate, '.soduwork-stage')).then(() => true, () => false);
    const complete = await fs.access(path.join(candidate, '.soduwork-release')).then(() => true, () => false);
    if (managed || complete) candidates.push(entry.name);
  }
  // Most upgrades retain exactly current + previous. Avoid starting PowerShell
  // and enumerating every Windows process when there is nothing we can remove.
  if (!candidates.length) return [];
  let active = running === null ? await inUse() : running;
  if (!Array.isArray(active)) return [];
  active = await processPaths(active, root, requestedRoot);
  if (!active) return [];
  onSnapshot(active);
  const retired = path.join(root, '.soduwork-retired');
  await fs.mkdir(retired, { recursive: true });
  if (!await realDirectory(retired) || !await realDirectory(root) || !await realDirectory(versions)) return [];
  const removed = [];
  for (const name of candidates) {
    const candidate = path.join(versions, name);
    const latest = await pointers(root).catch(() => null);
    if (!latest || latest.some((value, index) => value !== initial[index])) break;
    if (latest.includes(name)) continue;
    // Recheck the directory after the process query. Preselection is only an IO
    // optimization, never permission to remove a replaced directory or junction.
    const stat = await fs.lstat(candidate).catch(() => null);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) continue;
    const canonical = await fs.realpath(candidate);
    if (canonical.toLowerCase() !== candidate.toLowerCase()) continue;
    if (usesCandidate(active, candidate, root, requestedRoot)) continue;
    const managed = await fs.access(path.join(candidate, '.soduwork-stage')).then(() => true, () => false);
    const complete = await fs.access(path.join(candidate, '.soduwork-release')).then(() => true, () => false);
    if (!managed && !complete) continue;
    const retiredName = name + '-' + crypto.randomUUID();
    const receipt = path.join(retired, retiredName + '.json');
    let owned = false;
    try {
      // The receipt lives outside the directory being deleted, so a partially
      // successful recursive removal cannot erase the permission to retry it.
      await fs.writeFile(receipt, JSON.stringify({ schema: 1, kind: 'soduwork-retired-version', name: retiredName, source: name }), { flag: 'wx' });
      owned = true;
      await fs.rename(candidate, path.join(retired, retiredName)); removed.push(name);
    } catch (_) {
      if (owned) await fs.unlink(receipt).catch(() => {});
      /* locked or permission denied: retry at a later successful install */
    }
  }
  return removed;
}
async function deleteRetired(root, running = null) {
  const requestedRoot = path.resolve(root);
  root = await canonicalInstallRoot(requestedRoot);
  if (!root) return [];
  const retired = path.join(root, '.soduwork-retired');
  if (!await realDirectory(root) || !await realDirectory(retired)) return [];
  const entries = (await fs.readdir(retired, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && RETIRED_NAME.test(entry.name));
  if (!entries.length) return [];
  let active = running === null ? await inUse() : running;
  if (!Array.isArray(active)) return [];
  active = await processPaths(active, root, requestedRoot);
  if (!active) return [];
  const removed = [];
  for (const entry of entries) {
    const candidate = path.join(retired, entry.name);
    if (!await realDirectory(candidate)) continue;
    if (usesCandidate(active, candidate, root, requestedRoot)) continue;
    const receipt = path.join(retired, entry.name + '.json');
    const stat = await fs.lstat(receipt).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 1024) continue;
    const record = await fs.readFile(receipt, 'utf8').then(JSON.parse).catch(() => null);
    if (record?.schema !== 1 || record.kind !== 'soduwork-retired-version' || record.name !== entry.name ||
        !VERSION_NAME.test(record.source) || !entry.name.startsWith(record.source + '-')) continue;
    try {
      await fs.rm(candidate, { recursive: true, force: false }); removed.push(entry.name);
      await fs.unlink(receipt).catch(() => {});
    }
    catch (_) { /* interrupted maintenance is retried on a later launch */ }
  }
  return removed;
}
// Backward compatible programmatic entry for isolated maintenance callers that
// already hold the install lock. Installed clients use the two explicit phases.
async function prune(root, running = null) {
  let snapshot = running;
  const removed = await retire(root, snapshot, rows => { snapshot = rows; });
  await deleteRetired(root, snapshot);
  return removed;
}
function maintenanceScript(delaySeconds = 30) {
  if (!Number.isInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > 3600) throw Error('Invalid maintenance delay');
  return [
    "$ErrorActionPreference='Stop'",
    "function Trace-Maintenance($text) { if ($env:SODUWORK_MAINTENANCE_TRACE -eq '1') { Add-Content -LiteralPath (Join-Path $env:SODUWORK_MAINTENANCE_ROOT '.soduwork-maintenance-trace.log') -Value $text } }",
    "Trace-Maintenance 'scheduled'",
    'Start-Sleep -Seconds ' + delaySeconds,
    // Piping native output makes Windows PowerShell wait even for Electron's
    // GUI subsystem executable. A bare call returns before it sets LASTEXITCODE.
    'function Invoke-Maintenance($operation) {',
    '  $global:LASTEXITCODE=$null',
    '  & $env:SODUWORK_MAINTENANCE_EXE $env:SODUWORK_MAINTENANCE_SCRIPT $operation | Out-Null',
    "  if ($null -eq $global:LASTEXITCODE) { throw 'Maintenance process did not return an exit code' }",
    '  return [int]$global:LASTEXITCODE',
    '}',
    '$maintenance=$null; $activation=$null; $result=0; $operationStarted=$false',
    'try {',
    "  $maintenance=[IO.File]::Open((Join-Path $env:SODUWORK_MAINTENANCE_ROOT '.soduwork-maintenance.lock'),'OpenOrCreate','ReadWrite','None')",
    "  Trace-Maintenance 'maintenance-lock'",
    '  try {',
    "    $activation=[IO.File]::Open((Join-Path $env:SODUWORK_MAINTENANCE_ROOT '.soduwork-update.lock'),'OpenOrCreate','ReadWrite','None')",
    "    Trace-Maintenance 'activation-lock'",
    '    $operationStarted=$true',
    "    $result=Invoke-Maintenance '--retire-only'",
    "    Trace-Maintenance ('retire-exit=' + $result)",
    '  } finally { if ($activation) { $activation.Dispose(); $activation=$null } }',
    '  if ($result -eq 0) {',
    "    $result=Invoke-Maintenance '--delete-retired'",
    "    Trace-Maintenance ('delete-exit=' + $result)",
    '  }',
    "} catch { if ($operationStarted) { $result=1 }; Trace-Maintenance ('maintenance-skipped=' + $_.Exception.Message) } finally { if ($maintenance) { $maintenance.Dispose() } }",
    'exit $result',
  ].join('\n');
}
function scheduleMaintenance(root) {
  // Called both after normal client startup and by the installer *after* commit.
  // The latter inherits its existing elevation for Program Files installations;
  // an ordinary client never requests UAC just to perform housekeeping.
  const child = childProcess.spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(maintenanceScript(), 'utf16le').toString('base64')], {
      // Windows PowerShell can silently exit before executing an encoded command
      // with DETACHED_PROCESS. This helper is already launched without waiting
      // by NSIS/the client. Keep it alive until PowerShell finishes: on Windows
      // the console host can discard a command if its creating process exits
      // before initialization, even when spawn itself reported success.
      windowsHide: true, stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SODUWORK_MAINTENANCE_ROOT: root,
        SODUWORK_MAINTENANCE_EXE: process.execPath, SODUWORK_MAINTENANCE_SCRIPT: __filename },
    });
  child.on('error', error => {
    process.exitCode = 1;
    if (process.env.SODUWORK_MAINTENANCE_TRACE === '1') fs.appendFile(path.join(root, '.soduwork-maintenance-trace.log'),
      'spawn-error=' + (error.code || error.message) + '\n').catch(() => {});
  });
  child.on('exit', code => { if (code !== 0) process.exitCode = Number.isInteger(code) ? code : 1; });
}
module.exports = { prune, retire, deleteRetired, maintenanceScript };
if (require.main === module) {
  const versions = path.dirname(__dirname);
  if (path.basename(versions) === '.soduwork-versions') {
    if (process.argv[2] === '--schedule') scheduleMaintenance(path.dirname(versions));
    const operation = process.argv[2] === '--retire-only' ? retire :
      process.argv[2] === '--delete-retired' ? deleteRetired : null;
    if (operation) operation(path.dirname(versions)).then(removed => console.log('Retired payloads: ' + removed.length))
      .catch(error => { console.error('Maintenance skipped: ' + (error.code || error.message)); process.exitCode = 1; });
  }
}
