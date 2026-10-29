'use strict';

// Track only descendants whose process identity was observed while an owned
// ancestor was alive. Retain that identity across reparenting; a reused PID
// must never acquire ownership. This is lifecycle cleanup, not an OS sandbox.
const fs = require('node:fs');
const { snapshot: processSnapshot } = require('../pi-session/mcp-process-tree');

async function defaultSnapshot(pid, platform) {
  let rows;
  try { rows = await processSnapshot(pid); }
  catch (error) {
    // POSIX ps exits 1 when a selected PID has already disappeared. Confirm
    // that with a successful full snapshot; other failures still propagate.
    if (Number.isInteger(pid) && platform !== 'win32' && error.code === 1) {
      rows = (await processSnapshot()).filter(row => row.pid === pid);
    } else throw error;
  }
  if (platform !== 'linux') return rows;
  return rows.flatMap(row => {
    try {
      // ps lstart has whole-second precision. Linux start ticks distinguish
      // processes that reuse one PID within the same wall-clock second.
      const text = fs.readFileSync('/proc/' + row.pid + '/stat', 'utf8');
      const fields = text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/);
      if (['Z', 'X'].includes(fields[0]) || !/^\d+$/.test(fields[19])) return [];
      return [{ ...row, startToken: 'linux:' + fields[19] }];
    } catch (error) {
      if (['ENOENT', 'ESRCH'].includes(error.code)) return [];
      // Permission failures must not silently turn a live process into a
      // missing process, especially while certifying shutdown.
      throw error;
    }
  });
}

function normalize(rows) {
  if (!Array.isArray(rows)) throw TypeError('Process snapshot must be an array');
  const result = new Map(), duplicates = new Set();
  for (const value of rows) {
    if (!value || !Number.isInteger(value.pid) || value.pid <= 1 ||
        !Number.isInteger(value.parent) || value.parent < 0 ||
        !(typeof value.created === 'number' && Number.isFinite(value.created) && value.created > 0 ||
          typeof value.created === 'string' && value.created.trim())) continue;
    const row = { pid: value.pid, parent: value.parent, created: value.created,
      startToken: value.startToken == null ? '' : String(value.startToken) };
    if (result.has(row.pid)) duplicates.add(row.pid);
    result.set(row.pid, row);
  }
  // An ambiguous snapshot cannot establish a process identity.
  for (const pid of duplicates) result.delete(pid);
  return result;
}

function same(a, b) {
  if (!a || !b || a.pid !== b.pid) return false;
  // Kernel start ticks identify Linux processes independently of a rounded
  // wall-clock timestamp, which can shift while that same process is alive.
  if (a.startToken || b.startToken) return !!a.startToken && a.startToken === b.startToken;
  return a.created === b.created;
}

function defaultTerminate(row) {
  try { return process.kill(row.pid, 'SIGKILL'); }
  catch (error) { if (error.code === 'ESRCH') return true; throw error; }
}

/**
 * snapshot(optionalPid) -> [{ pid, parent, created, startToken? }]. It may
 * return all rows when given a PID. terminate(row) kills exactly that process,
 * never an unverified subtree, and may return a Promise. Both are injectable.
 *
 * Await start() immediately after the runtime's spawn event. stop()
 * coalesces concurrent calls and verifies observed processes have exited before resolving;
 * failures reject with an AggregateError whose report lists the outcome.
 * A later stop retries failed cleanup against the retained process identities.
 * dispose() only stops sampling. A later stop() still cleans retained owners.
 * Descendants that start and become orphaned between samples cannot be
 * inferred safely; the runtime must also close its own tool children.
 */
