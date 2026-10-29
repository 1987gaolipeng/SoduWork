'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'main', 'desktop-overlay.cjs'), 'utf8');

function block(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, 'missing block: ' + start);
  return source.slice(from, to);
}

test('启动看门狗在导航开始时布防且不会在 loadFile 后把 ready 清零', () => {
  const createWindow = block('function createWindow()', '/* ----- Overlay IPC ----- */');
  const loading = block("mainWindow.webContents.on('did-start-loading'", "mainWindow.webContents.on('page-title-updated'");
  assert.match(loading, /startReadyWatchdog\(\)/);
  assert.ok(createWindow.indexOf("webContents.on('did-start-loading'") < createWindow.indexOf('loadRenderer()'));
  const afterLoad = createWindow.slice(createWindow.indexOf('loadRenderer()'));
  assert.doesNotMatch(afterLoad, /startReadyWatchdog\(\)/);
});

test('紧急恢复通过新导航重新产生 ready 而不是等待旧页面二次上报', () => {
  const recover = block('function recoverFromEmergency(', 'function registerEmergencyShortcut()');
  assert.match(recover, /mainWindow\.reload\(\)/);
  assert.match(recover, /_setOverlayInputIgnored\(true\)/);
  assert.doesNotMatch(recover, /startReadyWatchdog\(\)/);
  assert.doesNotMatch(recover, /setOverlayIdleInput\(\)/);
});

test('所有主覆盖窗重载都由 did-start-loading 统一管理看门狗', () => {
  const calls = source.match(/^\s*startReadyWatchdog\(\);/gm) || [];
  assert.equal(calls.length, 1);
  assert.match(source, /onIpc\('renderer-ready'[\s\S]*clearTimeout\(_readyTimer\)/);
});
