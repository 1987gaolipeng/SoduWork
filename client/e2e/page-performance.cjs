'use strict';
// Production sandboxed preload and Chromium timing; synthetic IPC, no network.
const electron = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: true });
  const timer = setTimeout(() => child.kill(), 60000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, session, ipcMain } = electron;
  const { pathToFileURL } = require('node:url');
  const assert = require('node:assert/strict');
  const output = process.argv[2];
  if (!output || !path.isAbsolute(output)) throw Error('Absolute evidence directory required');
  fs.mkdirSync(output, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-page-timing-'));
  app.setPath('userData', profile); app.disableHardwareAcceleration();
  const client = path.resolve(__dirname, '..');
  const report = { ok: false, checks: [], boundary: 'Isolated Electron, production preload, synthetic IPC; no live Hub or user profile.' };
  let win;
  const js = code => win.webContents.executeJavaScript(code, true);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function check(name, code) { assert.equal(await js(code), true, name); report.checks.push(name); }
  app.whenReady().then(async () => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_r, cb) => cb({ cancel: true }));
    ipcMain.handle('client-update-status', async () => { await wait(40); return { privateContent: 'private-fixture' }; });
    const html = path.join(profile, 'fixture.html');
    fs.writeFileSync(html, '<!doctype html><title>Timing fixture</title><button data-view="settings">Settings</button><script src="' + pathToFileURL(path.join(client, 'core/page-performance.js')).href + '"></script>');
    win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(client, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    await win.loadFile(html);
    await check('production sandboxed preload preserves delayed IPC results', `(async()=>{
      const value=await soduWorkAPI.clientUpdateStatus();const data=await SoduWorkPagePerformance.snapshot();
      return value.privateContent==='private-fixture' && data.ipc.available && data.ipc.events.some(x=>x.name==='client-update-status' && x.durationMs>=30 && x.ok);
    })()`);
    await check('identity change discards pending IPC evidence', `(async()=>{
      const pending=soduWorkAPI.clientUpdateStatus();dispatchEvent(new Event('soduwork-data-scope-changed'));await pending;
      return (await SoduWorkPagePerformance.snapshot()).ipc.events.length===0;
    })()`);
    await js(`SoduWorkPagePerformance.navigate('settings',()=>{document.body.dataset.open='settings';return 42;});void 0;`);
    for (let i = 0; i < 50; i++) {
      if (await js(`(async()=> (await SoduWorkPagePerformance.snapshot()).events.some(x=>x.kind==='navigation' && x.firstFrameMs!==null))()`)) break;
      await wait(20);
    }
    await check('Chromium reports navigation and frame opportunity', `(async()=> (await SoduWorkPagePerformance.snapshot()).events.some(x=>x.kind==='navigation' && x.name==='settings' && x.ok && x.firstFrameMs!==null && x.firstFrameMs>=x.handlerMs))()`);
    await js(`setTimeout(()=>{const start=performance.now();while(performance.now()-start<80){}},0);void 0;`);
    for (let i = 0; i < 50; i++) {
      if (await js(`(async()=> (await SoduWorkPagePerformance.snapshot()).events.some(x=>x.kind==='longtask' && x.durationMs>=50))()`)) break;
      await wait(20);
    }
    await check('Chromium observes a real renderer long task', `(async()=> (await SoduWorkPagePerformance.snapshot()).events.some(x=>x.kind==='longtask' && x.durationMs>=50))()`);
    await check('export omits IPC contents and filesystem paths', `(async()=> !/private-fixture|privateContent|file:|fixture.html/.test(JSON.stringify(await SoduWorkPagePerformance.snapshot())))()`);
    report.sample = await js('SoduWorkPagePerformance.snapshot()');
    report.ok = true;
  }).catch(error => { report.error = String(error.stack || error); process.exitCode = 1; }).finally(() => {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
    win?.destroy(); app.quit();
  });
  app.on('will-quit', () => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} });
}
