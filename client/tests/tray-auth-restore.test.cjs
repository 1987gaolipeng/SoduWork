'use strict';

// Window and tray events are simulated. Authentication and routing use the
// production modules with an isolated test cipher and synthetic Hub responses.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createSafeStorage } = require('./helpers/device-safe-storage-fixture.cjs');

test('tray reopening preserves cached authentication and renews expiry without logging in', async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-tray-auth-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const authFile = require.resolve('../main/device-auth');
  delete require.cache[authFile];
  const auth = require(authFile);
  const handlers = new Map();
  const app = { getPath: () => profile };
  auth.install({ app,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    safeStorage: createSafeStorage() });
  const hub = 'https://tray-auth.fixture.invalid';
  const requests = [];
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  t.mock.method(global, 'fetch', async (url, options) => {
    requests.push(url);
    assert.equal(url, hub + '/api/v1/clients/enroll', 'A window reopen cannot submit a login or logout');
    const { device } = JSON.parse(options.body);
    const claims = { typ: 'device', cid: device, uid: 'fixture-owner',
      iat: Math.floor(clock / 1000), exp: Math.floor(clock / 1000) + 60 };
    const session = Buffer.from(JSON.stringify(claims)).toString('base64url') + '.' + 'a'.repeat(64);
    return { ok: true, status: 200, text: async () => JSON.stringify({
      authState: 'active', activationRequired: false, session, expiresIn: 60, user: { id: claims.uid },
    }) };
  });
  const state = require('../main/workspace-state.cjs').create({ ownerOf: () => auth.localOwner(app) });
  const windows = new Map();
  class Window extends EventEmitter {
    constructor() {
      super();
      this.destroyed = false;
      this.webContents = new EventEmitter();
      this.webContents.send = () => assert.fail('A targetless tray reopen must not navigate an existing window');
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    isMaximized() { return false; }
    isFullScreen() { return false; }
    setMenuBarVisibility() {}
    loadFile(_file, options) { this.route = options.query; }
    show() {}
    focus() {}
    close() { this.destroyed = true; this.emit('closed'); }
  }
  class Tray extends EventEmitter {
    setToolTip() {}
    setContextMenu() {}
  }
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const context = {
    _desktopOverlay: {
      notifyBlur() {}, setWorkspaceMaximized() {}, show() {},
      window: { isDestroyed: () => false, isVisible: () => true, webContents: { isLoading: () => false } },
    },
    _WORK_SPEC: require('../main/window-specs'), _workspaceState: state, _workWindows: windows,
    _geom: {
      get: () => null, restore: () => null, initial: () => ({ width: 1440, height: 900 }),
      limits: () => ({}), remember() {},
    },
    _workspaceTitlebar: { windowOptions: () => ({}), attach() {} },
    rendererRoot: () => path.resolve(__dirname, '..'), BrowserWindow: Window, Tray,
    Menu: { buildFromTemplate: value => value }, nativeImage: {}, _trayMenu: () => [],
    _nativeText: value => value, _appIcon: () => undefined, attachWorkWindowRecovery() {},
    require: name => {
      assert.equal(name, './main/tray-icon.cjs');
      return { createTrayIcon: () => ({}) };
    },
    __dirname: path.resolve(__dirname, '..'), path, setTimeout, clearTimeout, console,
  };
  const routingStart = source.indexOf('function revealWorkWindow(');
  const routingEnd = source.indexOf('function _appIcon(', routingStart);
  const revealStart = source.indexOf('function revealSoduWorkSuite(');
  const revealEnd = source.indexOf('function _trayMenu(', revealStart);
  const trayStart = source.indexOf('function createTray(');
  const trayEnd = source.indexOf('// Use the single-instance lock', trayStart);
  assert.ok(routingStart >= 0 && routingEnd > routingStart && revealStart >= 0 &&
    revealEnd > revealStart && trayStart >= 0 && trayEnd > trayStart);
  vm.runInNewContext(source.slice(routingStart, routingEnd) + source.slice(revealStart, revealEnd) +
    source.slice(trayStart, trayEnd), context, { filename: 'main-window-tray.js' });
  context.createTray();
  const bootstrap = window => handlers.get('device-auth-bootstrap')({ sender: window.webContents }, { hub });

  context.tray.emit('click');
  const first = windows.get('workspace');
  const initial = await bootstrap(first);
  assert.equal(initial.ok, true);
  assert.equal(initial.user.id, 'fixture-owner');
  assert.equal(requests.length, 1);
  state.set('settings');
  first.close();
  assert.equal(first.isDestroyed(), true);
  assert.equal(windows.has('workspace'), false);
  assert.equal(auth.session(app), initial.session);

  context.tray.emit('click');
  const reopened = windows.get('workspace');
  assert.notEqual(reopened, first);
  assert.equal(reopened.route.view, 'settings');
  assert.equal(JSON.parse(reopened.route.workspaceRestore).owner, state.context().owner);
  const restored = await bootstrap(reopened);
  assert.equal(restored.session, initial.session);
  assert.equal(requests.length, 1, 'A valid cached session survives closing the renderer');
  context.tray.emit('double-click');
  assert.equal(windows.get('workspace'), reopened, 'Repeated tray recovery reuses the open window');
  assert.equal(requests.length, 1);

  clock += 61000;
  reopened.close();
  context.tray.emit('double-click');
  const renewedWindow = windows.get('workspace');
  assert.notEqual(renewedWindow, reopened);
  assert.equal(renewedWindow.route.view, 'settings');
  const renewed = await bootstrap(renewedWindow);
  assert.equal(renewed.ok, true);
  assert.notEqual(renewed.session, initial.session);
  assert.equal(renewed.user.id, restored.user.id);
  assert.equal(requests.length, 2, 'Only expiry requires another enrollment request');
  renewedWindow.close();
});
