'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' });
  const timeout = setTimeout(() => child.kill(), 45000);
  child.on('exit', code => { clearTimeout(timeout); process.exitCode = code ?? 1; });
} else {
  const { app } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { pathToFileURL } = require('node:url'), assert = require('node:assert/strict');
  const baseline = process.env.SODUWORK_WATCH_BASELINE === '1';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-watch-recovery-'));
  const watched = path.join(root, 'watched'), state = { errors: [], delivered: new Set(), watchers: new Set() };
  const report = { ok: false, baseline, versions: { electron: process.versions.electron, node: process.versions.node, uv: process.versions.uv },
    cases: [], errors: [], measurements: [], boundary: 'Real Windows Electron/fs.watch in a fresh temporary directory. No user windows, SDKs, accounts or production. Original native fs.watch is the optional failing comparison.' };
  const output = path.resolve(__dirname, '../../outputs/windows-fs-watch-recovery/' + (baseline ? 'baseline.json' : 'report.json'));
  app.setPath('userData', path.join(root, 'profile'));
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function recreateDirectory(directory) {
    // Windows can keep the deleted directory pending until its watcher closes.
    // Retry only that transient OS condition, well before any SDK restart delay.
    const deadline = performance.now() + 1000;
    for (;;) {
      try { fs.mkdirSync(directory, { recursive: true }); return; }
      catch (error) {
        if (!['EPERM', 'EACCES'].includes(error.code) || performance.now() >= deadline) throw error;
        await wait(25);
      }
    }
  }
  async function until(fn, label) {
    for (let i = 0; i < 200; i++) { if (await fn()) return; await wait(15); }
    throw Error('Timed out: ' + label);
  }
  async function sample(phase, ms = 1500) {
    const start = process.cpuUsage(), at = performance.now(); await wait(ms);
    const delta = process.cpuUsage(start);
    const row = { phase, cpuPercent: (delta.user + delta.system) / (performance.now() - at) / 10 };
    report.measurements.push(row); return row;
  }
  function remember(watcher) {
    state.watchers.add(watcher); watcher.once('close', () => state.watchers.delete(watcher)); return watcher;
  }
  app.whenReady().then(async () => {
    assert.equal(process.platform, 'win32');
    if (!baseline) assert.equal(require('../main/windows-fs-watch-guard.cjs').install(), true);
    const esm = await import('node:fs'); assert.equal(esm.watch, fs.watch);
    fs.mkdirSync(watched);
    const watcher = remember(fs.watch(watched, () => {}));
    watcher.on('error', error => state.errors.push(error.code)); watcher.unref();
    await sample('watched-existing');
    // This is the fresh empty fixture directory, never a computed user path.
    assert.equal(path.dirname(watched), root); fs.rmdirSync(watched);
    const deleted = await sample('watched-deleted');
    await recreateDirectory(watched); const replacement = await sample('same-path-recreated');
    watcher.close();
    assert.ok(deleted.cpuPercent < 20 && replacement.cpuPercent < 20,
      'deletion must not peg a core: ' + JSON.stringify([deleted, replacement]));
    assert.deepEqual(state.errors, ['ENOENT']);
    report.cases.push('Deleting/recreating a watched directory closes the old native handle and reports one recoverable error; idle CPU remains below 20% of one core.');

    let restartCount = 0, stopped = false;
    function start() {
      const next = remember(esm.watch(pathToFileURL(watched), { encoding: 'buffer', persistent: false }, (_event, file) => {
        assert.ok(file == null || Buffer.isBuffer(file));
        if (file?.toString().endsWith('.json')) state.delivered.add(file.toString());
      }));
      next.on('error', () => {
        if (stopped) return;
        restartCount++; setTimeout(() => { if (!stopped) { fs.mkdirSync(watched, { recursive: true }); start(); } }, 30);
      });
      return next;
    }
    const initial = start();
    assert.equal(initial.ref(), initial); assert.equal(initial.unref(), initial);
    fs.rmdirSync(watched); await recreateDirectory(watched);
    await until(() => restartCount === 1 && state.watchers.size === 1, 'one recovered native watcher');
    fs.writeFileSync(path.join(watched, 'result.json'), '{}');
    await until(() => state.delivered.has('result.json'), 'completion delivered after same-path replacement');
    report.cases.push('The original FSWatcher ref/unref identity, URL paths and Buffer encoding remain intact; existing error-based restart receives a completion file after a same-path replacement.');
    stopped = true; for (const item of state.watchers) item.close();
    await until(() => state.watchers.size === 0, 'callers close native watchers');

    const controller = new AbortController(), abortEvents = [];
    const aborted = remember(fs.watch(Buffer.from(watched), { recursive: true, signal: controller.signal }, (_event, file) => abortEvents.push(file)));
    aborted.on('error', error => report.errors.push(error.code));
    fs.mkdirSync(path.join(watched, 'nested')); fs.writeFileSync(path.join(watched, 'nested', 'before.txt'), 'before');
    await until(() => abortEvents.some(name => String(name).includes('before.txt')), 'recursive real file event');
    controller.abort(); await until(() => state.watchers.size === 0, 'AbortSignal closes real watcher');
    const count = abortEvents.length;
    fs.writeFileSync(path.join(watched, 'nested', 'after.txt'), 'after'); await wait(100);
    assert.equal(abortEvents.length, count);
    report.cases.push('Recursive events and Buffer input paths are preserved; AbortSignal closes the native watcher, removes the guard and prevents later events.');
    const uv = process.report.getReport().libuv.filter(handle => handle.type === 'fs_event' && handle.is_active);
    assert.equal(uv.length, 0); report.activeNativeWatchers = uv.length;
    assert.deepEqual(report.errors, []); report.ok = true;
  }).catch(error => report.errors.push(String(error.stack || error)))
    .finally(() => {
      for (const watcher of state.watchers) watcher.close();
      fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
    });
}
