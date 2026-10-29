'use strict';
// Full source main.js/desk.html in a deliberately offline debug process.
// Uses a fresh profile and disables login registration and the Python Runner.
const electron = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const output = path.resolve(__dirname, '../../outputs/client-debug-20261013');
fs.mkdirSync(output, { recursive: true });
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE', 'NODE_USE_SYSTEM_CA', 'CHROME_DEVEL_SANDBOX']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)], {
    // This is the interactive source debug client. SW_HIDE suppresses its first
    // native workspace ShowWindow even after Electron reports startup ready.
    env, windowsHide: false, stdio: 'inherit',
  });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, session, globalShortcut, shell } = electron;
  const client = path.resolve(__dirname, '..');
  const root = fs.mkdtempSync(path.join(output, 'debug-profile-'));
  const profile = path.join(root, 'profile'), home = path.join(root, 'home'), workspace = path.join(root, 'workspace');
  for (const dir of [profile, home, workspace]) fs.mkdirSync(dir, { recursive: true });
  process.env.SODUWORK_USER_DATA = profile;
  app.setPath('userData', profile);
  if (path.resolve(app.getPath('userData')) !== profile) throw Error('Debug profile isolation failed');
  app.setPath('documents', workspace);
  app.setName('SoduWork Debug');
  const setAppUserModelId = app.setAppUserModelId.bind(app);
  app.setAppUserModelId = () => setAppUserModelId('com.soduwork.local-debug');
  app.getAppPath = () => client;
  os.homedir = () => home;
  require('node:module').syncBuiltinESMExports();
  fs.writeFileSync(path.join(profile, 'autostart-initialized'), '1');
  fs.writeFileSync(path.join(profile, 'chat-config.json'), JSON.stringify({ workDir: workspace }));
  const report = { scope: 'Full source desktop, offline isolated debug profile', pid: process.pid,
    profile, workspace, isolation: { freshProfile: true, externalNetworkingDisabled: true,
      subprocessesDisabled: true, externalOpenersDisabled: true },
    loginSettingsCalls: 0, runnerDisabled: true, runnerConfigureAttempts: 0,
    blockedNodeConnections: 0, blockedSubprocesses: {}, blockedExternalOpeners: 0,
    blockedNetwork: {}, nativeMouseForwarding: [],
    windows: [], loadedPages: [], errors: [], mainLoopLagMaxMs: 0, steadyLoopLagMaxMs: 0 };
  const reportPath = path.join(output, 'debug-workspace.json');
  const started = performance.now();
  function save() {
    report.durationMs = Math.round(performance.now() - started);
    report.windows = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed()).map(w => ({
      id: w.id, page: path.basename(w.webContents.getURL().split('?')[0]), visible: w.isVisible(),
      chromeReady: !!w._deskChromeReady, contentReady: !!w._deskContentReady, shown: !!w._deskShown,
    }));
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  }
  const block = raw => {
    let origin = 'unknown'; try { origin = new URL(String(raw?.url || raw)).origin; } catch (_) {}
    report.blockedNetwork[origin] = (report.blockedNetwork[origin] || 0) + 1;
  };
  globalThis.fetch = async input => { block(input); throw Error('Offline debug profile: no connected test backend'); };
  require('node:net').Socket.prototype.connect = function () {
    report.blockedNodeConnections++; throw Error('Node connections disabled in offline debug mode');
  };
  const subprocess = require('node:child_process');
  for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    subprocess[key] = () => {
      report.blockedSubprocesses[key] = (report.blockedSubprocesses[key] || 0) + 1;
      throw Error('Subprocesses disabled in offline debug mode');
    };
  }
  for (const key of ['openExternal', 'openPath', 'showItemInFolder']) {
    shell[key] = () => { report.blockedExternalOpeners++; throw Error('External openers disabled in offline debug mode'); };
  }
  require('node:module').syncBuiltinESMExports();
  // A failed enrollment still persists a fresh device identity and the renderer
  // may configure Runner with it. Its Python networking bypasses JS/Chromium
  // network hooks, so it must be disabled explicitly before main.js installs it.
  require('../main/runner-runtime').install = ({ ipcMain }) => {
    const disabled = () => ({ ok: false, running: false, pid: 0, capabilityGrants: [],
      error: 'Runner disabled in isolated offline debug mode' });
    ipcMain.handle('runner-configure', () => { report.runnerConfigureAttempts++; return disabled(); });
    for (const channel of ['runner-status', 'runner-capability-set', 'runner-component-confirm']) {
      ipcMain.handle(channel, disabled);
    }
  };
  // Each registration belongs to this process; no installed application's
  // global shortcut or login registration is queried or changed.
  app.setLoginItemSettings = () => { report.loginSettingsCalls++; };
  globalShortcut.register = () => false;
  const ignore = BrowserWindow.prototype.setIgnoreMouseEvents;
  BrowserWindow.prototype.setIgnoreMouseEvents = function (ignored, options) {
    report.nativeMouseForwarding.push({ windowId: this.id, ignored: !!ignored, forward: !!options?.forward });
    return ignore.call(this, ignored, options);
  };
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  app.commandLine.appendSwitch('remote-debugging-port', '0');
  function isolateSession(value) {
    value.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
      block(details.url); callback({ cancel: true });
    });
  }
  app.on('session-created', isolateSession);
  app.whenReady().then(() => isolateSession(session.defaultSession));
  app.on('browser-window-created', (_event, win) => {
    win.on('page-title-updated', event => { event.preventDefault(); win.setTitle('SoduWork - LOCAL DEBUG'); });
    win.webContents.on('render-process-gone', (_event, info) => report.errors.push({ kind: 'renderer-exit', reason: info.reason }));
    win.webContents.on('unresponsive', () => report.errors.push({ kind: 'unresponsive', windowId: win.id }));
    win.webContents.on('did-finish-load', async () => {
      win.setTitle('SoduWork - LOCAL DEBUG');
      try {
        const state = await win.webContents.executeJavaScript('({ready:document.readyState, shell:!!document.querySelector(".workspace-shell")})');
        report.loadedPages.push({ page: path.basename(win.webContents.getURL().split('?')[0]), ...state });
      } catch (error) { report.errors.push({ kind: 'startup-inspection', message: error.message }); }
      save();
    });
  });
  let previous = performance.now();
  const heartbeat = setInterval(() => {
    const current = performance.now(), lag = Math.max(0, current - previous - 100);
    report.mainLoopLagMaxMs = Math.max(report.mainLoopLagMaxMs, lag);
    if (previous - started >= 10000) report.steadyLoopLagMaxMs = Math.max(report.steadyLoopLagMaxMs, lag);
    previous = current;
  }, 100);
  const checkpoint = setInterval(save, 2000);
  // A bounded run also cleans up the overlay and this process's local services.
  const durationArg = process.argv.find(arg => arg.startsWith('--duration-ms='));
  const duration = durationArg ? Number(durationArg.split('=')[1]) : 90000;
  if (!Number.isFinite(duration) || duration < 10000 || duration > 3600000) throw Error('Invalid debug duration');
  const finish = setTimeout(() => app.quit(), duration);
  app.on('before-quit', () => {
    clearInterval(heartbeat); clearInterval(checkpoint); clearTimeout(finish); report.stopped = true; save();
  });
  app.on('quit', (_event, code) => {
    report.exitCode = code;
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  });
  require('../main.js');
  app.whenReady().then(() => { report.ready = true; save(); });
}
