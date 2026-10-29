'use strict';
// Native lifecycle stress derived from work-preview-lifecycle.cjs. The real
// preload/IPC and isolated WebContentsView run against loopback HTTP only.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 300000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, WebContentsView, ipcMain, webContents } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const http = require('node:http'), readline = require('node:readline'), assert = require('node:assert/strict');
  const { spawn } = require('node:child_process');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-preview-resources-'));
  const baseline = process.env.SODUWORK_PREVIEW_BASELINE === '1';
  const output = path.resolve(process.argv[2] || path.join(__dirname,
    '../../outputs/work-preview-resources/' + (baseline ? 'baseline-head.json' : 'report.json')));
  const report = { ok: false, errors: [], samples: [], phases: [], created: 0, destroyed: 0,
    source: baseline ? 'HEAD:client/main/work-preview.js' : 'working tree', electron: process.versions.electron,
    boundary: 'Isolated native Electron, real production IPC, loopback pages, Windows handles/GDI/private bytes. Forced GC distinguishes reachable wrappers from collectable churn; no user processes, profile, models or production calls.' };
  const active = new Set(), ownerWindows = new Set(), weakViews = [], replies = new Map();
  let server, probe, probeReady, base, current, requestId = 0;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(fn, label, timeout = 7000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await fn()) return; await delay(15); }
    throw Error('Timed out: ' + label);
  }
  const execute = source => current.webContents.executeJavaScript(source, true);
  const destroyedListeners = owner => owner.webContents.listenerCount('destroyed');
  const show = (tabId, endpoint, ref = 'fixture') => execute('soduWorkAPI.workPreview.show(' + JSON.stringify({
    tabId, ref, url: base + endpoint, bounds: { x: 0, y: 0, width: 500, height: 400 } }) + ')');
  const closeTab = tabId => execute('soduWorkAPI.workPreview.destroy(' + JSON.stringify(tabId) + ')');
  const listenerTotal = emitter => emitter.eventNames().reduce((total, name) => total + emitter.listenerCount(name), 0);
  app.setPath('userData', path.join(temp, 'profile'));
  app.commandLine.appendSwitch('js-flags', '--expose-gc');
  app.on('window-all-closed', () => {});
  process.on('unhandledRejection', error => report.errors.push(String(error.stack || error)));
  process.on('uncaughtException', error => report.errors.push(String(error.stack || error)));
  require('node:v8').setFlagsFromString('--expose_gc');
  const collect = require('node:vm').runInNewContext('gc');
  async function gc() { collect(); await delay(40); collect(); await delay(40); }
  function nativeMetrics(ids) {
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { replies.delete(id); reject(Error('Windows resource probe timed out')); }, 10000);
      replies.set(id, values => { clearTimeout(timer); resolve(values); });
      probe.stdin.write(JSON.stringify({ id, ids }) + '\n');
    });
  }
  async function sample(phase, cycle) {
    await delay(180); await gc();
    const processTypes = new Map(app.getAppMetrics().map(row => [row.pid, row.type]));
    const values = await nativeMetrics([...processTypes.keys()]);
    const row = { phase, cycle, at: new Date().toISOString(),
      processes: values.map(value => ({ ...value, type: processTypes.get(value.pid) })),
      mainHeapBytes: process.memoryUsage().heapUsed, webContents: webContents.getAllWebContents().length,
      nativeWindows: BrowserWindow.getAllWindows().length, activeViews: active.size,
      ipcListeners: listenerTotal(ipcMain), weakViewsAlive: weakViews.filter(ref => ref.deref()).length };
    report.samples.push(row);
    assert.equal(row.activeViews, 0, 'all scoped native views must close before sampling');
    assert.equal(row.webContents, ownerWindows.size, 'only current owner webContents may remain');
    console.log(JSON.stringify({ phase, cycle, webContents: row.webContents, main: row.processes.find(x => x.pid === process.pid) }));
    return row;
  }
  async function owner() {
    const win = new BrowserWindow({ show: false, width: 800, height: 600,
      webPreferences: { preload: path.resolve(__dirname, '../preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    ownerWindows.add(win); win.once('closed', () => ownerWindows.delete(win));
    await win.loadFile(path.join(temp, 'host.html'));
    current = win;
    await execute('window.previewCount=0;window.offPreview=soduWorkAPI.workPreview.onState(()=>previewCount++);void 0;');
    return win;
  }
  async function cycle(index) {
    const slow = index % 5 === 0;
    const result = await show('preview', slow ? '/slow/' + index : '/ok/' + index);
    assert.equal(result.ok, true);
    const view = [...active][0], wc = view.webContents;
    await until(() => slow ? server.requested.has('/slow/' + index) : wc.getTitle() === 'Native preview ready', 'actual preview navigation');
    assert.equal((await closeTab('preview')).ok, true);
    await until(() => wc.isDestroyed(), 'destroy preview');
  }
  function assertResourceBudget() {
    const warm = report.samples.find(row => row.phase === 'warm');
    const afterTabs = report.samples.find(row => row.phase === 'same-owner' && row.cycle === 100);
    const boundary = report.samples.find(row => row.phase === 'owner-boundary');
    const settled = report.samples.at(-1);
    const main = row => row.processes.find(process => process.type === 'Browser');
    const difference = (from, to) => Object.fromEntries(['handles', 'privateBytes', 'gdi', 'user']
      .map(key => [key, to[key] - from[key]]));
    const mainDelta = difference(main(boundary), main(settled));
    const rendererDelta = difference(warm.processes.find(p => p.type === 'Tab'), afterTabs.processes.find(p => p.type === 'Tab'));
    report.deltas = { ownerChurnMain: mainDelta, sameOwnerRenderer: rendererDelta };
    report.budgets = { mainHandles: 48, privateBytes: 16 * 1024 * 1024, gdi: 16, user: 12, rendererHandles: 40 };
    assert.equal(settled.webContents, 0); assert.equal(settled.nativeWindows, 0);
    assert.equal(settled.weakViewsAlive, 0, 'closed native view wrappers must be collectable');
    for (const row of report.samples) assert.equal(row.ipcListeners, warm.ipcListeners, 'IPC listeners cannot accumulate');
    assert.ok(mainDelta.handles <= report.budgets.mainHandles, 'owner churn grows native handles: ' + mainDelta.handles);
    assert.ok(mainDelta.privateBytes <= report.budgets.privateBytes, 'owner churn grows private memory');
    assert.ok(mainDelta.gdi <= report.budgets.gdi && mainDelta.user <= report.budgets.user, 'owner churn grows GDI/USER objects');
    assert.ok(rendererDelta.handles <= report.budgets.rendererHandles, 'preview renderer grows handles');
    assert.ok(rendererDelta.privateBytes <= report.budgets.privateBytes, 'preview renderer grows private memory');
  }
  app.whenReady().then(async () => {
    assert.equal(process.platform, 'win32', 'resource measurements require native Windows');
    probe = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(__dirname, 'windows-process-resources.ps1')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    probe.stderr.on('data', data => report.errors.push('probe: ' + data.toString()));
    readline.createInterface({ input: probe.stdout }).on('line', line => {
      try { const value = JSON.parse(line); if (value.ready) probeReady = true; else replies.get(value.id)?.(value.values); replies.delete(value.id); }
      catch (error) { report.errors.push('probe response: ' + String(error)); }
    });
    await until(() => probeReady, 'native resource probe', 15000);
    let preview = require('../main/work-preview');
    if (baseline) {
      // Evaluate HEAD in memory; never replace shared working-tree files.
      const Module = require('node:module'), filename = require.resolve('../main/work-preview');
      const source = require('node:child_process').execFileSync('git', ['show', 'HEAD:client/main/work-preview.js'], {
        cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', windowsHide: true });
      const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
      loaded._compile(source, filename); preview = loaded.exports;
    }
    preview.install({ ipcMain, BrowserWindow,
      WebContentsView: function (options) {
        const view = new WebContentsView(options); active.add(view); report.created++;
        weakViews.push(new WeakRef(view));
        view.webContents.once('destroyed', () => { active.delete(view); report.destroyed++; });
        return view;
      }, shell: { openExternal: async () => { throw Error('External navigation forbidden'); } } });
    server = http.createServer((req, res) => {
      server.requested.add(req.url);
      if (req.url.startsWith('/slow/')) return;
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      res.end('<!doctype html><title>Native preview ready</title><canvas width="400" height="200"></canvas><script>const c=document.querySelector("canvas").getContext("2d");c.fillStyle="#4399dd";c.fillRect(0,0,400,200)</script>');
    });
    server.requested = new Set();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + server.address().port;
    fs.writeFileSync(path.join(temp, 'host.html'), '<!doctype html><title>Native resource test owner</title>');
    const host = await owner(); const ownerBaseline = destroyedListeners(host);
    for (let i = 0; i < 10; i++) await cycle(-i);
    await closeTab(''); assert.equal(destroyedListeners(host), ownerBaseline);
    await sample('warm', 10);
    for (let i = 1; i <= 100; i++) {
      await cycle(i);
      if (i % 20 === 0) {
        await closeTab(''); assert.equal(destroyedListeners(host), ownerBaseline);
        await sample('same-owner', i);
      }
    }
    report.phases.push('100 preload/IPC open-close cycles (20 interrupted network loads), owner destroyed listener restored to baseline after each batch');
    await execute('offPreview();'); host.destroy(); await until(() => ownerWindows.size === 0, 'first owner closes');
    await sample('owner-boundary', 0);
    for (let i = 1; i <= 50; i++) {
      const host = await owner();
      assert.equal((await show('first', '/ok/owner-' + i)).ok, true);
      assert.equal((await show('second', '/slow/owner-' + i)).ok, true);
      await until(() => server.requested.has('/slow/owner-' + i), 'owner pending navigation');
      host.destroy(); await until(() => active.size === 0 && ownerWindows.size === 0, 'owner releases both previews');
      if (i % 10 === 0) await sample('owner-churn', i);
    }
    report.phases.push('50 native owner windows destroyed with two open previews each, including an in-flight HTTP load');
    await delay(1500); await sample('settled', 50);
    assert.equal(report.created, 210); assert.equal(report.destroyed, report.created);
    assertResourceBudget();
    assert.deepEqual(report.errors, []);
    report.ok = true;
  }).catch(error => { report.errors.push(String(error.stack || error)); })
    .finally(async () => {
      for (const win of [...ownerWindows]) if (!win.isDestroyed()) win.destroy();
      if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      if (probe) { probe.stdin.end(); await until(() => probe.exitCode !== null, 'resource helper exit', 3000).catch(() => probe.kill()); }
      report.ok = report.ok && report.errors.length === 0;
      fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ ok: report.ok, output, created: report.created, destroyed: report.destroyed, errors: report.errors }));
      app.exit(report.ok ? 0 : 1);
    });
}
