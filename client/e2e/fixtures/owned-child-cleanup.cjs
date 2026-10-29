'use strict';

// Outer Node test launcher only. Never attach this to an arbitrary PID or to
// a running test retroactively: pass the ChildProcess returned by this spawn.
const { createProcessTreeGuard } = require('../../main/agent-runtime/process-tree');
const { snapshot: processSnapshot } = require('../../main/pi-session/mcp-process-tree');

function createOwnedChildCleanup({ child, spawnedAt, timeoutMs = 12 * 60 * 1000,
  intervalMs = 1000, snapshot = processSnapshot, terminate, onReport = () => {} } = {}) {
  if (!child || !Number.isInteger(child.pid) || child.pid <= 1 || child.pid === process.pid ||
      typeof child.once !== 'function' || typeof child.removeListener !== 'function') {
    throw TypeError('The newly spawned ChildProcess is required');
  }
  if (!Number.isFinite(spawnedAt) || spawnedAt <= 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw TypeError('Record spawnedAt immediately before this spawn and use a positive timeout');
  }
  let verified = false, timer, stopping, lastReport;
  const guard = createProcessTreeGuard({ pid: child.pid, intervalMs,
    settleTimeoutMs: 5000, settleIntervalMs: 50,
    snapshot: async selected => {
      if (!verified && (child.exitCode !== null || child.signalCode !== null)) {
        throw Error('Owned child exited before its process identity was recorded; refusing PID adoption');
      }
      const rows = await snapshot(selected);
      if (!verified) {
        const roots = rows.filter(row => row?.pid === child.pid);
        const root = roots[0];
        if (roots.length !== 1 || root.parent !== process.pid || typeof root.created !== 'number' ||
            root.created < spawnedAt || child.exitCode !== null || child.signalCode !== null) {
          throw Error('The spawned child parent/creation identity could not be verified');
        }
        verified = true;
      }
      return rows;
    }, ...(terminate ? { terminate } : {}) });
  function detach() {
    clearTimeout(timer);
    child.removeListener('exit', onExit);
    child.removeListener('error', onError);
  }
  function stop(reason = 'manual') {
    if (stopping) return stopping;
    detach();
    // Wait for the initial snapshot. A failed baseline never authorizes kill.
    stopping = ready.then(() => guard.stop()).then(result => {
      lastReport = { reason, ok: true, rootPid: child.pid, ...result };
      onReport(lastReport);
      return lastReport;
    }, error => {
      guard.dispose();
      lastReport = { reason, ok: false, rootPid: child.pid, error: error.message,
        identityVerified: verified,
        ...(error.report || { terminated: [], skipped: [], remaining: [child.pid] }) };
      onReport(lastReport);
      throw Object.assign(error, { cleanupReport: lastReport });
    });
    // Callers can await stop(); automatic exit/timeout cleanup cannot create an
    // unhandled rejection. Failure stays visible in onReport and lastReport.
    stopping.catch(() => {});
    return stopping;
  }
  const onExit = () => { void stop('exit'); };
  const onError = () => { void stop('spawn-error'); };
  const ready = guard.start();
  ready.catch(() => {});
  child.once('exit', onExit);
  child.once('error', onError);
  timer = setTimeout(() => { void stop('timeout'); }, Math.max(1, spawnedAt + timeoutMs - Date.now()));
  timer.unref?.();
  return { ready, stop,
    get report() { return lastReport; },
    // Use only when the launcher deliberately hands supervision elsewhere.
    dispose() { detach(); guard.dispose(); },
  };
}

module.exports = { createOwnedChildCleanup };
