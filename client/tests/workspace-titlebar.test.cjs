'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
test.beforeEach(() => require('../main/native-locale.cjs').setLocale('zh-CN'));
const { create, overlayTheme, supportsTitlebar } = require('../main/workspace-titlebar.cjs');

function fixture(platform = 'win32') {
  const root = path.resolve(__dirname, '..'), handlers = new Map(), owners = new Map(), menus = [], fallback = [], popups = [];
  const ipcMain = new EventEmitter(); ipcMain.handle = (name, fn) => handlers.set(name, fn);
  let focused = null, created = 0, manager;
  function owner(file = pathToFileURL(path.join(root, 'desk.html')).href, managed = true, options) {
    const wc = Object.assign(new EventEmitter(), { url: file, mainFrame: { url: file }, sent: [], getURL() { return this.url; },
      isDestroyed: () => false, send(...args) { this.sent.push(args); }, setIgnoreMenuShortcuts(value) { this.ignoreMenuShortcuts = value; } });
    const win = Object.assign(new EventEmitter(), { webContents: wc, destroyed: false, themes: [],
      isDestroyed() { return this.destroyed; }, isMinimized: () => false, show() {},
      focus() { focused = this; this.emit('focus'); }, setTitleBarOverlay(theme) { this.themes.push(theme); },
      setMenu(value) { this.menu = value; }, setMenuBarVisibility(value) { this.menuVisible = value; } });
    owners.set(wc, win);
    if (managed) manager.attach(win, options);
    return { win, event: { sender: wc, senderFrame: wc.mainFrame } };
  }
  manager = create({ platform, app: { getAppPath: () => root }, ipcMain,
    BrowserWindow: { fromWebContents: wc => owners.get(wc), getFocusedWindow: () => focused },
    Menu: { buildFromTemplate: rows => Object.assign(rows, { popup: options => popups.push({ rows, options }) }), setApplicationMenu: menu => menus.push(menu) },
    getWorkspace: () => { created++; return owner('about:blank').win; },
    fallbackCommand: (command, win) => { fallback.push({ command, win }); },
  });
  function ready(requester) { ipcMain.emit('window-menu-ready', requester.event); ipcMain.emit('desk-content-ready', requester.event); }
  function menuItem(label) {
    const items = menus.at(-1).flatMap(row => row.submenu || []);
    return items.find(row => row.label === label);
  }
  return { manager, owner, handlers, ipcMain, ready, menus, menuItem, fallback, popups,
    created: () => created, focused: () => focused };
}

test('each supported platform keeps native controls and exposes the mode actually registered for that window', () => {
  for (const platform of ['win32', 'linux', 'darwin', 'freebsd']) {
    const f = fixture(platform), current = f.owner(), options = f.manager.windowOptions();
    const info = f.handlers.get('window-titlebar-info')(current.event);
    assert.equal(info.platform, platform); assert.equal(info.height, 34);
    if (platform === 'darwin') {
      assert.equal(options.titleBarStyle, 'hiddenInset'); assert.equal(options.titleBarOverlay, true);
      assert.deepEqual(options.trafficLightPosition, { x: 12, y: 10 });
      assert.equal(info.mode, 'hidden-inset'); assert.equal(info.nativeMenu, true);
    } else if (platform === 'freebsd') {
      assert.deepEqual(options, {}); assert.equal(info.mode, 'native');
    } else {
      assert.equal(options.titleBarStyle, 'hidden'); assert.equal(options.titleBarOverlay.height, 34);
      assert.equal(info.mode, 'overlay'); assert.equal(info.nativeMenu, false);
    }
    const unregistered = f.owner(undefined, false);
    assert.equal(f.handlers.get('window-titlebar-info')(unregistered.event).mode, 'native');
    assert.equal(f.handlers.get('window-titlebar-info')(unregistered.event).nativeMenu, false);
  }
});

