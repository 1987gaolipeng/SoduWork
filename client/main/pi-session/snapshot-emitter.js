'use strict';

// Coalesce BEFORE snapshot construction. Throttling only at IPC still cleans
// and copies the entire archive once per provider token in the main process.
// 50 ms keeps token/block updates visibly fluid while still coalescing the
// high-frequency provider events before building a UI snapshot.
//
// Queue all pending events and coalesce adjacent streaming deltas at the tail.
// Retain structural events individually with their original kinds.
// Build one snapshot and send one IPC per batch.
// Notify listeners in queue order so kind-specific rendering remains unchanged.
// Bound snapshot bursts during tool-heavy turns instead of serializing full history for every event.
function create(snapshot, listeners, delay = 50) {
  let timer = null, queue = null, disposed = false, lastFlush = 0;
  function dispatch() {
    const items = queue || [];
    timer = null; queue = null;
    lastFlush = Date.now();
    if (!items.length) return;
    const value = snapshot();
    listeners.forEach(fn => {
      for (const item of items) { try { fn(item, value); } catch (_) {} }
    });
  }
  return {
    emit(touched) {
      if (disposed) return;
      if (touched?.kind === 'ignored') return;
      const isDelta = touched?.kind === 'block' || touched?.partial === true;
      if (!queue) queue = [];
      if (isDelta) {
        const last = queue[queue.length - 1];
        if (last && last.__delta) queue[queue.length - 1] = Object.assign({}, touched, { __delta: true });
        else queue.push(Object.assign({}, touched, { __delta: true }));
      } else queue.push(touched);
      if (timer) return;
      const wait = isDelta ? delay : Math.max(0, delay - (Date.now() - lastFlush));
      timer = setTimeout(dispatch, wait);
    },
    dispose() { disposed = true; if (timer) clearTimeout(timer); timer = null; queue = null; },
  };
}
module.exports = { create };
