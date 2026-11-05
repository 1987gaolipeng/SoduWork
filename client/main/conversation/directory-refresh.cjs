'use strict';

// A socket notification is an invalidation hint, never authoritative row data.
// Retain notifications received during a refresh and coalesce them into one
// trailing refresh, with bounded retries even under a continuous event stream.
function create({ refresh, now = Date.now, setTimeout: later = setTimeout,
  clearTimeout: cancel = clearTimeout, minimumMs = 1000, retryMs = 5000 }) {
  let stopped = false, running = false, timer = null, wanted = false;
  let lastStart = -Infinity, failures = 0, retryAt = 0;
  const pending = new Set();
  function arm() {
    if (stopped || running || timer !== null || !wanted) return;
    const delay = Math.max(0, Math.max(retryAt, lastStart + minimumMs) - now());
    if (!delay) { void run(); return; }
    timer = later(() => { timer = null; void run(); }, delay);
    timer?.unref?.();
  }
  async function run() {
    if (stopped || running) return;
    running = true; wanted = false; lastStart = now();
    const ids = [...pending]; pending.clear();
    try {
      const result = await refresh(ids);
      if (result?.ok === false) throw Error('directory refresh unavailable');
      failures = 0;
      retryAt = 0;
    } catch (_) {
      failures++;
      retryAt = now() + Math.min(60000, retryMs * 2 ** Math.min(failures - 1, 4));
      wanted = true;
      for (const id of ids) pending.add(id);
    } finally {
      running = false;
      arm();
    }
  }
  return {
    wake(id) {
      if (stopped) return;
      if (id) pending.add(id);
      wanted = true;
      arm();
    },
    stop() {
      stopped = true; pending.clear(); wanted = false;
      if (timer !== null) cancel(timer);
      timer = null;
    },
  };
}

module.exports = { create };