test('titlebar support requires the actual renderer HTML, current module and draggable stylesheet together', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-titlebar-capability-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, 'components/workspace'); fs.mkdirSync(assets, { recursive: true });
  const html = '<link rel="stylesheet" href="components/workspace/window-menu.css"><script src="components/workspace/window-menu.js"></script>';
  fs.writeFileSync(path.join(root, 'desk.html'), html);
  assert.equal(supportsTitlebar(root), false);
  fs.writeFileSync(path.join(assets, 'window-menu.js'), 'getWindowTitlebar(); onWindowMenuCommand();');
  fs.writeFileSync(path.join(assets, 'window-menu.css'), '.window-menu{-webkit-app-region:drag}');
  assert.equal(supportsTitlebar(root), true);
  fs.writeFileSync(path.join(root, 'desk.html'), '<!--' + html + '-->');
  assert.equal(supportsTitlebar(root), false);
  fs.writeFileSync(path.join(root, 'desk.html'), html);
  fs.writeFileSync(path.join(assets, 'window-menu.js'), '/* old body menu without native titlebar protocol */');
  assert.equal(supportsTitlebar(root), false);
  fs.writeFileSync(path.join(assets, 'window-menu.js'), 'getWindowTitlebar(); onWindowMenuCommand();');
  fs.writeFileSync(path.join(assets, 'window-menu.css'), '.window-menu{height:34px}');
  assert.equal(supportsTitlebar(root), false);
  for (const platform of ['win32', 'linux', 'darwin']) {
    const f = fixture(platform), options = f.manager.windowOptions(root), current = f.owner(undefined, true, options);
    assert.deepEqual(options, {});
    assert.equal(f.handlers.get('window-titlebar-info')(current.event).mode, 'native');
    if (platform !== 'darwin') assert.equal(current.win.menuVisible, true);
  }
});

test('attach records the exact options used at construction even if renderer availability later changes', () => {
  const f = fixture(), options = f.manager.windowOptions(path.resolve(__dirname, 'absent-old-renderer'));
  const current = f.owner(undefined, true, options);
  assert.equal(f.manager.windowOptions(path.resolve(__dirname, '..')).titleBarStyle, 'hidden');
  assert.equal(f.handlers.get('window-titlebar-info')(current.event).mode, 'native');
  assert.equal(f.handlers.get('window-titlebar-info')(current.event).nativeMenu, true);
});

test('titlebar theme accepts only opaque literal colors, enforces contrast, and never accepts renderer heights', () => {
  assert.deepEqual(overlayTheme({ backgroundColor: 'rgb(16, 32, 48)', symbolColor: '#eee', height: 999 }),
    { color: '#102030', symbolColor: '#eeeeee', height: 34 });
  assert.deepEqual(overlayTheme({ backgroundColor: 'rgba(255, 255, 255, 1)', symbolColor: '#fff' }),
    { color: '#ffffff', symbolColor: '#000000', height: 34 });
  assert.equal(overlayTheme({ backgroundColor: '#000000', symbolColor: '#000000' }).symbolColor, '#ffffff');
  for (const bad of ['transparent', 'rgba(0,0,0,.5)', 'rgb(300,0,0)', 'url(file:///x)', '#ffffff00', '#fff;display:none', 'var(--ink)']) {
    assert.throws(() => overlayTheme({ backgroundColor: bad, symbolColor: '#fff' }), /opaque colors/);
  }
  const f = fixture(), current = f.owner(), other = f.owner();
  assert.deepEqual(f.handlers.get('window-titlebar-theme')(current.event, { backgroundColor: '#fff', symbolColor: '#333' }), { ok: true, applied: true });
  assert.equal(current.win.themes.length, 1); assert.equal(other.win.themes.length, 0);
  const mac = fixture('darwin'), macWin = mac.owner();
  assert.deepEqual(mac.handlers.get('window-titlebar-theme')(macWin.event, { backgroundColor: '#fff', symbolColor: '#333' }), { ok: true, applied: false });
  assert.equal(macWin.win.themes.length, 0);
});

