'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const handlers = new Map(), windowHandlers = new Map(), frames = new Map();
  const calls = { expand: 0, shrink: 0, begin: 0, end: 0, disarm: 0, positions: [] };
  const target = map => ({
    addEventListener: (name, cb) => map.set(name, cb),
    removeEventListener: (name, cb) => { if (map.get(name) === cb) map.delete(name); },
  });
  let nextFrame = 0;
  const sandbox = {
    document: target(handlers), window: { ...target(windowHandlers), innerWidth: 500, innerHeight: 500 },
    pet: { getBoundingClientRect: () => ({ left: 10, top: 10 }), offsetWidth: 30, offsetHeight: 30,
      classList: { add() {}, remove() {} }, style: {} },
    expandForOverlay: () => calls.expand++, shrinkFromOverlay: () => calls.shrink++,
    beginOverlayDrag: () => calls.begin++, endOverlayDrag: () => calls.end++,
    armGrabCursor() {}, disarmGrabCursor: () => calls.disarm++,
    setPetPos: (x, y) => calls.positions.push([x, y]),
    requestAnimationFrame: cb => { const id = ++nextFrame; frames.set(id, cb); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    Date, Math,
  };
  const source = fs.readFileSync(path.join(__dirname, '../components/pet/pet-ui.js'), 'utf8');
  const begin = source.indexOf('/* Dragging. */');
  const end = source.indexOf('/* Double-click opens notifications;', begin);
  assert.ok(begin >= 0 && end > begin);
  vm.runInNewContext(source.slice(begin, end), sandbox);
  const event = (x, y, options = {}) => ({ button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y,
    target: { closest: () => false }, preventDefault() {}, ...options });
  return { sandbox, calls, handlers, windowHandlers, frames, event };
}

test('lost release ends the drag when the mouse returns without a pressed button', () => {
  const f = fixture();
  f.sandbox._onPetPointerDown(f.event(0, 0));
  f.handlers.get('pointermove')(f.event(20, 20));
  assert.equal(f.calls.begin, 1);
  f.handlers.get('pointermove')(f.event(30, 30, { buttons: 0 }));
  assert.equal(f.calls.end, 1);
  assert.equal(f.calls.shrink, 1);
  assert.equal(f.calls.disarm, 1);
  assert.equal(f.handlers.size, 0);
  assert.equal(f.windowHandlers.size, 0);
  assert.equal(f.frames.size, 0);
});

test('blur ends an active drag once and ignores events from other pointers', () => {
  const f = fixture();
  f.sandbox._onPetPointerDown(f.event(10, 10));
  f.handlers.get('pointermove')(f.event(30, 30));
  f.handlers.get('pointerup')(f.event(30, 30, { pointerId: 2 }));
  assert.equal(f.calls.end, 0);
  f.windowHandlers.get('blur')();
  f.sandbox._onPetPointerUp(f.event(30, 30));
  assert.equal(f.calls.end, 1);
  assert.equal(f.calls.shrink, 1);
  assert.equal(f.handlers.size, 0);
});

test('a regular click does not expand or shrink the overlay', () => {
  const f = fixture();
  f.sandbox._onPetPointerDown(f.event(10, 10));
  f.handlers.get('pointerup')(f.event(10, 10));
  assert.equal(f.calls.expand, 0);
  assert.equal(f.calls.shrink, 0);
  assert.equal(f.handlers.size, 0);
});

test('release retains a fast final move even before the animation frame runs', () => {
  const f = fixture();
  f.sandbox._onPetPointerDown(f.event(20, 20));
  f.handlers.get('pointermove')(f.event(410, 310));
  f.handlers.get('pointerup')(f.event(410, 310, { buttons: 0 }));
  assert.deepEqual(f.calls.positions, [[400, 300]]);
  assert.equal(f.frames.size, 0);
});

test('pointer loss and blur release the capture exactly once', () => {
  const f = fixture(); let releaseCount = 0, lost;
  f.sandbox.captureOverlayPointer = (_event, callback) => { lost = callback; return () => releaseCount++; };
  f.sandbox._onPetPointerDown(f.event(20, 20));
  f.handlers.get('pointermove')(f.event(100, 100));
  lost();
  f.sandbox._onPetPointerBlur();
  assert.equal(releaseCount, 1);
  assert.equal(f.calls.end, 1);
  assert.equal(f.handlers.size, 0);
});
