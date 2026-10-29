'use strict';

// Hub timestamps are UTC; legacy Runner snapshots use Unix seconds.
function epoch(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0
    ? (value < 1e12 ? value * 1000 : value) : 0;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}[T ]/.test(value)) return 0;
  const parsed = Date.parse(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(value) ? value : value + 'Z');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
function project(remote, now = Date.now()) {
  const start = epoch(remote?.startedAt) || epoch(remote?.started);
  const end = epoch(remote?.finishedAt) || epoch(remote?.ended);
  const running = ['running', 'queued', 'dispatching'].includes(remote?.status);
  // A missing or inconsistent receipt is unknown, never a local executor's age.
  const stop = running ? now : end;
  return { elapsedMs: start && stop >= start ? stop - start : null,
    startedAt: start, completedAt: running ? 0 : end,
    timingTurn: remote ? [remote.ref || '', remote.round || 1, start].join(':') : '' };
}
module.exports = { epoch, project };
