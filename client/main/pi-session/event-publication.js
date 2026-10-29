'use strict';

// snapshot-emitter delivers every event kind against one immutable snapshot.
// Transport that snapshot once per burst, retaining all ordered control events.
// A different snapshot is a real state boundary and must not be coalesced away.
function create(publish, { capture = context => context, schedule = queueMicrotask } = {}) {
  const pending = new Map();
  function flush(key, entry) {
    if (pending.get(key) !== entry) return;
    pending.delete(key);
    // Publication used to run inside the session observer's error boundary.
    // Keep a closing window/bad observer from becoming an uncaught microtask.
    try { publish(entry.context, entry.events, entry.snapshot); } catch (_) {}
  }
  return {
    push(key, event, snapshot, context) {
      let entry = pending.get(key);
      if (entry && entry.snapshot !== snapshot) { flush(key, entry); entry = null; }
      if (!entry) {
        entry = { events: [], snapshot, context: capture(context, snapshot) };
        pending.set(key, entry);
        schedule(() => flush(key, entry));
      }
      entry.events.push(event || {});
    },
    flush(key) { const entry = pending.get(key); if (entry) flush(key, entry); },
    cancel(key) { pending.delete(key); },
    clear() { pending.clear(); },
  };
}

// Only event metadata crosses IPC. Raw touched blocks/tools may be large and
// can contain provider-private fields; transcript data belongs in snapshot.
function fields(event, full, snapshot) {
  return {
    kind: event?.kind,
    reason: event?.reason,
    failureKind: full && event?.failureKind || '',
    retrySafe: Boolean(full && event?.retrySafe),
    submissionId: full && event?.submissionId || '',
    taskId: String(event?.taskId || snapshot?.execution?.turnQueue?.activeTaskId || ''),
  };
}

const STREAM_FLUSH_MS = 16;
function createStreamScheduler(publish, { delay = STREAM_FLUSH_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const pending = new Map();
  function deliver(context, event, snapshot) { try { publish(context, event, snapshot); } catch (_) {} }
  function cancel(key) {
    const row = pending.get(key);
    if (row) { clearTimer(row.timer); pending.delete(key); }
  }
  return {
    push(key, event, snapshot, context) {
      if (event?.kind !== 'block') { cancel(key); deliver(context, event, snapshot); return; }
      const current = pending.get(key);
      if (current) { current.event = event; current.snapshot = snapshot; current.context = context; return; }
      const row = { event, snapshot, context };
      pending.set(key, row);
      row.timer = setTimer(() => {
        if (pending.get(key) !== row) return;
        pending.delete(key);
        deliver(row.context, row.event, row.snapshot);
      }, delay);
    },
    cancel,
    clear() { for (const key of pending.keys()) cancel(key); },
  };
}
module.exports = { create, fields, createStreamScheduler, STREAM_FLUSH_MS };
