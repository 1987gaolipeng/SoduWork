'use strict';
// Author metadata or laptop defaults -> production plugin/preload -> native window.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 60000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, WebContentsView, ipcMain, screen, safeStorage } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
  const { pathToFileURL } = require('node:url'), assert = require('node:assert/strict');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-app-sizing-'));
  const out = path.resolve(__dirname, '../../outputs/app-window-defaults-20261021');
  fs.mkdirSync(out, { recursive: true }); app.setPath('userData', path.join(temp, 'profile'));
  const report = { ok: false, cases: [], boundary: 'Isolated profile, authored metadata/default sizes and production plugin/preload/native-window chain. DOM actions exercise handlers; no claim of physical mouse input. Loopback app and minimal composer; no user account, business project or model requests.' };
  const windows = [], views = [], options = [];
  let host, server;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (check, label) => { for (let i = 0; i < 180; i++) { if (await check()) return; await delay(25); } throw Error('Timed out: ' + label); };
  app.on('window-all-closed', () => {});
  app.whenReady().then(async () => {
    const asset = file => pathToFileURL(path.resolve(__dirname, '..', file)).href;
    fs.writeFileSync(path.join(temp, 'host.html'), '<!doctype html><meta charset="utf-8"><title>Window settings regression</title>' +
      '<link rel="stylesheet" href="' + asset('theme/variables.css') + '">' +
      '<link rel="stylesheet" href="' + asset('components/panels/panels-apps.css') + '">' +
      '<style>body{margin:0;background:var(--bg-1);font:14px "Segoe UI",sans-serif}</style>' +
      ['core/app-window-sizing.js', 'components/panels/panels-apps.js', 'components/panels/plugin-ui-host.js']
        .map(file => '<script src="' + asset(file) + '"></script>').join(''));
    fs.writeFileSync(path.join(temp, 'composer.html'), '<!doctype html><textarea></textarea>');
    server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>Sizing fixture</title>'); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    // Size checks still exercise the settings panel; its storage now uses IPC.
    const settings = require('../main/app-settings-store.cjs');
    settings.configure({ app, safeStorage, ownerOf: () => 'sizing-fixture' });
    for (const action of ['get','update']) ipcMain.handle('app-settings-' + action,
      (_event, pluginId, input) => settings[action]({ pluginId, origin:base }, input));
    require('../main/work-preview').install({ app, ipcMain, screen,
      BrowserWindow: Object.assign(function (opts) { options.push(opts); const win = new BrowserWindow(opts); windows.push(win); return win; },
        { fromWebContents: wc => BrowserWindow.fromWebContents(wc) }),
      WebContentsView: function (opts) {
        const view = new WebContentsView(opts); views.push(view);
        const loadFile = view.webContents.loadFile.bind(view.webContents);
        view.webContents.loadFile = (file, query) => loadFile(path.basename(file) === 'desk.html' ? path.join(temp, 'composer.html') : file, query);
        return view;
      }, shell: { openExternal: async () => { throw Error('External navigation forbidden'); } } });
    host = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: {
      preload: path.resolve(__dirname, '../preload.js'), contextIsolation: true, nodeIntegration: false } });
    await host.loadFile(path.join(temp, 'host.html'));
    const js = source => host.webContents.executeJavaScript(source);
    await js(`window.fixture={item:{pluginId:'local:sizing',personal:true,name:'示例云端资料库',installed:true,enabled:true},title:'示例云端资料库',row:{id:'main',slot:'workspace.navigation',source:{type:'external',url:${JSON.stringify(base)}}}};
      window.SoduWorkAPI={pluginCatalog:async()=>({items:[fixture.item]})};
      localStorage.setItem('soduwork-app-settings:local:sizing',JSON.stringify({model:'fixture-model',params:{temperature:0.7},custom:'preserve'}));
      localStorage.setItem('soduwork-app-settings:local:other','{"model":"other"}');
      openAppSettings(fixture);`);
    assert.equal(await js('document.querySelectorAll("[data-window-field]").length'), 0);
    assert.equal(await js('(async()=> (await appSettingsOf("local:sizing")).values.model)()'), 'fixture-model');
    assert.equal(await js('document.querySelectorAll("#appsSetModel").length'), 0, 'Only declared application preferences render');
    await js('closeAppSettings();saveAppSettings("local:sizing",{values:{window:{width:"100vw",height:"100vh"},model:"fixture-model"}})');
    report.cases.push('App settings contain no size configuration; old per-user fullscreen overrides are ignored.');
    const display = await js('soduWorkAPI.workPreview.windowDisplay()');
    const expected = require('../core/app-window-sizing').opening(undefined, display.workArea);
    await js('PluginUIHost.openContribution(fixture.row,{item:fixture.item,detached:true})');
    await until(() => windows.length === 1 && windows[0].isVisible(), 'configured window');
    const first = windows[0];
    for (const key of ['x', 'y', 'width', 'height']) assert.equal(options[0][key], expected.normalBounds[key]);
    assert.deepEqual(first.getMinimumSize(), [expected.limits.minWidth, expected.limits.minHeight]);
    assert.equal(options[0].maxWidth, undefined); assert.equal(options[0].maxHeight, undefined);
    report.display = display; report.requestedBounds = expected.bounds;
    report.initialBounds = first.getBounds(); report.initialContentBounds = first.getContentBounds(); report.initialMaximized = first.isMaximized();
    if (!expected.startMaximized) {
      assert.ok(Math.abs(first.getBounds().width - expected.bounds.width) <= 1, 'Native width rounds by at most one logical pixel at fractional DPI');
      assert.ok(Math.abs(first.getBounds().height - expected.bounds.height) <= 1, 'Native height rounds by at most one logical pixel at fractional DPI');
    }
    if (expected.bounds.width === display.workArea.width && expected.bounds.height === display.workArea.height) {
      assert.equal(first.isMaximized(), true, 'A screen-filling opening needs a real maximized state so Restore can shrink it');
      first.unmaximize(); await until(() => !first.isMaximized(), 'restore initial large window');
      report.restoredBounds = first.getBounds();
      assert.ok(first.getBounds().width < display.workArea.width - 20 && first.getBounds().height < display.workArea.height - 20, 'Restore must produce a visibly smaller window');
      assert.ok(Math.abs(first.getBounds().width - expected.normalBounds.width) <= 1 && Math.abs(first.getBounds().height - expected.normalBounds.height) <= 1, 'Native restored bounds match the requested smaller normal window');
      first.setSize(600,450);
      await until(() => Math.abs(first.getBounds().width-600)<=1 && Math.abs(first.getBounds().height-450)<=1,'restored window can shrink well below startup size');
      report.userResizedBounds = first.getBounds();
      await delay(550); assert.equal(first.isMaximized(),false,'Late load/reveal callbacks must not maximize the restored window again');
      first.maximize(); await until(() => first.isMaximized(), 'maximize initial large window again');
      const chrome = first.contentView.children[0].webContents;
      await chrome.executeJavaScript('soduWorkWindowChrome.action("maximize")');
      await until(() => !first.isMaximized(), 'title bar action restores user size');
      assert.deepEqual(first.getBounds(),report.userResizedBounds,'Subsequent restore retains the user-resized window');
      await chrome.executeJavaScript('soduWorkWindowChrome.action("maximize")');
      await until(() => first.isMaximized(), 'title bar action maximizes again');
    }
    report.cases.push('An unconfigured app requests 1800x1125; a screen-filling opening is genuinely maximized, restores smaller on the first toggle, can shrink to 600x450, and remembers the user size across later maximize/restore actions.');
    await js(`fixture.item.appWindow={width:600,height:450,minWidth:300,minHeight:200,maxWidth:640,maxHeight:480};
      PluginUIHost.openContribution(fixture.row,{item:fixture.item,detached:true})`);
    assert.equal(windows.length, 1); assert.deepEqual(first.getBounds(), report.initialBounds);
    first.close(); await until(() => first.isDestroyed(), 'close first window');
    await js('PluginUIHost.openContribution(fixture.row,{item:fixture.item,detached:true})');
    await until(() => windows.length === 2 && windows[1].isVisible(), 'new configured window');
    const second = windows[1]; assert.equal(options[1].width, 600); assert.equal(options[1].height, 450);
    second.maximize(); await until(() => second.isMaximized(), 'native maximize');
    assert.ok(second.getBounds().width > 640); second.unmaximize(); await until(() => !second.isMaximized(), 'restore');
    second.setFullScreen(true); await until(() => second.isFullScreen(), 'native fullscreen');
    assert.ok(second.getBounds().height > 480); second.setFullScreen(false); await until(() => !second.isFullScreen(), 'exit fullscreen');
    report.cases.push('Changing authored plugin metadata leaves the existing native window intact; close/reopen applies new dimensions. A 640×480 opening cap allows native maximize and fullscreen above both caps.');
    report.ok = true;
  }).catch(error => { report.error = String(error.stack || error); }).finally(async () => {
    if (host && !host.isDestroyed()) host.destroy();
    for (const win of windows) if (!win.isDestroyed()) win.destroy();
    for (const view of views) if (view.webContents && !view.webContents.isDestroyed()) view.webContents.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
  });
}
