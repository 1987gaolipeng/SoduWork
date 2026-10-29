'use strict';
// Native application identity and real per-turn MCP transport, using only loopback fixtures.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const result = require('node:child_process').spawnSync(electron, [__filename, '--disable-gpu'], { env, windowsHide: true, stdio: 'inherit', timeout: 60000 });
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, WebContentsView, ipcMain, safeStorage } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const assert = require('node:assert/strict');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-app-rebind-'));
app.setPath('userData', path.join(root, 'profile')); app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const windows = [], leases = [], seen = [];
const report = { ok: false, cases: [], boundary: 'Isolated Electron native app/composer ownership, production application connection/grant/proxy and loopback MCP. Conversation handle is a fixture; opening IPC reuse is covered by access-open.test.cjs. No user data, business service or model calls.' };
let host, server;
const js = (wc, code) => wc.executeJavaScript(code);
const until = async (check, label) => {
  for (let i = 0; i < 300; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw Error('Timed out: ' + label);
};
app.whenReady().then(async () => {
  server = http.createServer((req, res) => {
    if (req.url !== '/mcp') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<!doctype html><title>Isolated application</title>'); return;
    }
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const rpc = JSON.parse(body); seen.push(req.headers.authorization);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: 'fixture account' }] } }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const caps = ['settings.read', 'settings.write', 'mcp.connect'];
  const plugin = require('../main/personal-plugins').create(app, {
    key: 'app-rebind', template: 'app', name: 'Application connection fixture', version: '0.1.0',
    description: 'Fixture only', instructions: 'Fixture only', mcpServers: 'media-ops-cloud',
    ui: { contributions: [{ id: 'main', title: 'Fixture', slot: 'workspace.navigation',
      source: { type: 'external', url: origin, bridge: { version: 1, capabilities: caps } } }] },
  }).plugin;
  require('../main/app-settings-store.cjs').configure({ app, safeStorage, ownerOf: () => 'isolated-owner' });
  fs.writeFileSync(path.join(root, 'host.html'), '<!doctype html><script>window.PluginUIHost={assertUse:async()=>{}};</script><script>' + fs.readFileSync(path.resolve(__dirname, '../components/panels/soduwork-app-bridge-host.js'), 'utf8') + '</script>');
  fs.writeFileSync(path.join(root, 'composer.html'), '<!doctype html><title>Isolated composer</title>');
  const preview = require('../main/work-preview');
  preview.install({ app, ipcMain,
    BrowserWindow: Object.assign(function (options) { const win = new BrowserWindow(options); windows.push(win); return win; }, { fromWebContents: wc => BrowserWindow.fromWebContents(wc) }),
    WebContentsView: function (options) {
      const view = new WebContentsView(options), load = view.webContents.loadFile.bind(view.webContents);
      view.webContents.loadFile = (file, options) => load(path.basename(file) === 'desk.html' ? path.join(root, 'composer.html') : file, options);
      return view;
    }, shell: { openExternal: async () => { throw Error('Unexpected external navigation'); } } });
  host = new BrowserWindow({ show: false, webPreferences: { preload: path.resolve(__dirname, '../preload.js'), contextIsolation: true, sandbox: true } });
  await host.loadFile(path.join(root, 'host.html'));
  const payload = { tabId: 'rebind', url: origin, appBridge: { appId: 'plugin:' + plugin.pluginId, contributionId: 'main', origin, version: 1, capabilities: caps } };
  const shown = await js(host.webContents, 'soduWorkAPI.workPreview.showDetached(' + JSON.stringify(payload) + ')');
  assert.equal(shown.ok, true, shown.reason);
  const [, application, composer] = windows[0].contentView.children;
  await until(() => !application.webContents.isLoading() && !composer.webContents.isLoading(), 'native views loaded');
  const bridgeCall = (method, params) => js(application.webContents, 'soduWorkAppBridge.request(' + JSON.stringify(method) + ',' + JSON.stringify(params) + ')');
  assert.equal((await bridgeCall('settings.update', { values: { ukey: 'fixture-account-a' } })).ok, true);
  assert.equal((await bridgeCall('mcp.connect', { server: 'media-ops-cloud', url: origin + '/mcp', credentialKey: 'ukey' })).ok, true);
  const ownership = require('../main/pi-session/app-mcp-grant.cjs'), grants = require('../main/pi-session/plugin-grant');
  let handle = { snapshot: () => ({ activePlugins: [] }) };
  ownership.bind(handle, host.webContents, '', app);
  assert.equal(ownership.forSession(handle), null);
  // The resolver remains the same function while the native owner changes.
  const resolve = async () => {
    const result = await grants.resolve({ app, pluginIds: [plugin.pluginId], cwd: root,
      appContext: ownership.forSession(handle), identityOf: async () => { throw Error('Application connection must not request a Hub connector'); } });
    leases.push(result.grant); return JSON.parse(fs.readFileSync(result.grant.configFile)).servers['media-ops-cloud'];
  };
  ownership.bind(handle, composer.webContents, plugin.pluginId, app);
  const firstTurn = {}; ownership.guardSend(handle, firstTurn); await firstTurn.beforeTurn();
  const first = await resolve();
  handle.snapshot = () => ({ activePlugins: [plugin.pluginId] });
  assert.ok(!JSON.stringify(first).includes('fixture-account-a'));
  const call = config => fetch(config.url, { method: 'POST', headers: { ...config.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } }) });
  assert.equal((await call(first)).status, 200); assert.equal(seen.at(-1), 'Bearer fixture-account-a');
  report.cases.push('The same resolver follows main-window to native-app rebinding; its declared local MCP calls the loopback service through the production proxy without a Hub connector request or exposing stored credentials.');
  const queued = {}; ownership.guardSend(handle, queued);
  await bridgeCall('settings.update', { values: { ukey: 'fixture-account-b' } });
  await assert.rejects(queued.beforeTurn(), /账号或设置已变化/);
  assert.equal((await call(first)).status, 401);
  const fresh = {}; ownership.guardSend(handle, fresh); await fresh.beforeTurn();
  assert.equal((await call(await resolve())).status, 200); assert.equal(seen.at(-1), 'Bearer fixture-account-b');
  ownership.bind(handle, host.webContents, '', app);
  const mainTurn = {}; ownership.guardSend(handle, mainTurn); await mainTurn.beforeTurn();
  assert.equal(ownership.forSession(handle).pluginId, plugin.pluginId);
  assert.equal((await call(await resolve())).status, 200);
  windows[0].destroy();
  const afterClose = {}; ownership.guardSend(handle, afterClose); await afterClose.beforeTurn();
  assert.equal((await call(await resolve())).status, 200);
  handle = { snapshot: () => ({ activePlugins: [plugin.pluginId] }) };
  ownership.bind(handle, host.webContents, '', app);
  const restored = {}; ownership.guardSend(handle, restored); await restored.beforeTurn();
  assert.equal((await call(await resolve())).status, 200);
  assert.equal(seen.at(-1), 'Bearer fixture-account-b');
  handle = { snapshot: () => ({ activePlugins: [] }) };
  ownership.bind(handle, host.webContents, '', app);
  const slash = { pluginIds: [plugin.pluginId] }; ownership.guardSend(handle, slash); await slash.beforeTurn();
  assert.equal((await call(await resolve())).status, 200);
  report.cases.push('An unrelated main-window conversation explicitly selecting the application can use its stored connection, without an application project group or an open application window.');
  report.cases.push('A credential change rejects queued old-account work and the old lease; a new turn uses the new account. The main window continues the same application conversation, including after its native window closes and a fresh handle restores the saved application selection.');
  // Exercise the production transcript card and its actual delegated click/open chain.
  const item = require('../main/personal-plugins').get(app, plugin.pluginId);
  // The isolated host is not desk.html. Keep its settings read account-scoped;
  // production desk-only IPC authorization is covered by app-settings.test.cjs.
  ipcMain.handle('app-settings-get', (event, id) => {
    assert.equal(event.sender, host.webContents); assert.equal(id, plugin.pluginId);
    return require('../main/app-settings-store.cjs').get({ pluginId: id, origin });
  });
  await js(host.webContents, 'window.fixtureCatalog=' + JSON.stringify({ items: [item] }) + ';window.SoduWorkAPI={pluginCatalog:async()=>fixtureCatalog,taskStorageKey:()=>"fixture-owner"};' +
    'document.head.insertAdjacentHTML("beforeend",' + JSON.stringify('<link rel="stylesheet" href="' + require('node:url').pathToFileURL(path.resolve(__dirname, '../theme/variables.css')).href + '"><link rel="stylesheet" href="' + require('node:url').pathToFileURL(path.resolve(__dirname, '../components/panels/panels-chat.css')).href + '"><link rel="stylesheet" href="' + require('node:url').pathToFileURL(path.resolve(__dirname, '../components/panels/panels-apps.css')).href + '"><style>body{margin:0;padding:20px;background:var(--bg-0);font:14px sans-serif}#aux{display:none}</style>') + ');' +
    'document.body.innerHTML=\'<section id="fixture"><div id="nchatList" class="nchat-inner"></div><div id="aux"><textarea id="nchatInput"></textarea><button id="nchatSend"></button><div id="nchatQueue"></div><div id="nchatTaskSuggest"></div><button id="nchatWd"></button></div></section>\';');
  for (const source of ['core/plugin-icon.js', 'components/panels/chat-plugin-mention-model.js',
    'components/panels/chat-message-plugins.js', 'components/panels/plugin-ui-host.js',
    'components/panels/panels-apps.js', 'components/panels/chat-composer-bindings.js']) {
    await js(host.webContents, fs.readFileSync(path.resolve(__dirname, '..', source), 'utf8') + '\nvoid 0;');
  }
  await js(host.webContents, 'window.cardPaint=()=>{nchatList.innerHTML=\'<p>本轮已完成</p><div class="nmessage-app-cards">\'+cardView.cards([{pluginId:' + JSON.stringify(plugin.pluginId) + '}])+\'</div>\'};' +
    'window.cardView=ChatMessagePlugins.create({esc:v=>String(v).replace(/[&<>"\x27]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",\'"\':"&quot;","\x27":"&#39;"}[c])),_ref:"fixture"},cardPaint);' +
    'cardPaint();ChatComposerBindings.create({_ref:"fixture",_sessionOptions:{},_snap:{},_paintBar(){}})._bind(document.getElementById("fixture"));');
  await until(() => js(host.webContents, '!!document.querySelector("[data-chat-open-app]")'), 'application card');
  await js(host.webContents, 'document.querySelector(".appsx-fav").click()');
  assert.equal(await js(host.webContents, 'document.querySelector(".appsx-fav").getAttribute("aria-pressed")'), 'true');
  assert.equal(await js(host.webContents, 'SoduWorkApps.favoriteAppIds().includes(' + JSON.stringify(plugin.pluginId) + ')'), true);
  await js(host.webContents, 'document.querySelector(".appsx-set").click()');
  await until(() => js(host.webContents, 'document.querySelector("#appsSettingsMask")?.classList.contains("show")'), 'application card settings');
  await js(host.webContents, 'document.querySelector("#appsSetClose").click()');
  assert.equal(windows.filter(win => !win.isDestroyed()).length, 0, 'settings and favorite clicks never open the app');
  // Compare the same Mine renderer at the catalog's standard two-column width.
  host.setContentSize(1080, 400);
  await js(host.webContents, 'const baseline=document.createElement("div");baseline.id="mineBaseline";baseline.style.cssText="width:1080px;padding:0 36px;position:absolute;top:180px;left:0";baseline.innerHTML=\'<div class="appsx-grid">\'+appsCardHtml({item:fixtureCatalog.items[0],title:fixtureCatalog.items[0].name,desc:fixtureCatalog.items[0].description},0,false)+\'</div>\';document.body.appendChild(baseline)');
  const compared = await js(host.webContents, `(()=>{const card=document.querySelector('.nmessage-app-card'),mine=document.querySelector('#mineBaseline .appsx-card');
    const style=e=>{const s=getComputedStyle(e);return ['fontFamily','fontSize','fontWeight','lineHeight','padding','gap','borderRadius'].map(k=>s[k])};
    const chat=document.querySelector('#nchatList'),chatStyle=getComputedStyle(chat);
    return {widths:[card.getBoundingClientRect().width,mine.getBoundingClientRect().width],
      contentWidth:chat.clientWidth-parseFloat(chatStyle.paddingLeft)-parseFloat(chatStyle.paddingRight),
      title:[style(card.querySelector('b')),style(mine.querySelector('b'))],description:[style(card.querySelector('small')),style(mine.querySelector('small'))],
      icon:[style(card.querySelector('.appsx-app-ico')),style(mine.querySelector('.appsx-app-ico'))],border:getComputedStyle(card).borderWidth}})()`);
  assert.equal(compared.widths[0], compared.contentWidth, 'card now follows the conversation content width');
  assert.ok(compared.widths[0] > compared.widths[1], 'wide conversations provide more room than the old fixed Mine width');
  for (const key of ['title','description','icon']) assert.deepEqual(compared[key][0], compared[key][1], key + ' matches Mine');
  assert.equal(compared.border, '0px');
  await js(host.webContents, 'document.querySelector("#mineBaseline").remove()');
  await new Promise(resolve => setTimeout(resolve, 100));
  const evidence = path.resolve(__dirname, '../../outputs/app-chat-rebind-20261023'); fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(evidence, 'application-card-wide.png'), (await host.webContents.capturePage()).toPNG());
  const beforeOpen = windows.length;
  await js(host.webContents, 'document.querySelector("[data-chat-open-app]").click()');
  await until(() => windows.length === beforeOpen + 1, 'application card opens native app');
  await until(() => !windows.at(-1).contentView.children[1].webContents.isLoading(), 'application card page loaded');
  assert.equal(windows.at(-1).contentView.children[1].webContents.getURL().startsWith(origin), true);
  await until(() => js(host.webContents, '!document.querySelector("[data-chat-open-app]").disabled'), 'application open action settled');
  await js(host.webContents, 'document.querySelector("[data-chat-open-app]").click()');
  await until(() => js(host.webContents, '!document.querySelector("[data-chat-open-app]").disabled'), 'second application open');
  assert.equal(windows.length, beforeOpen + 1, 'reopening focuses the same app window just like the app list');
  const sizes = [];
  for (const width of [760, 640, 520, 500, 460, 360, 280, 220, 640]) {
    await js(host.webContents, 'document.querySelector("#fixture").style.width=' + JSON.stringify(width + 'px'));
    await new Promise(resolve => setTimeout(resolve, 40));
    const size = await js(host.webContents, `(()=>{const card=document.querySelector('[data-chat-app]'),copy=card.querySelector('.appsx-card-txt'),button=card.querySelector('[data-chat-open-app]');
      return {width:card.getBoundingClientRect().width,container:card.parentElement.clientWidth,copy:copy.clientWidth,
        open:getComputedStyle(button).display!=='none',overflow:card.scrollWidth>card.clientWidth,
        title:getComputedStyle(copy.querySelector('b')).textOverflow,description:getComputedStyle(copy.querySelector('small')).textOverflow}})()`);
    assert.equal(size.width, size.container); assert.equal(size.overflow, false, 'no overflow at pane width ' + width);
    assert.equal(size.open, size.container > 420); assert.equal(size.title, 'ellipsis'); assert.equal(size.description, 'ellipsis');
    sizes.push(size);
  }
  assert.ok(sizes[0].copy > sizes[1].copy && sizes[1].copy > sizes[2].copy && sizes[2].copy > sizes[3].copy,
    'text shrinks first while the pill remains visible');
  assert.equal(sizes[0].open, true); assert.equal(sizes[4].open, false); assert.equal(sizes.at(-1).open, true);
  await js(host.webContents, 'document.querySelector("#fixture").style.width="360px"');
  await new Promise(resolve => setTimeout(resolve, 40));
  await js(host.webContents, 'document.querySelector(".appsx-card-txt b").click()');
  await until(() => js(host.webContents, '!document.querySelector("[data-chat-app]").hasAttribute("aria-busy")'), 'narrow card title opens app');
  for (const key of ['Enter', ' ']) {
    await js(host.webContents, 'document.querySelector("[data-chat-app]").dispatchEvent(new KeyboardEvent("keydown",{key:' + JSON.stringify(key) + ',bubbles:true,cancelable:true}))');
    await until(() => js(host.webContents, '!document.querySelector("[data-chat-app]").hasAttribute("aria-busy")'), 'card keyboard open');
  }
  assert.equal(windows.length, beforeOpen + 1, 'whole-card and keyboard opening retain one native app window');
  await js(host.webContents, 'document.querySelector("#fixture").style.width=""');
  host.setContentSize(360, 260);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await js(host.webContents, 'document.documentElement.scrollWidth<=innerWidth'), true);
  fs.writeFileSync(path.join(evidence, 'application-card.png'), (await host.webContents.capturePage()).toPNG());
  report.cases.push('Application cards retain Mine typography and controls, fill conversation content width and shrink text before hiding the pill below 420px; pane widths 220–760px fit without overflow and restore the pill when widened. Whole-card/title and Enter/Space opening focus the same native window; settings/favorites remain independent. DOM events test handlers, not physical mouse input.');
  report.ok = true;
}).catch(error => { report.error = String(error.stack || error); }).finally(async () => {
  for (const lease of leases) lease?.cleanup();
  host?.destroy(); for (const win of windows) if (!win.isDestroyed()) win.destroy();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  const output = path.resolve(__dirname, '../../outputs/app-chat-rebind-20261023'); fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'native-connection-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
});
