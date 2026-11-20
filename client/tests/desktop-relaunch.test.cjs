'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { create: createWorkspaceState } = require('../main/workspace-state.cjs');

const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8').replace(/\r\n/g, '\n');
function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, 'the production entry point must remain available');
  return source.slice(start, end);
}
const windowsSource = section('function revealWorkWindow(win) {', 'function _appIcon() {');
const relaunchSource = section("  app.on('second-instance',", '\n\n  _fileOpen.fromCommand');

function fixture({ platform = 'win32', workspace = 'minimized', overlay = 'normal', recovery = false, files = [] } = {}) {
  const created = [], calls = [], errors = [], timers = new Set();
  const preferences = { dock: false, pet: false, tray: false };
  const workWindows = new Map();
  const navigation = createWorkspaceState({ ownerOf: () => 'test-owner' });
  navigation.set('skills');

  class Window extends EventEmitter {
    constructor(options = {}) {
      super();
      this.options = options;
      this.visible = options.show === true;
      this.minimized = false;
      this.destroyed = false;
      this.focused = false;
      this.sent = [];
      this.webContents = new EventEmitter();
      this.webContents.send = (...args) => this.sent.push(args);
      created.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return this.minimized; }
    isMaximized() { return false; }
    isFullScreen() { return false; }
    restore() { this.minimized = false; this.emit('restore'); }
    show() { this.visible = true; }
    focus() { this.focused = true; }
    setMenuBarVisibility() {}
    setTitle() {}
    loadFile(file, options) { this.loaded = { file, options }; }
  }
  const original = workspace === 'missing' ? null : new Window();
  if (original) {
    original.minimized = workspace === 'minimized';
    original.destroyed = workspace === 'destroyed';
    workWindows.set('workspace', original);
  }
  created.length = 0;
  const overlayWindow = {
    isDestroyed: () => false, isMinimized: () => false, isVisible: () => true,
    show: () => calls.push('overlay.show'), focus: () => calls.push('overlay.focus'),
  };
  let secondInstance;
  const context = {
    __dirname: path.join(__dirname, '..'), path,
    process: { platform },
    console: { error: (...args) => errors.push(args) },
    app: { isPackaged: true, on(name, callback) {
      assert.equal(name, 'second-instance'); secondInstance = callback;
    } },
    _quitRelaunch: { deferLaunch: () => false },
    BrowserWindow: Window,
    _workWindows: workWindows,
    _WORK_SPEC: require('../main/window-specs'),
    _workspaceState: navigation,
    _workspaceTitlebar: { windowOptions: () => ({}), attach() {} },
    _geom: { get: () => null, restore: () => null,
      initial: () => ({ x: 20, y: 20, width: 1200, height: 800 }),
      limits: () => ({ minWidth: 800, minHeight: 540 }), remember() {} },
    rendererRoot: () => path.join(__dirname, '..'),
    _appIcon: () => null,
    attachWorkWindowRecovery() {},
    _flags: { all: () => ({ ...preferences }), merge(value) {
      calls.push('preferences.merge'); Object.assign(preferences, value);
    } },
    _desktopOverlay: {
      window: overlay === 'missing' ? null : overlayWindow,
      emergency: overlay === 'emergency',
      notifyBlur: () => calls.push('overlay.blur'),
      setWorkspaceMaximized() {},
      createWindow: () => calls.push('overlay.create'),
      recoverFromEmergency: () => calls.push('overlay.recover'),
    },
    _linuxStartup: { focusRecovery: () => { calls.push('recovery.check'); return recovery; } },
    _fileOpenModule: { instanceFiles: (...args) => { calls.push(['files.parse', ...args]); return files; } },
    _fileOpen: { enqueue(value) { calls.push(['files.enqueue', value]); return value.length > 0; } },
    setTimeout(callback) { timers.add(callback); return callback; },
    clearTimeout(callback) { timers.delete(callback); },
  };
  vm.runInNewContext(windowsSource + '\n' + relaunchSource, context);
  const argv = ['SoduWork.exe'], additionalData = { files };
  return { created, calls, errors, preferences, workWindows, original, navigation, timers,
    launch() { secondInstance({}, argv, 'test-working-directory', additionalData); },
    assertFileArguments() {
      assert.deepEqual(calls.find(row => row[0] === 'files.parse'),
        ['files.parse', argv, 'test-working-directory', true, additionalData]);
    },
  };
}

for (const platform of ['win32', 'darwin', 'linux']) {
  for (const workspace of ['minimized', 'hidden', 'destroyed', 'missing']) {
    test(`${platform} relaunch restores a ${workspace} workspace with every desktop entry disabled`, () => {
      for (const overlay of ['normal', 'missing', 'emergency']) {
        const f = fixture({ platform, workspace, overlay });
        f.launch();
        assert.deepEqual(f.errors, [], overlay);
        const win = f.workWindows.get('workspace');
        assert.ok(win && !win.isDestroyed(), `${overlay}: a live workspace must exist`);
        if (workspace === 'destroyed' || workspace === 'missing') {
          assert.notEqual(win, f.original, `${overlay}: replace the closed workspace`);
          assert.equal(f.created.length, 1);
          assert.equal(path.basename(win.loaded.file), 'desk.html');
          assert.equal(win.loaded.options.query.view, 'skills', 'reopening retains the last page');
          assert.equal(win.visible, false, 'a new renderer waits for readiness');
          win._deskContentReady = true;
          win.emit('ready-to-show');
        } else {
          assert.equal(win, f.original, 'relaunch reuses the existing workspace');
          assert.equal(f.created.length, 0);
          assert.equal(win.focused, true, `${overlay}: an existing workspace receives focus`);
          assert.deepEqual(win.sent, [], 'relaunch must not navigate away from the current page');
        }
        assert.equal(win.minimized, false, overlay);
        assert.equal(win.visible, true, overlay);
        assert.equal(f.navigation.get(), 'skills');
        assert.equal(f.timers.size, 0);
        assert.deepEqual(f.preferences, { dock: false, pet: false, tray: false });
        assert.ok(!f.calls.includes('preferences.merge'), 'relaunch does not override saved visibility');
        f.assertFileArguments();
      }
    });
  }

  test(`${platform} file-open relaunch keeps file delivery ahead of ordinary workspace activation`, () => {
    const files = ['example.soduwork-plugin'];
    const f = fixture({ platform, files, overlay: 'missing' });
    f.launch();
    f.assertFileArguments();
    assert.deepEqual(f.calls.find(row => row[0] === 'files.enqueue'), ['files.enqueue', files]);
    assert.equal(f.created.length, 0);
    assert.equal(f.original.minimized, true);
    assert.equal(f.original.visible, false);
    assert.ok(!f.calls.includes('overlay.create'));
    assert.deepEqual(f.errors, []);
  });
}

test('Linux startup recovery retains priority over file delivery and workspace activation', () => {
  const f = fixture({ platform: 'linux', recovery: true, files: ['example.soduwork-plugin'] });
  f.launch();
  assert.deepEqual(f.calls, ['recovery.check']);
  assert.equal(f.created.length, 0);
  assert.equal(f.original.minimized, true);
  assert.equal(f.original.visible, false);
  assert.deepEqual(f.errors, []);
});
