'use strict';
// Real production DOM/scripts, synthetic API/IPC, isolated profile and no network.
const electron = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: true });
  const timer = setTimeout(() => child.kill(), 60000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, session, net } = electron;
  const { fileURLToPath } = require('node:url');
  const assert = require('node:assert/strict');
  const output = process.argv[2];
  if (!output || !path.isAbsolute(output)) throw Error('Absolute evidence directory required');
  fs.mkdirSync(output, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-page-refresh-'));
  app.setPath('userData', profile); app.disableHardwareAcceleration();
  const client = path.resolve(__dirname, '..');
  const report = { ok: false, checks: [], boundary: 'Isolated Chromium DOM behavior; no live Hub, user profile or physical mouse assertions.' };
  let win;
  const js = code => win.webContents.executeJavaScript(code, true);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(code) {
    for (let i = 0; i < 100; i++) { if (await js(code)) return; await wait(20); }
    throw Error('Timed out: ' + code);
  }
  async function check(name, code) { assert.equal(await js(code), true, name); report.checks.push(name); }
  app.whenReady().then(async () => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_r, cb) => cb({ cancel: true }));
    session.defaultSession.protocol.handle('file', request => {
      if (path.basename(fileURLToPath(request.url.split('?')[0])) !== 'desk.html') return net.fetch(request.url, { bypassCustomProtocolHandlers: true });
      const mock = fs.readFileSync(path.join(__dirname, 'fixtures/page-audit-api.js'), 'utf8');
      const html = fs.readFileSync(path.join(client, 'desk.html'), 'utf8')
        .replace('<head>', '<head><script>' + mock + '\nsoduWorkAPI.workPreview.onComposerRefresh=()=>()=>{};</script>')
        .replace('<script src="desk-boot.js"></script>', '<script>fixtureInstallApi();</script><script src="desk-boot.js"></script>');
      return new Response(html, { headers: { 'content-type': 'text/html;charset=utf-8' } });
    });
    win = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    await win.loadFile(path.join(client, 'desk.html'), { query: { panel: 'workspace', view: 'settings' } });
    await until('Boolean(window.fixtureReady)');
    await js(`window.refreshRows={items:[{pluginId:'local:refresh-one',personal:true,enabled:true,name:'Refresh fixture',description:'Synthetic application',ui:{contributions:[{id:'main',slot:'workspace.navigation'}]}}]};
      fixtureOverrides.pluginCatalog=async()=>structuredClone(refreshRows); WorkspaceHost.open('apps',{});void 0;`);
    await until('Boolean(document.querySelector(".appsx-card"))');
    await js(`window.firstCard=document.querySelector('.appsx-card');window.pendingCatalog=[];
      fixtureOverrides.pluginCatalog=()=>new Promise((resolve,reject)=>pendingCatalog.push({resolve,reject}));
      window.refreshApps=renderAppsCatalog(true);void 0;`);
    await check('apps keep existing cards while refreshing', 'firstCard.isConnected && !document.querySelector(".appsx-loading")');
    await js('pendingCatalog.shift().resolve(structuredClone(refreshRows));refreshApps');
    await check('unchanged apps keep DOM identity', 'firstCard === document.querySelector(".appsx-card")');
    await js('window.refreshApps=renderAppsCatalog(true);void 0;');
    await js('pendingCatalog.shift().reject(Error("offline"));refreshApps');
    await check('failed refresh preserves apps with retry', 'firstCard.isConnected && !!document.querySelector("#appsRefreshNotice button")');
    await js('window.refreshApps=renderAppsCatalog(true);void 0;');
    await js('refreshRows.items[0].name="Updated fixture";pendingCatalog.shift().resolve(structuredClone(refreshRows));refreshApps');
    await check('changed apps update and clear the error', 'document.querySelector("#appsBody").textContent.includes("Updated fixture") && !document.querySelector("#appsRefreshNotice")');
    await js('window.refreshApps=renderAppsCatalog(true);dispatchEvent(new Event("soduwork-plugin-policy"));void 0;');
    await check('policy invalidation immediately removes cached grants', '!document.querySelector(".appsx-card")');
    await js('pendingCatalog.pop().resolve({items:[]});void 0;'); await wait(40);
    await js('pendingCatalog.shift().resolve(structuredClone(refreshRows));refreshApps');
    await check('old catalog cannot restore revoked apps', '!document.querySelector(".appsx-card")');

    await js('fixtureOverrides.pluginCatalog=async()=>({items:[]});WorkspaceHost.open("skills",{});void 0;');
    await until('Boolean(document.getElementById("capContent"))'); await wait(80);
    await js(`window.capShell=document.querySelector('.cap-shell');window.pendingCap=[];
      fixtureOverrides.capabilityCatalog=()=>new Promise((resolve,reject)=>pendingCap.push({resolve,reject}));
      window.capFirst=openCapabilityPanel();window.capSecond=openCapabilityPanel();void 0;`);
    await until('pendingCap.length>0');
    await check('capability reopen coalesces reads and keeps content', 'pendingCap.length===1 && capShell.isConnected');
    await js('pendingCap.shift().resolve({skills:[],mcpTemplates:[],summary:{}});Promise.all([capFirst,capSecond])');
    await check('unchanged capability data keeps toolbar and focus container', 'capShell === document.querySelector(".cap-shell")');
    await js('window.capFirst=openCapabilityPanel();void 0;'); await until('pendingCap.length>0');
    await js('pendingCap.shift().reject(Error("offline"));capFirst');
    await check('capability refresh failure preserves content with retry', 'capShell.isConnected && !!document.querySelector("#capRefreshNotice button")');

    await js(`window.libraryRows={items:[{id:'file-one',title:'Fixture document',kind:'document',storage:'local',filename:'fixture.md',updatedAt:1720000000000}],folders:[]};
      fixtureOverrides.listLibrary=async()=>structuredClone(libraryRows);WorkspaceHost.open('library',{});void 0;`);
    await until('document.querySelector("[data-library-content]")?.textContent.includes("Fixture document")');
    await js(`window.libraryRow=document.querySelector('[data-library-content]').firstElementChild;window.pendingLibrary=[];
      fixtureOverrides.listLibrary=()=>new Promise((resolve,reject)=>pendingLibrary.push({resolve,reject}));openLibraryPanel();void 0;`);
    await until('pendingLibrary.length>0');
    await check('library reopen keeps loaded rows', 'libraryRow.isConnected && !document.querySelector("[data-library-content]").hidden');
    await js('pendingLibrary.shift().resolve(structuredClone(libraryRows));void 0;'); await wait(50);
    await check('unchanged library rows keep DOM identity', 'libraryRow === document.querySelector("[data-library-content]").firstElementChild');
    await js('openLibraryPanel();void 0;'); await until('pendingLibrary.length>0');
    await js('pendingLibrary.shift().reject(Error("offline"));void 0;'); await wait(50);
    await check('library outage preserves rows and exposes retry', 'libraryRow.isConnected && !document.querySelector("[data-library-content]").hidden && !!document.querySelector("[data-library-retry]")');
    await js('fixtureOverrides.listLibrary=async()=>({items:[],folders:[]});fixtureOwner="second-owner";dispatchEvent(new Event("soduwork-data-scope-changed"));void 0;');
    await check('identity change removes old library and capability data', '!libraryRow.isConnected && !capShell.isConnected');
    await check('renderer has no unhandled errors', 'fixtureErrors.length===0');
    report.ok = true;
  }).catch(error => { report.error = String(error.stack || error); process.exitCode = 1; }).finally(() => {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
    win?.destroy(); app.quit();
  });
  app.on('will-quit', () => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} });
}
