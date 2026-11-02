'use strict';
// Real renderer -> production preload/IPC -> actual packaging and PC library.
// Isolated account/workspace; no model, production account or Hub is used.
const electron = require('electron');
if (typeof electron === 'string') {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-output-save-'));
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename, temporary], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 120000);
  child.on('exit', code => { clearTimeout(timer);
    if (path.dirname(path.resolve(temporary)) !== path.resolve(os.tmpdir())) throw Error('Unsafe cleanup');
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain, net } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
  const root = path.resolve(process.argv[2]);
  const client = path.resolve(__dirname, '..'), out = path.resolve(client, '../outputs/generated-output-library-roundtrip');
  const read = name => fs.readFileSync(path.join(client, name), 'utf8');
  fs.mkdirSync(out, { recursive: true }); app.setPath('userData', path.join(root, 'profile'));
  const report = { ok: false, boundary: 'Real Electron, preload, delivery packaging, PC storage and library panel; isolated identity, no Hub/model.', cases: [] };
  const sessions = new Map(), runtime = require('../main/conversation/artifact-runtime');
  const outputs = require('../main/pi-session/outputs'), packages = require('../main/conversation/delivery-package');
  let win, failWrite = false, writes = 0, externalOpens = 0;
  const js = async code => { try { return await win.webContents.executeJavaScript(code, true); } catch(error) { throw Error(error.message + '\nScript: ' + code.slice(0, 500)); } };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(code) { for (let n = 0; n < 160; n++) { if (await js(code)) return; await delay(25); } throw Error('Timed out: ' + code); }
  async function click(selector) {
    const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Missing enabled action');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point });
    await delay(50); await js('window.pending');
  }
  async function render(ref, legacy = false) {
    const files = runtime.snapshot(sessions.get(ref)).items.map(file => ({ ...file, changedInTurn: true }));
    await js(`closeLibraryPanel?.();messages.innerHTML='<article class="nmsg ai"><p>Generated files</p></article>';window.ref=${JSON.stringify(ref)};LibraryTransfer.bindSession(()=>({sessionId:window.ref,conversationTitle:window.ref}));window.files=${JSON.stringify(files)};
      if(${legacy})LibraryTransfer.decorateOutputs(messages,files,ref,{status:'idle'});
      else {ChatDeliveries.decorate(messages,files,ref,{status:'idle'});ChatDeliveries.hydrate(messages,{ref,api:soduWorkAPI.conversationSession,snapshot:{status:'idle'}});}void 0;`);
    await delay(150);
  }
  const list = scope => js(`SoduWorkAPI.listLibrary({scope:${JSON.stringify(scope || 'recommended')}})`);
  async function assertBytes(item, expected) {
    const bytes = await js(`(async()=>Array.from(new Uint8Array(await (await SoduWorkAPI.readLibraryBinary(${JSON.stringify(item.id)})).blob.arrayBuffer())))()`);
    assert.deepEqual(Buffer.from(bytes), expected);
  }
  app.whenReady().then(async () => {
    const owner = 'a'.repeat(32);
    ipcMain.on('client-distribution-info', event => { event.returnValue = { hubOrigin: 'http://127.0.0.1:1' }; });
    ipcMain.on('runtime-form', event => { event.returnValue = 'local-code'; });
    for (const [name, handler] of Object.entries({
      'hub-connection-info': () => ({ hub: 'http://127.0.0.1:1', internalTest: true, editable: false }),
      'app-version': () => 'isolated-output-save', 'sys-info': () => ({ platform: process.platform }),
      'work-root-default': () => path.join(root, 'library-workspace'), 'file-type-icon': () => ({ ok: false }), 'runner-configure': () => ({ ok: true }),
      'device-auth-bootstrap': () => ({ ok: true, stored: true, clientId: 'fixture', user: { id: 'alice' }, session: 'fixture-session', expiresIn: 3600 }),
      'pi-session-read-output-binary': (_event, ref, target) => require('../main/library-output.cjs').readAsync(sessions.get(ref), target),
    })) ipcMain.handle(name, handler);
    require('../main/library-local.cjs').install({ app, BrowserWindow, ownerOf: () => owner,
      ipcMain: { handle(name, fn) { ipcMain.handle(name, (event, ...args) => {
        if (args[0] === 'upload') { writes++; if (failWrite) throw Error('Fixture disk write failed'); }
        return fn(event, ...args);
      }); } }, shell: { openPath: async () => { externalOpens++; return ''; }, showItemInFolder() {} },
      dialog: { showSaveDialog: async () => { externalOpens++; return { canceled: true }; } } });
    require('../main/conversation/delivery-package-ipc').install({ ipcMain, session: { get: ref => sessions.get(ref) }, BrowserWindow, dialog: {} });
    for (const ext of ['md', 'html', 'png', 'pdf', 'xlsx', 'docx', 'pptx', 'bundle', 'legacy']) {
      const cwd = path.join(root, ext); fs.mkdirSync(cwd);
      const files = ext === 'bundle' ? { 'a.md': '# A', 'nested/b.md': '# B' } : { ['result.' + (ext === 'legacy' ? 'md' : ext)]: ext === 'html' ? '<!doctype html><html><body>Result</body></html>' : '# Exact file bytes: ' + ext };
      for (const [name, content] of Object.entries(files)) { const filename = path.join(cwd, name); fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, content); }
      sessions.set(ext, { cwd, sessionId: ext, sessionTitle: 'Generated ' + ext, snapshot: () => ({ status: 'idle' }), outputSnapshot: () => outputs.scan(cwd, 0, 1) });
    }
    win = new BrowserWindow({ show: false, width: 1100, height: 760, webPreferences: { preload: path.join(client, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, offscreen: true, backgroundThrottling: false } });
    win.webContents.on('console-message', event => { if (String(event.message).includes('Error')) console.log('RENDERER', event.message); });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, callback) => callback({ cancel: true }));
    const html = read('e2e/fixtures/library.html').replaceAll('../../', pathToFileURL(client + path.sep).href);
    win.webContents.session.protocol.handle('file', request => request.url === pathToFileURL(path.join(client, 'desk.html')).href
      ? new Response(html, { headers: { 'Content-Type': 'text/html' } }) : net.fetch(request.url, { bypassCustomProtocolHandlers: true }));
    await win.loadFile(path.join(client, 'desk.html'));
    await win.webContents.insertCSS(read('components/panels/chat-deliveries.css') + read('components/panels/library-transfer.css') + '#messages{margin:80px;max-width:800px}');
    await js(`localStorage.setItem('soduwork_work_root',${JSON.stringify(path.join(root, 'library-workspace'))});window.notices=[];window.petSay=text=>notices.push(text);window.messages=document.createElement('main');messages.id='messages';document.body.append(messages);void 0;`);
    for (const file of ['api-library-local.js', 'core/api-work-plugins.js', 'api.js', 'components/panels/library-file-icons.js', 'components/panels/panels-library-dialogs.js', 'components/panels/panels-library.js', 'components/panels/library-transfer.js', 'components/panels/chat-deliveries.js']) await js(read(file) + '\nvoid 0;');
    await js(`SoduWorkAPI.registerClient()`);
    await js(`window.WorkspaceHost={open:(_view,payload)=>openLibraryPanel(payload)};messages.addEventListener('click',event=>{const node=event.target.closest('button');if(node)window.pending=node.hasAttribute('data-library-output')?LibraryTransfer.saveDecorated(node):ChatDeliveries.handle(node,soduWorkAPI.conversationSession);});void 0;`);
    for (const ext of sessions.keys()) {
      const legacy = ext === 'legacy', action = legacy ? '[data-library-output]' : '[data-delivery-retry]';
      await render(ext, legacy); assert.equal(await js(`document.querySelector('${action}').classList.contains('is-saved')`), false);
      const before = writes; await delay(100); assert.equal(writes, before, 'Rendering must not save');
      if (ext === 'md') {
        failWrite = true; await click(action); failWrite = false;
        assert.equal(await js(`document.querySelector('${action}').classList.contains('is-saved')`), false);
        assert.equal((await list()).items.length, 0);
        assert.match(await js(`document.querySelector('[data-delivery-status]').textContent`), /Fixture disk write failed/);
      }
      await click(action); assert.equal(await js(`document.querySelector('${action}').classList.contains('is-saved')`), true);
      const item = (await list()).items.find(item => item.sessionId === ext);
      assert.ok(item, 'Saved item appears in Recommended: ' + ext);
      assert.ok((await list('all')).items.some(row => row.id === item.id));
      const expected = legacy ? fs.readFileSync(path.join(sessions.get(ext).cwd, 'result.md')) : (await packages.prepare(sessions.get(ext), runtime.snapshot(sessions.get(ext)).items.map(file => file.artifactId))).bytes;
      await assertBytes(item, expected);
      await js('openLibraryPanel();void 0;');
      await until(`document.querySelector('[data-library-select="${item.id}"]')`);
      await js('closeLibraryPanel();void 0;');
      const written = writes; await click(action); assert.equal(writes, written, 'Saved icon must locate, not upload again');
      await until(`document.querySelector('[data-library-select="${item.id}"]')`);
      assert.equal(await js(`document.body.innerText.includes(${JSON.stringify(item.filename)})`), true);
      await js('closeLibraryPanel();void 0;');
      if (!legacy) { await js(read('components/panels/chat-deliveries.js') + '\nvoid 0;'); await render(ext); await until(`document.querySelector('${action}').classList.contains('is-saved')`); assert.equal(writes, written); }
      report.cases.push(ext + ': explicit save, exact bytes, recommended/all visibility, duplicate click, receipt restoration');
    }
    await render('bundle');
    await until(`document.querySelector('[data-delivery-retry]').classList.contains('is-saved')`);
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await delay(150);
    fs.writeFileSync(path.join(out, 'bundle-saved.png'), (await win.webContents.capturePage()).toPNG());
    assert.equal(externalOpens, 0, 'Saving never opens a system app or download dialog');
    report.ok = true;
  }).catch(error => { report.error = String(error.stack); }).finally(async () => {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
    if (win) win.destroy();
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('soduwork-output-save-')) throw Error('Unsafe cleanup path');
    app.exit(report.ok ? 0 : 1);
  });
}