test('foreign URLs, frames, destroyed and unregistered windows cannot change native controls or menu state', () => {
  const f = fixture(), valid = f.owner();
  const invalid = [f.owner('https://example.com/desk.html').event,
    f.owner(pathToFileURL(path.resolve(__dirname, 'desk.html')).href).event,
    { ...valid.event, senderFrame: { url: valid.event.senderFrame.url } }];
  const dead = f.owner(); dead.win.destroyed = true; invalid.push(dead.event);
  for (const event of invalid) {
    assert.throws(() => f.handlers.get('window-titlebar-info')(event), /only available/);
    assert.throws(() => f.handlers.get('window-titlebar-theme')(event, { backgroundColor: '#fff', symbolColor: '#333' }), /only available/);
    assert.throws(() => f.handlers.get('window-menu-state')(event, { sidebarAvailable: true, sidebarHidden: false }), /only available/);
    assert.doesNotThrow(() => f.ipcMain.emit('window-menu-ready', event));
  }
  assert.throws(() => f.handlers.get('window-titlebar-theme')(f.owner(undefined, false).event, {}), /no managed titlebar/);
  assert.throws(() => f.handlers.get('window-menu-state')(valid.event, { sidebarAvailable: 'yes' }), /Invalid/);
  assert.deepEqual(valid.win.themes, []);
});

test('macOS application menu emits exactly one command per accelerator and reflects only the focused sidebar', () => {
  const f = fixture('darwin'), first = f.owner(), second = f.owner();
  f.manager.installMenu(); first.win.focus(); f.ready(first); f.ready(second);
  const commands = [['新对话', 'new', 'Command+N'], ['版本历史', 'history'], ['官网', 'website'], ['关于 SoduWork', 'about'], ['退出 SoduWork', 'quit', 'Command+Q']];
  for (const [label, command, shortcut] of commands) {
    const item = f.menuItem(label); assert.ok(item);
    if (shortcut) assert.equal(item.accelerator, shortcut);
    item.click();
    assert.deepEqual(first.win.webContents.sent.at(-1), ['window-menu-command', command]);
  }
  assert.equal(first.win.webContents.sent.length, commands.length);
  assert.equal(second.win.webContents.sent.length, 0);
  assert.equal(f.menuItem('隐藏侧栏').enabled, false);
  f.handlers.get('window-menu-state')(first.event, { sidebarAvailable: true, sidebarHidden: false });
  assert.equal(f.menuItem('隐藏侧栏').enabled, true); assert.equal(f.menuItem('隐藏侧栏').accelerator, 'Command+B');
  f.menuItem('隐藏侧栏').click();
  assert.deepEqual(first.win.webContents.sent.at(-1), ['window-menu-command', 'sidebar']);
  f.handlers.get('window-menu-state')(first.event, { sidebarAvailable: true, sidebarHidden: true });
  assert.equal(f.menuItem('显示侧栏').enabled, true);
  second.win.focus(); assert.equal(f.menuItem('隐藏侧栏').enabled, false);
});

test('native menu opens a desk when none exists and retains startup commands only until its trusted listener is ready', () => {
  const f = fixture('darwin'); f.manager.installMenu();
  f.menuItem('新对话').click();
  assert.equal(f.created(), 1);
  const win = f.focused(), wc = win.webContents;
  assert.deepEqual(wc.sent, []);
  wc.url = wc.mainFrame.url = pathToFileURL(path.resolve(__dirname, '../desk.html')).href;
  wc.emit('did-start-loading');
  f.ready({ event: { sender: wc, senderFrame: wc.mainFrame } });
  assert.deepEqual(wc.sent, [['window-menu-command', 'new']]);
  f.ready({ event: { sender: wc, senderFrame: wc.mainFrame } });
  assert.equal(wc.sent.length, 1);
});

test('cold-start native commands wait for both menu subscription and business readiness in either order', () => {
  for (const order of [['window-menu-ready', 'desk-content-ready'], ['desk-content-ready', 'window-menu-ready']]) {
    const f = fixture('darwin'), current = f.owner(); f.manager.installMenu(); current.win.focus();
    f.menuItem('新对话').click();
    f.ipcMain.emit(order[0], current.event);
    assert.deepEqual(current.win.webContents.sent, []);
    f.ipcMain.emit(order[1], current.event);
    assert.deepEqual(current.win.webContents.sent, [['window-menu-command', 'new']]);
  }
});

