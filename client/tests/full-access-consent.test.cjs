'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { create, content } = require('../main/access-control/full-access-consent');
const locale = require('../main/native-locale.cjs');
const DATA = 'soduwork-full-access-consent:data', ANSWER = 'soduwork-full-access-consent:answer';

function fixture(options = {}) {
  let id = 0;
  const windows = [], handlers = new Map();
  class Window extends EventEmitter {
    constructor(config = {}) {
      super(); this.options = config; this.destroyed = false; this.shown = false;
      const wc = this.webContents = new EventEmitter();
      wc.id = ++id; wc.destroyed = false; wc.url = 'file:///soduwork/chat.html'; wc.mainFrame = { url: wc.url };
      wc.getURL = () => wc.url; wc.isDestroyed = () => wc.destroyed;
      wc.setWindowOpenHandler = callback => { wc.openWindow = callback; };
      wc.session = Object.assign(new EventEmitter(), {
        setPermissionRequestHandler: callback => { wc.permissionRequest = callback; },
        setPermissionCheckHandler: callback => { wc.permissionCheck = callback; },
        webRequest: { onBeforeRequest: callback => { wc.request = callback; } },
      });
      windows.push(this);
    }
    getBounds() { return { x: 200, y: 100, width: 1000, height: 700 }; }
    setBounds(bounds) { this.bounds = bounds; }
    isDestroyed() { return this.destroyed; }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = this.webContents.destroyed = true;
      this.webContents.emit('destroyed'); this.emit('closed');
    }
    show() { this.shown = true; }
    focus() { this.focused = true; }
    async loadFile(file) {
      if (options.loadFailure) throw Error('fixture load failure');
      this.webContents.url = this.webContents.mainFrame.url = pathToFileURL(file).href;
      this.webContents.emit('did-start-navigation', {}, this.webContents.url, false, true);
      this.emit('ready-to-show');
    }
  }
  const parent = new Window();
  const confirm = create({ BrowserWindow: Window, ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    screen: { getDisplayMatching: () => ({ workArea: options.area || { x: 0, y: 0, width: 1920, height: 1080 } }) },
    timeoutMs: options.timeoutMs || 1000 });
  const event = window => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  return { windows, parent, confirm, event,
    data: (window, input = event(window)) => handlers.get(DATA)(input),
    size: (window, value) => handlers.get('soduwork-full-access-consent:size')(event(window), value),
    answer: (window, value, input = event(window)) => handlers.get(ANSWER)(input, value) };
}

test('embedded consent uses native view bounds, stays above its icon through height/size changes, and revokes on source navigation', async () => {
  for (const zoom of [1, 1.25]) {
    const f = fixture({ area: { x: -1920, y: 0, width: 1920, height: 1080 } });
    const content = { x: -1100, y: 50, width: 1000, height: 700 };
    const view = { x: 580, y: 30, width: 410, height: 660 };
    const source = new EventEmitter(); source.isDestroyed = () => false; source.getURL = () => 'file:///chatbar'; source.getZoomFactor = () => zoom;
    f.parent.getContentBounds = () => content;
    f.parent.contentView = { children: [{ webContents: source, getBounds: () => view }] };
    const anchor = { left: 24 / zoom, top: 610 / zoom, width: 28 / zoom, height: 28 / zoom, screenX: -9999, screenY: -9999 };
    const pending = f.confirm(f.parent, { source, anchor }), dialog = f.windows[1];
    const check = bounds => {
      assert.ok(bounds.x >= content.x + view.x && bounds.x + bounds.width <= content.x + view.x + view.width);
      assert.ok(bounds.y >= content.y + view.y && bounds.y + bounds.height <= content.y + view.y + 610 + view.height - 660 - 12);
    };
    check(dialog.options); f.size(dialog, 530); check(dialog.bounds);
    assert.equal(dialog.bounds.y + dialog.bounds.height, content.y + view.y + 610 - 12, 'expanded details remain anchored above the icon');
    content.x += 80; f.parent.emit('move'); check(dialog.bounds);
    view.width = 260; view.height = 560; f.parent.emit('resize'); check(dialog.bounds);
    assert.ok(dialog.bounds.width <= 236, 'narrow source view bounds the confirmation width');
    f.data(dialog); source.emit('did-start-navigation', {}, 'file:///other', false, true);
    assert.equal(await pending, false); assert.equal(source.listenerCount('destroyed'), 0);
    view.height = 200;
    const noAnchor = f.confirm(f.parent, {source}), fallback = f.windows.at(-1);
    assert.ok(fallback.options.y >= content.y + view.y && fallback.options.y + fallback.options.height <= content.y + view.y + view.height, 'legacy request without an icon still fits its source view');
    f.data(fallback); f.answer(fallback,{decision:'cancel'}); assert.equal(await noAnchor,false);
  }
});

