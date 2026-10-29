'use strict';

// `progress` remains the download percentage used by the Hub's existing
// protocol. The renderer must use phaseProgress for the *current* operation;
// null explicitly means there is no measurable percentage for that operation.
const PHASES = Object.freeze({ idle: 'idle', development: 'idle', checking: 'checking',
  current: 'current', available: 'verifying', downloading: 'downloading',
  downloaded: 'ready', waiting: 'waiting', deferred: 'deferred',
  installing: 'preparing', installed: 'installed', failed: 'failed', manual: 'manual' });

function advance(previous, patch, now = new Date().toISOString()) {
  const next = { ...previous, ...patch, updatedAt: now };
  const changed = patch.state && patch.state !== previous.state;
  const phase = patch.phase || (changed ? PHASES[patch.state] : previous.phase) || PHASES[next.state] || 'idle';
  next.phase = phase;
  if (phase !== previous.phase) next.phaseStartedAt = now;
  if (Object.hasOwn(patch, 'phaseProgress')) {
    next.phaseProgress = Number.isFinite(patch.phaseProgress)
      ? Math.max(0, Math.min(100, patch.phaseProgress)) : null;
  } else if (phase === 'downloading') next.phaseProgress = Math.max(0, Math.min(100, Number(next.progress) || 0));
  else if (phase !== previous.phase) next.phaseProgress = ['ready', 'installed', 'current'].includes(phase) ? 100 : null;
  if (patch.state === 'checking') {
    next.receivedBytes = 0; next.totalBytes = 0; next.verifiedBytes = 0;
  }
  return next;
}

module.exports = { advance };
