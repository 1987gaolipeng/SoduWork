'use strict';
// Source-only fixture: local HTTP, synthetic cloud receipts and a private profile.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','ELECTRON_NO_ATTACH_CONSOLE','CHROME_CRASHPAD_PIPE_NAME','CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' });
  const timeout = setTimeout(() => { child.kill(); process.exitCode = 1; }, 45000);
  child.on('exit', code => { clearTimeout(timeout); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, WebContentsView, ipcMain } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
  const crypto = require('node:crypto'), assert = require('node:assert/strict');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-cloud-native-'));
  const out = path.resolve(__dirname, '../../outputs/cloud-delivery-20261014'); fs.mkdirSync(out, { recursive: true });
  app.setPath('userData', path.join(root, 'profile')); app.on('window-all-closed', () => {});
  const { create } = require('../main/conversation/cloud-handoff');
  const runtime = require('../main/conversation/artifact-runtime');
  const contents = { page: '<!doctype html><title>Private cloud page</title><link rel="stylesheet" href="assets/style.css"><h1>Cloud result</h1><script src="assets/app.js"></script>',
    css: 'h1{color:rgb(19,84,73)}', js: 'document.body.dataset.cloudReady="yes";' };
  const names = { page: 'index.html', css: 'assets/style.css', js: 'assets/app.js' };
  const rows = Object.entries(contents).map(([id, text]) => ({ id, taskId: 'task', filename: names[id], role: 'output',
    evidenceMeta: { round: 1, category: id === 'page' ? 'primary' : 'supporting' }, size: Buffer.byteLength(text),
    sha256: crypto.createHash('sha256').update(text).digest('hex'), url: '/attachments/' + id + '?ticket=fixture' }));
  let server, win, handle, current, receipt, emptyPoll = true, polls = 0, downloads = 0, fork;
  const views = [], report = { ok: false, cases: [] };
  const account = (hub, uid) => ({ hub, clientId: 'fixture', session: Buffer.from(JSON.stringify({
    typ: 'device', uid, cid: 'fixture', iat: 1, exp: 9999999999 })).toString('base64url') + '.' + 'a'.repeat(64) });
  const request = async (_identity, route, options) => {
    if (route.startsWith('/cloud-conversations/')) {
      const input = JSON.parse(options.body.get('options'));
      receipt = { transferId: route.split('/').at(-1), phase: 'committed', taskId: 'task', ref: 'remote',
        source: { sessionId: input.sessionId, adapterId: input.agentId, entryKind: 'cloud' } };
      return receipt;
    }
    if (route.includes('/ai-session')) return { ref: 'remote', status: 'completed', last: 0, items: [] };
    if (route.endsWith('/ai-status')) return { status: 'completed' };
    if (route.endsWith('/attachments')) { polls++; return emptyPoll ? [] : rows; }
    if (route.startsWith('/conversation-handoffs/')) return receipt;
    throw Error('Unexpected fixture route: ' + route);
  };
  const controller = () => create({ app, identityOf: async () => current, request, interval: 60000 });
  const until = async (fn, label) => { for (let i = 0; i < 160; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 30)); } throw Error('Timed out: ' + label); };
  app.whenReady().then(async () => {
    server = http.createServer((req, res) => {
      assert.equal(req.headers.authorization, 'Device ' + current.session);
      const id = req.url.split('/').at(-1).split('?')[0]; downloads++;
      if (!contents[id]) { res.writeHead(404); res.end(); return; } res.end(contents[id]);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    current = account('http://127.0.0.1:' + server.address().port, 'alice');
    let cloud = controller();
    const started = await cloud.start({ requestId: crypto.randomUUID(), agentId: 'pi', text: 'Create a website' });
    handle = await cloud.reopen(started.sessionId, 'fixture');
    await until(() => polls > 0, 'settled poll');
    assert.deepEqual(handle.outputSnapshot().files, []);
    emptyPoll = false;
    const result = await cloud.materialize(handle, { taskId: 'task', attachmentId: 'page' });
    assert.equal(result.ok, true); assert.equal(result.artifacts.length, 3); assert.equal(downloads, 3);
    assert.ok(result.artifacts.every(file => file.cloudTaskId === 'task' && file.remoteAttachmentId && file.artifactId));
    assert.match(result.artifact.path, /cloud-results/);
    report.cases.push('An unmaterialized cloud selection downloads the complete verified batch over authenticated local HTTP');
    require('../main/agent-runtime/pi-session-bridge').get = ref => ref === 'fixture' ? handle : ref === 'local-fork' ? fork : null;
    require('../main/work-preview').install({ ipcMain, BrowserWindow,
      WebContentsView: function(options) { const view = new WebContentsView(options); views.push(view); return view; },
      shell: { openExternal: async () => { throw Error('External navigation is forbidden'); } } });
    const host = path.join(root, 'host.html'); fs.writeFileSync(host, '<!doctype html><title>Fixture</title>');
    win = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: {
      preload: path.resolve(__dirname, '../preload.js'), contextIsolation: true, nodeIntegration: false } });
    await win.loadFile(host);
    const show = tabId => win.webContents.executeJavaScript('soduWorkAPI.workPreview.show(' + JSON.stringify({
      tabId, ref: 'fixture', kind: 'artifact', artifactId: result.artifact.artifactId,
      bounds: { x: 0, y: 0, width: 900, height: 600 } }) + ')');
    assert.equal((await show('cloud')).ok, true);
    await until(() => views.some(view => view.webContents.getTitle() === 'Private cloud page'), 'native preview');
    const page = views.find(view => view.webContents.getTitle() === 'Private cloud page').webContents;
    assert.match(page.getURL(), /^http:\/\/127\.0\.0\.1:\d+\/index\.html/);
    assert.deepEqual(await page.executeJavaScript('({ready:document.body.dataset.cloudReady,color:getComputedStyle(document.querySelector("h1")).color})'),
      { ready: 'yes', color: 'rgb(19, 84, 73)' });
    report.cases.push('Production preload and native WebContentsView resolve the private cloud projection and run its HTML/CSS/JS');
    let continueLocal;
    require('../main/conversation/local-delivery-action').install({app,
      ipcMain:{handle:(name,fn)=>{if(name==='conversation-delivery-continue-local')continueLocal=fn;}},
      session:{get:ref=>ref==='fixture'?handle:null},ownerOf:()=>require('../main/platform-connections/runtime.cjs').scope(current),
      resolveSession:original=>cloud.artifactSession(original),shell:{}});
    const frame={},event={senderFrame:frame,sender:{mainFrame:frame,isDestroyed:()=>false,
      getURL:()=>require('node:url').pathToFileURL(path.resolve(__dirname,'../desk.html')).href}};
    const copied=await continueLocal(event,'fixture',[result.artifact.artifactId]);
    assert.equal(copied.ok,true,copied.reason);assert.notEqual(copied.cwd,path.dirname(result.artifact.path));
    fork={cwd:copied.cwd,sessionId:'fork',snapshot:()=>({status:'idle'}),outputSnapshot:()=>require('../main/pi-session/outputs').scan(copied.cwd,0,1)};
    const forkEntry=runtime.snapshot(fork).items.find(item=>item.relative==='index.html');
    const shown=await win.webContents.executeJavaScript('soduWorkAPI.workPreview.show('+JSON.stringify({
      tabId:'local-fork',ref:'local-fork',kind:'artifact',artifactId:forkEntry.artifactId,bounds:{x:0,y:0,width:900,height:600}})+')');
    assert.equal(shown.ok,true);
    await until(()=>views.some(view=>view.webContents.getTitle()==='Private cloud page'&&view.webContents.getURL()!==page.getURL()),'local fork preview');
    const localPage=views.find(view=>view.webContents.getTitle()==='Private cloud page'&&view.webContents.getURL()!==page.getURL()).webContents;
    assert.equal(await localPage.executeJavaScript('document.body.dataset.cloudReady'),'yes');
    fs.writeFileSync(copied.file.path,'<h1>Local edited copy</h1>');
    assert.equal(fs.readFileSync(result.artifact.path,'utf8'),contents.page);
    report.cases.push('Actual continuation IPC copies all assets; native local HTML executes JS and local edits never modify the cloud cache');
    handle.close(); cloud = controller(); handle = await cloud.reopen(started.sessionId, 'fixture');
    assert.equal((await cloud.artifactSession(handle)).outputSnapshot().files.length, 3);
    assert.equal((await show('reopened')).ok, true);
    report.cases.push('A fresh cloud coordinator reopens the persisted verified cache for native preview');
    await assert.rejects(cloud.materialize(handle, { taskId: 'foreign', attachmentId: 'page' }), /不属于/);
    current = account(current.hub, 'bob');
    assert.equal((await show('foreign-account')).ok, false);
    await assert.rejects(cloud.materialize(handle, { taskId: 'task', attachmentId: 'page' }), /其他账号/);
    assert.equal(downloads, 3);
    report.cases.push('Foreign task and account cannot materialize or open a private cloud preview');
    report.ok = true;
  }).catch(error => { report.error = String(error.stack || error); }).finally(async () => {
    handle?.close(); win?.destroy(); runtime.dispose?.(); server?.close();
    fs.writeFileSync(path.join(out, 'native-preview.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
    await require('node:fs/promises').rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
    app.exit(report.ok ? 0 : 1);
  });
}
