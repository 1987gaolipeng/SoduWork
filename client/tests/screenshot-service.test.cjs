'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { create, captureSize, pngPayload } = require('../main/screenshot-service.cjs');

function png(width = 50, height = 40) {
  const bytes = Buffer.alloc(40);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
  bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12);
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  return 'data:image/png;base64,' + bytes.toString('base64');
}
function fixture(options = {}) {
  const root = path.resolve(__dirname, '..'), handlers = new Map(), windows = [], writes = [], clips = [], captures = [];
  const screen = Object.assign(new EventEmitter(), {
    getAllDisplays: () => options.displays || [
      { id: 1, label: '左屏', bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
      { id: 2, label: '主屏', bounds: { x: 0, y: 0, width: 1280, height: 800 }, scaleFactor: 2 }
    ], getCursorScreenPoint: () => ({ x: 100, y: 100 }), getDisplayNearestPoint: () => ({ id: 2 })
  });
  class Window extends EventEmitter {
    constructor(opts = {}) {
      super(); this.options = opts; this.destroyed = false; this.visible = false; this.focusCount = 0;
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: { url: '' }, url: '', isDestroyed: () => this.destroyed,
        getURL() { return this.url; }, setWindowOpenHandler(fn) { this.openHandler = fn; },
        setIgnoreMenuShortcuts(value) { this.ignoreShortcuts = value; }
      });
      windows.push(this);
    }
    static fromWebContents(wc) { return windows.find(w => w.webContents === wc); }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    isMinimized() { return false; }
    showInactive() { this.visible = true; }
    show() { this.visible = true; }
    hide() { this.visible = false; this.hideCount = (this.hideCount || 0) + 1; }
    focus() { this.focusCount++; }
    setAlwaysOnTop() {}
    setBounds(bounds) { this.bounds = { ...bounds }; }
    setVisibleOnAllWorkspaces() {}
    setMenu() {}
    loadFile(file) {
      this.webContents.url = pathToFileURL(file).href;
      this.webContents.mainFrame.url = this.webContents.url;
      if (options.loadFailure && this.options.webPreferences) return Promise.reject(new Error('load failed'));
      if (this.options.webPreferences && !options.manualReady) queueMicrotask(() => {
        handlers.get('screenshot-ready')?.({ sender: this.webContents, senderFrame: this.webContents.mainFrame });
      });
      return Promise.resolve();
    }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const owner = new Window(); owner.loadFile(path.join(root, 'desk.html')); owner.show();
  const event = win => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
  const nativeImage = { createFromBuffer(bytes) { return { isEmpty: () => false, toPNG: () => bytes,
    getSize: () => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }) }; } };
  const service = create({ app: { getAppPath: () => root, isReady: () => true }, BrowserWindow: Window,
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) }, screen,
    desktopCapturer: { async getSources(request) {
      captures.push(request);
      options.onCapture?.(owner, windows);
      if (options.capture) return options.capture();
      // Intentionally reversed: a display's physical source must never depend on array order.
      return screen.getAllDisplays().slice().reverse().map(display => ({ display_id: String(display.id), name: display.label,
        thumbnail: { isEmpty: () => false, getSize: () => ({ width: display.bounds.width * display.scaleFactor,
          height: display.bounds.height * display.scaleFactor }),
        toPNG: () => Buffer.from(png(display.bounds.width * display.scaleFactor, display.bounds.height * display.scaleFactor).split(',')[1], 'base64') }
      }));
    } }, nativeImage, ClipboardItem: class ClipboardItem { constructor(data) { this.data = data; } },
    clipboard: options.modernClipboard ? { async write(items) {
      if (options.asyncClipboard) await options.asyncClipboard();
      if (options.clipFailure) throw new Error('clipboard busy'); clips.push(...items);
    } } : { writeImage(image) { if (options.clipFailure) throw new Error('clipboard busy'); clips.push(image); } },
    dialog: { showSaveDialog: async () => options.dialog ? options.dialog() : ({ canceled: false, filePath: path.join(root, 'user-picked.png') }) },
    fs: { promises: { writeFile: async (...args) => { if (options.writeFailure) throw new Error('read only'); writes.push(args); } } },
    getTheme: () => ({ tokens: { '--accent': '#7350b5' } }), timeoutMs: options.timeoutMs || 5000, hideDelayMs: options.hideDelayMs || 0
  });
  const call = (channel, win = owner, payload) => handlers.get(channel)(event(win), payload);
  const ready = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
  return { service, call, owner, windows, ready, screen, captures, writes, clips, event, handlers };
}