test('old renderer keeps native menus and uses trusted fallback without requiring the new listener', async () => {
  for (const platform of ['darwin', 'win32']) {
    const f = fixture(platform), current = f.owner(undefined, true, {});
    f.manager.installMenu(); current.win.focus();
    const item = platform === 'darwin' ? f.menuItem('新对话') : current.win.menu[0].submenu[0];
    item.click(); assert.equal(f.fallback.length, 0);
    f.ipcMain.emit('desk-content-ready', current.event);
    await Promise.resolve();
    assert.deepEqual(f.fallback, [{ command: 'new', win: current.win }]);
    assert.deepEqual(current.win.webContents.sent, []);
    assert.equal(f.created(), 0);
  }
});

test('a native-framed Windows window can load the new renderer without losing View or registering duplicate shortcuts', async () => {
  const f = fixture('win32'), current = f.owner(undefined, true, {});
  current.win.focus();
  const sidebar = () => current.win.menu[1].submenu[0];
  assert.equal(sidebar().enabled, false);
  f.ready(current);
  f.handlers.get('window-menu-state')(current.event, { sidebarAvailable: true, sidebarHidden: false });
  assert.equal(sidebar().enabled, true); assert.equal(sidebar().label, '隐藏侧栏');
  sidebar().click();
  assert.deepEqual(current.win.webContents.sent, [['window-menu-command', 'sidebar']]);
  assert.equal(f.fallback.length, 0);
  f.handlers.get('window-menu-state')(current.event, { sidebarAvailable: true, sidebarHidden: true });
  assert.equal(sidebar().label, '显示侧栏');
  const info = f.handlers.get('window-titlebar-info')(current.event);
  assert.equal(info.mode, 'native'); assert.equal(info.nativeMenu, true);
  current.win.webContents.emit('did-start-loading');
  assert.equal(sidebar().enabled, false);
});

test('navigating away revokes native-menu delivery and closed windows cannot receive later commands', () => {
  const f = fixture('darwin'), current = f.owner(); f.manager.installMenu(); current.win.focus(); f.ready(current);
  current.win.webContents.emit('did-start-loading');
  current.win.webContents.url = current.win.webContents.mainFrame.url = 'https://example.com/';
  f.menuItem('新对话').click(); f.ready(current);
  assert.deepEqual(current.win.webContents.sent, []);
  current.win.webContents.url = current.win.webContents.mainFrame.url = pathToFileURL(path.resolve(__dirname, '../desk.html')).href;
  f.ready(current); assert.deepEqual(current.win.webContents.sent, []);
  current.win.destroyed = true; current.win.emit('closed');
  f.menuItem('新对话').click(); assert.equal(f.created(), 1);
  assert.deepEqual(current.win.webContents.sent, []);
});

test('Windows and Linux do not install accelerators that could duplicate renderer keyboard shortcuts', () => {
  for (const platform of ['win32', 'linux']) {
    const f = fixture(platform), win = f.owner();
    f.manager.installMenu(); win.win.focus(); f.manager.refreshMenu();
    assert.equal(f.menus.length, 0);
  }
});

test('native accelerators use current bindings, can be cleared, and pause while recording', () => {
  const f = fixture('darwin'), current = f.owner();
  f.manager.installMenu(); current.win.focus(); f.ready(current);
  const update = f.handlers.get('window-shortcuts-state');
  assert.equal(typeof update, 'function');
  update(current.event, { bindings: { 'new-chat': 'Ctrl+Alt+J', 'toggle-sidebar': 'Alt+F9', 'open-about': 'F2' }, recording: false });
  assert.equal(f.menuItem('新对话').accelerator, 'Command+Alt+J');
  assert.equal(f.menuItem('隐藏侧栏').accelerator, 'Alt+F9');
  assert.equal(f.menuItem('关于 SoduWork').accelerator, 'F2');
  update(current.event, { bindings: { 'new-chat': '' }, recording: true });
  for (const label of ['新对话', '隐藏侧栏', '关于 SoduWork', '退出 SoduWork']) assert.equal(f.menuItem(label).accelerator, undefined);
  assert.equal(current.win.webContents.ignoreMenuShortcuts, true);
  update(current.event, { bindings: { 'new-chat': '' }, recording: false });
  assert.equal(f.menuItem('新对话').accelerator, undefined);
  assert.equal(f.menuItem('退出 SoduWork').accelerator, 'Command+Q');
  assert.equal(current.win.webContents.ignoreMenuShortcuts, false);
});

