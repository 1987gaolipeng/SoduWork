'use strict';
// Real Electron single-instance transport; window operations remain recording stubs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const electron = require('electron');
const PREFIX = 'soduwork-desktop-relaunch-';

function isolatedProfile(profile) {
  const root = path.dirname(path.resolve(profile || ''));
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(root).startsWith(PREFIX));
  assert.equal(path.basename(profile), 'profile');
  return root;
}

if (typeof electron !== 'string') {
  const { app } = electron;
  const profile = process.env.SODUWORK_RELAUNCH_PROFILE;
  isolatedProfile(profile);
  app.setPath('userData', profile);
  app.disableHardwareAcceleration();
  const fileOpen = require('../main/file-open.cjs');
  const locked = app.requestSingleInstanceLock(fileOpen.instanceData(process.argv, process.cwd(), app.isPackaged));
  process.send({ kind: 'lock', locked, packaged: app.isPackaged });
  if (!locked) app.quit();
  else if (process.env.SODUWORK_RELAUNCH_ROLE === 'secondary') app.exit(42);
  else {
    let state;
    const overlay = {};
    const flags = Object.freeze({ dock: false, pet: false, tray: false });
    const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
    const start = source.indexOf("  app.on('second-instance',");
    const end = source.indexOf('\n  });', start);
    assert.ok(start >= 0 && end > start, 'Production second-instance listener must be present');
    const listener = source.slice(start, end + '\n  });'.length);
    const openSettings = source.slice(source.indexOf('function openFirstChatSettings(link) {'), source.indexOf('const _workWindows'));
    require('node:vm').runInNewContext(openSettings + '\n' + listener, {
      app, process, console,
      _linuxStartup: { focusRecovery: () => false },
      _fileOpenModule: fileOpen,
      _firstChatLinks: require('../main/first-chat-links.cjs'),
      _quitRelaunch: require('../main/quit-relaunch.cjs').create(app),
      desktopStarted: true,
      _fileOpen: { enqueue: files => { state.files = files; return files.length > 0; } },
      _desktopOverlay: overlay,
      _flags: { get: () => flags, merge: () => { throw Error('Relaunch must preserve entry preferences'); } },
      openDeskWindow: (options, anchor) => state.workspaces.push({ options, anchor }),
    }, { filename: 'main.js:second-instance' });
    app.on('second-instance', () => process.send({ kind: 'relaunch', ...state, flags }));
    process.on('message', message => {
      if (message === 'stop') { app.quit(); return; }
      if (message?.kind !== 'prepare') return;
      state = { name: message.name, files: [], workspaces: [], overlayCalls: [] };
      const record = name => () => state.overlayCalls.push(name);
      overlay.window = message.name === 'missing-overlay' ? null : {
        isDestroyed: () => false, isMinimized: () => false, isVisible: () => false,
        restore: record('restore'), show: record('show'), focus: record('focus'),
      };
      overlay.emergency = message.name === 'emergency-overlay';
      overlay.createWindow = record('create');
      overlay.recoverFromEmergency = record('recover');
      process.send({ kind: 'prepared', name: message.name });
    });
    process.on('disconnect', () => app.quit());
    app.whenReady().then(() => process.send({ kind: 'ready' }));
  }
} else {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), PREFIX)));
  const profile = path.join(root, 'profile');
  const output = path.resolve(process.argv[2] || path.join(__dirname, '../../outputs/desktop-relaunch'));
  fs.mkdirSync(profile);
  const env = { ...process.env, SODUWORK_RELAUNCH_PROFILE: profile };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const children = new Set();
  const report = { ok: false, platform: process.platform, packaged: false, cases: [],
    boundary: 'Real unbundled Electron requestSingleInstanceLock/second-instance and the production listener. Isolated temporary profile, no windows or UI automation, window operations stubbed. Does not verify installed shortcuts, native foreground focus or visible window recovery.' };

  function launch(role, args = []) {
    const child = spawn(electron, [__filename, ...args], { env: { ...env, SODUWORK_RELAUNCH_ROLE: role },
      windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = '', exited = false, spawnError;
    const messages = [], waiters = [];
    // Failed spawns emit error and close, but do not emit exit.
    const done = new Promise(resolve => child.once('close', (code, signal) => {
      exited = true; children.delete(entry); resolve({ code, signal });
      for (const waiter of waiters.splice(0)) waiter.reject(Error(`${role} exited before ${waiter.kind}: ${code}\n${stderr}`));
    }));
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
    child.on('message', message => {
      const index = waiters.findIndex(waiter => waiter.kind === message.kind);
      if (index < 0) messages.push(message);
      else waiters.splice(index, 1)[0].resolve(message);
    });
    child.on('error', error => {
      spawnError = error;
      for (const waiter of waiters.splice(0)) waiter.reject(error);
    });
    const entry = { child, done, wait(kind) {
      const index = messages.findIndex(message => message.kind === kind);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      if (spawnError) return Promise.reject(spawnError);
      if (exited) return Promise.reject(Error(`${role} already exited before ${kind}\n${stderr}`));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(Error(`Timed out: ${role} ${kind}\n${stderr}`)); }, 15000);
        const waiter = { kind, resolve: value => { clearTimeout(timer); resolve(value); },
          reject: error => { clearTimeout(timer); reject(error); } };
        waiters.push(waiter);
      });
    }, async waitForExit(timeout = 15000) {
      let timer;
      try {
        return await Promise.race([done, new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error(`Timed out: ${role} exit\n${stderr}`)), timeout);
        })]);
      } finally { clearTimeout(timer); }
    } };
    children.add(entry);
    return entry;
  }

  async function stop(entry) {
    if (!children.has(entry)) return;
    try {
      if (entry.child.connected) entry.child.send('stop', error => {
        if (error && children.has(entry)) entry.child.kill();
      });
      else entry.child.kill();
      await entry.waitForExit(5000);
    } catch (error) {
      if (!children.has(entry)) return;
      entry.child.kill('SIGKILL');
      await entry.waitForExit(5000);
    }
  }

  (async () => {
    try {
      const primary = launch('primary');
      assert.deepEqual(await primary.wait('lock'), { kind: 'lock', locked: true, packaged: false });
      await primary.wait('ready');
      for (const name of ['hidden-overlay', 'missing-overlay', 'emergency-overlay']) {
        primary.child.send({ kind: 'prepare', name });
        await primary.wait('prepared');
        const secondary = launch('secondary');
        const lock = await secondary.wait('lock');
        assert.equal(lock.locked, false, 'Second launch must reach the existing Electron instance');
        assert.equal(lock.packaged, false, 'This fixture must not pretend to be an installed package');
        const result = await primary.wait('relaunch');
        report.cases.push(result);
        assert.equal((await secondary.waitForExit()).code, 0);
        assert.deepEqual(result.workspaces, [{ options: { panel: 'workspace' }, anchor: null }], name);
        assert.deepEqual(result.overlayCalls, [], 'Relaunch must not restore disabled overlay entries');
        assert.deepEqual(result.flags, { dock: false, pet: false, tray: false });
        assert.deepEqual(result.files, []);
      }
      for (const [step, view] of [['runtime', 'agents'], ['model', 'models']]) {
        primary.child.send({ kind: 'prepare', name: step });
        await primary.wait('prepared');
        const secondary = launch('secondary', ['soduwork://first-chat/' + step]);
        assert.equal((await secondary.wait('lock')).locked, false);
        const result = await primary.wait('relaunch');
        assert.equal((await secondary.waitForExit()).code, 0);
        assert.deepEqual(result.workspaces, [{ options: { panel: 'workspace', view }, anchor: null }]);
        report.cases.push(result);
      }
      report.ok = true;
    } catch (error) {
      report.error = String(error.stack || error);
      process.exitCode = 1;
    } finally {
      const stopped = await Promise.allSettled([...children].map(stop));
      const cleanupErrors = stopped.filter(result => result.status === 'rejected').map(result => String(result.reason));
      try {
        assert.equal(children.size, 0, 'Do not remove a profile while its test process is still running');
        isolatedProfile(profile);
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
      } catch (error) { cleanupErrors.push(String(error)); report.retainedProfile = profile; }
      if (cleanupErrors.length) {
        report.ok = false; report.cleanupErrors = cleanupErrors; process.exitCode = 1;
      }
      fs.mkdirSync(output, { recursive: true });
      fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ ...report, output }, null, 2));
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
