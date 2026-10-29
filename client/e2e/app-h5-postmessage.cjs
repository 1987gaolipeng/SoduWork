'use strict';
// Real native views/preloads and three HTTP origins. The sidebar accepts a
// deterministic message; the separate live cloud test runs the real model.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const r = require('node:child_process').spawnSync(electron, [__filename, '--disable-gpu'], { env, windowsHide: true, stdio: 'inherit', timeout: 90000 });
  process.exit(r.status ?? 1);
}
const { app, BrowserWindow, WebContentsView, ipcMain, safeStorage } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const assert = require('node:assert/strict');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-postmessage-'));
app.setPath('userData', path.join(root, 'profile')); app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const report = { ok: false, cases: [], boundary: 'Real Chromium cross-origin postMessage, production native app/composer IPC, H5 SDK and title bar. Deterministic composer admission fixture; real model/MCP/PG tested separately.' };
const servers = [], views = [], windows = [];
let host, childOrigin, deniedOrigin;
const sdk = fs.readFileSync(path.resolve(__dirname, '../sdk/soduwork-app.js'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, label) => { for (let i = 0; i < 400; i++) { if (await check()) return; await delay(25); } throw Error('Timed out: ' + label); };
const js = (wc, value) => wc.executeJavaScript(value);
async function serve(handler) {
  const server = http.createServer(handler); servers.push(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + server.address().port;
}
app.whenReady().then(async () => {
  const child = (_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><meta charset="utf-8"><script>' + sdk + '</script><p>H5 child</p>'); };
  childOrigin = await serve(child); deniedOrigin = await serve(child);
  const origin = await serve((request, response) => {
    if (request.url === '/sdk.js') { response.writeHead(200, { 'Content-Type': 'application/javascript' }); response.end(sdk); return; }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><meta charset="utf-8"><script src="/sdk.js"></script><script>soduWorkApp.configure({allowedFrameOrigins:[' + JSON.stringify(childOrigin) + ']});window.refreshes=0;soduWorkApp.events.onRefresh(()=>refreshes++);</script>' +
      '<iframe id="allowed" src="' + childOrigin + '"></iframe><iframe id="denied" src="' + deniedOrigin + '"></iframe><iframe id="same" src="/same"></iframe>');
  });
  // /same must be a child-only document rather than recursively embedding.
  servers.at(-1).removeAllListeners('request');
  servers.at(-1).on('request', (request, response) => {
    if (request.url === '/sdk.js') { response.writeHead(200, { 'Content-Type': 'application/javascript' }); response.end(sdk); return; }
    if (request.url === '/same') { child(request, response); return; }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><meta charset="utf-8"><script src="/sdk.js"></script><script>soduWorkApp.configure({allowedFrameOrigins:[' + JSON.stringify(childOrigin) + ']});window.refreshes=0;soduWorkApp.events.onRefresh(()=>refreshes++);</script>' +
      '<iframe id="allowed" src="' + childOrigin + '"></iframe><iframe id="denied" src="' + deniedOrigin + '"></iframe><iframe id="same" src="/same"></iframe>');
  });
  fs.writeFileSync(path.join(root, 'host.html'), '<!doctype html><title>Host</title><script>window.SoduWorkI18n={getLocale:()=>window.hostLocale||"zh-CN"};window.PluginUIHost={assertUse:async()=>{}};</script><script>' + fs.readFileSync(path.resolve(__dirname, '../components/panels/soduwork-app-bridge-host.js'), 'utf8') + '</script>');
  fs.writeFileSync(path.join(root, 'composer.html'), '<!doctype html><textarea id="draft">User draft kept</textarea><script>window.received=[];soduWorkAPI.workPreview.onComposerSubmit(p=>{received.push(p.text);soduWorkAPI.workPreview.composerSubmitResult({id:p.id,ok:true});});</script>');
  const caps = ['context.read', 'conversation.send', 'composer.control', 'settings.read', 'settings.write'];
  const plugin = require('../main/personal-plugins').create(app, { key: 'h5-settings-test', name: 'H5 settings test', version: '0.1.0', template: 'app', description: 'Cross-origin fixture', instructions: 'Fixture only', ui: { contributions: [{ id: 'h5', title: 'H5', slot: 'workspace.navigation', source: { type: 'external', url: origin, bridge: { version: 1, capabilities: caps } } }] } }).plugin;
  require('../main/app-settings-store.cjs').configure({ app, safeStorage, ownerOf: () => 'h5-fixture-owner' });
  require('../main/work-preview').install({ app, ipcMain,
    BrowserWindow: Object.assign(function (options) { const win = new BrowserWindow(options); windows.push(win); return win; }, { fromWebContents: wc => BrowserWindow.fromWebContents(wc) }),
    WebContentsView: function (options) {
      const view = new WebContentsView(options); views.push(view);
      const load = view.webContents.loadFile.bind(view.webContents);
      view.webContents.loadFile = (file, options) => load(path.basename(file) === 'desk.html' ? path.join(root, 'composer.html') : file, options);
      return view;
    }, shell: { openExternal: async () => { throw Error('External open forbidden'); } } });
  host = new BrowserWindow({ show: false, webPreferences: { preload: path.resolve(__dirname, '../preload.js'), contextIsolation: true, sandbox: true } });
  await host.loadFile(path.join(root, 'host.html'));
  const payload = { tabId: 'h5-test', url: origin, appBridge: { appId: 'plugin:' + plugin.pluginId, contributionId: 'h5', origin, version: 1, capabilities: caps } };
  assert.equal((await js(host.webContents, 'soduWorkAPI.workPreview.showDetached(' + JSON.stringify(payload) + ')')).ok, true);
  const [chrome, application, composer] = windows[0].contentView.children;
  await until(() => application.webContents.mainFrame.frames.length === 3 && !composer.webContents.isLoading(), 'three child frames');
  const frame = base => application.webContents.mainFrame.frames.find(row => row.url.startsWith(base));
  await until(() => frame(childOrigin)?.executeJavaScript('!!window.soduWorkApp'), 'child SDK');
  assert.equal((await frame(childOrigin).executeJavaScript('soduWorkApp.context.get()')).locale, 'zh-CN');
  await js(host.webContents, 'window.hostLocale="en-US"');
  assert.equal((await frame(childOrigin).executeJavaScript('soduWorkApp.context.get()')).locale, 'en-US');
  report.cases.push('Host interface locale crosses the existing permission-checked native context and authorized H5 postMessage bridge.');
  const sent = await frame(childOrigin).executeJavaScript('soduWorkApp.chat.send({text:"Cross-origin task",requestId:"cross-once"})');
  assert.equal(sent.accepted, true);
  assert.equal((await frame(childOrigin).executeJavaScript('soduWorkApp.chat.send({text:"Cross-origin task",requestId:"cross-once"})')).ok, true);
  assert.deepEqual(await js(composer.webContents, 'received'), ['Cross-origin task']);
  assert.equal(await js(composer.webContents, 'draft.value'), 'User draft kept');
  report.cases.push('Explicitly authorized cross-origin iframe sends through real postMessage and owned native composer; duplicate operation sends once and preserves draft.');
  assert.equal((await frame(origin + '/same').executeJavaScript('soduWorkApp.chat.send({text:"Same-origin task",requestId:"same-once"})')).ok, true);
  report.cases.push('Same-origin iframe uses the same public function and postMessage channel.');
  await frame(deniedOrigin).executeJavaScript('window.answer=null;addEventListener("message",e=>{if(e.data.type==="response")answer=e.data});parent.postMessage({channel:"soduwork.app/v1",type:"request",id:"denied",method:"composer.send",params:{text:"Rejected",requestId:"denied"}},' + JSON.stringify(origin) + ')');
  await frame(childOrigin).executeJavaScript('parent.postMessage({channel:"soduwork.app/v1",type:"request",id:"secret",method:"mcp.connect",params:{server:"bad"}},' + JSON.stringify(origin) + ')');
  await delay(250);
  assert.deepEqual(await js(composer.webContents, 'received'), ['Cross-origin task', 'Same-origin task']);
  assert.equal(await frame(deniedOrigin).executeJavaScript('answer'), null);
  report.cases.push('Unlisted origin and arbitrary MCP method are rejected before native dispatch.');
  assert.equal((await frame(childOrigin).executeJavaScript('soduWorkApp.settings.update({values:{ukey:"cross-origin-fixture-secret",theme:"dark"}})')).ok,true);
  assert.equal((await frame(childOrigin).executeJavaScript('soduWorkApp.settings.get({keys:["ukey"],includeSecrets:true})')).values.ukey,'cross-origin-fixture-secret');
  assert.equal((await frame(childOrigin).executeJavaScript('soduWorkApp.settings.get()')).values.ukey,undefined);
  await frame(deniedOrigin).executeJavaScript('parent.postMessage({channel:"soduwork.app/v1",type:"request",id:"denied-setting",method:"settings.update",params:{values:{ukey:"attacker"}}},' + JSON.stringify(origin) + ')');
  await delay(200);
  assert.equal((await js(application.webContents,'soduWorkApp.settings.get({keys:["ukey"],includeSecrets:true})')).values.ukey,'cross-origin-fixture-secret');
  report.cases.push('Authorized cross-origin H5 updates arbitrary own-app settings and explicitly reads ukey; ordinary reads mask it and unlisted origins cannot replace it.');
  const before = await js(composer.webContents, 'received.length');
  await js(chrome.webContents, 'soduWorkWindowChrome.action("refresh")');
  await until(() => !application.webContents.isLoading() && application.webContents.mainFrame.frames.length === 3, 'shell page reload');
  assert.equal(await js(composer.webContents, 'received.length'), before);
  assert.equal(await js(composer.webContents, 'draft.value'), 'User draft kept');
  report.cases.push('Production title-bar Refresh reloads application only and retains its composer state.');
  report.ok = true;
}).catch(error => { report.error = String(error.stack || error); }).finally(async () => {
  host?.destroy(); windows.forEach(win => { if (!win.isDestroyed()) win.destroy(); });
  for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  const output = path.resolve(__dirname, '../../outputs/app-h5-postmessage-20261020'); fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
});