test('only the dedicated top-level confirmation renderer can grant a displayed, acknowledged request', async () => {
  const f = fixture(); const result = f.confirm(f.parent), dialog = f.windows[1];
  const data = f.data(dialog);
  const value = { requestId: data.requestId, decision: 'allow', acknowledged: true };
  assert.equal(dialog.options.modal, true); assert.equal(dialog.options.parent, f.parent);
  assert.equal(dialog.options.webPreferences.sandbox, true); assert.equal(dialog.options.webPreferences.contextIsolation, true);
  assert.equal(dialog.options.webPreferences.nodeIntegration, false); assert.equal(dialog.options.webPreferences.webviewTag, false);
  assert.notEqual(dialog.options.webPreferences.preload, path.resolve(__dirname, '../preload.js'));
  assert.equal(f.data(f.parent), null);
  assert.equal(f.answer(f.parent, value).ok, false, 'parent renderer cannot self-authorize');
  assert.equal(f.answer(dialog, value, { ...f.event(dialog), senderFrame: { url: dialog.webContents.url } }).ok, false, 'subframes cannot authorize');
  assert.equal(f.answer(dialog, value, { ...f.event(dialog), sender: { id: dialog.webContents.id } }).ok, false, 'numeric ID is insufficient');
  assert.equal(f.answer(dialog, value).ok, true); assert.equal(await result, true);
  assert.equal(dialog.isDestroyed(), true); assert.equal(f.answer(dialog, value).ok, false, 'replayed answer is rejected');
  assert.equal(f.parent.listenerCount('closed'), 0); assert.equal(f.parent.webContents.listenerCount('did-start-navigation'), 0);
});

test('missing acknowledgement, wrong request, cancellation and a response before presentation fail closed', async t => {
  for (const kind of ['unchecked', 'wrong-request', 'cancel', 'not-presented']) await t.test(kind, async () => {
    const f = fixture(), result = f.confirm(f.parent), dialog = f.windows[1];
    const data = kind === 'not-presented' ? { requestId: 'forged' } : f.data(dialog);
    f.answer(dialog, { requestId: kind === 'wrong-request' ? 'old-request' : data.requestId,
      decision: kind === 'cancel' ? 'cancel' : 'allow', acknowledged: kind !== 'unchecked' });
    assert.equal(await result, false);
  });
});

test('owner closure, main-frame navigation, reload, renderer exit and dialog failure cancel authorization', async t => {
  for (const kind of ['owner-closed', 'owner-navigation', 'dialog-closed', 'renderer-gone', 'load-event', 'reload', 'redirect', 'escape']) await t.test(kind, async () => {
    const f = fixture(), result = f.confirm(f.parent), dialog = f.windows[1]; f.data(dialog);
    const ev = { preventDefault() {} };
    if (kind === 'owner-closed') f.parent.destroy();
    if (kind === 'owner-navigation') f.parent.webContents.emit('did-start-navigation', ev, 'file:///other', false, true);
    if (kind === 'dialog-closed') dialog.destroy();
    if (kind === 'renderer-gone') dialog.webContents.emit('render-process-gone');
    if (kind === 'load-event') dialog.webContents.emit('did-fail-load');
    if (kind === 'reload') dialog.webContents.emit('did-start-navigation', ev, dialog.webContents.url, false, true);
    if (kind === 'redirect') dialog.webContents.emit('will-redirect', ev);
    if (kind === 'escape') dialog.webContents.emit('before-input-event', ev, { key: 'Escape' });
    assert.equal(await result, false); assert.equal(dialog.isDestroyed(), true);
  });
});

