'use strict';

const { createTrustedWindow } = require('./app-menu-info.cjs');
const hasWebsite = Boolean(require('../package.json').homepage);
const fs = require('node:fs');
const path = require('node:path');
const { translate } = require('./native-locale.cjs');
const { DEFAULT_SHORTCUTS, normalizeCombo, bindingError } = require('../core/shortcut-bindings.js');
const HEIGHT = 34;
const COMMANDS = new Set(['new', 'sidebar', 'history', 'website', 'about', 'quit']);
const MENU_SHORTCUTS = { new: 'new-chat', sidebar: 'toggle-sidebar', about: 'open-about' };

function shortcutState(raw, platform) {
  if (!raw || typeof raw.recording !== 'boolean' || !raw.bindings || typeof raw.bindings !== 'object' || Array.isArray(raw.bindings)) throw new Error('Invalid window shortcuts state');
  const known = new Set(DEFAULT_SHORTCUTS.map(row => row.id)), bindings = {};
  for (const [id, value] of Object.entries(raw.bindings)) {
    if (!known.has(id) || typeof value !== 'string' || value.length > 100) throw new Error('Invalid window shortcut binding');
    const combo = normalizeCombo(value);
    if ((value.trim() && !combo) || bindingError(combo, platform === 'darwin' ? 'mac' : 'win')) throw new Error('Invalid window shortcut binding');
    bindings[id] = combo;
  }
  return { bindings, recording: raw.recording };
}

