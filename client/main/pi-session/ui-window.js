'use strict';

// A renderer's history window is only a bounded projection of the existing
// runtime. Live publications and refreshes must use the same projection.
function create() {
  const windows = new WeakMap();
  const bounded = (value, fallback, max) => Number.isFinite(Number(value)) && Number(value) > 0
    ? Math.min(max, Math.max(fallback, Math.floor(Number(value)))) : fallback;
  function request(handle, win, options) {
    if (!handle || !win || handle.detached || handle.attachedWindow !== win || win.isDestroyed()) return false;
    const previous = windows.get(handle);
    const old = previous?.win === win ? previous : {};
    const messageLimit = Math.max(old.messageLimit || 80, bounded(options?.messageLimit, 80, 2000));
    windows.set(handle, { win, messageLimit,
      toolLimit: Math.max(old.toolLimit || 160, bounded(options?.toolLimit, messageLimit * 2, 4000)) });
    return true;
  }
  function snapshot(handle) {
    const row = windows.get(handle);
    const options = row && !handle.detached && row.win === handle.attachedWindow && !row.win.isDestroyed()
      ? { messageLimit: row.messageLimit, toolLimit: row.toolLimit } : undefined;
    return typeof handle.uiSnapshot === 'function' ? handle.uiSnapshot(options) : handle.snapshot();
  }
  return { request, snapshot, reset: handle => windows.delete(handle) };
}
module.exports = { create };