test('explicit hidden capture hides only its owner before pixels are acquired and restores it after cancel', async t => {
  const f = fixture({ onCapture(owner) { assert.equal(owner.isVisible(), false); } });
  t.after(() => f.service.dispose());
  const other = new f.owner.constructor(); other.show();
  const pending = f.call('screenshot-start', f.owner, { hideOwner: true }); await f.ready();
  assert.equal(f.owner.isVisible(), false); assert.equal(f.owner.hideCount, 1);
  assert.equal(other.isVisible(), true); assert.equal(other.hideCount, undefined);
  await f.call('screenshot-cancel', f.windows[2]);
  assert.equal((await pending).cancelled, true);
  assert.equal(f.owner.isVisible(), true); assert.equal(f.owner.focusCount, 1);
  assert.equal(other.isVisible(), true); assert.equal(other.focusCount, 0);
});

test('ordinary capture and non-boolean flags keep the owner in the frozen screen', async t => {
  for (const payload of [undefined, { hideOwner: false }, { hideOwner: 'true' }]) {
    const f = fixture({ onCapture(owner) { assert.equal(owner.isVisible(), true); } });
    t.after(() => f.service.dispose());
    const pending = f.call('screenshot-start', f.owner, payload); await f.ready();
    assert.equal(f.owner.hideCount, undefined);
    await f.call('screenshot-cancel', f.windows[1]); await pending;
  }
});

test('hidden capture restores on success, acquisition failure, editor failure and service disposal', async t => {
  for (const mode of ['copy', 'save', 'capture-error', 'load-error', 'dispose']) {
    const f = fixture(mode === 'capture-error' ? { capture: async () => { throw new Error('capture failed'); } } :
      mode === 'load-error' ? { loadFailure: true } : {});
    t.after(() => f.service.dispose());
    const pending = f.call('screenshot-start', f.owner, { hideOwner: true }); await f.ready();
    if (mode === 'dispose') f.service.dispose();
    else if (mode === 'copy' || mode === 'save') {
      const overlay = f.windows[1]; await f.call('screenshot-claim', overlay);
      assert.equal((await f.call('screenshot-finish', overlay, { action: mode, dataUrl: png() })).ok, true);
    }
    const result = await pending;
    assert.equal(result.ok, !mode.endsWith('error'), mode);
    assert.equal(f.owner.isVisible(), true, mode); assert.equal(f.owner.hideCount, 1, mode);
  }
});

test('cancellation during compositor delay restores the owner and never captures later', async t => {
  const f = fixture({ hideDelayMs: 40 }); t.after(() => f.service.dispose());
  const pending = f.call('screenshot-start', f.owner, { hideOwner: true });
  assert.equal(f.owner.isVisible(), false);
  f.owner.webContents.emit('did-start-navigation', {}, 'file:///other.html', false, true);
  assert.equal((await pending).cancelled, true); assert.equal(f.owner.isVisible(), true);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(f.captures.length, 0); assert.equal(f.windows.length, 1);
});

test('capture never reveals an owner that was already hidden before starting', async t => {
  const f = fixture(); t.after(() => f.service.dispose()); f.owner.hide();
  const pending = f.call('screenshot-start', f.owner, { hideOwner: true }); await f.ready();
  await f.call('screenshot-cancel', f.windows[1]); await pending;
  assert.equal(f.owner.isVisible(), false); assert.equal(f.owner.focusCount, 0);
});