function supportsTitlebar(root) {
  try {
    if (typeof root !== 'string' || !path.isAbsolute(root)) return false;
    const html = fs.readFileSync(path.join(root, 'desk.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    if (!/<script\b[^>]*\bsrc\s*=\s*["'](?:\.\/)?components\/workspace\/window-menu\.js(?:[?#][^"']*)?["'][^>]*>/i.test(html) ||
        !/<link\b[^>]*\bhref\s*=\s*["'](?:\.\/)?components\/workspace\/window-menu\.css(?:[?#][^"']*)?["'][^>]*>/i.test(html)) return false;
    const js = fs.readFileSync(path.join(root, 'components/workspace/window-menu.js'), 'utf8');
    const css = fs.readFileSync(path.join(root, 'components/workspace/window-menu.css'), 'utf8');
    return js.includes('getWindowTitlebar') && js.includes('onWindowMenuCommand') && /-webkit-app-region\s*:\s*drag\b/.test(css);
  } catch (_) { return false; }
}

function solidColor(value) {
  if (typeof value !== 'string' || value.length > 80) return null;
  const text = value.trim();
  if (/^#[\da-f]{6}$/i.test(text)) return text.toLowerCase();
  if (/^#[\da-f]{3}$/i.test(text)) return '#' + [...text.slice(1)].map(c => c + c).join('').toLowerCase();
  const match = /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})(?:\s*[,/]\s*(1(?:\.0+)?))?\s*\)$/i.exec(text);
  if (!match || match.slice(1, 4).some(n => Number(n) > 255)) return null;
  return '#' + match.slice(1, 4).map(n => Number(n).toString(16).padStart(2, '0')).join('');
}
function luminance(hex) {
  const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
}
function overlayTheme(raw) {
  const color = solidColor(raw?.backgroundColor), ink = solidColor(raw?.symbolColor);
  if (!color || !ink) throw new Error('Titlebar theme requires two opaque colors');
  const bg = luminance(color), fg = luminance(ink);
  const contrast = (Math.max(bg, fg) + .05) / (Math.min(bg, fg) + .05);
  const symbolColor = contrast >= 4.5 ? ink : bg > .179 ? '#000000' : '#ffffff';
  return { color, symbolColor, height: HEIGHT };
}

function create({ app, ipcMain, BrowserWindow, Menu, getRendererRoot, getWorkspace, fallbackCommand, platform = process.platform }) {
  const trustedWindow = createTrustedWindow({ app, BrowserWindow, getRendererRoot });
  const records = new WeakMap();
  let lastWindow = null, menuInstalled = false;
  const mode = platform === 'darwin' ? 'hidden-inset' : ['win32', 'linux'].includes(platform) ? 'overlay' : 'native';

  function windowOptions(root = getRendererRoot?.() || app.getAppPath()) {
    if (!supportsTitlebar(root)) return {};
    if (mode === 'hidden-inset') return { titleBarStyle: 'hiddenInset', titleBarOverlay: true, trafficLightPosition: { x: 12, y: 10 } };
    if (mode === 'overlay') return { titleBarStyle: 'hidden', titleBarOverlay: { color: '#f3f6fb', symbolColor: '#242427', height: HEIGHT } };
    return {};
  }
  function registered(win) { return win && !win.isDestroyed() && records.has(win); }
  function isTrusted(win) {
    if (!registered(win)) return false;
    const wc = win.webContents;
    return trustedWindow({ sender: wc, senderFrame: wc.mainFrame }) === win;
  }
  function target() {
    const focused = BrowserWindow.getFocusedWindow();
    return registered(focused) ? focused : registered(lastWindow) ? lastWindow : null;
  }
  function send(win, command) {
    if (!COMMANDS.has(command) || !isTrusted(win)) return false;
    const row = records.get(win);
    if (!row.contentReady) return false;
    if (!row.listenerReady) {
      if (row.mode !== 'native' || !fallbackCommand) return false;
      Promise.resolve().then(() => fallbackCommand(command, win)).catch(error => console.error('[window-menu]', error));
      return true;
    }
    win.webContents.send('window-menu-command', command);
    return true;
  }
  function dispatch(command, requestedWindow) {
    if (!COMMANDS.has(command)) return false;
    const win = requestedWindow || target() || getWorkspace?.();
    if (!registered(win)) return false;
    if (win.isMinimized()) win.restore();
    win.show(); win.focus();
    if (send(win, command)) return true;
    const row = records.get(win);
    // Keep startup commands local to this window; never send them to a preview.
    const url = win.webContents.getURL();
    const initialDocument = !row.everReady && (!url || url === 'about:blank');
    if ((!row.contentReady || !row.listenerReady) && (isTrusted(win) || initialDocument) && row.pending.length < 16) { row.pending.push(command); return true; }
    return false;
  }
  function accelerator(row, command) {
    if (row?.recording) return undefined;
    const id = MENU_SHORTCUTS[command];
    const combo = id ? row?.bindings?.[id] ?? DEFAULT_SHORTCUTS.find(item => item.id === id)?.binding : command === 'quit' ? 'Ctrl+Q' : '';
    return combo ? combo.split('+').map(key => key === 'Ctrl' ? platform === 'darwin' ? 'Command' : 'Control' : key.replace(/^Arrow/, '')).join('+') : undefined;
  }
  function menuRows(win, name) {
    const row = records.get(win), state = row?.state || {};
    const item = (label, command, extra = {}) => ({ label: translate(label), accelerator: accelerator(row, command), ...extra, click: () => dispatch(command, win) });
    if (name === 'file') return [item('新对话', 'new'), item('退出 SoduWork', 'quit')];
    if (name === 'view') return [item(state.sidebarHidden ? '显示侧栏' : '隐藏侧栏', 'sidebar', { enabled: state.sidebarAvailable === true })];
    return [item('版本历史', 'history'), item('官网', 'website', { enabled: hasWebsite }), item('关于 SoduWork', 'about')];
  }
  function refreshMenu() {
    if (platform !== 'darwin') {
      const win = target();
      if (win && records.get(win)?.mode === 'native') setFallbackMenu(win);
      return;
    }
    if (!menuInstalled) return;
    const row = records.get(target()) || {}, state = row.state || {};
    const item = (label, command, extra = {}) => ({ label: translate(label), accelerator: accelerator(row, command), ...extra, click: () => dispatch(command) });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'SoduWork', submenu: [item('关于 SoduWork', 'about'), { type: 'separator' }, { role: 'services' },
        { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' }, item('退出 SoduWork', 'quit')] },
      { label: translate('文件'), submenu: [item('新对话', 'new'), { type: 'separator' }, { role: 'close' }] },
      { role: 'editMenu' },
      { label: translate('视图'), submenu: [item(state.sidebarHidden ? '显示侧栏' : '隐藏侧栏', 'sidebar',
        { enabled: state.sidebarAvailable === true })] },
      { label: translate('帮助'), role: 'help', submenu: [item('版本历史', 'history'), item('官网', 'website', { enabled: hasWebsite }), item('关于 SoduWork', 'about', { accelerator: undefined })] },
    ]));
  }
  function installMenu() { if (platform === 'darwin') { menuInstalled = true; refreshMenu(); } }
  function setFallbackMenu(win) {
    win.setMenu(Menu.buildFromTemplate([
      { label: translate('文件'), submenu: menuRows(win, 'file') },
      { label: translate('视图'), submenu: menuRows(win, 'view') },
      { label: translate('帮助'), submenu: menuRows(win, 'help') },
    ]));
    win.setMenuBarVisibility(true);
  }
  function attach(win, options = windowOptions()) {
    if (records.has(win)) return;
    const actualMode = options.titleBarStyle === 'hiddenInset' ? 'hidden-inset' : options.titleBarStyle === 'hidden' ? 'overlay' : 'native';
    const row = { mode: actualMode, listenerReady: false, contentReady: false, everReady: false,
      pending: [], bindings: {}, recording: false, state: { sidebarAvailable: false, sidebarHidden: false } };
    records.set(win, row);
    if (platform !== 'darwin' && actualMode === 'native') setFallbackMenu(win);
    win.on('focus', () => { lastWindow = win; refreshMenu(); });
    win.webContents.on('did-start-loading', () => {
      if (row.everReady) row.pending = [];
      row.listenerReady = false; row.contentReady = false;
      row.recording = false; win.webContents.setIgnoreMenuShortcuts?.(false);
      row.state = { sidebarAvailable: false, sidebarHidden: false };
      refreshMenu();
    });
    win.on('closed', () => { row.pending = []; records.delete(win); if (lastWindow === win) lastWindow = null; refreshMenu(); });
  }
  function requireOwner(event) {
    const win = trustedWindow(event);
    if (!win) throw new Error('Titlebar is only available in the SoduWork window');
    return win;
  }
  ipcMain.handle('window-titlebar-info', event => {
    const row = records.get(requireOwner(event));
    return { platform, mode: row?.mode || 'native', height: HEIGHT, nativeMenu: Boolean(row && (platform === 'darwin' || row.mode === 'native')) };
  });
  ipcMain.handle('window-titlebar-theme', (event, theme) => {
    const win = requireOwner(event), row = records.get(win);
    if (!row) throw new Error('This window has no managed titlebar');
    const normalized = overlayTheme(theme);
    if (row.mode !== 'overlay') return { ok: true, applied: false };
    win.setTitleBarOverlay(normalized);
    return { ok: true, applied: true };
  });
  ipcMain.handle('window-menu-state', (event, state) => {
    const row = records.get(requireOwner(event));
    if (!row) throw new Error('This window has no application menu');
    if (typeof state?.sidebarAvailable !== 'boolean' || typeof state?.sidebarHidden !== 'boolean') throw new Error('Invalid window menu state');
    if (row.state.sidebarAvailable !== state.sidebarAvailable || row.state.sidebarHidden !== state.sidebarHidden) {
      row.state = { sidebarAvailable: state.sidebarAvailable, sidebarHidden: state.sidebarHidden };
      refreshMenu();
    }
    return { ok: true };
  });
  ipcMain.handle('window-shortcuts-state', (event, state) => {
    const win = requireOwner(event), row = records.get(win);
    if (!row) throw new Error('This window has no application menu');
    const normalized = shortcutState(state, platform);
    row.bindings = normalized.bindings; row.recording = normalized.recording;
    win.webContents.setIgnoreMenuShortcuts?.(row.recording);
    if (platform !== 'darwin' && row.mode === 'native') setFallbackMenu(win);
    else refreshMenu();
    return { ok: true };
  });
  ipcMain.handle('window-menu-open', (event, name) => {
    const win = requireOwner(event), row = records.get(win);
    if (!row) throw new Error('This window has no application menu');
    if (!['file', 'view', 'help'].includes(name)) throw new Error('Invalid window menu');
    if (!row.contentReady || row.recording) return { ok: false };
    Menu.buildFromTemplate(menuRows(win, name)).popup({ window: win });
    return { ok: true };
  });
  function ready(event, kind) {
    const win = trustedWindow(event), row = win && records.get(win);
    if (!row) return;
    row[kind] = true; row.everReady = true;
    if (!row.contentReady || (!row.listenerReady && row.mode !== 'native')) return;
    const commands = row.pending.splice(0);
    for (const command of commands) send(win, command);
  }
  ipcMain.on('window-menu-ready', event => ready(event, 'listenerReady'));
  ipcMain.on('desk-content-ready', event => ready(event, 'contentReady'));
  return { windowOptions, attach, installMenu, refreshMenu };
}

module.exports = { create, overlayTheme, supportsTitlebar, HEIGHT };