function createProcessTreeGuard({ pid, platform = process.platform,
  snapshot = value => defaultSnapshot(value, platform),
  terminate = defaultTerminate, intervalMs = 250,
  settleTimeoutMs = 2000, settleIntervalMs = 25 } = {}) {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) throw TypeError('An owned child PID is required');
  if (typeof snapshot !== 'function' || typeof terminate !== 'function') throw TypeError('Process operations must be functions');
  if (!Number.isFinite(intervalMs) || intervalMs < 0 || !Number.isFinite(settleTimeoutMs) ||
      settleTimeoutMs < 0 || !Number.isFinite(settleIntervalMs) || settleIntervalMs <= 0) {
    throw TypeError('Process monitoring intervals are invalid');
  }
  const owned = new Map();
  let root = null, baselineAttempted = false, timer = null, pending = null;
  let stopping = false, disposed = false, stopPromise = null, lastError = null;
  const read = async selected => normalize(await snapshot(selected));
  const state = () => ({ rootFound: !!root, tracked: owned.size });

  function collect(rows) {
    if (!baselineAttempted) {
      baselineAttempted = true;
      root = rows.get(pid) || null;
      if (root) owned.set(pid, { ...root, depth: 0 });
    }
    // Remove dead/reused descendants, but retain the root tombstone so its
    // original identity can never be replaced by another process at that PID.
    for (const [id, row] of owned) {
      if (id !== pid && !same(row, rows.get(id))) owned.delete(id);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows.values()) {
        if (row.pid === process.pid || owned.has(row.pid)) continue;
        const parent = owned.get(row.parent);
        if (!parent || !same(parent, rows.get(parent.pid))) continue;
        // Child creation cannot predate the ancestor's creation. Numeric
        // timestamps have a common epoch in the default platform snapshot.
        if (typeof row.created === 'number' && typeof parent.created === 'number' && row.created < parent.created) continue;
        owned.set(row.pid, { ...row, depth: parent.depth + 1 });
        changed = true;
      }
    }
    return state();
  }

  function pause() { clearTimeout(timer); timer = null; }
  function schedule() {
    if (timer || stopping || disposed || intervalMs === 0 || !root) return;
    timer = setTimeout(() => {
      timer = null;
      refresh().catch(error => { lastError = error; }).finally(schedule);
    }, intervalMs);
    timer.unref?.();
  }
  function refresh() {
    if (pending) return pending;
    if (stopping || disposed) return Promise.resolve(state());
    const operation = read().then(rows => { lastError = null; return collect(rows); });
    pending = operation;
    operation.then(() => { if (pending === operation) pending = null; },
      error => { lastError = error; if (pending === operation) pending = null; });
    return operation;
  }
  async function start() {
    const result = await refresh();
    schedule();
    return result;
  }
  async function finishStop() {
    if (pending) await pending.catch(() => {});
    const report = { terminated: [], skipped: [], remaining: [] }, errors = [];
    try {
      const rows = await read(); collect(rows);
      if (!root && rows.has(pid)) {
        report.remaining.push(pid);
        errors.push(Error('Runtime process identity was never verified: ' + pid));
      }
    } catch (error) { errors.push(error); }
    const targets = [...owned.values()].sort((a, b) => b.depth - a.depth || b.pid - a.pid);
    const signalled = [];
    for (const row of targets) {
      try {
        const current = (await read(row.pid)).get(row.pid);
        if (!current || !same(row, current)) {
          report.skipped.push({ pid: row.pid, reason: current ? 'identity-changed' : 'exited' });
          continue;
        }
        if (await terminate({ ...row }) === false) throw Error('Process termination was rejected: ' + row.pid);
        report.terminated.push(row.pid);
        signalled.push(row);
      } catch (error) { errors.push(error); }
    }
    // A successful signal is not proof of exit. Wait for the exact recorded
    // identities to disappear; PID reuse counts as the original having exited.
    const deadline = Date.now() + settleTimeoutMs;
    while (signalled.length) {
      try {
        const rows = await read();
        report.remaining = signalled.filter(row => same(row, rows.get(row.pid))).map(row => row.pid);
        if (!report.remaining.length) break;
        if (Date.now() >= deadline) {
          errors.push(Error('Owned processes did not exit: ' + report.remaining.join(', ')));
          break;
        }
        await new Promise(resolve => setTimeout(resolve, settleIntervalMs));
      } catch (error) { errors.push(error); break; }
    }
    if (errors.length) {
      const error = new AggregateError(errors, 'Agent runtime process cleanup was incomplete');
      error.report = report;
      lastError = error;
      throw error;
    }
    owned.clear();
    lastError = null;
    return report;
  }
  function stop() {
    if (!stopPromise) {
      stopping = true;
      pause();
      const operation = finishStop();
      stopPromise = operation;
      // A transient snapshot or termination failure must remain retryable.
      // Keep the recorded identities and revalidate them on every attempt.
      operation.catch(() => { if (stopPromise === operation) stopPromise = null; });
    }
    return stopPromise;
  }
  function dispose() { disposed = true; pause(); }
  return { start, refresh, stop, dispose,
    get trackedCount() { return owned.size; }, get lastError() { return lastError; } };
}

module.exports = { createProcessTreeGuard };
