'use strict';

// Exercise the model page through the production preload, trusted IPC, real
// probes and platform safeStorage, with an isolated profile and loopback vendor.
const electron = require('electron');
if (typeof electron === 'string') {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-capabilities-'));
  const env = { ...process.env, SODUWORK_CAPABILITIES_TEST_ROOT: root };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)],
    { env, windowsHide: true, stdio: 'inherit' });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 90000);
  child.on('exit', code => {
    clearTimeout(timer); process.exitCode = timedOut ? 1 : code ?? 1;
    // root is created directly under the OS temporary directory above.
    const target = path.resolve(root), parent = path.resolve(os.tmpdir()) + path.sep;
    if (!target.startsWith(parent)) throw Error('Unexpected fixture cleanup target');
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  });
} else {
  const { app, BrowserWindow, ipcMain, safeStorage, net } = electron;
  const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
  const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
  const client = path.resolve(__dirname, '..'), output = process.argv[2];
  assert.ok(output && path.isAbsolute(output), 'Absolute evidence directory required');
  fs.mkdirSync(output, { recursive: true });
  const temp = process.env.SODUWORK_CAPABILITIES_TEST_ROOT;
  assert.ok(temp && path.isAbsolute(temp), 'Use the Node launcher for an isolated temporary profile');
  const profile = path.join(temp, 'profile'); fs.mkdirSync(profile);
  app.setPath('userData', profile); app.disableHardwareAcceleration();
  if (process.platform === 'darwin') app.commandLine.appendSwitch('use-mock-keychain');
  const report = { ok: false, cases: [], boundary: 'Production renderer, preload, local IPC, probes and safeStorage. Synthetic loopback vendor and Hub; no production credentials or account.' };
  const vendorRequests = [], hubRequests = [], blocked = [], challenges = new Map();
  const sockets = new Set();
  let win, server, origin, hold = false, imageResponse = 'readable', changed = 0;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = code => win.webContents.executeJavaScript(code, true);
  const record = name => { report.cases.push(name); console.log('PASS ' + name); };
  async function until(expression) {
    for (let i = 0; i < 300; i++) { if (await js(expression)) return; await delay(30); }
    throw Error('Timed out: ' + expression);
  }
  async function click(selector) {
    await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);
    await delay(40);
    const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();
      const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);
      if(e.disabled||!e.contains(document.elementFromPoint(x,y)))throw Error('Target is not clickable');return{x,y};})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
    await delay(30);
  }
  function complete(response, content, stream, call) {
    if (!stream) { response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] })); return; }
    response.setHeader('Content-Type', 'text/event-stream');
    const deltas = call ? [{ tool_calls: [{ index: 0, id: 'synthetic-call', type: 'function',
      function: { name: 'soduwork_capability_echo', arguments: JSON.stringify({ value: content }) } }] }] : [{ content: content.slice(0, 4) }, { content: content.slice(4) }];
    for (const delta of deltas) response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] }) + '\n\n');
    response.end('data: [DONE]\n\n');
  }
  async function startServer() {
    server = http.createServer(async (request, response) => {
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Access-Control-Allow-Headers', '*');
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'OPTIONS') { response.end('{}'); return; }
      if (request.url === '/api/v1/my-models') {
        hubRequests.push(request.method);
        response.end(JSON.stringify({ providers: [], usable: [], myModels: [], mediaUsable: {}, revision: 'synthetic' })); return;
      }
      assert.equal(request.url, '/vendor/v1/chat/completions');
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.authorization, 'Bearer synthetic-local-key');
      let body = ''; for await (const chunk of request) body += chunk;
      const data = JSON.parse(body); vendorRequests.push(data);
      assert.ok(['synthetic-wire-model', 'synthetic-added-model'].includes(data.model));
      if (hold) return; // User cancellation must abort this actual HTTP request.
      const first = data.messages[0].content, result = data.messages.find(message => message.role === 'tool');
      if (result) { complete(response, result.content, data.stream); return; }
      if (Array.isArray(first)) {
        const digits = challenges.get(first.find(part => part.type === 'image_url').image_url.url);
        if (imageResponse === 'rejected') {
          response.writeHead(400);
          response.end(JSON.stringify({ error: { code: 'image_not_supported', message: 'Images are not supported.' } }));
        } else complete(response, imageResponse === 'mismatch' ? 'Unreadable' : digits, data.stream);
        return;
      }
      const expected = /(?:Reply only with |with value )([a-f0-9]+)\./.exec(first)?.[1];
      assert.ok(expected, 'The probe must carry a random challenge');
      complete(response, expected, data.stream, Boolean(data.tools));
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = 'http://127.0.0.1:' + server.address().port;
  }
  app.whenReady().then(async () => {
    assert.equal(safeStorage.isEncryptionAvailable(), true, 'No plaintext fallback');
    await startServer();
    const image = require('../main/model-capability-image.cjs'), challenge = image.challenge;
    image.challenge = () => { const value = challenge(); challenges.set(value.url, value.expected); return value; };
    require('../main/local-model-ipc.cjs').install({ app, ipcMain, safeStorage, changed: () => changed++ });
    ipcMain.handle('hub-connection-info', () => ({ hub: origin, internalTest: true }));
    ipcMain.handle('app-version', () => 'synthetic');
    ipcMain.handle('sys-info', () => ({ platform: process.platform, arch: process.arch }));
    ipcMain.handle('runner-configure', () => ({ ok: true }));
    ipcMain.handle('device-auth-bootstrap', () => ({ ok: false, stored: false }));
    ipcMain.handle('local-agent-models-get', () => ({ ok: true, scopeKey: 'synthetic', selections: {} }));
    const store = require('../main/local-model-store.cjs');
    store.save({ providers: [{ id: 'synthetic', name: 'Synthetic local service', baseUrl: origin + '/vendor/v1' }],
      models: [{ providerId: 'synthetic', name: 'synthetic-wire-model', label: 'Synthetic model', config: {} }],
      keys: { synthetic: 'synthetic-local-key' } });
    const styles = ['theme/variables.css', 'components/panels/panels-schedules.css', 'components/panels/panels-agents.css',
      'components/panels/panels-connections.css', 'components/panels/model-capabilities.css',
      'components/workspace/workspace-shell.css', 'components/workspace/workspace-page-layout.css', 'desk-window.css',
      'theme/workspace-experience.css', 'theme/workspace-page-heads.css'];
    const localeScripts = JSON.parse(fs.readFileSync(path.join(client, 'core/locales/manifest.json'))).map(file => 'core/locales/' + file);
    const scripts = [...localeScripts, 'core/i18n-dom.js', 'core/i18n.js', 'core/api-work-plugins.js', 'api.js', 'components/panels/model-capabilities.js',
      'components/panels/model-catalog-editor.js', 'components/panels/model-service-delete.js', 'components/panels/panels-models.js'];
    const html = '<!doctype html><html data-desk-panel="workspace" data-workspace-view="models" data-theme="azure" data-skin="flat"><head><meta charset="utf-8">' +
      styles.map(file => '<link rel="stylesheet" href="' + file + '">').join('') + '</head><body><script>' +
      'window.errors=[];addEventListener("error",e=>errors.push(e.message));addEventListener("unhandledrejection",e=>errors.push(String(e.reason)));' +
      'const esc=v=>String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(String.fromCharCode(34),"&quot;");' +
      'let cfg={locale:"zh-CN"};const saveCfg=()=>{};' +
      'window.petSay=()=>{};window._humanErr=e=>e.message;window.ComposeModelPicker={refresh:async()=>{}};</script>' +
      scripts.map(file => '<script src="' + file + '"></script>').join('') + '<script>openModelsPanel();</script></body></html>';
    win = new BrowserWindow({ show: false, width: 1500, height: 1000, webPreferences: {
      preload: path.join(client, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false,
      offscreen: true, backgroundThrottling: false, partition: 'capabilities-' + require('node:crypto').randomUUID() } });
    const desk = pathToFileURL(path.join(client, 'desk.html')).href;
    win.webContents.session.protocol.handle('file', request => request.url === desk
      ? new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      : net.fetch(request.url, { bypassCustomProtocolHandlers: true }));
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, done) => {
      const allowed = new URL(request.url).origin === origin;
      if (!allowed) blocked.push(request.url);
      done({ cancel: !allowed });
    });
    await win.loadURL(desk); await until('_mdLoadState==="ready"');
    await click('[data-mdselect="device:synthetic"]');
    await click('[data-mdcheck]');
    await until('[..._mdChecks.values()].some(value=>value.checks?.streaming?.status==="passed")');
    const latest = store.get().myModels[0];
    for (const name of ['connection', 'imageInput', 'toolCalling', 'streaming']) assert.equal(latest.capabilityCheck.checks[name].status, 'passed');
    assert.equal(vendorRequests.length, 5);
    assert.ok(vendorRequests.some(value => Array.isArray(value.messages[0].content)));
    assert.ok(vendorRequests.some(value => value.stream && value.tools));
    assert.ok(vendorRequests.some(value => value.messages.some(message => message.role === 'tool')));
    assert.equal(changed, 1);
    assert.match(await js('document.querySelector(".md-model-row").innerText'), /图片输入.*支持/s);
    record('Native model-page click verifies connection, image, streamed tools with result and streaming through production IPC');
    const encrypted = fs.readFileSync(path.join(profile, 'local-model-capabilities.secure.json'), 'utf8');
    assert.doesNotMatch(encrypted, /synthetic-wire-model|synthetic-local-key|passed/);
    await win.loadURL(desk); await until('_mdLoadState==="ready"');
    await click('[data-mdselect="device:synthetic"]');
    assert.equal(await js('_mdMyModels[0].capabilityProfile.imageInput.state'), 'supported');
    assert.match(await js('document.querySelector(".md-model-row").innerText'), /图片输入.*支持/s);
    record('Encrypted evidence restores capability badges after a real window reload');
    imageResponse = 'mismatch';
    await click('[data-mdcheck]');
    await until('[..._mdChecks.values()].some(value=>value.checks?.imageInput?.status==="inconclusive"&&!value.pending)');
    const imageBadge = 'document.querySelector(".md-model-row .md-cap-badge").textContent';
    assert.equal(await js(imageBadge), '图片输入支持');
    assert.match(await js('document.querySelector(".md-cap-report").textContent'), /对话沿用上次通过的结果，你仍可发图。/);
    assert.match(await js('document.querySelector(".md-cap-report").textContent'), /未收到与图片中六位数字完全一致的回复/);
    assert.equal(store.get().myModels[0].runtimeRevision, latest.runtimeRevision);
    await win.loadURL(desk); await until('_mdLoadState==="ready"');
    await click('[data-mdselect="device:synthetic"]');
    assert.equal(await js(imageBadge), '图片输入支持');
    record('An inconclusive image recheck keeps the native image badge and explains the mismatch after reload');
    imageResponse = 'rejected';
    await click('[data-mdcheck]');
    await until('[..._mdChecks.values()].some(value=>value.checks?.imageInput?.status==="unsupported"&&!value.pending)');
    const imageReport = 'document.querySelector(".md-cap-report").textContent';
    for (const locale of ['en-US', 'ja-JP', 'ko-KR', 'zh-CN']) {
      await js('SoduWorkI18n.setLocale(' + JSON.stringify(locale) + ');void 0');
      await until(imageReport + '.includes(SoduWorkI18n.translateText("服务拒绝了本次图片请求。对话沿用上次通过的结果，你仍可发图。"))');
    }
    const rejected = store.get().myModels[0];
    assert.equal(rejected.capabilityCheck.verifiedChecks.imageInput.checkedAt, latest.capabilityCheck.checks.imageInput.checkedAt);
    assert.equal(rejected.runtimeRevision, latest.runtimeRevision);
    await win.loadURL(desk); await until('_mdLoadState==="ready"');
    await click('[data-mdselect="device:synthetic"]');
    assert.equal(await js(imageBadge), '图片输入支持');
    assert.ok((await js(imageReport)).includes('服务拒绝了本次图片请求。对话沿用上次通过的结果，你仍可发图。'));
    record('An explicitly rejected recheck retains the native route, passing timestamp and localized guidance across reload');
    hold = true;
    await click('[data-mdcheck]');
    await until('[..._mdChecks.values()].some(value=>value.pending&&value.modelRef)');
    await until('[..._mdChecks.values()].some(value=>value.pending&&value.checks?.connection?.status==="running")');
    for (const locale of ['en-US', 'ja-JP', 'ko-KR', 'zh-CN']) {
      await js('SoduWorkI18n.setLocale(' + JSON.stringify(locale) + ');void 0');
      await until('document.querySelector(\'.md-cap-unchecked[role="status"] > div\')?.textContent === ' +
        'SoduWorkI18n.translateText("服务连接") + " · " + SoduWorkI18n.translateText("正在检测")');
    }
    record('Pending progress labels and statuses switch between all four locales during a real HTTP check');
    await click('[data-mdcancelcheck]');
    await until('[..._mdChecks.values()].some(value=>value.checks?.connection?.status==="cancelled")');
    const cancelled = store.get().myModels[0];
    assert.equal(cancelled.capabilityProfile.imageInput.state, 'supported');
    assert.equal(cancelled.capabilityCheck.checks.connection.status, 'cancelled');
    assert.equal(changed, 1, 'Cancellation must not reload model runtimes');
    record('Native cancellation aborts the HTTP probe while preserving earlier verified capability and runtime revision');
    const beforeLocaleSwitch = JSON.stringify(store.get());
    report.locales = [];
    for (const [locale, retained] of [
      ['zh-CN', '检测已取消，已有证据仍保留'],
      ['en-US', 'Testing was cancelled. Existing evidence was retained.'],
      ['ja-JP', '検査をキャンセルしました。既存の検証結果は保持されています。'],
      ['ko-KR', '검사가 취소되었습니다. 기존 검증 결과는 유지됩니다.'],
    ]) {
      await js('SoduWorkI18n.setLocale(' + JSON.stringify(locale) + ');void 0');
      await until('document.querySelector(".md-cap-report").textContent.includes(' + JSON.stringify(retained) + ')');
      const dates = await js('[...document.querySelectorAll("[data-md-checked-at]")].map(node=>({stored:node.dataset.mdCheckedAt,text:node.textContent,expected:new Date(node.dataset.mdCheckedAt).toLocaleString(' + JSON.stringify(locale) + ')}))');
      assert.ok(dates.length >= 2, 'Current and retained evidence timestamps must be present');
      for (const date of dates) assert.equal(date.text, date.expected, locale + ': ' + date.stored);
      assert.equal(await js('document.querySelector("[data-pname]").value'), 'Synthetic local service');
      report.locales.push({ locale, timestamps: dates.length, retainedEvidenceTranslated: true });
    }
    assert.equal(JSON.stringify(store.get()), beforeLocaleSwitch, 'Language switches cannot modify saved model or capability evidence');
    await js('SoduWorkI18n.setLocale("zh-CN");void 0');
    record('All four shipped locales translate cancellation and retained evidence, preserve model settings, and format both report dates consistently');
    const beforeEdit = store.get().myModels[0].capabilityCheck.runSequence;
    const beforeRequests = vendorRequests.length;
    await click('[data-mdcheck]');
    for (let i = 0; vendorRequests.length === beforeRequests && i < 200; i++) await delay(25);
    assert.ok(vendorRequests.length > beforeRequests, 'The request must be in flight before editing');
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await click('[data-pname]');
    win.webContents.selectAll();
    await win.webContents.debugger.sendCommand('Input.insertText', { text: 'Unsaved renamed service' });
    assert.equal(await js('document.querySelector("[data-pname]").value'), 'Unsaved renamed service');
    // The embedded workspace hides the overlay close button; its parent calls this production action.
    await js('closeModelsPanel()');
    await until('(async()=>{const row=(await soduWorkAPI.localModels.get()).myModels[0];return row.capabilityCheck.runSequence>' +
      beforeEdit + '&&row.capabilityCheck.checks.connection.status==="cancelled"})()');
    assert.equal(store.get().myModels[0].capabilityProfile.imageInput.state, 'supported');
    assert.equal(store.get().providers[0].name, 'Synthetic local service', 'Editing and cancelling cannot commit the draft');
    assert.equal(changed, 1);
    record('Editing a service during a real HTTP check cancels it before the UI record disappears, and closing preserves prior evidence');

    hold = false;
    imageResponse = 'rejected';
    await win.loadURL(desk); await until('_mdLoadState==="ready"');
    await click('[data-mdselect="device:synthetic"]');
    await js(`(() => {
      const key = document.querySelector('[data-pkey]');
      key.value = 'unsaved-replacement';
      key.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await click('[data-mdeditor] > summary');
    await js(`(() => {
      const name = document.querySelector('[data-padd]');
      name.value = 'synthetic-added-model';
      name.dispatchEvent(new Event('input', { bubbles: true }));
      const claim = document.querySelector('[data-mdfield="imageInput"]');
      claim.value = 'supported';
      claim.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    const beforeAdd = vendorRequests.length;
    await click('[data-madd]');
    const addedRow = '_mdMyModels.find(row=>row.name==="synthetic-added-model")';
    await until(addedRow + '?.capabilityCheck?.checks?.streaming?.status==="passed"');
    const added = store.get().myModels.find(row => row.name === 'synthetic-added-model');
    assert.equal(await js('document.querySelector("[data-pkey]").value'), 'unsaved-replacement');
    assert.equal(await js('document.querySelector("#mdSave").disabled'), false);
    assert.equal(added.capabilityCheck.checks.imageInput.status, 'unsupported');
    assert.equal(added.capabilityProfile.imageInput.source, 'configured');
    assert.equal(added.capabilityProfile.imageInput.conflict, true);
    const addedCalls = vendorRequests.slice(beforeAdd);
    assert.equal(addedCalls.length, 5, 'Exactly one complete check is expected');
    assert.ok(addedCalls.every(call => call.model === 'synthetic-added-model'));
    await win.loadURL(desk); await until('_mdLoadState==="ready"');
    await click('[data-mdselect="device:synthetic"]');
    assert.equal(await js(addedRow + '.capabilityProfile.imageInput.conflict'), true);
    const conflictBadge = await js(`[...document.querySelectorAll('[data-md-model]')].find(row =>
      JSON.parse(row.dataset.mdModel)[1] === 'synthetic-added-model').querySelector('.md-cap-badge').textContent`);
    assert.ok(conflictBadge.includes('配置冲突'), conflictBadge);
    assert.equal(vendorRequests.length, beforeAdd + 5, 'Reload must reuse saved evidence');
    record('Clicking Add model alone saves the chat model, checks it once and persists the conflict');

    assert.deepEqual(blocked, []); assert.deepEqual(await js('errors'), []);
    assert.ok(hubRequests.every(method => method === 'GET'), 'Local probes must not post credentials or checks to the Hub');
    report.ok = true; report.vendorRequestCount = vendorRequests.length; report.hubReads = hubRequests.length;
  }).catch(async error => {
    report.error = String(error.stack || error);
    if (win && !win.isDestroyed()) report.renderer = await js('({errors,state:typeof _mdLoadState==="string"?_mdLoadState:"missing",text:document.body.innerText})').catch(() => null);
  }).finally(async () => {
    win?.destroy(); for (const socket of sockets) socket.destroy();
    if (server) await new Promise(resolve => server.close(resolve));
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, cases: report.cases.length, output, error: report.error }));
    app.exit(report.ok ? 0 : 1);
  });
}
