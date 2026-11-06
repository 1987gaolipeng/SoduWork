'use strict';
// Real Electron workers, SQLite files and admin renderer; all data and HTTP are isolated.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), http = require('node:http');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const electron = require('electron');
const client = path.resolve(__dirname, '..');
const output = path.join(client, 'outputs/nov04-stability/performance');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawnSync(electron, [__filename, ...process.argv.slice(2)], {
    env, windowsHide: true, encoding: 'utf8', timeout: 180000,
  });
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  assert.equal(child.status, 0, child.error?.message || 'Isolated Electron validation failed');
} else {
  const { app, BrowserWindow } = electron;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-stability-e2e-'));
  fs.mkdirSync(output, { recursive: true });
  app.setPath('userData', path.join(profile, 'electron'));
  app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});
  const report = { ok: false, boundary: 'Isolated Electron and real loopback HTTP; synthetic admin identity and data; no business services or paid models.' };
  let win, server, sync;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = code => win.webContents.executeJavaScript(code, true);
  async function until(code, timeout = 10000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await js(code)) return; await sleep(50); }
    throw Error('Renderer condition timed out: ' + code);
  }
  async function click(text) {
    const point = await js(`(async () => {
      const node = [...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});
      if (!node || node.disabled || !node.getClientRects().length) throw Error('Missing click target');
      node.scrollIntoView({block:'center'});
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const r=node.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};
    })()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    await sleep(100);
  }
  async function pressure() {
    const { createWorker } = require('../main/conversation/account-sync-store');
    const actor = require('../tests/helpers/platform-session-fixture.cjs').identity();
    const file = path.join(profile, 'outbox.json');
    let store = createWorker(file);
    const options = { app: {}, store, identityOf: () => actor, fetch: async () => { throw Error('isolated offline'); } };
    sync = require('../main/conversation/account-sync').create(options);
    const lag = monitorEventLoopDelay({ resolution: 10 }); lag.enable();
    const started = performance.now();
    const sources = Array.from({ length: 500 }, (_, index) => ({ sessionId: 'load-' + index,
      snapshot: () => ({ messages: [{ id: 'message', role: 'user', text: 'x'.repeat(200000), createdAt: 1 }] }) }));
    for (const source of sources) sync.bind(source, actor);
    assert.equal((await sync.flush()).pending, 500);
    assert.ok(sources.every(source => source.accountSync.state !== 'synced'));
    const elapsedMs = performance.now() - started;
    lag.disable();
    report.queue = { sources: 500, textBytes: 100000000, elapsedMs: Math.round(elapsedMs),
      eventLoopP99Ms: +(lag.percentile(99) / 1e6).toFixed(2), eventLoopMaxMs: +(lag.max / 1e6).toFixed(2) };
    assert.ok(report.queue.eventLoopP99Ms < 150, 'Main-process p99 must stay below the 150 ms stress budget');
    assert.ok(report.queue.eventLoopMaxMs < 500, 'Main-process stalls must stay below 500 ms');
    await sync.close(); sync = null;
    store = createWorker(file);
    try {
      assert.equal((await store.pending()).length, 500);
      const batch = await store.batch({ ...actor, ownerKey: require('../main/device-auth-request').accountScopeKey(actor) });
      assert.ok(Buffer.byteLength(JSON.stringify(batch)) < 17 * 1024 * 1024);
      for (let revision = 2; revision <= 21; revision++) {
        const next = { ...batch[0], id: 'updated-' + revision, body: { ...batch[0].body, sourceRevision: revision } };
        await store.enqueue(next);
      }
      assert.equal((await store.pending()).length, 500, 'Complete snapshots compact only their own source');
      report.queue.restartPending = 500; report.queue.coalescedUpdates = 20;
    } finally { await store.close(); }
  }
  async function browser() {
    const dist = path.resolve(client, '../hub-frontend/dist');
    const user = { id: 'isolated-admin', username: 'fixture', name: 'Fixture', isSuper: true, permissions: [] };
    let stalled = true, requests = 0, aborted = 0;
    report.browser = { requests: 0 };
    server = http.createServer((req, res) => {
      const route = new URL(req.url, 'http://localhost').pathname;
      if (route === '/api/v1/admin/integrations') {
        requests++;
        report.browser.requests = requests;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (stalled) { res.write('['); res.on('close', () => { aborted++; report.browser.aborted = aborted; }); return; }
        res.end(JSON.stringify([{ id: 'fixture', name: 'Recovered source', type: 'generic', enabled: true, taskCount: 123 }])); return;
      }
      if (route.startsWith('/api/') || route === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(route.endsWith('/admin/me') ? user : route === '/healthz' ? { ok: true } : [])); return;
      }
      const file = path.resolve(dist, route === '/' ? 'index.html' : '.' + route);
      if (!file.startsWith(dist + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
      let body = fs.readFileSync(file);
      if (file.endsWith('index.html')) body = Buffer.from(body.toString().replace('<head>', `<head><script>
        localStorage.setItem('soduwork_hub_admin_token','isolated-fixture');
        localStorage.setItem('soduwork_hub_admin_user',${JSON.stringify(JSON.stringify(user))});
        localStorage.setItem('soduwork.locale','zh-CN');sessionStorage.setItem('soduwork-hub-screen','integrations');
      </script>`));
      res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }); res.end(body);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    win = new BrowserWindow({ show: false, width: 1280, height: 900,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    const origin = 'http://127.0.0.1:' + server.address().port;
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, done) =>
      done({ cancel: !details.url.startsWith(origin + '/') }));
    const started = performance.now();
    await win.loadURL(origin);
    await until('document.body.innerText.includes("请求超时")', 40000);
    report.browser.bodyTimeoutMs = Math.round(performance.now() - started);
    assert.ok(aborted > 0, 'Timed-out body stream must release the network request');
    await until('!document.querySelector(".loading")');
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.join(output, 'timeout.png'), (await win.webContents.capturePage()).toPNG());
    stalled = false;
    // The 15-second poll may already own the next request at the 30-second
    // deadline. Let that real request reach its own deadline before a manual
    // retry, without changing production timers or bypassing the busy guard.
    const pendingAtRecovery = requests;
    const recoveryDeadline = Date.now() + 35000;
    while (aborted < pendingAtRecovery && Date.now() < recoveryDeadline) await sleep(50);
    assert.equal(aborted, pendingAtRecovery);
    await sleep(100);
    const beforeRetry = requests;
    await click('重试');
    await until('document.body.innerText.includes("Recovered source")');
    assert.equal(requests, beforeRetry + 1, 'One native retry must cause exactly one fresh request');
    await click('负责人绑定 · 未分配'); await click('接入源');
    await until('document.body.innerText.includes("Recovered source")');
    // Present the final surface before capture; hidden compositors may retain an older frame.
    win.showInactive();
    await sleep(300);
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.join(output, 'recovered.png'), (await win.webContents.capturePage()).toPNG());
    report.browser.requests = requests; report.browser.aborted = aborted;
    report.browser.nativeRetryRecovery = true; report.browser.nativeNavigationRecovery = true;
  }
  app.whenReady().then(async () => {
    try { if (!process.argv.includes('--browser-only')) await pressure(); await browser(); report.ok = true; }
    catch (error) {
      report.error = error.stack; console.error(error);
      if (win && !win.isDestroyed()) {
        report.rendererText = await js('document.body.innerText');
        fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG());
      }
    }
    finally {
      await sync?.close();
      if (win && !win.isDestroyed()) { await win.webContents.session.closeAllConnections(); win.destroy(); }
      server?.closeAllConnections(); server?.close();
      fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report));
      app.exit(report.ok ? 0 : 1);
    }
  });
}
