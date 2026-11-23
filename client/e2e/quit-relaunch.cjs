'use strict';

// Real Electron single-instance handoff and app.relaunch with isolated profiles.
// Cleanup delay is synthetic: no model, Hub or user application is started/stopped.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const electron = require('electron');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

if (typeof electron === 'string') {
  (async () => {
    const output = path.resolve(process.argv[2] || '../outputs/quit-relaunch');
    fs.mkdirSync(output, { recursive: true });
    const results = [];
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
    async function waitFor(file, timeout = 20000) {
      const started = Date.now();
      while (!fs.existsSync(file)) {
        if (Date.now() - started > timeout) throw Error('Timed out waiting for ' + path.basename(file));
        await delay(40);
      }
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    for (const scenario of ['plain', 'file', 'multiple']) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-quit-e2e-'));
      fs.writeFileSync(path.join(root, 'scenario.json'), JSON.stringify({ scenario }));
      const logs = fs.openSync(path.join(output, scenario + '.log'), 'w');
      // Explicitly select no file for a plain launch; the probe's own root path
      // must not be treated as an OS file-open argument by the source launcher.
      const launch = files => spawn(electron, [__filename, '--quit-probe-root', root,
        '--soduwork-open-file', files[0] || '--quit-probe-no-file'],
      { env, windowsHide: true, stdio: ['ignore', logs, logs] });
      const original = launch([path.join(root, 'old.txt')]);
      try {
        await waitFor(path.join(root, 'stopping.json'));
        const a = path.join(root, '材料 & report.txt'), b = path.join(root, 'second.txt');
        const requests = scenario === 'plain' ? [[]] : scenario === 'file' ? [[a]] : [[a], [b], [a]];
        const launchers = requests.map(launch);
        await Promise.all(launchers.map(child => new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', code => code === 0 ? resolve() : reject(Error('launcher exit ' + code)));
        })));
        const restarted = await waitFor(path.join(root, 'restarted.json'));
        await waitFor(path.join(root, 'finished.json'));
        assert.notEqual(restarted.pid, original.pid);
        const expected = scenario === 'plain' ? [] : scenario === 'file' ? [a] : [a, b];
        assert.deepEqual([...restarted.files].sort(), expected.sort());
        const events = fs.readFileSync(path.join(root, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
        assert.equal(events.filter(e => e.event === 'relaunch').length, 1);
        assert.equal(events.filter(e => e.event === 'second-instance').length, requests.length);
        assert.ok(!events.some(e => e.event === 'open-workspace' || e.event === 'enqueue-exiting'));
        results.push({ scenario, ok: true, root, events, files: restarted.files });
      } finally {
        // Only this probe's initial child; its relaunch has its own bounded exit timer.
        if (original.exitCode === null) original.kill();
        fs.closeSync(logs);
      }
    }
    const report = { ok: true, nativeElectron: true, syntheticCleanup: true, results };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: true, checks: results.map(r => r.scenario), output }));
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { app, BrowserWindow } = electron;
  const root = process.argv[process.argv.indexOf('--quit-probe-root') + 1];
  if (!root || !fs.existsSync(path.join(root, 'scenario.json'))) throw Error('Missing isolated probe root');
  app.setPath('userData', path.join(root, 'profile'));
  const files = require('../main/file-open.cjs');
  const record = event => fs.appendFileSync(path.join(root, 'events.jsonl'), JSON.stringify({ event, pid: process.pid }) + '\n');
  const write = (name, value) => fs.writeFileSync(path.join(root, name + '.json'), JSON.stringify(value));
  const watchdog = setTimeout(() => app.exit(2), 15000);
  watchdog.unref();
  const locked = app.requestSingleInstanceLock(files.instanceData(process.argv, process.cwd(), false));
  if (!locked) app.quit();
  else if (fs.existsSync(path.join(root, 'stopping.json'))) {
    app.whenReady().then(async () => {
      const win = new BrowserWindow({ show: false });
      await win.loadURL('data:text/html,<title>Quit handoff probe</title>');
      write('restarted', { pid: process.pid, files: files.commandFiles(process.argv, process.cwd(), false) });
      app.once('quit', () => write('finished', { pid: process.pid }));
      app.quit();
    });
  } else {
    const state = require('../main/quit-relaunch.cjs').create(app);
    const relaunch = app.relaunch.bind(app);
    app.relaunch = options => { record('relaunch'); return relaunch(options); };
    app.on('second-instance', () => record('second-instance'));
    const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
    const handler = source.slice(source.indexOf("  app.on('second-instance'"), source.indexOf('  _fileOpen.fromCommand'));
    require('node:vm').runInNewContext(handler, { app, _quitRelaunch: state, _fileOpenModule: files,
      _firstChatLinks: require('../main/first-chat-links.cjs'),
      _linuxStartup: { focusRecovery: () => false },
      _fileOpen: { enqueue: () => { record('enqueue-exiting'); return 0; } },
      openDeskWindow: () => record('open-workspace'), console });
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
      await win.loadURL('data:text/html,<title>Quitting probe</title>');
      state.markQuitting(); app.quit();
    });
  }
}
