'use strict';

// Real Electron relaunch with controlled open-file delivery and cleanup delay.
// This does not simulate macOS Finder itself or start a model/Hub/user profile.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const electron = require('electron');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

if (typeof electron === 'string') {
  (async () => {
    const output = path.resolve(process.argv[2] || '../outputs/native-file-quit-relaunch');
    fs.mkdirSync(output, { recursive: true });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-native-file-quit-'));
    fs.writeFileSync(path.join(root, 'probe.json'), JSON.stringify({ nativeFileQuit: true }));
    const log = fs.openSync(path.join(output, 'probe.log'), 'w');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
    const original = spawn(electron, [__filename, '--native-file-probe-root', root,
      '--soduwork-open-file', path.join(root, 'earlier.txt')],
    { env, windowsHide: true, stdio: ['ignore', log, log] });
    let launchError;
    original.once('error', error => { launchError = error; });
    async function waitFor(name) {
      const filename = path.join(root, name + '.json'), started = Date.now();
      while (!fs.existsSync(filename)) {
        if (launchError) throw launchError;
        if (Date.now() - started > 20000) throw Error('Timed out waiting for ' + name);
        await delay(40);
      }
      return JSON.parse(fs.readFileSync(filename, 'utf8'));
    }
    try {
      await waitFor('stopping');
      const a = path.join(root, '材料 & first.txt'), b = path.join(root, 'second.txt');
      fs.writeFileSync(path.join(root, 'requests.pending'), JSON.stringify([a, b, a]));
      fs.renameSync(path.join(root, 'requests.pending'), path.join(root, 'requests.json'));
      const restarted = await waitFor('restarted');
      await waitFor('finished');
      const events = fs.readFileSync(path.join(root, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.notEqual(restarted.pid, original.pid);
      assert.deepEqual(restarted.files, [a, b]);
      assert.equal(events.filter(row => row.event === 'open-file').length, 3);
      assert.equal(events.filter(row => row.event === 'relaunch').length, 1);
      assert.ok(!events.some(row => row.event === 'exiting-workspace'));
      const report = { ok: true, nativeElectron: true, syntheticCleanup: true,
        syntheticNativeFileEvents: true, root, files: restarted.files, events };
      fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ ok: true, files: restarted.files.length, output }));
    } finally {
      if (original.exitCode === null) original.kill();
      fs.closeSync(log);
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { app, BrowserWindow } = electron;
  const root = process.argv[process.argv.indexOf('--native-file-probe-root') + 1];
  if (!root || !fs.existsSync(path.join(root, 'probe.json'))) throw Error('Missing isolated native-file probe root');
  app.setPath('userData', path.join(root, 'profile'));
  const files = require('../main/file-open.cjs');
  const record = event => fs.appendFileSync(path.join(root, 'events.jsonl'), JSON.stringify({ event, pid: process.pid }) + '\n');
  const write = (name, data) => fs.writeFileSync(path.join(root, name + '.json'), JSON.stringify(data));
  const watchdog = setTimeout(() => app.exit(2), 15000); watchdog.unref();
  if (!app.requestSingleInstanceLock(files.instanceData(process.argv, process.cwd(), false))) app.quit();
  else if (fs.existsSync(path.join(root, 'stopping.json'))) {
    app.whenReady().then(async () => {
      const win = new BrowserWindow({ show: false });
      await win.loadURL('data:text/html,<title>Native file restart</title>');
      write('restarted', { pid: process.pid, files: files.commandFiles(process.argv, process.cwd(), false) });
      app.once('quit', () => write('finished', { pid: process.pid })); app.quit();
    }).catch(error => { console.error(error); app.exit(2); });
  } else {
    const state = require('../main/quit-relaunch.cjs').create(app);
    files.create({ app, ipcMain: { handle() {} }, getWorkspace: () => null,
      revealWorkspace: () => record('exiting-workspace'), identityOf: async () => null, ownerOf: () => '',
      deferLaunch: requested => state.deferLaunch(requested) });
    const relaunch = app.relaunch.bind(app);
    app.relaunch = options => { record('relaunch'); return relaunch(options); };
    const poll = setInterval(() => {
      const filename = path.join(root, 'requests.json');
      if (!fs.existsSync(filename)) return;
      clearInterval(poll);
      for (const file of JSON.parse(fs.readFileSync(filename, 'utf8'))) {
        record('open-file'); app.emit('open-file', { preventDefault() {} }, file);
      }
    }, 40);
    poll.unref();
    let cleanupReady = false, timer;
    app.on('before-quit', event => {
      if (cleanupReady) return;
      event.preventDefault();
      if (!timer) {
        write('stopping', { pid: process.pid });
        timer = setTimeout(() => { cleanupReady = true; app.quit(); }, 2500);
      }
    });
    app.whenReady().then(async () => {
      const win = new BrowserWindow({ show: false });
      await win.loadURL('data:text/html,<title>Native file shutdown</title>');
      state.markQuitting(); app.quit();
    }).catch(error => { console.error(error); app.exit(2); });
  }
}
