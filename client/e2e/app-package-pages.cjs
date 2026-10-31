'use strict';
// Three real Electron launches: install, process restart, then import on another profile.
const electron = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
if (typeof electron === 'string') {
  const evidence = process.env.SODUWORK_PACKAGE_EVIDENCE;
  if (evidence) fs.mkdirSync(evidence,{recursive:true});
  const root = fs.mkdtempSync(path.join(evidence || os.tmpdir(), 'soduwork-static-h5-'));
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  for (const phase of ['install', 'restart', 'receiver']) {
    const result = require('node:child_process').spawnSync(electron, [__filename, root, phase], { env, windowsHide: true, encoding: 'utf8', timeout: 45000 });
    process.stdout.write(result.stdout || '');
    if (result.status !== 0) { process.stderr.write(result.stderr || String(result.error)); process.exit(result.status || 1); }
    if (phase === 'install') fs.renameSync(path.join(root, 'candidate'),path.join(root,'candidate-source-kept'));
  }
} else {
  const { app, BrowserWindow, WebContentsView, ipcMain } = electron;
  const root = process.argv[2], phase = process.argv[3];
  app.setPath('userData', path.join(root, phase === 'receiver' ? 'receiver-profile' : 'author-profile'));
  app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
  const personal = require('../main/personal-plugins'), resources = require('../main/plugin-resources');
  const windows = []; let host;
  const report = { phase, ok: false, boundary: 'Real Electron package resource protocol, isolated profiles, no HTTP server, business service, credentials or models.' };
  const js = async (wc, text) => { try { return await wc.executeJavaScript(text); }
    catch (error) { throw Error(text.slice(0, 140) + ': ' + (error?.message || JSON.stringify(error))); } };
  async function until(check) { for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 30)); } throw Error('Package page did not become ready'); }
  app.whenReady().then(async () => {
    require('../main/app-settings-store.cjs').configure({app,safeStorage:electron.safeStorage,ownerOf:()=>'fixture/account'});
    console.log('Package phase',phase,'started');
    let pluginId;
    if (phase === 'install') {
      const out = path.join(root, 'candidate');
      require('../../skills/app-developer/scripts/scaffold.cjs').scaffold({ out, key: 'static-h5', name: '纯静态便签' });
      const draftPath = path.join(out, 'soduwork-plugin-draft.json'), draft = JSON.parse(fs.readFileSync(draftPath, 'utf8'));
      let html = fs.readFileSync(path.join(out, 'ui/index.html'), 'utf8');
      html = html.replace('</main>', '<button id="counter">Increase</button><output id="total"></output><div id="data"></div><img id="picture" src="picture.svg"></main>') + '<link rel="stylesheet" href="styles.css"><script type="module" src="local.mjs"></script>';
      fs.writeFileSync(path.join(out, 'ui/index.html'), html);
      const files = { 'styles.css': '#data{color:rgb(18,52,86)}', 'data.json': '{"message":"离线数据"}',
        'math.mjs': 'export const add=n=>n+1;',
        'local.mjs': `import{add}from'./math.mjs';const total=document.getElementById('total');total.textContent=localStorage.getItem('count')||'0';document.getElementById('counter').onclick=()=>{total.textContent=add(Number(total.textContent));localStorage.setItem('count',total.textContent)};document.getElementById('data').textContent=(await(await fetch('./data.json')).json()).message;window.staticReady=true;`,
        'picture.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="blue"/></svg>' };
      for (const [file, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(out, 'ui', file), content);
        draft.resources.push({ path: 'ui/' + file, kind: 'ui' });
      }
      const collected = resources.collect(draft, draftPath, out);
      pluginId = personal.create(app, collected).plugin.pluginId;
      fs.writeFileSync(path.join(root, 'id.json'), JSON.stringify(pluginId));
      await personal.exportToFile(app, { showSaveDialog: async () => ({ filePath: path.join(root, 'static.soduwork-plugin') }) }, pluginId);
    } else if (phase === 'receiver') {
      const body = require('../main/plugin-package-reader.cjs').readPersonalArchive(fs.readFileSync(path.join(root, 'static.soduwork-plugin')));
      pluginId = personal.create(app, body).plugin.pluginId;
    } else pluginId = JSON.parse(fs.readFileSync(path.join(root, 'id.json'), 'utf8'));
    fs.writeFileSync(path.join(root, 'host.html'), '<!doctype html><title>Static package fixture</title>');
    fs.writeFileSync(path.join(root, 'composer.html'), '<!doctype html><textarea id="draft">保留草稿</textarea><script>window.received=[];soduWorkAPI.workPreview.onComposerSubmit(p=>{received.push(p.text);soduWorkAPI.workPreview.composerSubmitResult({id:p.id,ok:true})});</script>');
    require('../main/work-preview').install({ app, ipcMain,
      BrowserWindow: Object.assign(function(options) { const win = new BrowserWindow(options); windows.push(win); return win; }, { fromWebContents: wc => BrowserWindow.fromWebContents(wc) }),
      WebContentsView: function(options) { const view = new WebContentsView(options), load = view.webContents.loadFile.bind(view.webContents); view.webContents.loadFile = (file, options) => load(path.basename(file) === 'desk.html' ? path.join(root, 'composer.html') : file, options); return view; },
      shell: { openExternal: async () => { throw Error('No external navigation expected'); } } });
    host = new BrowserWindow({ show: false, webPreferences: { preload: path.resolve(__dirname, '../preload.js'), contextIsolation: true, sandbox: true } });
    await host.loadFile(path.join(root, 'host.html'));
    const opened = await js(host.webContents, `soduWorkAPI.workPreview.showDetached(${JSON.stringify({ tabId: 'package-static', package: { pluginId, contributionId: 'main' } })})`);
    assert.equal(opened.ok, true, opened.reason);
    const [, application, composer] = windows.at(-1).contentView.children, wc = application.webContents;
    await until(() => js(wc, '!!window.staticReady && picture.naturalWidth===10'));
    assert.match(wc.getURL(), /^https:\/\/[a-f0-9]{32}\.soduwork-app\.invalid\/ui\/index.html$/);
    assert.equal(await js(wc, 'document.getElementById("data").textContent'), '离线数据');
    assert.equal(await js(wc, 'getComputedStyle(document.getElementById("data")).color'), 'rgb(18, 52, 86)');
    assert.equal(await js(wc, 'typeof require'), 'undefined');
    assert.equal(await js(wc, `(async()=> (await fetch('/data.json')).json())().then(x=>x.message)`), '离线数据', 'root-relative resources resolve within the package');
    console.log('Package phase',phase,'SQLite and image checks passed');
    const storedNote = await js(wc, `new Promise((resolve,reject)=>{const request=indexedDB.open('notes',1);request.onupgradeneeded=()=>request.result.createObjectStore('notes');request.onerror=()=>reject(request.error.name+": "+request.error.message);request.onsuccess=()=>{const db=request.result,tx=db.transaction('notes','readwrite'),store=tx.objectStore('notes'),read=store.get('note');read.onsuccess=()=>{const previous=read.result;store.put('记在本机','note');tx.oncomplete=()=>{db.close();resolve(previous||'')}}}})`);
    assert.equal(storedNote, phase === 'restart' ? '记在本机' : '');
    assert.equal(await js(wc, 'document.getElementById("total").textContent'), phase === 'restart' ? '1' : '0');
    await js(wc, 'document.getElementById("counter").click()');
    const guard = require('../main/pi-session/app-mcp-grant.cjs'), handle = {}, turn = {};
    guard.bind(handle, composer.webContents, pluginId, app); guard.guardSend(handle, turn); await turn.beforeTurn();
    assert.equal(guard.forSession(handle).connection.server, 'soduwork-jiyong');
    await js(wc, 'document.getElementById("description").value="离线应用对话";document.getElementById("submit").click()');
    await until(() => js(composer.webContents, 'received.length===1'));
    assert.equal(await js(composer.webContents, 'draft.value'), '保留草稿');
    assert.equal(await js(wc, `(async()=> (await fetch('/references/private.txt')).status)()`), 404);
    console.log('Package phase',phase,'conversation checks passed');
    await wc.session.flushStorageData();
    report.ok = true; report.checks = ['bundled HTML/CSS/module JS/JSON/image', 'interactive localStorage and IndexedDB across process restart', 'portable import without original source or server', 'no ukey, business login or Node access', 'native send guard and SDK conversation', 'undeclared resources blocked'];
  }).catch(error => { report.error = String(error.stack || error); }).finally(() => {
    host?.destroy(); for (const win of windows) if (!win.isDestroyed()) win.destroy();
    console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
  });
}
