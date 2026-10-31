'use strict';

const cp = require('node:child_process');
const path = require('node:path');
function exec(file, args) {
  return new Promise((resolve, reject) => cp.execFile(file, args,
    { windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' } },
    (error, stdout) => error ? reject(error) : resolve(stdout)));
}
async function snapshot(pid) {
  if (process.platform === 'win32') {
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const args = ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate' + (Number.isInteger(pid) ? ' -Filter "ProcessId=' + pid + '"' : '') +
      ' | Where-Object { $_.CreationDate } | ForEach-Object { [pscustomobject]@{ pid=$_.ProcessId; parent=$_.ParentProcessId; created=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } } | ConvertTo-Json -Compress'];
    let text;
    try { text = await exec(powershell, args); }
    catch (error) {
      // WMI occasionally stalls even after the worker has exited. Retry only a
      // timed-out read, once, with a fresh identity snapshot. Persistent errors
      // still reject, and this never retries a process termination operation.
      if (!error.killed) throw error;
      text = await exec(powershell, args);
    }
    const value = text.trim() ? JSON.parse(text) : [];
    return (Array.isArray(value) ? value : [value]).filter(row => {
      // WMI can retain exited process objects while an inspection/security
      // tool holds a handle. Signal zero only queries kernel liveness.
      if (!Number.isInteger(row?.pid) || row.pid <= 1) return false;
      try { process.kill(row.pid, 0); return true; }
      catch (error) {
        // Access denied means unknown, never proof of exit.
        return error.code !== 'ESRCH';
      }
    });
  }
  // lstart is available on both BSD/macOS and Linux; etimes is Linux-only.
  const text = await exec('ps', Number.isInteger(pid)
    ? ['-p', String(pid), '-o', 'pid=,ppid=,lstart='] : ['-eo', 'pid=,ppid=,lstart=']);
  return text.trim().split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) return [];
    const created = Date.parse(match[3]);
    // Whole-second precision is intentionally conservative at the boundary.
    return Number.isFinite(created) ? [{ pid: Number(match[1]), parent: Number(match[2]), created }] : [];
  });
}
async function stopAfter(child, since, terminateTree, before) {
  const rows = await snapshot();
  if (child.exitCode !== null || child.signalCode !== null) return;
  // Earlier direct children may be legitimate background services. Never
  // cross their subtree when reclaiming a later foreground invocation.
  // POSIX lstart is rounded to seconds. A pre-dispatch snapshot distinguishes
  // a new worker from a completed background worker even within that second.
  // If the snapshot was unavailable, keep the conservative time boundary.
  const existed = before && new Set(before.map(row => `${row.pid}:${row.created}`));
  const roots = rows.filter(row => row.parent === child.pid && row.pid > 1 &&
    row.pid !== process.pid && (existed
      ? !existed.has(`${row.pid}:${row.created}`) : row.created >= since));
  for (const root of roots) {
    const fresh = (await snapshot(root.pid)).find(row => row.pid === root.pid);
    if (!fresh || fresh.parent !== root.parent || fresh.created !== root.created) continue;
    await terminateTree({ pid: root.pid, exitCode: null, signalCode: null });
  }
}
module.exports = { snapshot, stopAfter };
