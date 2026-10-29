'use strict';
// Production IPC and real Chromium storage/auth against an isolated loopback
// origin. Delayed/failed cleanup is injected at the Session API boundary only.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 45000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, WebContentsView, ipcMain, session, webContents } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const http = require('node:http'), assert = require('node:assert/strict');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-preview-isolation-'));
  const output = path.resolve(__dirname, '../../outputs/work-preview-session-isolation/report.json');
  const report = { ok: false, cases: [], errors: [], loginPrompts: 0,
    boundary: 'Hidden native Electron, production preload/work-preview IPC, isolated temporary userData and loopback origin. Real cookies, localStorage, IndexedDB, CacheStorage, ServiceWorkers and HTTP Basic auth. Cleanup API delay/failure injected; no user windows or external accounts.' };
  const owners = new Set(), views = [], partitions = [];
  let server, base;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(fn, label) {
    for (let i = 0; i < 300; i++) { if (await fn()) return; await delay(20); }
    throw Error('Timed out: ' + label);
  }
  app.setPath('userData', path.join(temp, 'profile'));
  app.on('window-all-closed', () => {});
  app.on('login', (event, _wc, details, _authInfo, callback) => {
    event.preventDefault();
    assert.ok(details.url.startsWith(base + '/auth'));
    report.loginPrompts++; callback('fixture-user', 'fixture-password');
  });
  process.on('unhandledRejection', error => report.errors.push(String(error.stack || error)));
  process.on('uncaughtException', error => report.errors.push(String(error.stack || error)));
  const js = (owner, code) => owner.webContents.executeJavaScript(code, true);
  const showCode = tab => 'soduWorkAPI.workPreview.show(' + JSON.stringify({ tabId: tab, ref: 'isolation-fixture',
    url: base + '/page', bounds: { x: 0, y: 0, width: 500, height: 400 } }) + ')';
  async function owner() {
    const win = new BrowserWindow({ show: false, width: 800, height: 600,
      webPreferences: { preload: path.resolve(__dirname, '../preload.js'), contextIsolation: true, nodeIntegration: false } });
    owners.add(win); win.once('closed', () => owners.delete(win));
    await win.loadFile(path.join(temp, 'host.html')); return win;
  }
  async function open(win, tab) {
    const opened = await js(win, showCode(tab));
    assert.equal(opened.ok, true, opened.reason);
    const wc = views.at(-1).webContents;
    await until(() => wc.getTitle() === 'Isolated preview', 'page loaded'); return wc;
  }
  async function startWaiting(win, tab) {
    await js(win, 'window.settled=false;' + showCode(tab) + '.then(r=>{window.result=r;window.settled=true;});void 0;');
  }
  const state = wc => wc.executeJavaScript(`(async()=>({cookie:document.cookie,local:localStorage.getItem('owner'),
    databases:(await indexedDB.databases()).map(x=>x.name),caches:await caches.keys(),
    workers:(await navigator.serviceWorker.getRegistrations()).length}))()`);
  async function seed(wc, name) {
    await wc.executeJavaScript(`(async()=>{
      document.cookie='owner=${name}; path=/';localStorage.setItem('owner','${name}');
      await new Promise((resolve,reject)=>{const request=indexedDB.open('owner-${name}',1);
        request.onupgradeneeded=()=>request.result.createObjectStore('data');
        request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;
          const tx=db.transaction('data','readwrite');tx.objectStore('data').put('${name}','owner');
          tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};});
      const cache=await caches.open('owner-${name}');await cache.put('/cached',new Response('${name}'));
      await navigator.serviceWorker.register('/worker.js');await navigator.serviceWorker.ready;return true;
    })()`);
  }
  app.whenReady().then(async () => {
    require('../main/work-preview').install({ ipcMain, BrowserWindow,
      session: { fromPartition(name) {
        const real = session.fromPartition(name);
        const row = { name, real, gate: null, failNext: false, starts: 0, finishes: 0 };
        partitions.push(row);
        return {
          on: (...args) => real.on(...args),
          async closeAllConnections() {
            assert.equal(views.filter(view => view.webContents && !view.webContents.isDestroyed() && view.webContents.session === real).length, 0,
              'native contents must be destroyed before the Session is drained');
            await real.closeAllConnections();
          },
          async clearData() {
            row.starts++; const gate = row.gate; row.gate = null;
            if (gate) await gate;
            if (row.failNext) { row.failNext = false; throw Error('Expected fixture cleanup failure'); }
            await real.clearData(); row.finishes++;
          },
          clearAuthCache: () => real.clearAuthCache(),
        };
      } },
      WebContentsView: function (options) { const view = new WebContentsView(options); views.push(view); return view; },
      shell: { openExternal: async () => { throw Error('External navigation forbidden'); } } });
    server = http.createServer((req, res) => {
      if (req.url === '/auth') {
        if (req.headers.authorization !== 'Basic ' + Buffer.from('fixture-user:fixture-password').toString('base64')) {
          res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="isolated-preview"', 'Cache-Control': 'no-store' }); res.end(); return;
        }
        res.writeHead(200, { 'Cache-Control': 'no-store' }); res.end('authenticated'); return;
      }
      if (req.url === '/worker.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
        res.end('self.addEventListener("install",e=>self.skipWaiting());self.addEventListener("activate",e=>e.waitUntil(clients.claim()));'); return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      res.end('<!doctype html><title>Isolated preview</title><p>isolated</p>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + server.address().port;
    fs.writeFileSync(path.join(temp, 'host.html'), '<!doctype html><title>Isolated owner</title>');
    const a = await owner(), av = await open(a, 'a'); await seed(av, 'A');
    const b = await owner(), bv = await open(b, 'b');
    const blank = { cookie: '', local: null, databases: [], caches: [], workers: 0 };
    assert.notEqual(av.session, bv.session); assert.deepEqual(await state(bv), blank);
    await seed(bv, 'B'); const bState = await state(bv);
    assert.deepEqual(await state(av), { cookie: 'owner=A', local: 'A', databases: ['owner-A'], caches: ['owner-A'], workers: 1 });
    assert.equal(await av.executeJavaScript('fetch("/auth").then(r=>r.text())'), 'authenticated');
    assert.equal(await av.executeJavaScript('fetch("/auth").then(r=>r.text())'), 'authenticated');
    assert.equal(report.loginPrompts, 1);
    report.cases.push('Two simultaneous owners have different native Sessions and independent cookies, storage, databases, caches and service workers; HTTP auth is cached within its owner.');

    const recycled = av.session, first = partitions[0]; let release;
    first.gate = new Promise(resolve => { release = resolve; });
    a.destroy(); await until(() => av.isDestroyed() && first.starts === 1, 'cleanup started after destruction');
    const cancelled = await owner(); await startWaiting(cancelled, 'cancelled');
    await delay(120); assert.equal(await js(cancelled, 'settled'), false); assert.equal(partitions.length, 2);
    cancelled.destroy();
    const d = await owner(); await startWaiting(d, 'd'); await delay(120);
    assert.equal(await js(d, 'settled'), false); assert.equal(partitions.length, 2);
    release(); await until(() => js(d, 'settled'), 'waiting owner gets fully cleared partition');
    assert.equal((await js(d, 'result')).ok, true);
    const dv = views.at(-1).webContents; await until(() => dv.getTitle() === 'Isolated preview', 'recycled page loaded');
    assert.equal(dv.session, recycled); assert.equal(partitions.length, 2); assert.equal(views.length, 3);
    assert.deepEqual(await state(dv), blank); assert.deepEqual(await state(bv), bState);
    assert.equal(await dv.executeJavaScript('fetch("/auth").then(r=>r.text())'), 'authenticated');
    assert.equal(report.loginPrompts, 2, 'HTTP authentication must prompt again after reuse');
    report.cases.push('Cleanup blocks new previews; a destroyed waiting owner creates no view or Session. Reuse occurs after real cleanup, with every stored value and HTTP auth removed while the other live owner remains intact.');

    await seed(dv, 'D'); first.failNext = true; d.destroy();
    const e = await owner(), ev = await open(e, 'e');
    assert.notEqual(ev.session, recycled); assert.notEqual(ev.session, bv.session);
    assert.deepEqual(await state(ev), blank); assert.deepEqual(await state(bv), bState);
    assert.equal(partitions.length, 3);
    report.cases.push('A failed cleanup quarantines its real Session: a subsequent owner receives a different empty partition and cannot access the retained old data.');
    b.destroy(); e.destroy();
    await until(() => webContents.getAllWebContents().length === 0, 'all native WebContents destroyed');
    await delay(150); assert.deepEqual(report.errors, []); report.ok = true;
  }).catch(error => report.errors.push(String(error.stack || error)))
    .finally(async () => {
      for (const win of owners) if (!win.isDestroyed()) win.destroy();
      if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      report.ok = report.ok && report.errors.length === 0;
      report.nativeSessions = partitions.length; report.viewsCreated = views.length;
      fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
    });
}