test('capture size uses maximum physical resolution, independent of negative screen origins', () => {
  assert.deepEqual(captureSize([
    { bounds: { x: -3000, y: -600, width: 3000, height: 2000 }, scaleFactor: 1 },
    { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 2 }
  ]), { width: 3840, height: 2160 });
});
test('PNG guard rejects non-PNG, corrupt payloads, oversized images and decode mismatch', () => {
  const nativeImage = { createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 50, height: 40 }) }) };
  assert.equal(pngPayload(png(), nativeImage).bytes.length, 40);
  for (const value of ['data:image/jpeg;base64,AA==', 'data:image/png;base64,?', png(999999, 1), png(51, 40)]) {
    assert.throws(() => pngPayload(value, nativeImage), /截图|PNG/);
  }
});
test('only a local desk main frame may start and only exact active overlays may obtain pixels', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  const frame = { ...f.event(f.owner), senderFrame: { url: f.owner.webContents.url } };
  assert.equal((await f.handlers.get('screenshot-start')(frame)).ok, false);
  for (const file of ['https://example.com/desk.html', pathToFileURL(path.join(__dirname, 'desk.html')).href,
    pathToFileURL(path.resolve(__dirname, '../index.html')).href]) {
    f.owner.webContents.url = f.owner.webContents.mainFrame.url = file;
    assert.equal((await f.call('screenshot-start')).ok, false);
  }
  f.owner.loadFile(path.resolve(__dirname, '../desk.html'));
  const pending = f.call('screenshot-start'); await f.ready();
  assert.equal((await f.call('screenshot-data')).ok, false);
  const overlay = f.windows[1];
  const badFrame = { ...f.event(overlay), senderFrame: { url: overlay.webContents.url } };
  assert.equal((await f.handlers.get('screenshot-data')(badFrame)).ok, false);
  await f.call('screenshot-cancel', overlay); assert.equal((await pending).cancelled, true);
});
test('multi-monitor overlays preserve bounds and original pixels, claim hides other displays', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  const pending = f.call('screenshot-start'); await f.ready();
  assert.equal(f.windows.length, 3);
  assert.deepEqual(f.captures, [
    { types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } },
    { types: ['screen'], thumbnailSize: { width: 2560, height: 1600 } }
  ]);
  const [left, right] = f.windows.slice(1), leftData = await f.call('screenshot-data', left), rightData = await f.call('screenshot-data', right);
  assert.equal(left.options.x, -1920); assert.equal(left.options.width, 1920);
  assert.equal(left.options.thickFrame, false); assert.equal(left.options.roundedCorners, false);
  assert.deepEqual(left.bounds, f.screen.getAllDisplays()[0].bounds);
  assert.deepEqual(right.bounds, f.screen.getAllDisplays()[1].bounds);
  assert.equal(leftData.width, 1920); assert.equal(leftData.displayId, '1');
  assert.equal(rightData.width, 2560); assert.equal(rightData.height, 1600); assert.equal(rightData.theme.accent, '#7350b5');
  assert.deepEqual(rightData.bounds, f.screen.getAllDisplays()[1].bounds); assert.equal(rightData.scaleFactor, 2);
  assert.equal(right.options.webPreferences.nodeIntegration, false); assert.equal(right.options.webPreferences.sandbox, true);
  assert.equal(right.focusCount, 1); assert.equal(left.visible, true);
  assert.equal((await f.call('screenshot-claim', right)).ok, true); assert.equal(left.visible, false);
  assert.equal((await f.call('screenshot-claim', left)).ok, false);
  await f.call('screenshot-cancel', right); assert.deepEqual(await pending, { ok: true, cancelled: true });
  assert.equal(f.owner.focusCount, 1); assert.equal(left.destroyed, true); assert.equal(right.destroyed, true);
});
test('copy finishes exactly once and frees old overlays; concurrent start does not create duplicates', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  const pending = f.call('screenshot-start'); await f.ready();
  assert.equal((await f.call('screenshot-start')).ok, false); assert.equal(f.windows.length, 3);
  const overlay = f.windows[1]; await f.call('screenshot-claim', overlay);
  assert.deepEqual(await f.call('screenshot-finish', overlay, { action: 'copy', dataUrl: png() }), { ok: true });
  assert.deepEqual(await pending, { ok: true, action: 'copy' }); assert.equal(f.clips.length, 1);
  assert.equal((await f.call('screenshot-data', overlay)).ok, false);
  const next = f.call('screenshot-start'); await f.ready(); await f.call('screenshot-cancel', f.windows[3]); await next;
});
test('save cancel and write failure retain editing; selected PNG path is only written after success', async t => {
  let cancel = true, fail = true;
  const options = { dialog: () => ({ canceled: cancel, filePath: 'chosen-image.png' }), get writeFailure() { return fail; } };
  const f = fixture(options); t.after(() => f.service.dispose());
  const pending = f.call('screenshot-start'); await f.ready(); const overlay = f.windows[1];
  await f.call('screenshot-claim', overlay);
  assert.deepEqual(await f.call('screenshot-finish', overlay, { action: 'save', dataUrl: png() }), { ok: false, cancelled: true });
  assert.equal(overlay.destroyed, false); assert.equal(f.writes.length, 0);
  cancel = false;
  assert.equal((await f.call('screenshot-finish', overlay, { action: 'save', dataUrl: png() })).ok, false);
  assert.equal(overlay.destroyed, false); fail = false;
  assert.deepEqual(await f.call('screenshot-finish', overlay, { action: 'save', dataUrl: png() }), { ok: true });
  assert.deepEqual(await pending, { ok: true, action: 'save' }); assert.equal(f.writes[0][0], 'chosen-image.png');
});
test('owner closure, display changes and renderer crash cancel all capture windows and permit retry', async t => {
  for (const trigger of ['owner', 'display-removed', 'display-metrics-changed', 'renderer']) {
    const f = fixture(); t.after(() => f.service.dispose());
    const pending = f.call('screenshot-start'); await f.ready();
    if (trigger === 'owner') f.owner.destroy();
    else if (trigger === 'renderer') f.windows[1].webContents.emit('render-process-gone');
    else f.screen.emit(trigger);
    const result = await pending;
    assert.equal(result.ok === false || result.cancelled, true);
    assert.ok(f.windows.slice(1).every(win => win.destroyed));
  }
});
test('missing display source and load failure return actionable errors without leaving overlays', async t => {
  for (const options of [{ capture: async () => [] }, { loadFailure: true }]) {
    const f = fixture(options); t.after(() => f.service.dispose());
    const result = await f.call('screenshot-start');
    assert.equal(result.ok, false); assert.ok(result.error); assert.ok(f.windows.slice(1).every(win => win.destroyed));
  }
});
test('a pending capture cannot open overlays after its owner closes', async t => {
  let release;
  const f = fixture({ capture: () => new Promise(resolve => { release = resolve; }) }); t.after(() => f.service.dispose());
  const pending = f.call('screenshot-start'); await f.ready(); f.owner.destroy();
  assert.deepEqual(await pending, { ok: true, cancelled: true });
  release([]); await f.ready(); assert.equal(f.windows.length, 1);
});
test('invalid completion and clipboard failure preserve the same editable capture for retry', async t => {
  const options = { clipFailure: true }, f = fixture(options); t.after(() => f.service.dispose());
  const pending = f.call('screenshot-start'); await f.ready(); const overlay = f.windows[1];
  assert.equal((await f.call('screenshot-finish', f.owner, { action: 'copy', dataUrl: png() })).ok, false);
  assert.equal((await f.call('screenshot-finish', overlay, { action: 'copy', dataUrl: png() })).ok, false);
  await f.call('screenshot-claim', overlay);
  for (const data of [{ action: 'upload', dataUrl: png() }, { action: 'copy', dataUrl: png(5000, 4000) },
    { action: 'copy', dataUrl: 'data:image/png;base64,AAAA' }]) {
    assert.equal((await f.call('screenshot-finish', overlay, data)).ok, false);
    assert.equal(overlay.destroyed, false);
  }
  assert.equal((await f.call('screenshot-finish', overlay, { action: 'copy', dataUrl: png() })).ok, false);
  assert.equal(overlay.destroyed, false); options.clipFailure = false;
  assert.equal((await f.call('screenshot-finish', overlay, { action: 'copy', dataUrl: png() })).ok, true);
  assert.deepEqual(await pending, { ok: true, action: 'copy' });
});
test('completion ignores late native save answers after cancellation and blocks double save', async t => {
  let release;
  const f = fixture({ dialog: () => new Promise(resolve => { release = resolve; }) }); t.after(() => f.service.dispose());
  const pending = f.call('screenshot-start'); await f.ready(); const overlay = f.windows[1];
  await f.call('screenshot-claim', overlay);
  const saving = f.call('screenshot-finish', overlay, { action: 'save', dataUrl: png() });
  assert.equal((await f.call('screenshot-finish', overlay, { action: 'save', dataUrl: png() })).ok, false);
  await f.call('screenshot-cancel', overlay); assert.equal((await pending).cancelled, true);
  release({ canceled: false, filePath: 'late-answer.png' });
  assert.deepEqual(await saving, { ok: false, cancelled: true }); assert.equal(f.writes.length, 0);
});
test('screen capture timeout cannot later display stale pixels or retain capture lock', async t => {
  let release;
  const f = fixture({ timeoutMs: 10, capture: () => new Promise(resolve => { release = resolve; }) });
  t.after(() => f.service.dispose());
  const pending = f.call('screenshot-start');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.match((await pending).error, /超时/); assert.equal(f.windows.length, 1);
  release([]); await f.ready(); assert.equal(f.windows.length, 1);
});
test('owner navigation cancels capture while the editor cannot navigate or open child windows', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  const pending = f.call('screenshot-start'); await f.ready(); const overlay = f.windows[1];
  let prevented = 0;
  overlay.webContents.emit('will-navigate', { preventDefault() { prevented++; } });
  overlay.webContents.emit('will-attach-webview', { preventDefault() { prevented++; } });
  assert.equal(prevented, 2); assert.deepEqual(overlay.webContents.openHandler(), { action: 'deny' });
  f.owner.webContents.emit('did-start-navigation', {}, 'https://example.com', false, false);
  assert.equal(overlay.destroyed, false);
  f.owner.webContents.emit('did-start-navigation', {}, 'https://example.com', false, true);
  assert.deepEqual(await pending, { ok: true, cancelled: true });
  assert.equal(f.screen.listenerCount('display-added'), 0);
  assert.equal(f.owner.listenerCount('closed'), 0);
});
test('no overlay is shown until every screen has decoded and painted its frozen image', async t => {
  const f = fixture({ manualReady: true }); t.after(() => f.service.dispose());
  const pending = f.call('screenshot-start'); await f.ready(); const [left, right] = f.windows.slice(1);
  assert.equal(left.visible, false); assert.equal(right.visible, false);
  assert.equal((await f.call('screenshot-ready', f.owner)).ok, false);
  assert.equal((await f.call('screenshot-data', left)).width, 1920);
  await f.call('screenshot-ready', left); await f.ready();
  assert.equal(left.visible, false); assert.equal(right.visible, false);
  await f.call('screenshot-ready', right); await f.ready();
  assert.equal(left.visible, true); assert.equal(right.visible, true);
  await f.call('screenshot-ready', right); assert.equal(right.focusCount, 1);
  await f.call('screenshot-cancel', right); assert.equal((await pending).cancelled, true);
});
test('an editor that fails to become ready times out without ever covering the desktop', async t => {
  const f = fixture({ manualReady: true, timeoutMs: 10 }); t.after(() => f.service.dispose());
  const pending = f.call('screenshot-start'); await new Promise(resolve => setTimeout(resolve, 30));
  assert.match((await pending).error, /超时/);
  assert.ok(f.windows.slice(1).every(win => win.destroyed && !win.visible));
});
test('screens at the same physical resolution share one acquisition, and each source keeps its actual returned pixel size', async t => {
  const displays = [
    { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
    { id: 2, bounds: { x: 1920, y: 0, width: 960, height: 540 }, scaleFactor: 2 }
  ];
  const f = fixture({ displays }); t.after(() => f.service.dispose());
  const pending = f.call('screenshot-start'); await f.ready();
  assert.equal(f.captures.length, 1);
  const data = await f.call('screenshot-data', f.windows[2]);
  assert.equal(data.width, 1920); assert.equal(data.scaleFactor, 2); assert.equal(data.bounds.width, 960);
  await f.call('screenshot-cancel', f.windows[1]); await pending;
});
test('Electron 44 async PNG clipboard completion is awaited before closing the editor', async t => {
  let release;
  const f = fixture({ modernClipboard: true, asyncClipboard: () => new Promise(resolve => { release = resolve; }) });
  t.after(() => f.service.dispose());
  const pending = f.call('screenshot-start'); await f.ready(); const overlay = f.windows[1];
  await f.call('screenshot-claim', overlay);
  const copying = f.call('screenshot-finish', overlay, { action: 'copy', dataUrl: png() });
  await f.ready(); assert.equal(overlay.destroyed, false); assert.equal(f.clips.length, 0);
  assert.equal(typeof release, 'function'); release();
  assert.deepEqual(await copying, { ok: true }); assert.deepEqual(await pending, { ok: true, action: 'copy' });
  assert.equal(f.clips.length, 1); assert.deepEqual(Object.keys(f.clips[0].data), ['image/png']);
  assert.equal(f.clips[0].data['image/png'].type, 'image/png');
});
test('Electron 44 rejected clipboard write preserves annotations and permits another attempt', async t => {
  const options = { modernClipboard: true, clipFailure: true }, f = fixture(options); t.after(() => f.service.dispose());
  const pending = f.call('screenshot-start'); await f.ready(); const overlay = f.windows[1]; await f.call('screenshot-claim', overlay);
  assert.equal((await f.call('screenshot-finish', overlay, { action: 'copy', dataUrl: png() })).ok, false);
  assert.equal(overlay.destroyed, false); options.clipFailure = false;
  assert.deepEqual(await f.call('screenshot-finish', overlay, { action: 'copy', dataUrl: png() }), { ok: true });
  await pending;
});