test('shortcut state and menu popups remain restricted to a managed trusted window and fixed actions', () => {
  const f = fixture('win32'), current = f.owner(undefined, true, {}), other = f.owner(undefined, true, {});
  current.win.focus(); f.ready(current); f.ready(other);
  const update = f.handlers.get('window-shortcuts-state'), open = f.handlers.get('window-menu-open');
  assert.equal(typeof update, 'function'); assert.equal(typeof open, 'function');
  update(current.event, { bindings: { 'new-chat': 'Ctrl+Alt+J' }, recording: false });
  assert.equal(current.win.menu[0].submenu[0].accelerator, 'Control+Alt+J');
  assert.equal(other.win.menu[0].submenu[0].accelerator, 'Control+N');
  assert.throws(() => update(current.event, { bindings: { 'shell:execute': 'F4' }, recording: false }), /Invalid/);
  assert.throws(() => update(current.event, { bindings: { 'new-chat': 'Ctrl+NotARealKey' }, recording: false }), /Invalid/);
  assert.throws(() => update(f.owner(undefined, false).event, { bindings: {}, recording: false }), /no application menu/);
  const foreign = f.owner('https://example.com/desk.html');
  assert.throws(() => update(foreign.event, { bindings: {}, recording: false }), /only available/);
  assert.throws(() => open(foreign.event, 'file'), /only available/);
  assert.throws(() => open(current.event, 'shell'), /Invalid/);
  assert.deepEqual(open(current.event, 'file'), { ok: true });
  assert.equal(f.popups.length, 1); assert.equal(f.popups[0].options.window, current.win);
  assert.equal(f.popups[0].rows[0].label, '新对话');
  f.popups[0].rows[0].click();
  assert.deepEqual(current.win.webContents.sent.at(-1), ['window-menu-command', 'new']);
  other.win.focus();
  assert.equal(other.win.menu[0].submenu[0].accelerator, 'Control+N');
});

test('real preload subscribes before readiness, filters commands and unsubscribes only its own listener', async () => {
  const ipcRenderer = new EventEmitter(), calls = [], exposed = {};
  ipcRenderer.invoke = async (...args) => { calls.push(args); return {}; };
  ipcRenderer.send = channel => { calls.push([channel]); ipcRenderer.emit('window-menu-command', {}, 'new'); };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../preload.js'), 'utf8'), {
    require: () => ({ ipcRenderer, webUtils: {}, contextBridge: { exposeInMainWorld: (key, api) => { exposed[key] = api; } } }),
  });
  const events = [], unsubscribe = exposed.soduWorkAPI.onWindowMenuCommand(command => events.push(command));
  assert.deepEqual(events, ['new']);
  ipcRenderer.emit('window-menu-command', {}, 'shell:execute');
  ipcRenderer.emit('window-menu-command', {}, 'sidebar');
  assert.deepEqual(events, ['new', 'sidebar']); unsubscribe();
  ipcRenderer.emit('window-menu-command', {}, 'quit'); assert.equal(events.length, 2);
  await exposed.soduWorkAPI.getWindowTitlebar();
  await exposed.soduWorkAPI.setWindowTitlebarTheme({ backgroundColor: '#fff', symbolColor: '#333' });
  await exposed.soduWorkAPI.setWindowMenuState({ sidebarAvailable: true, sidebarHidden: false });
  await exposed.soduWorkAPI.setWindowShortcuts({ bindings: { 'new-chat': 'Ctrl+Alt+J' }, recording: false });
  await exposed.soduWorkAPI.openWindowMenu('file');
  assert.deepEqual(calls.map(args => args[0]), ['window-menu-ready', 'window-titlebar-info', 'window-titlebar-theme', 'window-menu-state', 'window-shortcuts-state', 'window-menu-open']);
});
