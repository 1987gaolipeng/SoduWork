'use strict';
// Real hidden Electron windows, production preload/IPC, and loopback HTTP only.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 45000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, WebContentsView, ipcMain } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http'), assert = require('node:assert/strict');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-preview-lifecycle-'));
  const out = path.resolve(__dirname, '../../outputs/work-preview-lifecycle-20261001');
  fs.mkdirSync(out, { recursive: true }); app.setPath('userData', path.join(temp, 'profile'));
  const report = { ok: false, cases: [], errors: [], boundary: 'Hidden native BrowserWindow/WebContentsView, production preload and work-preview IPC, isolated profile and local HTTP. No models, user windows or external websites.' };
  const views = [], requested = new Set(); let win, server, finished = false;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async fn => { for (let i = 0; i < 160; i++) { if (await fn()) return; await delay(25); } throw Error('Fixture condition timed out'); };
  const js = code => win.webContents.executeJavaScript(code, true);
  const errorText = error => String(error && error.stack || error);
  process.on('unhandledRejection', error => report.errors.push('unhandledRejection: ' + errorText(error)));
  process.on('uncaughtException', error => { report.errors.push('uncaughtException: ' + errorText(error)); void finish(1); });
  app.on('window-all-closed', event => event?.preventDefault?.());
  async function finish(code) {
    if (finished) return; finished = true;
    for (const view of views) { const wc = view.webContents; if (wc && !wc.isDestroyed()) wc.close({ waitForBeforeUnload: false }); }
    if (win && !win.isDestroyed()) win.destroy();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await delay(100);
    if (report.errors.length) code = 1;
    report.ok = code === 0;
    fs.writeFileSync(path.join(out, 'electron.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); app.exit(code);
  }
  app.whenReady().then(async () => {
    require('../main/work-preview').install({ ipcMain, BrowserWindow,
      WebContentsView: function (options) { const view = new WebContentsView(options); views.push(view); return view; },
      shell: { openExternal: async () => { throw Error('External navigation forbidden in fixture'); } } });
    server = http.createServer((req, res) => {
      requested.add(req.url);
      if (req.url.startsWith('/slow')) return;
      if (req.url === '/fail') { req.socket.destroy(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<!doctype html><title>Live preview fixture</title><p>preview alive</p>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    fs.writeFileSync(path.join(temp, 'host.html'), '<!doctype html><title>Isolated preview lifecycle</title>');
    win = new BrowserWindow({ show: false, width: 800, height: 600,
      webPreferences: { preload: path.resolve(__dirname, '../preload.js'), contextIsolation: true, nodeIntegration: false } });
    await win.loadFile(path.join(temp, 'host.html'));
    await js('window.previewStates=[];soduWorkAPI.workPreview.onState(state=>previewStates.push(state));void 0;');
    const show = (tabId, endpoint, ref = 'fixture-a') => js('soduWorkAPI.workPreview.show(' + JSON.stringify({ tabId, ref, url: base + endpoint, bounds: { x: 0, y: 0, width: 500, height: 400 } }) + ')');
    const destroy = id => js('soduWorkAPI.workPreview.destroy(' + JSON.stringify(id) + ')');
    for (let i = 0; i < 5; i++) {
      assert.equal((await show('loading', '/slow-' + i)).ok, true); await until(() => requested.has('/slow-' + i));
      const wc = views.at(-1).webContents; assert.ok(wc.isLoading());
      assert.equal((await destroy('loading')).ok, true); await until(() => wc.isDestroyed());
    }
    await delay(150); assert.deepEqual(report.errors, []);
    report.cases.push('Five real loading navigations closed via production preload/IPC; WebContents destroyed without unhandled rejection or uncaught exception.');
    await show('replacement', '/slow-replaced'); await until(() => requested.has('/slow-replaced'));
    const replaced = views.at(-1).webContents;
    assert.equal((await show('replacement', '/ok', 'fixture-b')).ok, true);
    await until(() => replaced.isDestroyed()); await until(() => views.at(-1).webContents.getTitle() === 'Live preview fixture');
    assert.equal(await js('previewStates.filter(s=>s.tabId==="replacement"&&s.error).length'), 0);
    report.cases.push('Same tab id replaced across session refs during load; old callbacks do not publish errors into the new preview.');
    await show('failure', '/fail');
    await until(() => js('previewStates.some(s=>s.tabId==="failure"&&Boolean(s.error))'));
    assert.match(await js('previewStates.find(s=>s.tabId==="failure"&&s.error).error'), /ERR_|连接|加载/i);
    report.cases.push('An actual network load failure remains visible through the production state subscription.');
    assert.equal((await js('soduWorkAPI.workPreview.command("failure","load",{url:"javascript:alert(1)"})')).ok, false);
    report.cases.push('Unsafe navigation remains rejected.');
    await show('document-lifetime', '/ok');
    const retained = views.at(-1).webContents;
    await until(() => retained.getTitle() === 'Live preview fixture');
    const inPage = new Promise(resolve => win.webContents.once('did-navigate-in-page', resolve));
    await js('location.hash="same-document";void 0;'); await inPage;
    await js('const frame=document.createElement("iframe");frame.src=' + JSON.stringify(base + '/subframe') + ';document.body.append(frame);void 0;');
    await until(() => requested.has('/subframe'));
    assert.equal(retained.isDestroyed(), false);
    assert.equal(views.at(-1).getVisible(), true);
    report.cases.push('Actual owner hash navigation and subframe loading preserve the native preview.');
    const navigationListeners = win.webContents.listenerCount('did-start-navigation');
    for (let i = 0; i < 2; i++) {
      const old = views.at(-1).webContents;
      await js('soduWorkAPI.workPreview.setOcclusion({blocked:true});soduWorkAPI.workPreview.suppressWorkPreview(true);void 0;');
      const reloaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
      win.reload(); await reloaded;
      await until(() => old.isDestroyed());
      assert.equal(win.contentView.children.length, 0);
      await js('soduWorkAPI.workPreview.setOcclusion({blocked:true});soduWorkAPI.workPreview.setOcclusion({blocked:false});void 0;');
      assert.equal(win.contentView.children.length, 0, 'closing a menu after reload cannot revive the old preview');
      assert.equal((await show('fresh-document-' + i, '/ok')).ok, true);
      assert.equal(views.at(-1).getVisible(), true, 'reloaded document does not inherit suppression');
      assert.equal(win.webContents.listenerCount('did-start-navigation'), navigationListeners);
    }
    report.cases.push('Two real BrowserWindow reloads destroy all old child views; menu close cannot restore them, fresh previews are visible, and lifecycle listeners do not accumulate.');
    await js('window.previewStates=[];soduWorkAPI.workPreview.onState(state=>previewStates.push(state));void 0;');
    await show('owner-close', '/slow-owner'); await until(() => requested.has('/slow-owner'));
    const loading = views.at(-1).webContents; win.destroy(); await until(() => loading.isDestroyed()); await delay(200);
    assert.deepEqual(report.errors, []); report.cases.push('Destroying the host while its native preview is loading cleans up the owned view without process errors.');
    await finish(0);
  }).catch(error => { report.errors.push(errorText(error)); void finish(1); });
}
