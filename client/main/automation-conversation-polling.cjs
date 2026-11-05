'use strict';

const POLL_INTERVAL_MS = 5_000;
const MAX_IDLE_INTERVAL_MS = 30_000;
const MAX_PUSH_IDLE_INTERVAL_MS = 60_000;
const ACTIVE_INTERVAL_MS = 15_000;
const MAX_ERROR_INTERVAL_MS = 60_000;
const MIN_WAKE_INTERVAL_MS = 1_000;

// Schedule after completion: a slow Hub must never accumulate interval callbacks.
function createPoller({ tick, setTimeout: scheduleTimeout = setTimeout,
  clearTimeout: cancelTimeout = clearTimeout, now = Date.now, random = Math.random }) {
  let timer = null, started = false, stopped = false, running = false;
  let pendingWake = false, lastWakeAt = -Infinity;
  let backingOff = false;
  let idleCount = 0, errorCount = 0, scope;
  const jitter = delay => Math.round(delay * (0.8 + 0.2 * random()));
  function schedule(delay) {
    if (stopped) return;
    if (timer !== null) cancelTimeout(timer);
    timer = scheduleTimeout(run, delay);
    timer?.unref?.();
  }
  function nextDelay(result) {
    backingOff = result.state === 'error' || result.state === 'blocked';
    if (scope !== result.scope) {
      scope = result.scope;
      idleCount = errorCount = 0;
    }
    if (result.state === 'blocked') {
      idleCount = errorCount = 0;
      return Math.max(POLL_INTERVAL_MS, Number(result.retryAfterMs) || MAX_ERROR_INTERVAL_MS);
    }
    if (result.state === 'error') {
      idleCount = 0;
      return jitter(Math.min(MAX_ERROR_INTERVAL_MS, POLL_INTERVAL_MS * 2 ** Math.min(errorCount++, 4)));
    }
    errorCount = 0;
    if (result.state === 'active') {
      idleCount = 0;
      return jitter(ACTIVE_INTERVAL_MS);
    }
    return jitter(Math.min(result.pushConfirmed ? MAX_PUSH_IDLE_INTERVAL_MS : MAX_IDLE_INTERVAL_MS,
      POLL_INTERVAL_MS * 2 ** Math.min(idleCount++, 4)));
  }
  async function run() {
    timer = null;
    if (stopped || running) return;
    running = true;
    if (pendingWake) { pendingWake = false; lastWakeAt = now(); }
    let result;
    try { result = await tick(); }
    catch (_) { result = { state: 'error', scope }; }
    finally { running = false; }
    if (stopped) return;
    result = result || { state: 'idle', scope };
    const delay = nextDelay(result);
    // Failed/auth-blocked requests retain their backoff even if a wake arrived in flight.
    if (result.state === 'error' || result.state === 'blocked') pendingWake = false;
    schedule(pendingWake ? Math.max(0, MIN_WAKE_INTERVAL_MS - (now() - lastWakeAt)) : delay);
  }
  return {
    start() {
      if (started || stopped) return;
      started = true;
      schedule(Math.round(random() * POLL_INTERVAL_MS));
    },
    wake() {
      if (!started || stopped) return;
      // A remote hint is not permission to bypass HTTP/authentication backoff.
      if (backingOff) return;
      idleCount = 0;
      pendingWake = true;
      if (!running) schedule(Math.max(0, MIN_WAKE_INTERVAL_MS - (now() - lastWakeAt)));
    },
    stop() {
      stopped = true;
      pendingWake = false;
      if (timer !== null) cancelTimeout(timer);
      timer = null;
    },
  };
}

module.exports = { createPoller, POLL_INTERVAL_MS, MAX_IDLE_INTERVAL_MS, MAX_PUSH_IDLE_INTERVAL_MS,
  ACTIVE_INTERVAL_MS, MAX_ERROR_INTERVAL_MS };
