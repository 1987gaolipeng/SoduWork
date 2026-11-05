'use strict';

// Completion-based polling: one request chain, one timer, and at most one
// coalesced wake-up. Push is an optimization; bounded polling remains a fallback.
function create({ tick, baseMs = 5000, idleMs = () => 20000, errorMs = 60000,
  setTimeout: later = setTimeout, clearTimeout: cancel = clearTimeout,
  random = Math.random, now = Date.now, maxStartGapMs = () => Infinity }) {
  let stopped = false, started = false, timer = null, running = null, wakePending = false;
  let timerDue = 0;
  let idleCount = 0, errorCount = 0, scope = null;
  function arm(delay) {
    if (stopped || !started) return;
    if (timer) cancel(timer);
    delay = Math.max(1000, delay);
    timerDue = now() + delay;
    timer = later(() => { timer = null; void run(); }, delay);
    timer?.unref?.();
  }
  function run() {
    if (stopped) return Promise.resolve();
    if (running) return running;
    const beganAt = now();
    running = Promise.resolve().then(tick).catch(error => ({ state: 'error', error }))
      .then(result => {
        result ||= {};
        if (result.scope !== undefined && result.scope !== scope) {
          scope = result.scope; idleCount = 0; errorCount = 0;
        }
        let delay;
        if (result.state === 'error' || result.state === 'blocked') {
          idleCount = 0;
          delay = Math.min(errorMs, baseMs * 2 ** Math.min(++errorCount, 8));
          if (result.state === 'blocked') delay = errorMs;
        } else {
          errorCount = 0;
          idleCount = result.state === 'active' ? 0 : Math.min(idleCount + 1, 8);
          delay = Math.min(idleMs(), baseMs * 2 ** idleCount);
        }
        // A push during failure cannot defeat outage/authentication backoff.
        if (wakePending && !errorCount) delay = 1000;
        if (!errorCount) delay = Math.min(delay, maxStartGapMs() - (now() - beganAt));
        wakePending = false;
        arm(delay * (0.8 + 0.2 * random()));
        return result;
      }).finally(() => { running = null; });
    return running;
  }
  return {
    start() { if (!started && !stopped) { started = true; arm(baseMs * random()); } },
    wake() {
      if (stopped) return;
      idleCount = 0;
      if (running) wakePending = true;
      else if (!errorCount && (!timer || timerDue > now() + 1000)) arm(1000);
    },
    run,
    stop() { stopped = true; if (timer) cancel(timer); timer = null; },
  };
}

module.exports = { create };
