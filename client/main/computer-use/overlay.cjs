'use strict';
const path = require('node:path');
const nativeTheme = require('../native-theme.cjs');
const locale = require('../native-locale.cjs');

function create({ BrowserWindow, screen, ipcMain, globalShortcut, onCancel, testOptions = {} }) {
  const windows = new Map();
  let active = false, stopping = false, parent = null, timer = null, shortcut = false, generation = 0;
  function state(display, point, targetId) {
    const b = display.bounds;
    const contains = point.x >= b.x && point.x < b.x + b.width && point.y >= b.y && point.y < b.y + b.height;
    return { primary: display.id === targetId, locale: locale.getLocale(), stopping,
      theme: nativeTheme.snapshot(parent),
      label: locale.translate(stopping ? '正在停止电脑操作…' : 'SoduWork 正在操作电脑'),
      cancelLabel: locale.translate('取消操作'), cursor: contains ? { x: point.x - b.x, y: point.y - b.y } : null };
  }
  function publish() {
    if (!active) return;
    const point = screen.getCursorScreenPoint(), display = screen.getDisplayNearestPoint(point);
    for (const row of windows.values()) {
      if (!row.ready || row.window.isDestroyed()) continue;
      const value = state(row.display, point, display.id), key = JSON.stringify(value);
      if (row.last === key) continue;
      row.last = key; row.window.webContents.send('computer-overlay-state', value);
    }
  }
  function ready(event) {
    const row = [...windows.values()].find(item => item.window.webContents === event.sender);
    if (!row || row.window.isDestroyed() || event.senderFrame !== event.sender.mainFrame) return;
    row.ready = true; publish();
    if (testOptions.show !== false) row.window.showInactive();
    row.resolve?.(); row.resolve = null;
  }
  ipcMain.on('computer-overlay-ready', ready);
  function rebuild() {
    const displays = screen.getAllDisplays(), ids = new Set(displays.map(d => d.id));
    for (const [id, row] of windows) if (!ids.has(id)) { row.intentionalClose = true; row.window.destroy(); windows.delete(id); }
    const pending = [];
    for (const display of displays) {
      const existing = windows.get(display.id);
      if (existing) { existing.display = display; existing.window.setBounds(display.bounds); continue; }
      const window = new BrowserWindow({ ...display.bounds, show: false, transparent: true, frame: false,
        backgroundColor: '#00000000', focusable: false, skipTaskbar: true, resizable: false, movable: false,
        ...(process.platform === 'win32' ? { type: 'toolbar' } : {}),
        hasShadow: false, fullscreenable: false, enableLargerThanScreen: true,
        webPreferences: { preload: path.join(__dirname, 'overlay-preload.cjs'), contextIsolation: true,
          nodeIntegration: false, sandbox: true, backgroundThrottling: false, ...testOptions.webPreferences } });
      // Windows clamps constructor bounds to workArea (excluding the taskbar).
      // Set the actual display bounds after HWND creation, including at high DPI.
      window.setBounds(display.bounds);
      window.setIgnoreMouseEvents(true);
      window.setAlwaysOnTop(true, 'screen-saver');
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      window.setContentProtection(true);
      const row = { window, display, ready: false, last: '' };
      windows.set(display.id, row);
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => { event.preventDefault(); if (active) onCancel(); });
      const initialized = new Promise((resolve, reject) => {
        row.resolve = resolve;
        window.webContents.once('did-fail-load', (_e, code) => reject(Error('Computer overlay failed: ' + code)));
        window.webContents.once('render-process-gone', () => { reject(Error('Computer overlay renderer stopped')); if (active) onCancel(); });
        window.once('closed', () => {
          row.resolve?.(); row.resolve = null;
          if (active && !row.intentionalClose) onCancel();
        });
      });
      pending.push(initialized);
      window.loadFile(path.join(__dirname, 'overlay.html')).catch(() => onCancel());
    }
    return Promise.all(pending);
  }
  const changed = () => { if (active) rebuild().then(publish).catch(onCancel); };
  for (const name of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(name, changed);
  function hide() {
    active = false; stopping = false; generation++;
    if (timer) clearInterval(timer); timer = null;
    if (shortcut) globalShortcut.unregister('Escape'); shortcut = false;
    for (const row of windows.values()) { row.window.destroy(); }
    windows.clear(); parent = null;
  }
  return {
    async show(owner) {
      parent = owner || parent;
      if (active) { publish(); return; }
      // Never advertise Escape unless it really owns a global cancellation key.
      shortcut = globalShortcut.register('Escape', () => { if (active && !stopping) { stopping = true; publish(); onCancel(); } });
      if (!shortcut) throw Error('Unable to register Escape for computer control');
      active = true; stopping = false; const current = ++generation;
      let timeout;
      try {
        await Promise.race([rebuild(), new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('Computer overlay did not become ready')), 5000); })]);
        if (!active || current !== generation) throw Error('Computer control was cancelled before starting');
        if ([...windows.values()].some(row => !row.ready || row.window.isDestroyed())) throw Error('Computer-control indicator was closed before starting');
        publish(); timer = setInterval(publish, 33); timer.unref?.();
      } catch (error) { hide(); throw error; }
      finally { clearTimeout(timeout); }
    },
    hide, windows: () => [...windows.values()].map(row => row.window),
    dispose() { hide(); ipcMain.removeListener('computer-overlay-ready', ready); for (const name of ['display-added', 'display-removed', 'display-metrics-changed']) screen.removeListener(name, changed); },
  };
}
module.exports = { create };
