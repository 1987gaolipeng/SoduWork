'use strict';
// Isolated authenticated Hub -> production preload/IPC -> right native preview.
// The private file protocol serves a fixture at the trusted workspace URL; no
// application profile, business data, external model or production Hub is used.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)],
    { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 60000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, WebContentsView, ipcMain, net, session } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const http = require('node:http'), crypto = require('node:crypto'), assert = require('node:assert/strict');
  const { pathToFileURL } = require('node:url');
  const client = path.resolve(__dirname, '..');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-preview-auth-'));
  const output = path.resolve(process.argv[2] || path.join(client, '../outputs/attachment-preview-auth-20261022'));
  fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(root, 'profile'));
  app.on('window-all-closed', () => {});
  const cwd = path.join(root, 'work'); fs.mkdirSync(cwd);
  const bytes = {
    page: '<!doctype html><meta charset="utf-8"><title>Authenticated delivery</title><link rel="stylesheet" href="style.css"><h1>成果已打开</h1><script src="app.js"></script>',
    style: 'h1{color:rgb(34,139,90)}', script: 'document.body.dataset.ready="verified";',
  };
  const names = { page: 'stardust-era.html', style: 'style.css', script: 'app.js' };
  const rows = Object.entries(bytes).map(([id, text]) => ({ id, taskId: 'task', filename: names[id],
    role: id === 'page' ? 'output' : 'supporting', size: Buffer.byteLength(text),
    sha256: crypto.createHash('sha256').update(text).digest('hex'),
    url: '/attachments/' + id + '?ticket=private-fixture-ticket',
    evidenceMeta: { identifier: 'turn-1', category: id === 'page' ? 'primary' : 'supporting' } }));
  const handle = { cwd, sessionId: 'fixture', deliveryOwner: 'fixture-owner', snapshot: () => ({ status: 'idle' }) };
  const views = [], requests = [], report = { ok: false, isolated: true, cases: [], errors: [] };
  let win, server, identity, listStatus = 200;
  const js = code => win.webContents.executeJavaScript(code, true);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (check, label) => {
    for (let n = 0; n < 150; n++) { if (await check()) return; await delay(30); }
    throw Error('Timed out: ' + label);
  };
  app.whenReady().then(async () => {
    server = http.createServer((req, res) => {
      requests.push({ url: req.url, auth: req.headers.authorization, secret: req.headers['x-soduwork-secret'] });
      if (req.headers.authorization !== 'Device fixture-session') { res.writeHead(401); return res.end('{}'); }
      if (req.url === '/api/v1/tasks/task/attachments') {
        res.writeHead(listStatus, { 'content-type': 'application/json' }); return res.end(JSON.stringify(rows));
      }
      const id = new URL(req.url, 'http://fixture').pathname.split('/').at(-1);
      if (!(id in bytes)) { res.writeHead(404); return res.end(); }
      res.end(bytes[id]);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    identity = { hub: 'http://127.0.0.1:' + server.address().port, clientId: 'device', session: 'fixture-session' };
    const get = ref => ref === 'fixture' ? handle : null;
    require('../main/agent-runtime/pi-session-bridge').get = get;
    require('../main/pi-session/attachment-materialize').install({ app, ipcMain,
      identityOf: async () => identity, ownerOf: () => 'fixture-owner', sessionOf: get });
    require('../main/work-preview').install({ app, ipcMain, BrowserWindow,
      WebContentsView: function(options) { const view = new WebContentsView(options); views.push(view); return view; },
      shell: { openExternal: async () => { throw Error('Unexpected external navigation'); } } });
    const href = file => pathToFileURL(path.join(client, file)).href;
    const css = ['theme/variables.css', 'components/panels/panels-chat.css', 'components/panels/code-workbench.css', 'components/panels/chat-deliveries.css'];
    const scripts = ['chat-output-links', 'chat-dom-patch', 'panels-chat-tools', 'chat-workspace-info',
      'chat-workspace-split', 'chat-workspace-controls', 'panels-chat-workspace', 'chat-deliveries'];
    const html = '<!doctype html><meta charset="utf-8">' + css.map(file => '<link rel="stylesheet" href="' + href(file) + '">').join('') +
      '<style>body{margin:0;font-family:Segoe UI}.nchat{height:100vh}.nchat-stage{height:100%;display:flex}.nchat-main{flex:1;min-width:0;padding:24px}.nmsg{width:100%}</style>' +
      '<main class="nchat" id="chat"><div class="nchat-stage"><section class="nchat-main" id="messages"><article class="nmsg ai"><div class="ntext">已完成，点击预览成果。</div><button data-open-app="task-output:task:page" hidden></button></article></section></div></main>' +
      scripts.map(file => '<script src="' + href('components/panels/' + file + '.js') + '"></script>').join('');
    const desk = href('desk.html'), isolated = session.fromPartition('attachment-preview-' + crypto.randomUUID());
    isolated.protocol.handle('file', request => request.url === desk
      ? new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      : net.fetch(request, { bypassCustomProtocolHandlers: true }));
    win = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: {
      preload: path.join(client, 'preload.js'), session: isolated, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) report.errors.push(message); });
    await win.loadURL(desk);
    const file = { artifactId: 'task-output:task:page', taskId: 'task', attachmentId: 'page',
      kind: 'website', name: 'stardust-era.html', relative: 'stardust-era.html', size: rows[0].size, primary: true };
    await js(`window.notices=[];window.petSay=text=>notices.push(text);window.SoduWorkAPI={taskStorageKey:()=>"fixture-scope"};
      window.files=[${JSON.stringify(file)}];ChatWorkbench.bind(chat,()=>({ref:'fixture'}));
      ChatWorkbench.render(chat,{messages:[]},[]);
      ChatDeliveries.decorate(messages,files,'fixture',{status:'idle',cloudHandoff:{taskId:'task'}});
      ChatWorkbench.render(chat,{messages:[]},files.map(file=>({...file,primary:false})));
      messages.addEventListener('click',event=>{const button=event.target.closest('[data-open-app]');if(button)ChatWorkbench.openOutput(button.dataset.openApp)});void 0;`);
    const selector = '.ndelivery [data-open-app]';
    const point = await js(`(()=>{const r=document.querySelector('${selector}').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    await until(() => views.some(view => !view.webContents.isDestroyed() && view.webContents.getTitle() === 'Authenticated delivery'), 'authenticated right preview');
    const page = views.find(view => !view.webContents.isDestroyed() && view.webContents.getTitle() === 'Authenticated delivery').webContents;
    assert.match(page.getURL(), /^http:\/\/127\.0\.0\.1:\d+\//);
    assert.ok(!page.getURL().includes('ticket='));
    assert.deepEqual(await page.executeJavaScript('({ready:document.body.dataset.ready,color:getComputedStyle(document.querySelector("h1")).color})'),
      { ready: 'verified', color: 'rgb(34, 139, 90)' });
    assert.ok(requests.every(row => row.auth === 'Device fixture-session' && !row.secret));
    assert.deepEqual(await js('notices'), []);
    report.cases.push('Real filename click downloads the session-authenticated batch and opens HTML/CSS/JS in the right native view without exposing tickets');
    assert.equal(await js(`getComputedStyle(document.querySelector('${selector}')).outlineStyle`), 'none');
    report.cases.push('Mouse selection does not leave the browser default rectangle');
    await js('document.querySelector("[data-wb-close]").click();document.activeElement.blur();document.body.tabIndex=-1;document.body.focus();void 0;');
    win.webContents.focus();
    await until(() => js('document.activeElement===document.body'), 'body before keyboard navigation');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    await until(() => js(`document.activeElement===document.querySelector('${selector}') && document.activeElement.matches(':focus-visible')`), 'keyboard filename focus');
    assert.equal(await js('getComputedStyle(document.activeElement).outlineStyle'), 'solid');
    assert.ok(await js('parseFloat(getComputedStyle(document.activeElement).outlineWidth)>=2'), 'theme zoom preserves a visible focus ring');
    assert.equal(await js('document.activeElement.matches(":focus-visible")'), true);
    report.cases.push('Keyboard navigation retains the visible themed focus ring');
    listStatus = 401;
    const denied = await js('soduWorkAPI.attachmentMaterialize({ref:"fixture",taskId:"task",attachmentId:"page"})');
    assert.equal(denied.ok, false); assert.match(denied.reason, /HTTP 401/);
    report.cases.push('A later unauthorized request cannot reuse previously cached bytes');
    fs.writeFileSync(path.join(output, 'focus.png'), (await win.webContents.capturePage()).toPNG());
    report.ok = true;
  }).catch(error => { report.error = String(error.stack || error); }).finally(() => {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); win?.destroy(); server?.close(); app.exit(report.ok ? 0 : 1);
  });
}
