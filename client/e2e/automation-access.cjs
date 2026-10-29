'use strict';
// Isolated profile/native consent -> production automation worker/main open ->
// real Pi SDK and local model fixture. No real Hub, account or paid model.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 90000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain, protocol, net, screen } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
  const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
  const client = path.resolve(__dirname, '..'), root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-automation-access-'));
  const out = path.resolve(client, '../outputs/automation-access-20261015'); fs.mkdirSync(out, { recursive: true });
  const baseline = process.argv.includes('--baseline'), report = { ok: false, baseline, cases: [], errors: [] };
  app.setPath('userData', path.join(root, 'profile')); app.on('window-all-closed', () => {});
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  const read = file => fs.readFileSync(path.join(client, file), 'utf8');
  const source = file => baseline ? require('node:child_process').execFileSync('git', ['show', '9b66045b:client/' + file], { cwd: client, encoding: 'utf8' }) : read(file);
  const desk = path.join(client, 'desk.html'), pageURL = pathToFileURL(desk).href;
  const html = '<!doctype html><html lang="zh-CN"><body><span id="actual"></span><script>' +
    read('components/panels/work-composer.js') + '</script><script>window.showMode=mode=>{document.querySelector("#actual").textContent=WorkComposer.permissionLabel(mode)};</script></body></html>';
  let owner, fixture, context, managers = [], opens = 0, confirmations = 0, previousSessionId;
  const js = (win, code) => win.webContents.executeJavaScript(code, true);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(check, description) {
    for (let i = 0; i < 300; i++) { const value = await check(); if (value) return value; await delay(25); }
    throw Error('Timed out: ' + description);
  }
  async function click(win, selector) {
    const point = await js(win, `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
    await delay(30);
  }
  app.whenReady().then(async () => {
    protocol.handle('file', request => request.url.split('?')[0] === pageURL
      ? new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
      : net.fetch(request.url, { bypassCustomProtocolHandlers: true }));
    function HiddenConsent(options) {
      const win = new BrowserWindow({ ...options, webPreferences: { ...options.webPreferences, backgroundThrottling: false } });
      win.show = () => {}; win.focus = () => {}; return win;
    }
    const nativeConfirm = require('../main/access-control/full-access-consent').create({ BrowserWindow: HiddenConsent, ipcMain, screen });
    const confirmFullAccess = (parent, options) => { confirmations++; return nativeConfirm(parent, options); };
    const preferences = require('../main/access-control/preferences');
    preferences.install({ app, ipcMain, BrowserWindow, confirmFullAccess });
    fixture = await require('./fixtures/resumed-pi.cjs').create(path.join(root, 'runtime'));
    previousSessionId = fixture.sdk.SessionManager.prototype.getSessionId;
    fixture.sdk.SessionManager.prototype.getSessionId = function () { managers.push(this); return previousSessionId.call(this); };
    const now = Math.floor(Date.now() / 1000);
    const token = Buffer.from(JSON.stringify({ typ: 'device', uid: 'isolated-owner', cid: 'fixture', iat: now - 60, exp: now + 3600 })).toString('base64url') + '.' + 'a'.repeat(64);
    const identity = { hub: 'http://127.0.0.1', clientId: 'fixture', session: token };
    const ipc = source('main/pi-session/ipc.js');
    const handler = ipc.slice(ipc.indexOf('  async function openConversation('), ipc.indexOf("  ipcMain.handle('pi-session-open',"));
    context = vm.createContext({
      app, path, BrowserWindow, confirmFullAccess,
      _cloudHandoff: { observe() {} }, skillTurn: require('../main/pi-session/skill-turn'), sendIdentityOf: null,
      identityOf: async () => identity,
      memories: { context: async () => ({}), attach: async () => {} }, updateWorkloads: { guard: () => ({ ok: true }) },
      session: {
        findBySessionId: id => fixture.handle?.sessionId === id ? fixture.handle : null,
        archivedConversation: async (_app, id) => archive?.id === id ? archive : null,
        open: async value => {
          opens++;
          const session = await fixture.open({ ref: value.ref, resumePath: value.resumePath || '',
            accessPolicy: value.accessPolicy, readOnly: value.readOnly, modelName: value.modelName });
          return { ok: true, session };
        },
      },
      capabilities: { resolve: async () => ({ catalog: {}, selectedSkills: [], capabilityIds: [] }) },
      capabilityGrantsOf: null, _skillDirs: () => [], _newSessionCwd: () => fixture.cwd, _defaultCwd: () => fixture.cwd, workDir: () => root,
      attachments: { stage: async () => ({ files: [], warnings: [] }) }, sessionSpec: require('../main/conversation/session-spec'),
      _conf: () => ({}), _entryContextPrompts: () => [], _awaitBounded: value => value, OPEN_TIMEOUT_MS: 45000,
      _bindUsage() {}, _attach() {}, _detach() {}, _wire() {}, _openReply: session => ({ ok: true, ref: session.ref, sessionId: session.sessionId, snapshot: session.snapshot() }),
      require: name => require(path.join(client, 'main/pi-session', name)),
    });
    vm.runInContext(handler, context);
    let archive = null;
    const conversation = { ...require('../main/access-control/automation-access').service(app, context.openConversation),
      open: (options, ownerIdentity) => context.openConversation(null, options, ownerIdentity),
      send: async (ref, text, files, options) => {
        const submitted = fixture.handle.submit(text, files, options);
        return { ok: submitted.accepted, completion: submitted.completion };
      }, find: () => fixture.handle };
    ipcMain.handle('pi-session-open', (event, options) => context.openConversation(event, options));
    const workerModule = { exports: {} };
    vm.runInNewContext(source('main/automation-conversations.js'), { module: workerModule, exports: workerModule.exports,
      require: name => require(name.startsWith('.') ? path.join(client, 'main', name) : name), console, setInterval, clearInterval }, { filename: 'automation-worker' });
    owner = new BrowserWindow({ show: false, width: 700, height: 500,
      webPreferences: { preload: path.join(client, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    owner.webContents.on('console-message', event => { if (event.level >= 3) report.errors.push(event.message); });
    await owner.loadFile(desk);
    await js(owner, 'window.saved=null;soduWorkAPI.accessPreferences.set("full",0).then(value=>saved=value);void 0;');
    const consent = await until(() => BrowserWindow.getAllWindows().find(win => win.getParentWindow() === owner), 'native default consent');
    await until(() => js(consent, 'Boolean(document.querySelector("#consentAllow"))'), 'native consent buttons');
    await click(consent, '#consentAcknowledged'); await click(consent, '#consentAllow');
    assert.equal((await until(() => js(owner, 'saved'), 'saved native default')).ok, true);
    assert.equal(preferences.snapshot(app).mode, 'full');
    let run = 0;
    async function runAutomation(trigger = 'manual') {
      const runId = 'run-' + (++run), input = { runId, text: '保留完整材料和权限\n手动执行夹具', adapterId: 'pi', cwd: fixture.cwd };
      const journal = new Map(), acknowledgements = [];
      const worker = workerModule.exports.createWorker({ identityOf: async () => identity,
        request: async (_owner, route, body) => route.endsWith('/inbox') ? { items: [{ id: runId }] }
          : route.endsWith('/claim') ? { ok: true, trigger, input } : (acknowledgements.push(body), { ok: true }),
        journal: { read: key => journal.get(key), write: (key, value) => journal.set(key, value) },
        conversation, catalog: async () => [], instanceId: 'fixture' });
      await worker.tick();
      await until(async () => { await worker.tick(); return acknowledgements.find(row => row.state === 'succeeded'); }, 'ordinary automated turn completion');
      worker.stop(); return fixture.handle.snapshot();
    }
    const full = await runAutomation();
    if (baseline) {
      assert.equal(full.accessPolicy == null, true);
      report.cases.push('Original worker reproduces confirmed default full with no runtime access policy');
    } else {
      assert.equal(full.accessPolicy.mode, 'full');
      await js(owner, `showMode(${JSON.stringify(full.accessPolicy.mode)});void 0;`);
      assert.equal(await js(owner, 'document.querySelector("#actual").textContent'), '完全访问');
      const savedId = fixture.handle.sessionId, savedPath = managers.at(-1).getSessionFile();
      fixture.handle.close(); context.session.findBySessionId = () => null;
      archive = { id: savedId, path: savedPath, cwd: fixture.cwd, adapterId: 'pi' };
      assert.equal((await js(owner, 'soduWorkAPI.accessPreferences.set("readonly",1)')).ok, true);
      const restored = await js(owner, `soduWorkAPI.conversationSession.open({chatId:${JSON.stringify(savedId)}})`);
      assert.equal(restored.ok, true, restored.reason); assert.equal(restored.snapshot.accessPolicy.mode, 'full');
      await js(owner, `showMode(${JSON.stringify(restored.snapshot.accessPolicy.mode)});void 0;`);
      assert.equal(await js(owner, 'document.querySelector("#actual").textContent'), '完全访问');
      fixture.handle.close(); archive = null;
      report.cases.push('Manual full policy and production permission label match; reopening preserves full after default changes');
      const readonly = await runAutomation();
      assert.equal(readonly.accessPolicy.mode, 'readonly');
      assert.equal(fixture.requests.at(-1).tools.some(tool => tool.function.name === 'write'), false);
      assert.equal(fixture.requests.at(-1).tools.some(tool => tool.function.name === 'edit'), false);
      await js(owner, `showMode(${JSON.stringify(readonly.accessPolicy.mode)});void 0;`);
      assert.equal(await js(owner, 'document.querySelector("#actual").textContent'), '只读'); fixture.handle.close();
      assert.equal((await js(owner, 'soduWorkAPI.accessPreferences.set("standard",2)')).ok, true);
      assert.equal((await runAutomation()).accessPolicy.mode, 'standard'); fixture.handle.close();
      report.cases.push('Manual readonly has no SDK write/edit tools; standard compiles the corresponding real policy');
      fs.writeFileSync(path.join(app.getPath('userData'), 'access-preferences.json'), JSON.stringify({ schema: 1, mode: 'full', revision: 4, fullConsentVersion: 1 }));
      assert.equal((await runAutomation('timer')).accessPolicy == null, true);
      report.cases.push('Timer retains its original compatibility policy despite a confirmed full default');
    }
    assert.equal(confirmations, 1); assert.deepEqual(report.errors, []);
    report.runtimeOpens = opens; report.localModelRequests = fixture.requests.length; report.paidModelRequests = 0; report.ok = true;
  }).catch(error => { report.error = String(error.stack || error); }).finally(async () => {
    if (fixture && previousSessionId) fixture.sdk.SessionManager.prototype.getSessionId = previousSessionId;
    await fixture?.close();
    BrowserWindow.getAllWindows().forEach(win => { if (!win.isDestroyed()) win.destroy(); });
    fs.writeFileSync(path.join(out, baseline ? 'baseline.json' : 'fixed.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
  });
}
