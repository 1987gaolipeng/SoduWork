/* Application sidebar resizing stays independent of conversation rendering. */
(function (global) {
  'use strict';
  function install(api) {
    global.__soduWorkChatbarResize?.dispose();
    document.getElementById('chatbarResizeHandle')?.remove();
    const handle = document.createElement('div');
    handle.id = 'chatbarResizeHandle';
    document.body.appendChild(handle);
    const events = new AbortController();
    let pointer = null, startX = 0, startW = 0, inset = 10;
    let queued = null, frame = 0, inFlight = false, disposed = false, lastSent = null;

    function schedule() {
      if (!disposed && !inFlight && !frame && queued !== null) frame = requestAnimationFrame(flush);
    }
    function flush() {
      frame = 0;
      if (disposed || inFlight || queued === null) return;
      const width = queued; queued = null;
      if (width === lastSent) return;
      lastSent = width;
      inFlight = true;
      Promise.resolve().then(() => api.composerSetWidth(width)).catch(() => {
        lastSent = null;
      }).finally(() => { inFlight = false; schedule(); });
    }
    function finish() {
      if (pointer === null) return;
      const id = pointer; pointer = null;
      handle.classList.remove('dragging');
      document.documentElement.classList.remove('chatbar-resizing');
      try { if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id); } catch (_) {}
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      flush(); // Also commits a final position when a background frame was throttled.
    }
    const listen = (target, type, fn) => target.addEventListener(type, fn, { signal: events.signal });
    listen(handle, 'pointerdown', event => {
      if (event.button !== 0 || pointer !== null || document.body.dataset.composerState !== 'pinned') return;
      pointer = event.pointerId;
      startX = event.screenX;
      // Native width includes the unchanged right outer inset. Never reuse a stale mode width.
      startW = Math.round(global.innerWidth + inset);
      lastSent = startW;
      handle.classList.add('dragging');
      document.documentElement.classList.add('chatbar-resizing');
      try { handle.setPointerCapture(pointer); } catch (_) {}
      event.preventDefault();
    });
    listen(global, 'pointermove', event => {
      if (event.pointerId !== pointer) return;
      queued = Math.round(startW + startX - event.screenX);
      schedule();
      event.preventDefault();
    });
    listen(global, 'pointerup', event => {
      if (event.pointerId !== pointer) return;
      queued = Math.round(startW + startX - event.screenX);
      finish();
    });
    listen(global, 'pointercancel', event => { if (event.pointerId === pointer) finish(); });
    listen(handle, 'lostpointercapture', event => { if (event.pointerId === pointer) finish(); });
    listen(global, 'blur', finish);
    const controller = {
      setWidthInset(value) { if (Number.isFinite(value) && value >= 0 && value <= 40) inset = value; },
      dispose() {
        finish(); disposed = true; queued = null;
        if (frame) cancelAnimationFrame(frame);
        events.abort(); handle.remove();
      },
    };
    global.__soduWorkChatbarResize = controller;
    return controller;
  }
  global.SoduWorkChatbarResize = { install };
})(window);
