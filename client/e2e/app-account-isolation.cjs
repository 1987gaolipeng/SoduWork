'use strict';
// Real native IPC with synthetic accounts and package bytes; no Hub or model.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const result = require('node:child_process').spawnSync(electron, [__filename, ...process.argv.slice(2)],
    { env, windowsHide: true, stdio: 'inherit', timeout: 60000 });
  if (result.error) console.error(result.error);
  process.exitCode = result.status ?? 1;
} else {
  const { app, BrowserWindow, WebContentsView, ipcMain, safeStorage } = electron;
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-native-account-'));
  const output = path.resolve(process.argv[2] || path.join(temporary, 'evidence'));
  fs.mkdirSync(output, { recursive: true });
  app.setPath('userData', path.join(temporary, 'profile'));
  app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
  const report = { ok: false, cases: [], boundary: 'Actual Electron WebContents, restricted app preload and main IPC; synthetic accounts, in-memory catalog/package bytes, no company service or model.' };
  const windows = [], views = [], handlers = new Map();
  let owner = 'fixture-hub/account-a', token = 'synthetic-session-a', fetches = 0, host;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (action, label) => { for (let i = 0; i < 200; i++) { if (await action()) return; await pause(25); } throw Error('Timed out: ' + label); };
  const js = (wc, code) => wc.executeJavaScript(code);
  app.whenReady().then(async () => {
    const store = require('../main/app-settings-store.cjs'), resources = require('../main/plugin-resources');
    const contract = require('../core/plugin-package-page.cjs');
    const pluginId = 'synthetic-account-app', origin = contract.origin(pluginId);
    const capabilities = require('../main/soduwork-app-bridge-contract.cjs').CAPABILITIES;
    const ui = { contributions: [{ id: 'main', slot: 'workspace.navigation', source: {
      type: 'package', entry: 'ui/index.html', bridge: { version: 1, capabilities },
    } }] };
    const files = resources.normalize([{ path: 'ui/index.html', kind: 'ui', encoding: 'utf8', content: '<!doctype html><title>Account fixture</title><p>Isolated application</p>' }]);
    const installed = { pluginId, installed: true, enabled: true, permissions: { canUse: true }, ui, capabilities: { mcpServers: ['fixture'] } };
    store.configure({ app, safeStorage, ownerOf: () => owner });
    fs.writeFileSync(path.join(temporary, 'host.html'), '<!doctype html><script>window.requests=[];soduWorkAPI.workPreviewAppHost.onRequest(request=>requests.push(request));</script>');
    fs.writeFileSync(path.join(temporary, 'composer.html'), '<!doctype html><textarea id="draft">Retained draft</textarea>');
    require('../main/work-preview').install({ app,
      ipcMain: { handle(name, action) { handlers.set(name, action); ipcMain.handle(name, action); }, on: ipcMain.on.bind(ipcMain) },
      BrowserWindow: Object.assign(function(options) { const win = new BrowserWindow(options); windows.push(win); return win; }, { fromWebContents: wc => BrowserWindow.fromWebContents(wc) }),
      WebContentsView: function(options) { const view = new WebContentsView(options); views.push(view);
        const load = view.webContents.loadFile.bind(view.webContents);
        view.webContents.loadFile = (file, options) => load(path.basename(file) === 'desk.html' ? path.join(temporary, 'composer.html') : file, options);
        return view; },
      identityOf: async () => ({ hub: 'https://fixture.invalid', clientId: 'synthetic-device', session: token }),
      fetchImpl: async url => { fetches++; return Response.json(url.endsWith('/ui-package') ? { ui, resources: files } : { items: [installed] }); },
      shell: { openExternal: async () => { throw Error('External navigation forbidden'); } },
    });
    host = new BrowserWindow({ show: false, webPreferences: { preload: path.resolve(__dirname, '../preload.js'), contextIsolation: true, sandbox: true } });
    await host.loadFile(path.join(temporary, 'host.html'));
    const payload = { tabId: 'account-app', package: { pluginId, contributionId: 'main' } };
    const open = () => js(host.webContents, 'soduWorkAPI.workPreview.showDetached(' + JSON.stringify(payload) + ')');
    assert.equal((await open()).ok, true);
    const [, page, composer] = windows.at(-1).contentView.children, firstId = page.webContents.id, firstSession = page.webContents.session;
    await until(() => page.webContents.getTitle() === 'Account fixture', 'initial app page');
    store.update({ pluginId, origin }, { values: { token: 'synthetic-account-a-value' } });
    assert.equal((await js(page.webContents, "soduWorkAppBridge.settings.get({keys:['token'],includeSecrets:true})")).values.token, 'synthetic-account-a-value');
    token = 'synthetic-renewed-account-a';
    assert.equal((await open()).reused, true);
    assert.equal((await js(page.webContents, "soduWorkAppBridge.settings.get({keys:['token'],includeSecrets:true})")).values.token, 'synthetic-account-a-value');
    report.cases.push('same-account token renewal preserves the existing native app');

    const queueContext = async expected => {
      await js(page.webContents, 'window.contextResult=null;void soduWorkAppBridge.context.get().then(value=>{contextResult=value});');
      await until(() => js(host.webContents, 'requests.length===' + expected), 'forwarded pending request');
      return js(host.webContents, 'requests.at(-1).id');
    };
    const id = await queueContext(1);
    assert.equal((await js(host.webContents, 'soduWorkAPI.workPreviewAppHost.authorize(' + JSON.stringify(id) + ')')).ok, true);
    assert.equal(handlers.get('work-preview-app-authorize')({ sender: page.webContents }, id).ok, false);
    assert.equal(handlers.get('work-preview-app-authorize')({ sender: composer.webContents }, id).ok, false);
    assert.equal(handlers.get('work-preview-app-authorize')({ sender: host.webContents }, 'unknown').ok, false);
    await js(host.webContents, 'soduWorkAPI.workPreviewAppHost.respond(' + JSON.stringify(id) + ',{ok:true})');
    await until(() => js(page.webContents, 'contextResult?.ok===true'), 'valid parent response');
    assert.equal(handlers.get('work-preview-app-authorize')({ sender: host.webContents }, id).ok, false);
    report.cases.push('only the actual pending parent sender authorizes; unknown and completed IDs are rejected');

    const delayedId = await queueContext(2);
    owner = 'fixture-hub/account-b'; token = 'synthetic-session-b';
    store.update({ pluginId, origin }, { values: { token: 'synthetic-account-b-value' } });
    assert.equal(handlers.get('work-preview-app-authorize')({ sender: host.webContents }, delayedId).ok, false);
    await js(host.webContents, 'soduWorkAPI.workPreviewAppHost.respond(' + JSON.stringify(delayedId) + ',{ok:true,secret:"must-not-return"})');
    await until(() => js(page.webContents, 'contextResult?.ok===false'), 'stale pending response denied');
    assert.doesNotMatch(JSON.stringify(await js(page.webContents, 'contextResult')), /must-not-return/);
    const methods = [
      ['settings.get', { keys: ['token'], includeSecrets: true }],
      ['settings.update', { values: { token: 'wrong-owner-write' } }],
      ['mcp.connect', { server: 'fixture', url: origin + '/mcp', credentialKey: 'token' }],
      ['attachments.pick', {}], ['attachments.begin', { name: 'empty.txt', size: 0 }],
      ['automation.create', { text: 'Synthetic task', requestId: 'stale', context: { spaceId: 'fixture' } }],
      ['composer.send', { text: 'stale', requestId: 'stale' }], ['composer.expand', {}],
      ['notifications.send', { recipientUserId: 'fixture', text: 'stale' }],
      ['conversation.open', {}],
    ];
    const priorFetches = fetches;
    for (const [method, params] of methods) {
      const result = await js(page.webContents, 'soduWorkAppBridge.request(' + JSON.stringify(method) + ',' + JSON.stringify(params) + ')');
      assert.equal(result.ok, false, method);
      assert.match(result.reason, /account changed/i, method);
      assert.equal(Object.hasOwn(result, 'values'), false, method);
    }
    assert.equal(fetches, priorFetches, 'no stale request may resolve a new-account catalog or credentials');
    assert.equal(store.get({ pluginId, origin }, { keys: ['token'], includeSecrets: true }).values.token, 'synthetic-account-b-value');
    assert.equal(store.get({ pluginId, origin }).revision, 1);
    const grant = require('../main/pi-session/app-mcp-grant.cjs');
    assert.throws(() => grant.context(composer.webContents, pluginId, undefined, app), { code: 'APP_ACCOUNT_CHANGED' });
    const priorViews = views.length;
    assert.equal(await js(page.webContents, "window.open(location.href)===null"), true);
    await pause(50); assert.equal(views.length, priorViews);
    report.cases.push('retained A page, composer and queued requests reject all B actions without credential reads or writes');
    report.cases.push('stale popup cannot create a new view under the next account');

    assert.equal((await open()).reused, undefined);
    const [, current] = windows.at(-1).contentView.children;
    await until(() => current.webContents.getTitle() === 'Account fixture', 'new account app page');
    assert.notEqual(current.webContents.id, firstId);
    assert.notEqual(current.webContents.session, firstSession);
    assert.equal((await js(current.webContents, "soduWorkAppBridge.settings.get({keys:['token'],includeSecrets:true})")).values.token, 'synthetic-account-b-value');
    assert.equal((await open()).reused, true);
    report.cases.push('B deliberately reopening the same app creates a new isolated view and may access only B settings');
    report.ok = true;
  }).catch(error => { report.error = error.stack; console.error(error); }).finally(() => {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    for (const win of BrowserWindow.getAllWindows()) { try { win.destroy(); } catch (_) {} }
    app.exit(report.ok ? 0 : 1);
  });
}
