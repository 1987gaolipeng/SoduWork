'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function bridgeHarness() {
  const ipcRenderer = new EventEmitter();
  const sent = [];
  const replies = [];
  ipcRenderer.send = (...args) => sent.push(args);
  ipcRenderer.invoke = () => new Promise(resolve => replies.push(resolve));
  let bridge;
  const electron = { ipcRenderer, webUtils: {}, contextBridge: {
    exposeInMainWorld(name, value) { if (name === 'soduWorkAPI') bridge = value; },
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8'), {
    require(name) { assert.equal(name, 'electron'); return electron; }, console, process,
  });
  return { bridge, ipcRenderer, sent, replies };
}

test('preload acknowledges the latest blur revision and stale events or query replies cannot roll it back', async () => {
  const h = bridgeHarness();
  const rects = [{ x: 100, y: 100, width: 60, height: 180 }];
  h.bridge.setOverlayShape(rects);
  assert.equal(h.sent.at(-1)[2], 0, 'first report stays compatible with revision zero');
  const pendingQuery = h.bridge.getOverlayShape();
  h.bridge.onOverlayWindowBlur(() => h.bridge.setOverlayShape(rects));
  h.ipcRenderer.emit('overlay-window-blur', {}, 2);
  assert.equal(h.sent.at(-1)[2], 2, 'acknowledge before invoking renderer callback');
  h.replies.shift()({ revision: 1, supported: true, awaitingShape: true });
  await pendingQuery;
  h.ipcRenderer.emit('overlay-window-blur', {}, 1);
  h.ipcRenderer.emit('overlay-window-blur', {}, -1);
  h.ipcRenderer.emit('overlay-window-blur', {}, '3');
  h.bridge.setOverlayShape(rects);
  assert.equal(h.sent.at(-1)[2], 2, 'older or malformed revisions never replace the current revision');
  const reloadedQuery = h.bridge.getOverlayShape();
  h.replies.shift()({ revision: 5, supported: true, awaitingShape: true });
  await reloadedQuery;
  h.bridge.setOverlayShape(rects);
  assert.equal(h.sent.at(-1)[2], 5, 'query bootstraps a freshly loaded renderer');
});

test('blur before DOMContentLoaded is retained and replayed when the renderer consumer binds', async () => {
  const h = bridgeHarness();
  const rects = [{ x: 100, y: 100, width: 60, height: 180 }];
  const firstQuery = h.bridge.getOverlayShape();
  h.replies.shift()({ revision: 0, supported: true });
  await firstQuery;
  h.bridge.setOverlayShape(rects);
  h.ipcRenderer.emit('overlay-window-blur', {}, 1);
  let callbacks = 0;
  h.bridge.onOverlayWindowBlur(() => { callbacks++; h.bridge.setOverlayShape(rects); });
  assert.equal(callbacks, 1, 'binding consumes the blur that arrived after query but before DOM ready');
  assert.equal(h.sent.at(-1)[2], 1);
  h.ipcRenderer.emit('overlay-window-blur', {}, 2);
  assert.equal(callbacks, 2, 'subsequent live blur still has one callback');
  assert.equal(h.sent.at(-1)[2], 2);
});

test('querying a pending revision does not swallow its subsequent blur event', async () => {
  const h = bridgeHarness();
  const query = h.bridge.getOverlayShape();
  h.replies.shift()({ revision: 3, supported: true, awaitingShape: true });
  await query;
  let callbacks = 0;
  h.bridge.onOverlayWindowBlur(() => { callbacks++; });
  h.ipcRenderer.emit('overlay-window-blur', {}, 3);
  h.ipcRenderer.emit('overlay-window-blur', {}, 3);
  assert.equal(callbacks, 1, 'the current blur must dismiss panels exactly once even when its query arrived first');
});
