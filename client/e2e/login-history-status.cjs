'use strict';

// Real Electron auth, preload, sidebar, device-auth, SQLite and native opener.
// Hub responses and optional capability services are synthetic; no model turn runs.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 90000);
  child.on('error', error => { clearTimeout(timer); console.error(error); process.exitCode = 1; });
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain, protocol, net } = electron;
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const http = require('node:http'), assert = require('node:assert/strict');
  const { pathToFileURL } = require('node:url');
  const profile = require('./lib/isolated-profile.cjs').isolateProfile(app, 'login-history-status');
  const client = path.resolve(__dirname, '..'), report = { ok: false, checks: [], evidence: profile.root };
  app.commandLine.appendSwitch('use-mock-keychain');
  app.on('window-all-closed', () => {});
  let server, win, shared, bridge, sdk, originalRuntimeCreate, originalPrepare;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(expression, label) {
    for (let i = 0; i < 250; i++) {
      if (await win.webContents.executeJavaScript(expression)) return;
      await sleep(20);
    }
    throw Error('Lifecycle did not settle: ' + label);
  }
  function token(uid, device) {
    const now = Math.floor(Date.now() / 1000);
    return Buffer.from(JSON.stringify({ typ: 'device', uid, cid: device, iat: now - 1, exp: now + 3600 }))
      .toString('base64url') + '.' + 'a'.repeat(64);
  }
  async function login(account) {
    await until('!!document.querySelector("#soduWorkAuthAccount") && !document.querySelector(".soduwork-auth-submit").disabled', 'login form');
    const loaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    await win.webContents.executeJavaScript(`document.querySelector('#soduWorkAuthAccount').value=${JSON.stringify(account)};
      document.querySelector('#soduWorkAuthPassword').value='synthetic-password';
      document.querySelector('.soduwork-auth-form').requestSubmit();void 0;`);
    await Promise.race([loaded, sleep(6000).then(() => { throw Error('Login did not reload: ' + account); })]);
    await until(`SoduWorkAPI.clientAuthSnapshot().user?.id === ${JSON.stringify(account)}`, 'signed in ' + account);
    await until('document.querySelector("#soduWorkClientAuthGate")?.hidden === true', 'login gate closed');
  }
  async function logout() {
    const loaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    await win.webContents.executeJavaScript('document.querySelector("[data-logout]").click();void 0;');
    await until('!!document.querySelector("[data-ac-confirm]")', 'logout confirmation');
    await win.webContents.executeJavaScript('document.querySelector("[data-ac-confirm]").click();void 0;');
    await Promise.race([loaded, sleep(6000).then(() => { throw Error('Logout did not reload'); })]);
    await until('!SoduWorkAPI.clientAuthSnapshot().user && document.querySelector("#soduWorkClientAuthGate")?.checkVisibility()', 'signed out');
    assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll(".ws-chat").length'), 0);
  }
  async function rows() {
    return win.webContents.executeJavaScript('WorkspaceShell.searchChats().map(row=>[row.id,WorkspaceShell._chatState(row)]).sort()');
  }
  async function run() {
    await app.whenReady();
    let signedIn = '', device = '', inferenceRequests = 0;
    server = http.createServer((request, response) => {
      let raw = '';
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Access-Control-Allow-Headers', '*');
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'OPTIONS') { response.end('{}'); return; }
      request.on('data', chunk => { raw += chunk; });
      request.on('end', () => {
        const body = raw ? JSON.parse(raw) : {}, route = request.url.split('?')[0];
        if (body.device) device = body.device;
        const user = () => signedIn ? { id: signedIn, username: signedIn, displayName: signedIn } : null;
        const auth = () => ({ authState: signedIn ? 'active' : 'pending', activationRequired: !signedIn,
          user: user(), ...(signedIn ? { session: token(signedIn, device), expiresIn: 3600 } : {}) });
        if (route === '/api/v1/clients/enroll') response.end(JSON.stringify(auth()));
        else if (route === '/api/v1/client-auth/login') { signedIn = body.account; response.end(JSON.stringify(auth())); }
        else if (route === '/api/v1/client-auth/logout') { signedIn = ''; response.end('{"ok":true,"activationRequired":true}'); }
        else if (route === '/api/v1/client-auth/me') response.end(JSON.stringify({ user: user() }));
        else if (route === '/api/v1/client-auth/policy') response.end('{"mailReady":false,"allowSelfRegistration":false}');
        else { inferenceRequests++; response.writeHead(404); response.end('{"detail":"Unexpected synthetic Hub route"}'); }
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const hub = 'http://127.0.0.1:' + server.address().port;
    require('../main/hub-endpoint.cjs').initialize(app,
      { SODUWORK_TEST_HUB_URL: hub, SODUWORK_USER_DATA: profile.userData });
    const auth = require('../main/device-auth');
    auth.install({ app, ipcMain, safeStorage: { isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from('synthetic:' + value),
      decryptString: value => value.toString().slice('synthetic:'.length) } });
    ipcMain.handle('hub-connection-info', () => ({ hub, internalTest: true, editable: false }));
    ipcMain.handle('sys-info', () => ({ platform: process.platform, arch: process.arch }));
    ipcMain.handle('app-version', () => 'test');
    ipcMain.handle('work-root-default', () => profile.root);
    ipcMain.handle('runner-configure', () => ({ ok: true }));
    ipcMain.handle('recent-workspace-get', () => null);
    ipcMain.on('runtime-form', event => { event.returnValue = 'local-code'; });
    ipcMain.on('client-distribution-info', event => { event.returnValue = {}; });

    const engine = require('../main/pi-session/session'), config = require('../main/pi-session/model-config');
    const agentDir = config.agentDir(app), folder = path.join(agentDir, 'sessions', 'synthetic');
    fs.mkdirSync(folder, { recursive: true });
    const definitions = [['complete-one', 'alpha', false], ['complete-two', 'alpha', false], ['preflight-failure', 'alpha', false],
      ['real-failure', 'alpha', true], ['other-account', 'beta', false]];
    for (const [id, , failed] of definitions) fs.writeFileSync(path.join(folder, id + '.jsonl'), [
      { type: 'session', version: 3, id, cwd: profile.root, timestamp: '2026-11-10T00:00:00Z' },
      { type: 'message', id: id + '-request', parentId: null, timestamp: '2026-11-10T00:00:01Z',
        message: { role: 'user', content: [{ type: 'text', text: 'Synthetic request ' + id }], timestamp: 1794268801000 } },
      { type: 'message', id: id + '-answer', parentId: id + '-request', timestamp: '2026-11-10T00:00:02Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Saved synthetic answer ' + id }],
          stopReason: failed ? 'error' : 'stop', ...(failed ? { errorMessage: 'Synthetic provider failure' } : {}),
          timestamp: 1794268802000, usage: { input: 10, output: 5, totalTokens: 15 } } },
    ].map(value => JSON.stringify(value)).join('\n') + '\n');
    const archiveBytes = definitions.map(([id]) => fs.readFileSync(path.join(folder, id + '.jsonl'), 'utf8'));
    sdk = await import(pathToFileURL(path.join(client, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href);
    const model = { id: 'synthetic-model', label: 'Synthetic model', contextWindow: 200000,
      baseUrl: hub + '/model', key: 'synthetic-model-key', proxyExpiresAt: Date.now() + 3600000 };
    const modelsPath = config.writeModels(agentDir, model);
    originalPrepare = config.prepare; config.prepare = async () => ({ ok: true, provider: 'soduwork', agentDir, model });
    originalRuntimeCreate = sdk.ModelRuntime.create;
    sdk.ModelRuntime.create = () => originalRuntimeCreate.call(sdk.ModelRuntime, { modelsPath,
      authPath: path.join(agentDir, 'auth.json'), modelsStorePath: path.join(agentDir, 'models.db') });
    bridge = require('../main/agent-runtime/pi-session-bridge').createPiSessionBridge({ app, sessionModule: engine, runnerAdapters: [] });
    bridge.setExternalHistory({ history: async () => ({ ok: true, chats: [] }) });
    const store = require('../main/conversation/replica-store.cjs').create(path.join(profile.userData, 'history.sqlite'));
    const identity = () => require('../main/conversation/requirement-context').cachedIdentity(app);
    shared = require('../main/conversation/shared-history.cjs').create({ app, session: bridge, store, identityOf: identity });
    bridge.setReplicaHistory(shared);
    const archive = await engine.history(app, 50);
    await shared.register(archive.chats.map(row => {
      const [, owner, failed] = definitions.find(([id]) => id === row.id);
      return { ...row, adapterId: 'pi', state: failed || row.id === 'preflight-failure' ? 'failed' : 'completed',
        status: failed || row.id === 'preflight-failure' ? 'unreachable' : 'idle', creator: { account: owner, hub } };
    }));
    require('../main/pi-session/environment-ipc').install({ app, ipcMain, session: bridge,
      identityOf: async () => identity(), workDir: () => profile.root, _skillDirs: () => [], _conf: () => ({}) });
    const context = vm.createContext({ app, path, session: bridge, identityOf: async () => identity(), sendIdentityOf: null,
      _sharedHistory: shared, _accountSync: { isAccountConversation: () => false }, _cloudHandoff: { observe() {}, isRemote: () => false },
      memories: { context: async () => ({}), attach: async () => {}, assertOwner() {} },
      capabilities: { resolve: async () => ({ catalog: {}, selectedSkills: [], capabilityIds: [], skills: [], capabilities: [] }) },
      updateWorkloads: { guard: () => ({ ok: true }) }, capabilityGrantsOf: null, _skillDirs: () => [],
      _newSessionCwd: () => profile.root, _defaultCwd: () => profile.root, workDir: () => profile.root,
      _conf: () => ({ mode: 'readonly' }), attachments: require('../main/pi-session/attachments'),
      sessionSpec: require('../main/conversation/session-spec'), skillTurn: require('../main/pi-session/skill-turn'),
      pluginGrant: require('../main/pi-session/plugin-grant'), taskInput: { request: async () => { throw Error('Unexpected task request'); } },
      BrowserWindow, confirmFullAccess: async () => false, _entryContextPrompts: () => [],
      _awaitBounded: value => value, OPEN_TIMEOUT_MS: 45000,
      _sessionOwners: { bind() {}, quarantine() {}, closed() {} }, _bindUsage() {}, _attach() {}, _detach() {},
      _discardRenderer() {}, _clearRelease() {},
      _wire(_windows, handle) { shared.observe(handle, identity()); },
      _openReply: (handle, extra) => require('../main/pi-session/open-reply').openReply(app, handle, extra),
      require: require('node:module').createRequire(path.join(client, 'main/pi-session/ipc.js')) });
    const source = fs.readFileSync(path.join(client, 'main/pi-session/ipc.js'), 'utf8');
    vm.runInContext(source.slice(source.indexOf('  async function openConversation('),
      source.indexOf("  ipcMain.handle('pi-session-open',")), context);
    ipcMain.handle('pi-session-open', (event, options) => context.openConversation(event, options));

    const scripts = ['api-library-local.js', 'core/plugin-locales.js', 'core/api-work-plugins.js', 'api.js', 'components/client-auth/account-ui.js',
      'components/client-auth/client-auth.js', 'components/workspace/workspace-chat-history.js',
      'components/workspace/workspace-sidebar-state.js', 'components/workspace/workspace-chat-list.js',
      'components/workspace/workspace-shell.js'];
    const page = path.join(profile.root, 'lifecycle.html');
    fs.writeFileSync(page, '<!doctype html><html><head><meta charset="utf-8"><base href="' + pathToFileURL(client + path.sep).href + '">' +
      ['theme/variables.css', 'components/client-auth/client-auth.css', 'components/workspace/workspace-shell.css',
        'components/workspace/workspace-navigation.css'].map(file => '<link rel="stylesheet" href="' + file + '">').join('') +
      '</head><body><button data-logout onclick="ClientAuth.logout()">Sign out</button><article id="openedConversation"></article>' +
      '<script>window.fixtureErrors=[];addEventListener("error",e=>fixtureErrors.push(e.error?.stack||e.message));addEventListener("unhandledrejection",e=>fixtureErrors.push(String(e.reason)));</script>' +
      scripts.map(file => '<script src="' + file + '"></script>').join('') +
      '<script>WorkspaceHost={async open(view,payload){const reply=await soduWorkAPI.conversationSession.open({chatId:payload.chatId});window.openedReply=reply;' +
      'if(reply.ok){openedConversation.textContent=reply.snapshot.messages.map(m=>m.text||"").join("\\n");WorkspaceShell.setActive("create");WorkspaceShell.setActiveChat(reply.sessionId);await WorkspaceShell.refreshConversationHistory();}return reply.ok;}};WorkspaceShell.mount();</script></body></html>');
    win = new BrowserWindow({ show: false, width: 1280, height: 900,
      webPreferences: { preload: path.join(client, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    const workspaceUrl = pathToFileURL(path.join(client, 'desk.html')).href;
    // Keep the production IPC origin check while serving the isolated renderer fixture.
    protocol.handle('file', request => request.url === workspaceUrl
      ? new Response(fs.readFileSync(page), { headers: { 'Content-Type': 'text/html' } })
      : net.fetch(request.url, { bypassCustomProtocolHandlers: true }));
    await win.loadURL(workspaceUrl);
    await login('alpha'); await until('WorkspaceShell.searchChats().length===4', 'alpha history');
    const expected = [['complete-one', 'completed'], ['complete-two', 'completed'], ['preflight-failure', 'failed'], ['real-failure', 'failed']];
    assert.deepEqual(await rows(), expected);
    report.checks.push('Authenticated alpha sees two completed chats and genuine provider/preflight failures');
    await logout(); report.checks.push('Logout confirmation clears authenticated history and reloads the login gate');
    await login('alpha'); await until('WorkspaceShell.searchChats().length===4', 'relogin history');
    assert.deepEqual(await rows(), expected);
    assert.deepEqual(await win.webContents.executeJavaScript('[...document.querySelectorAll(".ws-chat")].map(b=>[b.dataset.chatId,b.querySelector(".st-chat").className]).sort()'),
      expected.map(([id, state]) => [id, 'st-chat st-chat-' + state]));
    await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.join(profile.root, 'after-relogin.png'), (await win.webContents.capturePage()).toPNG());
    report.checks.push('Same-account relogin preserves completed states before any conversation click');
    for (const id of ['complete-one', 'real-failure', 'preflight-failure']) {
      await win.webContents.executeJavaScript(`document.querySelector('[data-chat-id="${id}"]').click();void 0;`);
      await until(`window.openedReply?.sessionId===${JSON.stringify(id)}`, 'open ' + id);
      const opened = await win.webContents.executeJavaScript('openedReply');
      assert.equal(opened.ok, true, opened.reason); assert.equal(opened.sessionId, id);
      assert.ok(JSON.stringify(opened.snapshot.messages).includes('Saved synthetic answer ' + id));
      await until('WorkspaceShell.searchChats().length===4', 'post-open history');
      assert.deepEqual(await rows(), expected);
    }
    report.checks.push('Clicking opens the original archives without clearing the genuine failed state');
    await logout(); await login('beta'); await until('WorkspaceShell.searchChats().length===1', 'beta history');
    assert.deepEqual(await rows(), [['other-account', 'completed']]);
    const denied = await win.webContents.executeJavaScript('soduWorkAPI.conversationSession.open({chatId:"complete-one"})');
    assert.equal(denied.ok, false);
    report.checks.push('A different account cannot list or open alpha history');
    await logout(); await login('alpha'); await until('WorkspaceShell.searchChats().length===4', 'return alpha');
    assert.deepEqual(await rows(), expected);
    assert.deepEqual(definitions.map(([id]) => fs.readFileSync(path.join(folder, id + '.jsonl'), 'utf8')),
      archiveBytes, 'viewing history must not append or execute a model turn');
    assert.equal(inferenceRequests, 0); assert.deepEqual(await win.webContents.executeJavaScript('fixtureErrors'), []);
    report.checks.push('A/B/A retains original records without inference or transcript changes');
    report.ok = true;
  }
  run().catch(async error => {
    report.error = error.stack;
    if (win && !win.isDestroyed()) {
      report.renderer = await win.webContents.executeJavaScript(`({
        auth:window.SoduWorkAPI?.clientAuthSnapshot?.(),
        status:document.querySelector('.soduwork-auth-status')?.textContent, errors:window.fixtureErrors,
        opened:window.openedReply,
        body:document.body.innerText, url:location.href,
        rows:window.WorkspaceShell?.searchChats?.().map(row=>[row.id,WorkspaceShell._chatState(row)])})`)
        .catch(error => ({ error: error.message }));
      fs.writeFileSync(path.join(profile.root, 'failure.png'), (await win.webContents.capturePage()).toPNG());
    }
  }).finally(async () => {
    if (win && !win.isDestroyed()) win.destroy();
    await bridge?.dispose(); await shared?.close();
    if (originalPrepare) require('../main/pi-session/model-config').prepare = originalPrepare;
    if (originalRuntimeCreate) sdk.ModelRuntime.create = originalRuntimeCreate;
    server?.close();
    fs.writeFileSync(path.join(profile.root, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2)); app.exit(report.ok ? 0 : 1);
  });
}
