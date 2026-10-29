'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the real dock event handlers. Geometry is fixed at scale 1; native
// window regions and Chromium geometry have separate isolated Electron coverage.
function boot(initial = {}) {
  const dockListeners = new Map(), documentListeners = new Map();
  const classes = new Set(), frames = new Map(), timers = new Map();
  const calls = { begin: 0, end: 0, depth: 0, save: 0, disarm: 0, writes: 0 };
  let sequence = 0;
  const add = (listeners, type, callback) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(callback);
  };
  const dock = {
    dataset: {}, style: {}, firstElementChild: null,
    classList: {
      add: name => classes.add(name), remove: name => classes.delete(name),
      contains: name => classes.has(name),
    },
    addEventListener: (type, callback) => add(dockListeners, type, callback),
    set innerHTML(value) { calls.writes++; this.firstElementChild = { value }; },
    getBoundingClientRect() {
      const width = 36, height = 150;
      const left = !this.style.left || this.style.left === 'auto' ? 1000 - width : parseInt(this.style.left);
      const top = parseInt(this.style.top) || 0;
      return { left, top, width, height, right: left + width, bottom: top + height };
    },
  };
  const sandbox = {
    cfg: { dockVisible: true, tasksOn: true, dockX: null, dockY: 120, ...initial },
    innerWidth: 1000, innerHeight: 800,
    document: {
      readyState: 'complete', getElementById: id => id === 'edgeDock' ? dock : null,
      addEventListener: (type, callback) => add(documentListeners, type, callback),
      removeEventListener: (type, callback) => documentListeners.get(type)?.delete(callback),
    },
    requestAnimationFrame(callback) { const id = ++sequence; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    setTimeout(callback) { const id = ++sequence; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
    saveCfg() { calls.save++; },
    expandForOverlay() { calls.depth++; }, shrinkFromOverlay() { calls.depth--; },
    beginOverlayDrag() { calls.begin++; }, endOverlayDrag() { calls.end++; },
    armGrabCursor() {}, disarmGrabCursor() { calls.disarm++; },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/pet/pet-dock.js'), 'utf8'), sandbox);
  sandbox._syncSidebar();
  const fire = (type, x, y, pointerId = 1) => {
    const listeners = type === 'pointerdown' ? dockListeners : documentListeners;
    for (const callback of [...(listeners.get(type) || [])]) {
      callback({ type, button: 0, pointerId, clientX: x, clientY: y, target: { closest: () => null } });
    }
  };
  const frame = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); };
  const snapshot = () => ({ ...dock.style, floating: classes.has('floating') });
  const start = () => {
    const { left, top } = dock.getBoundingClientRect();
    fire('pointerdown', left + 8, top + 8);
    return { x: left + 8, y: top + 8 };
  };
  return { sandbox, dock, calls, frames, documentListeners, fire, frame, snapshot, start };
}

test('task/config sidebar refresh preserves the in-flight drag position and floating shape', () => {
  for (const dockX of [null, 500]) {
    const h = boot({ dockX });
    const origin = h.start();
    h.fire('pointermove', origin.x - 120, origin.y + 30);
    h.frame();
    const during = h.snapshot();
    const button = h.dock.firstElementChild;
    for (let i = 0; i < 30; i++) {
      h.sandbox._syncSidebar();
      h.sandbox.updateNoticeBadge();
    }
    assert.deepEqual(h.snapshot(), during, 'a background refresh must not restore saved coordinates');
    assert.equal(h.dock.firstElementChild, button, 'refresh must preserve button nodes');
    assert.equal(h.calls.writes, 1);
    h.fire('pointerup', origin.x - 120, origin.y + 30);
    h.sandbox._syncSidebar();
    assert.deepEqual(h.snapshot(), during, 'release persists the current drag position');
    assert.equal(h.calls.depth, 0);
  }
});

