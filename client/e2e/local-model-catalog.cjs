'use strict';

// Real model settings, API partitioning, desktop IPC and encryption use only a
// temporary profile and synthetic Hub. macOS uses Chromium's test keychain.
const electron = require('electron');
if (typeof electron === 'string') {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-local-catalog-'));
  const env = { ...process.env, SODUWORK_CATALOG_TEST_ROOT: root };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)],
    { env, windowsHide: true, stdio: 'inherit' });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 120000);
  child.on('exit', code => {
    clearTimeout(timer); process.exitCode = timedOut ? 1 : code ?? 1;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  });
} else {
  const { app, BrowserWindow, ipcMain, safeStorage, net } = electron;
  const fs = require('node:fs'), path = require('node:path');
  const http = require('node:http'), assert = require('node:assert/strict');
  const { pathToFileURL } = require('node:url');
  const client = path.resolve(__dirname, '..'), output = process.argv[2];
  assert.ok(output && path.isAbsolute(output), 'Absolute evidence directory required');
  fs.mkdirSync(output, { recursive: true });
  const temp = process.env.SODUWORK_CATALOG_TEST_ROOT;
  assert.ok(temp && path.isAbsolute(temp), 'Launch this fixture with Node to manage its temporary profile');
  const profile = path.join(temp, 'profile'); fs.mkdirSync(profile);
  app.setPath('userData', profile); app.disableHardwareAcceleration();
  if (process.platform === 'darwin') app.commandLine.appendSwitch('use-mock-keychain');
  const report = { ok: false, cases: [], screenshots: [],
    keychain: process.platform === 'darwin' ? 'Chromium test keychain' : 'Platform safeStorage backend',
    boundary: 'Actual Electron model page, api.js, production local-model IPC and safeStorage encryption API; macOS test keychain, synthetic loopback Hub, native pointer clicks and Chromium typing. No real account, user profile, provider or model call; no system keychain permission validation.' };
  const key = 'synthetic-local-model-key', hubWrites = [], blocked = [], requests = [];
  const managed = { revision: 'fixture-1', defaultModels: { pi: 'shared-model' }, providers: ['company-first', 'company-second'].map(id => ({
    id, name: id, baseUrl: 'https://fixture.invalid/v1', kind: 'openai-compat', keySet: true,
    modelNames: ['shared-model'], modelDefs: [{ name: 'shared-model', label: 'Shared model', modality: 'chat' }],
  })), myModels: [], usable: ['company-first', 'company-second'].map(providerId => ({
    providerId, name: 'shared-model', label: 'Shared model', keyFrom: 'org' })), mediaUsable: {} };
  managed.providers.push({id:'custom-personal-fixture', name:'Personal Hub service', personal:true,
    baseUrl:'https://personal.example.invalid/v1', kind:'openai-compat', modelNames:[], modelDefs:[]});
  let win, composer, server, hub, localId, holdLocalSaves = false, failedHubWrites = 0;
  const pendingLocalSaves = [];
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = code => win.webContents.executeJavaScript(code, true);
  const record = name => { report.cases.push(name); console.log('PASS ' + name); };
  async function until(expression) {
    for (let i = 0; i < 200; i++) { if (await js(expression)) return; await delay(40); }
    throw Error('Timed out: ' + expression);
  }
  async function waitForLocalSave() {
    for (let i = 0; i < 200; i++) { if (pendingLocalSaves.length) return; await delay(40); }
    throw Error('Timed out waiting for the held local save');
  }
  function releaseLocalSaves() {
    holdLocalSaves = false;
    for (const resolve of pendingLocalSaves.splice(0)) resolve();
  }
  async function click(selector) {
    await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);
    await delay(30);
    const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();
      const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);
      if(e.disabled||!e.contains(document.elementFromPoint(x,y)))throw Error('Target is not clickable');return{x,y};})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
    await delay(40);
  }
  async function fill(selector, value) {
    await click(selector);
    assert.equal(await js(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`), true);
    win.webContents.selectAll();
    await win.webContents.debugger.sendCommand('Input.insertText', { text: value });
    assert.equal(await js(`document.querySelector(${JSON.stringify(selector)}).value`), value);
  }
  async function shot(name) {
    const file = path.join(output, name + '.png');
    fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG()); report.screenshots.push(file);
  }
  async function assertLocalCount(count) {
    assert.equal(await js('document.querySelectorAll(".md-model-row").length'), count);
    assert.equal(await js(`document.querySelector('[data-mdselect="${localId}"] .cfg-nav-meta em').textContent`), count + ' 模型');
    assert.equal(await js('document.querySelectorAll("[data-mdedit]").length'), count);
    assert.equal(await js('document.querySelector(".cfg-detail").innerText.includes("组织管理")'), false);
  }
  async function saved(revision) {
    await until(`_mdLoadState==='ready'&&!_mdDirty&&_mdData.localRevision>=${revision}`);
    await assertLocalCount(1);
  }
  async function startHub() {
    server = http.createServer(async (request, response) => {
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Access-Control-Allow-Headers', '*');
      response.setHeader('Access-Control-Allow-Methods', 'GET,PUT,OPTIONS');
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'OPTIONS') { response.end('{}'); return; }
      requests.push({ method: request.method, path: request.url });
      if (request.url !== '/api/v1/my-models') { response.writeHead(404); response.end('{}'); return; }
      if (request.method === 'PUT') {
        let data = ''; for await (const chunk of request) data += chunk;
        const body = JSON.parse(data); hubWrites.push(body);
        if (failedHubWrites) {
          failedHubWrites--; response.writeHead(503); response.end('{"detail":"Synthetic Hub outage"}'); return;
        }
        assert.equal(body.expectedRevision, managed.revision, 'managed retries must retain the last acknowledged revision');
        for (const provider of body.providers || []) {
          const old = managed.providers.find(row => row.id === provider.id);
          if (old) Object.assign(old, provider);
        }
        if (Array.isArray(body.models)) managed.myModels = body.models;
        managed.revision = 'fixture-' + (Number(managed.revision.split('-')[1]) + 1);
        response.end(JSON.stringify({ ok: true, revision: managed.revision })); return;
      }
      response.end(JSON.stringify(managed));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    hub = 'http://127.0.0.1:' + server.address().port;
  }
  app.whenReady().then(async () => {
    assert.equal(safeStorage.isEncryptionAvailable(), true, 'Encryption must be available; no plaintext fallback');
    await startHub();
    require('../main/local-model-ipc.cjs').install({ app, ipcMain, safeStorage });
    // Hold the transport before the production handler to prove deletion safety
    // while encryption and persistence are still pending, without replacing either.
    ipcMain.handle('fixture-before-local-save', () => holdLocalSaves
      ? new Promise(resolve => pendingLocalSaves.push(resolve)) : undefined);
    const store = require('../main/local-model-store.cjs');
    ipcMain.on('fixture-models-changed', () => composer?.webContents.send('models-changed'));
    const preload = path.join(temp, 'preload.cjs');
    fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron'); let closeDeskWindowCalls=0;
      contextBridge.exposeInMainWorld('soduWorkAPI',{
        getHubConnection:async()=>({hub:${JSON.stringify(hub)},internalTest:true}),
        localModels:{get:()=>ipcRenderer.invoke('local-models-get'),save:async input=>{
          await ipcRenderer.invoke('fixture-before-local-save');return ipcRenderer.invoke('local-models-save',input)},
          test:(id,name)=>ipcRenderer.invoke('local-models-test',id,name)},
        broadcast:domain=>{if(domain==='models')ipcRenderer.send('fixture-models-changed')},
        onModelsChanged:fn=>{ipcRenderer.on('models-changed',fn);return ()=>ipcRenderer.removeListener('models-changed',fn)},
        closeDeskWindow:()=>{closeDeskWindowCalls++},
        getCloseDeskWindowCalls:()=>closeDeskWindowCalls});`);
    const styles = ['theme/variables.css', 'components/panels/panels-schedules.css', 'components/panels/panels-agents.css',
      'components/panels/panels-connections.css', 'components/panels/model-capabilities.css',
      'components/workspace/workspace-shell.css', 'components/workspace/workspace-page-layout.css', 'desk-window.css',
      'theme/workspace-experience.css', 'theme/workspace-page-heads.css'];
    const scripts = ['core/api-work-plugins.js', 'api.js', 'components/panels/model-capabilities.js',
      'components/panels/model-catalog-editor.js', 'components/panels/model-service-delete.js', 'components/panels/panels-models.js'];
    const html = '<!doctype html><html data-desk-panel="workspace" data-workspace-view="models" data-theme="azure" data-skin="flat"><head><meta charset="utf-8">' +
      styles.map(file => '<link rel="stylesheet" href="' + file + '">').join('') + '</head><body><script>' +
      'window.errors=[];window.notice="";window.notices=[];window.pickerRefreshFailures=0;addEventListener("error",e=>errors.push(e.message));addEventListener("unhandledrejection",e=>errors.push(String(e.reason)));' +
      'const esc=v=>String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(String.fromCharCode(34),"&quot;");' +
      'window.petSay=m=>{notice=m;notices.push(m)};window._humanErr=e=>e.message;window.ComposeModelPicker={refresh:async()=>{if(window.pickerRefreshFailures)throw Error("picker refresh failed")}};</script>' +
      scripts.map(file => '<script src="' + file + '"></script>').join('') + '<script>openModelsPanel();</script></body></html>';
    win = new BrowserWindow({ show: false, width: 1500, height: 1000, webPreferences: {
      preload, sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false,
      partition: 'local-model-catalog-' + require('node:crypto').randomUUID() } });
    const desk = pathToFileURL(path.join(client, 'desk.html')).href;
    const composeUrl = desk + '?view=compose';
    const composeHtml = '<!doctype html><meta charset="utf-8"><div class="cp-modelwrap">' +
      '<button id="cpModelBtn"><span id="cpModelName"></span></button><div id="cpModelPop"></div></div>' +
      ['core/api-work-plugins.js', 'api.js', 'core/model-choice.js', 'components/panels/panels-compose-model-picker.js']
        .map(file => '<script src="' + file + '"></script>').join('') +
      '<script>ComposeModelPicker.bind({api:()=>soduWorkAPI})</script>';
    win.webContents.session.protocol.handle('file', request => request.url === desk
      ? new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      : request.url === composeUrl ? new Response(composeHtml, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      : net.fetch(request.url, { bypassCustomProtocolHandlers: true }));
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, done) => {
      const allowed = new URL(request.url).origin === hub;
      if (!allowed) blocked.push(request.url);
      done({ cancel: !allowed });
    });
    await win.loadURL(desk); await until('_mdLoadState==="ready"');
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    const human = fs.readFileSync(path.join(client, 'components/pet/pet-ui.js'), 'utf8');
    await js(human.slice(human.indexOf('function _humanErr('), human.indexOf('/* Speech bubbles. */')));
    await click('#mdAddInline'); localId = await js('document.querySelector("[data-pname]").dataset.pname');
    await fill('[data-pname]', 'Synthetic local service'); await click('#mdSave');
    await until('!_mdSaveFlight && document.getElementById("md-url-error")?.textContent === "请填写 API 地址"');
    assert.equal(await js('notices.includes("请填写 API 地址")'), false);
    assert.equal(store.get().revision, 0);
    assert.equal(await js('document.querySelector(".cfg-state.is-draft").textContent'), '未保存');
    assert.equal(await js('document.querySelector("[data-purl]").getAttribute("aria-invalid")'), 'true');
    await js('closeModelsPanel(); openModelsPanel()'); await until('_mdLoadState === "ready"');
    assert.equal(await js('document.querySelector("[data-pname]").value'), 'Synthetic local service');
    assert.equal(await js('document.querySelector("#mdSave").disabled'), false);
    assert.equal(await js('document.querySelector("#mdSave").textContent'), '保存');
    assert.equal(store.get().providers.length, 0);
    record('An incomplete service reports its field error and remains unsaved after reopening without a durable write');
    await fill('[data-purl]', 'http://127.0.0.1:1/v1');
    await fill('[data-pkey]', key); await click('[data-mdeditor] summary');
    await fill('[data-padd]', 'shared-model'); await fill('[data-mdlabel]', 'Local model'); await click('[data-madd]');
    assert.equal(store.get().revision, 0, 'Add model cannot save a service draft');
    await assertLocalCount(0);
    await js('window.pickerRefreshFailures=1'); await click('#mdSave');
    await until('_mdLoadState==="ready"&&!_mdSaveFlight&&_mdData.localRevision===1');
    assert.equal(store.get().myModels.length, 0, 'Saving the service leaves the model form unsubmitted');
    assert.equal(await js('document.querySelector("[data-padd]").value'), 'shared-model');
    assert.equal(await js('document.querySelector(".md-pi-guidance b").textContent'), '本地 Pi 可选的对话模型：0 个');
    assert.equal(await js('document.activeElement.dataset.mdaddchat'), localId, 'first save reveals the next action');
    await click('[data-mdaddchat]');
    assert.equal(await js('document.activeElement.dataset.padd'), localId);
    assert.equal(await js('document.querySelector("[data-paddtype]").value'), 'chat');
    composer = new BrowserWindow({ show: false, webPreferences: {
      session: win.webContents.session, preload, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
    const compose = script => composer.webContents.executeJavaScript(script, true);
    await composer.loadURL(composeUrl);
    await compose('ComposeModelPicker.refresh(true)');
    await compose('document.getElementById("cpModelBtn").click()');
    await compose('document.querySelector("[data-model=shared-model]").click()');
    await click('[data-madd]'); await saved(2);
    assert.equal(await js('document.querySelector(".md-pi-guidance b").textContent'), '本地 Pi 可选的对话模型：1 个');
    const localRef = store.get().usable[0].name;
    const row = 'document.querySelector(' + JSON.stringify('[data-model="' + localRef + '"]') + ')';
    for (let i = 0; i < 100 && !await compose('!!' + row); i++) await delay(50);
    assert.equal(await compose('ComposeModelPicker.value().modelName'), 'shared-model');
    await compose('document.getElementById("cpModelBtn").click()');
    await compose(row + '.click()');
    assert.equal(await compose('ComposeModelPicker.value().modelName'), localRef);
    assert.equal(await compose('SoduWorkAPI.myModels().then(catalog => catalog.defaultModels.pi)'), 'shared-model');
    record('Saving a provider guides to its chat form and broadcasts the new selectable choice to a separate Pi composer');
    assert.equal(await js('notices.some(message=>message.includes("模型配置已保存"))'), true);
    assert.equal(await js('notices.some(message=>message.includes("没存上"))'), false);
    await js('window.pickerRefreshFailures=0');
    assert.equal(store.get().myModels.length, 1);
    assert.equal(store.get().providers[0].modelDefs.length, 1, 'public execution catalog retains its definitions');
    assert.equal(store.get().usable.length, 1);
    const raw = fs.readFileSync(path.join(profile, 'local-models.secure.json'), 'utf8');
    assert.ok(JSON.parse(raw).cipher); assert.equal(raw.includes(key), false); assert.equal(raw.includes('shared-model'), false);
    record('Adding one local model saves one encrypted record and renders one editable row and count');

    await win.loadURL(desk); await until('_mdLoadState==="ready"');
    await click('[data-mdselect="' + localId + '"]'); await assertLocalCount(1);
    assert.equal(await js('document.querySelector("[data-pkey]").value'), '');
    await click('[data-mdedit]'); await fill('[data-mdlabel]', 'Edited local label'); await click('[data-madd]');
    assert.equal(await js('_mdMyModels.find(row=>row.localOnly).label'), 'Edited local label');
    await click('#mdSave'); await saved(3);
    assert.equal(store.get().myModels[0].label, 'Edited local label');
    record('Reload and same-ID editing retain one local row without treating its mirror as a duplicate');

    await click('[data-mdedit]'); await fill('[data-padd]', 'renamed-local-model'); await click('[data-madd]');
    await assertLocalCount(1);
    assert.equal(await js('document.querySelector(".md-model-list").textContent.includes("shared-model")'), false);
    await click('#mdSave'); await saved(4);
    assert.equal(store.get().myModels[0].name, 'renamed-local-model');
    await js('document.querySelector(".md-model-row").scrollIntoView({block:"center"})'); await delay(80);
    const localCredentials = await js('document.querySelector(".md-credentials").innerText');
    assert.match(localCredentials, /本地访问密钥已配置/);
    assert.match(localCredentials, /不使用 Hub 模型额度/);
    assert.doesNotMatch(localCredentials, /个人额度|公司凭据/);
    assert.equal(await js('document.querySelector("[data-pclear]").getAttribute("aria-label")'), '移除本地密钥');
    await shot('local-model-single-row');
    record('Renaming replaces the visible and persisted local ID without a stale organization row');

    for (const id of ['company-first', 'company-second']) {
      await click('[data-mdselect="' + id + '"]');
      assert.equal(await js('document.querySelectorAll(".md-model-row").length'), 1);
      assert.equal(await js('document.querySelectorAll("[data-mdedit]").length'), 0);
      assert.equal(await js('document.querySelector(".md-settings-section input").readOnly'), true);
      assert.equal(await js('document.querySelector("[data-purl]")'), null);
      assert.equal(await js('document.querySelector(".md-model-list").textContent.includes("Shared model")'), true);
    }
    record('Identical model names from separate Hub providers remain visible and organization-managed');

    await click('[data-mdselect="' + localId + '"]'); await click('[data-mdedit]');
    await fill('[data-mdlabel]', 'Draft for removed model');
    await js('window.removedEditor=document.querySelector("[data-mdeditor]");window.removedApply=removedEditor.querySelector("[data-madd]");');
    holdLocalSaves = true; await click('[data-mdel]'); await waitForLocalSave();
    assert.equal(store.get().revision, 4, 'the deletion has not reached the production store');
    assert.equal(store.get().myModels.length, 1);
    assert.equal(await js('document.getElementById("mdSave").disabled'), true);
    assert.equal(await js('_mdSave(false)===_mdSave(false)'), true, 'reentrant saves share the pending operation');
    assert.equal(pendingLocalSaves.length, 1, 'reentrant saves must not create another local write');
    assert.equal(await js('removedEditor.isConnected'), false);
    assert.equal(await js('_mdDrafts.size'), 0);
    await js('removedApply.click();removedEditor.querySelector("[data-padd]").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));');
    assert.equal(await js('_mdMyModels.length'), 0, 'detached callbacks cannot reinsert a removed model during save');
    releaseLocalSaves();
    await until('_mdLoadState==="ready"&&!_mdDirty&&_mdData.localRevision>=5'); await assertLocalCount(0);
    assert.equal(store.get().myModels.length, 0);
    assert.equal(store.get().providers.length, 1);
    assert.equal(store.get().providers[0].keySet, true, 'model removal preserves its provider credential');
    await js(`closeModelsPanel();openModelsPanel({editor:true,providerId:${JSON.stringify(localId)}});`);
    await until('_mdLoadState==="ready"'); await assertLocalCount(0);
    assert.equal(await js('document.querySelector("[data-padd]").value'), '');
    await win.loadURL(desk); await until('_mdLoadState==="ready"');
    await click('[data-mdselect="' + localId + '"]'); await assertLocalCount(0);
    record('Deleting the edited model clears its draft, rejects detached callbacks during save and stays removed after reopening');

    for (const name of ['retained-model', 'removed-sibling']) {
      await click(name === 'retained-model' ? '[data-mdaddchat]' : '[data-mdeditor] summary');
      await fill('[data-padd]', name); await click('[data-madd]');
    }
    await until('_mdLoadState==="ready"&&!_mdDirty&&_mdData.localRevision===7');
    await assertLocalCount(2);
    await click('[data-mdedit="' + localId + '|0"]'); await fill('[data-mdlabel]', 'Retained unsaved label');
    await click('[data-mdel="' + localId + '|1"]'); await saved(8);
    assert.equal(await js('document.querySelector("[data-padd]").value'), 'retained-model');
    assert.equal(await js('document.querySelector("[data-mdlabel]").value'), 'Retained unsaved label');
    assert.equal(await js(`_mdDrafts.get(${JSON.stringify(localId)}).original`), 'retained-model');
    await click('[data-madd]'); await click('#mdSave'); await saved(9);
    assert.equal(store.get().myModels[0].label, 'Retained unsaved label');
    record('Deleting another row preserves the current edit draft and its unsaved fields through save and reload');

    await click('[data-mdedit]'); await fill('[data-mdlabel]', 'Draft for removed provider');
    await click('[data-pdelete]');
    await js('window.providerEditor=document.querySelector("[data-mdeditor]");window.providerApply=providerEditor.querySelector("[data-madd]");');
    await until('document.querySelector("[data-md-delete-confirm]")?.disabled===false');
    holdLocalSaves = true; await click('[data-md-delete-confirm]'); await waitForLocalSave();
    assert.equal(store.get().revision, 9, 'provider deletion is inspected before persistence');
    assert.equal(store.get().providers.length, 1);
    assert.equal(await js('providerEditor.isConnected'), true);
    assert.equal(await js(`_mdDrafts.has(${JSON.stringify(localId)})`), true);
    await js('providerApply.click()');
    assert.equal(await js('_mdMyModels.length'), 1);
    releaseLocalSaves();
    await until('_mdLoadState==="ready"&&!_mdDirty&&_mdData.localRevision>=10');
    assert.equal(store.get().providers.length, 0); assert.equal(store.get().myModels.length, 0);
    assert.equal(await js(`!!document.querySelector('[data-mdselect="${localId}"]')`), false);
    assert.equal(await js('window.soduWorkAPI.getCloseDeskWindowCalls()'), 0, 'confirmed provider removal must not close the workspace window');
    assert.equal(await js('providerEditor.isConnected'), false);
    assert.equal(await js(`_mdDrafts.has(${JSON.stringify(localId)})`), false);
    record('Confirmed provider removal retains the editor until persistence, rejects in-flight edits and keeps the workspace open');

    assert.equal(hubWrites.length, 0, 'local-only changes must not write the Hub catalog');
    record('Production API keeps local-only records out of Hub requests');

    await click('#mdAddInline');
    const mixedLocalId = await js('document.querySelector("[data-pname]").dataset.pname');
    await fill('[data-pname]', 'Mixed local service'); await fill('[data-purl]', 'http://127.0.0.1:2/v1');
    await fill('[data-pkey]', key);
    await click('[data-mdselect="custom-personal-fixture"]'); await fill('[data-purl]', 'https://managed-retry.invalid/v1');
    failedHubWrites = 1; await js('notices.length=0'); await click('#mdSave');
    await until('!_mdSaveFlight&&_mdManagedDirty&&!_mdLocalDirty');
    assert.equal(hubWrites.length, 1);
    assert.equal(store.get().revision, 11);
    assert.equal(store.get().providers[0].name, 'Mixed local service');
    assert.equal(store.get().providers[0].keySet, true);
    assert.equal(await js('_mdData.localRevision'), store.get().revision);
    assert.equal(await js('notices.includes("本地模型配置已保存，Hub 模型配置未保存，请重试。")'), true);
    assert.equal(await js('document.getElementById("mdSave").disabled'), false);
    await click('#mdSave'); await until('!_mdSaveFlight&&_mdLoadState==="ready"&&!_mdDirty');
    assert.equal(hubWrites.length, 2);
    assert.equal(store.get().revision, 11, 'retry must not replay the already committed local save');
    assert.equal(managed.providers.find(row => row.id === 'custom-personal-fixture').baseUrl, 'https://managed-retry.invalid/v1');
    await win.loadURL(desk); await until('_mdLoadState==="ready"');
    assert.equal(await js(`_mdData.providers.find(row=>row.id===${JSON.stringify(mixedLocalId)}).name`), 'Mixed local service');
    await click('[data-mdselect="custom-personal-fixture"]');
    assert.equal(await js('document.querySelector("[data-purl]").value'), 'https://managed-retry.invalid/v1');
    record('Mixed local and managed edits report partial success and retry only the uncommitted Hub save');

    for (const body of hubWrites) {
      assert.equal(JSON.stringify(body).includes(key), false);
      assert.equal(JSON.stringify(body).includes(localId), false);
      assert.equal(JSON.stringify(body).includes(mixedLocalId), false);
      assert.equal(JSON.stringify(body).includes('Mixed local service'), false);
      assert.equal(JSON.stringify(body).includes('127.0.0.1'), false);
      assert.deepEqual(body.models, []); assert.deepEqual(body.keys, {});
      assert.deepEqual(body.providers.map(provider => provider.id), ['custom-personal-fixture']);
      assert.ok(!Object.keys(body).some(name => name.startsWith('local')));
    }
    assert.deepEqual(blocked, []); assert.deepEqual(await js('errors'), []);
    assert.ok(requests.every(request => request.path === '/api/v1/my-models'));
    report.ok = true; report.hubRequests = requests; report.hubWrites = hubWrites.length;
  }).catch(async error => {
    report.error = String(error.stack || error);
    if (win && !win.isDestroyed()) {
      report.renderer = await js('({errors,notice,state:typeof _mdLoadState==="string"?_mdLoadState:"missing"})').catch(() => null);
      await shot('failure').catch(() => {});
    }
  }).finally(async () => {
    releaseLocalSaves();
    composer?.destroy(); win?.destroy();
    if (server) await new Promise(resolve => server.close(resolve));
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, cases: report.cases.length, output, error: report.error }));
    app.exit(report.ok ? 0 : 1);
  });
}