test('duplicate requests cancel both instead of sharing consent; independent owners remain independent', async () => {
  const f = fixture(); const first = f.confirm(f.parent), firstDialog = f.windows[1];
  const old = f.data(firstDialog);
  assert.equal(await f.confirm(f.parent), false); assert.equal(await first, false); assert.equal(f.windows.length, 2);
  const next = f.confirm(f.parent), nextDialog = f.windows[2], fresh = f.data(nextDialog);
  assert.notEqual(fresh.requestId, old.requestId);
  f.answer(nextDialog, { requestId: old.requestId, decision: 'allow', acknowledged: true });
  assert.equal(await next, false);
  const other = new f.parent.constructor();
  const a = f.confirm(f.parent), aDialog = f.windows.at(-1), b = f.confirm(other), bDialog = f.windows.at(-1);
  f.answer(aDialog, { requestId: f.data(aDialog).requestId, decision: 'allow', acknowledged: true });
  bDialog.destroy(); assert.equal(await a, true); assert.equal(await b, false);
});

test('unavailable owners, load rejection and timeout never fall back to approval', async () => {
  const f = fixture({ timeoutMs: 20 });
  assert.equal(await f.confirm(null), false); f.parent.destroy(); assert.equal(await f.confirm(f.parent), false);
  const timed = fixture({ timeoutMs: 20 });
  assert.equal(await timed.confirm(timed.parent), false); assert.equal(timed.windows[1].isDestroyed(), true);
  const failed = fixture({ loadFailure: true });
  assert.equal(await failed.confirm(failed.parent), false);
});

test('isolated confirmation denies permissions, network, arbitrary local files, downloads and extra windows', async () => {
  const f = fixture({ area: { x: 0, y: 0, width: 340, height: 430 } });
  const result = f.confirm(f.parent), dialog = f.windows[1], wc = dialog.webContents;
  assert.ok(dialog.options.width <= 340); assert.ok(dialog.options.height <= 430);
  assert.equal(wc.permissionCheck(), false); let permitted = true; wc.permissionRequest(null, 'media', value => { permitted = value; }); assert.equal(permitted, false);
  let cancelled = false;
  wc.request({ url: wc.url }, value => { cancelled = value.cancel; }); assert.equal(cancelled, false);
  for (const url of ['https://example.com', 'file:///private.txt', wc.url + '?other=1']) {
    wc.request({ url }, value => { cancelled = value.cancel; }); assert.equal(cancelled, true);
  }
  let prevented = false; wc.session.emit('will-download', { preventDefault() { prevented = true; } }); assert.equal(prevented, true);
  assert.deepEqual(wc.openWindow({ url: 'https://example.com' }), { action: 'deny' }); assert.equal(await result, false);
});

test('confirmation content is localized through the native source dictionary', t => {
  t.after(() => locale.setLocale('zh-CN'));
  locale.setLocale('zh-CN'); const chinese = content(); assert.equal(chinese.title, '允许完全访问？'); assert.equal(chinese.lang, 'zh-CN');
  locale.setLocale('en-US'); const english = content(); assert.equal(english.lang, 'en-US'); assert.equal(english.cancel, 'Cancel');
  for (const [key, value] of Object.entries(english)) assert.ok(!/[\u3400-\u9fff]/.test(value), 'English translation missing: ' + key);
});