test('hiding the dock during a drag immediately hides it and closes the gesture', () => {
  for (const preference of ['dockVisible', 'tasksOn']) {
    const h = boot();
    const origin = h.start();
    h.fire('pointermove', origin.x - 100, origin.y + 20);
    // Hide before the queued drawing frame: no stale frame may move a hidden dock.
    h.sandbox.cfg[preference] = false;
    h.sandbox._syncSidebar();
    assert.equal(h.dock.classList.contains('show'), false);
    assert.equal(h.calls.depth, 0, 'hidden dock must release overlay interaction');
    assert.equal(h.calls.begin, h.calls.end, 'drag shape mode must be balanced');
    assert.equal(h.frames.size, 0);
    for (const type of ['pointermove', 'pointerup', 'pointercancel']) {
      assert.equal(h.documentListeners.get(type)?.size || 0, 0, type + ' listener must be removed');
    }
    assert.ok(h.calls.disarm > 0, 'hiding without pointerup must restore the cursor');
    const hidden = h.snapshot();
    h.fire('pointermove', origin.x - 200, origin.y + 80);
    h.fire('pointerup', origin.x - 200, origin.y + 80);
    h.frame();
    assert.deepEqual(h.snapshot(), hidden);

    h.sandbox.cfg[preference] = true;
    h.sandbox._syncSidebar();
    assert.equal(h.dock.classList.contains('show'), true);
    const again = h.start();
    h.fire('pointermove', again.x - 40, again.y + 10);
    h.fire('pointercancel', again.x - 40, again.y + 10);
    assert.equal(h.calls.depth, 0);
    assert.equal(h.calls.begin, 2);
    assert.equal(h.calls.end, 2);
    assert.equal(h.frames.size, 0);
  }
});

test('pointer cancellation saves the pending frame and the next drag starts cleanly', () => {
  const h = boot();
  const origin = h.start();
  h.fire('pointermove', origin.x - 100, origin.y + 20);
  h.fire('pointercancel', origin.x - 100, origin.y + 20);
  assert.equal(h.sandbox.cfg.dockX, 864);
  assert.equal(h.sandbox.cfg.dockY, 140);
  assert.equal(h.frames.size, 0);
  assert.equal(h.calls.depth, 0);
  const again = h.start();
  h.fire('pointermove', again.x - 80, again.y + 30);
  h.frame();
  h.sandbox._syncSidebar();
  assert.equal(h.dock.getBoundingClientRect().left, 784);
  h.fire('pointerup', again.x - 80, again.y + 30);
  assert.equal(h.sandbox.cfg.dockX, 784);
  assert.equal(h.sandbox.cfg.dockY, 170);
  assert.equal(h.calls.save, 2);
  assert.equal(h.calls.begin, 2);
  assert.equal(h.calls.end, 2);
  assert.equal(h.calls.depth, 0);
});

test('another pointer cannot replace or end the active drag', () => {
  const h = boot();
  const origin = h.start();
  h.fire('pointerdown', origin.x - 300, origin.y + 50, 2);
  h.fire('pointermove', origin.x - 300, origin.y + 50, 2);
  h.fire('pointerup', origin.x - 300, origin.y + 50, 2);
  assert.equal(h.calls.begin, 0);
  h.fire('pointermove', origin.x - 100, origin.y + 20);
  h.frame();
  const position = h.snapshot();
  h.fire('pointercancel', origin.x - 300, origin.y + 50, 2);
  h.sandbox._syncSidebar();
  assert.deepEqual(h.snapshot(), position);
  assert.equal(h.calls.depth, 1);
  h.fire('pointerup', origin.x - 100, origin.y + 20);
  assert.equal(h.sandbox.cfg.dockX, 864);
  assert.equal(h.calls.depth, 0);
  assert.equal(h.calls.begin, 1);
  assert.equal(h.calls.end, 1);
});

test('hiding before the drag threshold releases listeners without opening drag mode', () => {
  const h = boot();
  h.start();
  h.sandbox.cfg.dockVisible = false;
  h.sandbox._syncSidebar();
  assert.equal(h.dock.classList.contains('show'), false);
  assert.equal(h.calls.begin, 0);
  assert.equal(h.calls.end, 0);
  assert.equal(h.calls.depth, 0);
  assert.equal(h.calls.save, 0);
  assert.equal(h.documentListeners.get('pointermove').size, 0);
  assert.ok(h.calls.disarm > 0);
});
