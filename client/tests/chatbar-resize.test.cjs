'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../components/panels/chatbar-resize.js'), 'utf8');
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture(send) {
  const nodes = new Map(), frames = new Map(); let frameId = 0;
  class Element extends EventTarget {
    constructor() { super(); const classes = new Set(); this.classList = {
      add: key => classes.add(key), remove: key => classes.delete(key), contains: key => classes.has(key) }; }
    remove() { nodes.delete(this.id); }
    setPointerCapture(id) { this.captured = id; }
    hasPointerCapture(id) { return this.captured === id; }
    releasePointerCapture() { this.captured = null; }
  }
  const root = new Element(), body = { dataset: { composerState: 'pinned' }, appendChild: node => nodes.set(node.id, node) };
  const document = { body, documentElement: root, getElementById: id => nodes.get(id), createElement: () => new Element() };
  const window = new EventTarget(); window.innerWidth = 390;
  const calls = [], api = { composerSetWidth: width => {
    calls.push(width); window.innerWidth = width - 10; return send ? send(width) : Promise.resolve({ ok: true, width });
  } };
  vm.runInNewContext(source, { window, document, AbortController, Promise, Number, Math,
    requestAnimationFrame: fn => { frames.set(++frameId, fn); return frameId; }, cancelAnimationFrame: id => frames.delete(id) });
  const controller = window.SoduWorkChatbarResize.install(api), handle = nodes.get('chatbarResizeHandle');
  const fire = (target, type, data = {}) => { const event = new Event(type, { cancelable: true });
    Object.assign(event, { pointerId: 1, button: 0, screenX: 900, clientX: 3 }, data); target.dispatchEvent(event); };
  const frame = async () => { const jobs = [...frames.values()]; frames.clear(); jobs.forEach(fn => fn()); await settle(); };
  return { controller, handle, root, window, calls, fire, frame, frames };
}
test('screen coordinates stay stable as the native view moves, and a second drag starts at its real current width', async () => {
  const f = fixture();
  f.fire(f.handle, 'pointerdown');
  assert.equal(f.handle.captured, 1);
  f.fire(f.window, 'pointermove', { screenX: 880, clientX: -17 }); await f.frame();
  assert.deepEqual(f.calls, [420]);
  f.fire(f.window, 'pointermove', { screenX: 880, clientX: 3 }); await f.frame();
  assert.deepEqual(f.calls, [420], 'local coordinate rebasing must not reverse or repeat a width change');
  f.fire(f.window, 'pointerup', { screenX: 880 }); await settle();
  assert.equal(f.root.classList.contains('chatbar-resizing'), false);
  f.fire(f.handle, 'pointerdown', { screenX: 880 });
  f.fire(f.window, 'pointerup', { screenX: 860 }); await settle();
  assert.deepEqual(f.calls, [420, 440]);
  f.controller.dispose();
});
test('slow native acknowledgments retain only the latest width and commit the final release position', async () => {
  const resolves = [], f = fixture(() => new Promise(resolve => resolves.push(resolve)));
  f.fire(f.handle, 'pointerdown');
  f.fire(f.window, 'pointermove', { screenX: 890 }); await f.frame();
  for (const screenX of [880, 870, 860]) { f.fire(f.window, 'pointermove', { screenX }); await f.frame(); }
  f.fire(f.window, 'pointerup', { screenX: 850 }); await settle();
  assert.deepEqual(f.calls, [410]);
  resolves.shift()({ ok: true }); await settle(); await f.frame();
  assert.deepEqual(f.calls, [410, 450]);
  resolves.shift()({ ok: true }); await settle();
  assert.equal(f.frames.size, 0);
  f.controller.dispose();
});
test('cancellation and blur release capture and cursor state; right clicks and disposed listeners cannot resize', async () => {
  const f = fixture();
  f.fire(f.handle, 'pointerdown', { button: 2 });
  f.fire(f.window, 'pointermove', { screenX: 800 }); await f.frame();
  assert.deepEqual(f.calls, []);
  f.fire(f.handle, 'pointerdown'); f.fire(f.window, 'pointercancel');
  assert.equal(f.handle.captured, null);
  assert.equal(f.root.classList.contains('chatbar-resizing'), false);
  f.fire(f.handle, 'pointerdown'); f.fire(f.window, 'blur');
  assert.equal(f.handle.captured, null);
  f.controller.dispose(); f.fire(f.handle, 'pointerdown'); f.fire(f.window, 'pointermove', { screenX: 800 }); await f.frame();
  assert.deepEqual(f.calls, []);
});
