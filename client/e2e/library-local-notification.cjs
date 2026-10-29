'use strict';
// Production renderer, preload, native file stores, Hub routes and attachment
// transport in isolated accounts. No production services or real recipients.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 120000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain, net } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
  const assert = require('node:assert/strict'), { spawn } = require('node:child_process'), { pathToFileURL } = require('node:url');
  const client = path.resolve(__dirname, '..'), backend = path.resolve(client, '../hub-backend');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-library-e2e-'));
  const output = path.resolve(client, '../outputs/library-local-notification');
  fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(temporary, 'profile'));
  const owners = Object.fromEntries(['sender', 'recipient', 'other'].map(name => [name, crypto.randomBytes(16).toString('hex')]));
  const report = { ok: false, boundary: 'Isolated real Electron, preload, native stores, SQLite Hub routes and signed attachment download. Fixture identity and organization only; no real messages.', cases: [], errors: [] };
  let win, server, origin, account = 'sender', serverLog = '';
  const read = file => fs.readFileSync(path.join(client, file), 'utf8');
  const js = code => win.webContents.executeJavaScript(code, true);
  const call = (method, ...args) => js(`SoduWorkAPI[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(code) { for (let i = 0; i < 120; i++) { if (await js(code)) return; await wait(25); } throw Error('Timed out: ' + code); }
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click();void 0;`);
  const identity = () => ({ ok: true, stored: true, clientId: 'fixture-device-' + account, user: { id: account }, session: 'fixture-' + account, expiresIn: 3600 });
  const counts = async () => (await fetch(origin + '/fixture/counts')).json();
  app.whenReady().then(async () => {
    const probe = require('node:net').createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); origin = 'http://127.0.0.1:' + port;
    server = spawn(path.join(backend, '.venv/Scripts/python.exe'), ['-m', 'uvicorn', 'tests.library_notification_server:app', '--host', '127.0.0.1', '--port', String(port)], {
      cwd: backend, windowsHide: true, env: { ...process.env, SODUWORK_LIBRARY_E2E_ROOT: temporary }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', data => serverLog += data); server.stderr.on('data', data => serverLog += data);
    let ready = false;
    for (let i = 0; i < 180; i++) { try { ready = (await fetch(origin + '/ready')).ok; } catch (_) {} if (ready) break; await wait(100); }
    assert(ready, serverLog);
    ipcMain.on('runtime-form', event => { event.returnValue = 'local-code'; });
    ipcMain.on('client-distribution-info', event => {
      event.returnValue = { ...require('../main/distribution.cjs').publicInfo(), hubOrigin: origin };
    });
    for (const [channel, handler] of Object.entries({
      'hub-connection-info': () => ({ hub: origin, internalTest: true, editable: false }),
      'app-version': () => 'notification-fixture', 'sys-info': () => ({ platform: process.platform }),
      'file-type-icon': () => ({ ok: false }), 'runner-configure': () => ({ ok: true }), 'device-auth-bootstrap': identity,
      'device-auth-login': (_event, input) => { assert(owners[input.account]); account = input.account; return identity(); },
    })) ipcMain.handle(channel, handler);
    require('../main/library-local.cjs').install({ app, ipcMain, BrowserWindow, ownerOf: () => owners[account], shell: {}, dialog: {} });
    require('../main/attachment-files.js').install({ app, ipcMain, BrowserWindow, net, ownerOf: () => owners[account],
      identityOf: () => ({ hub: origin, clientId: 'fixture-device-' + account, secret: 'fixture' }), dialog: {}, shell: {} });
    win = new BrowserWindow({ show: false, width: 1120, height: 820, webPreferences: {
      preload: path.join(client, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false,
    } });
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 3 && !message.includes('favicon')) report.errors.push(message); });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (request, done) => {
      const blocked = new URL(request.url).origin !== origin; if (blocked) report.errors.push('External request blocked'); done({ cancel: blocked });
    });
    const html = read('e2e/fixtures/library.html').replaceAll('../../', pathToFileURL(client + path.sep).href);
    win.webContents.session.protocol.handle('file', request => request.url === pathToFileURL(path.join(client, 'desk.html')).href
      ? new Response(html, { headers: { 'Content-Type': 'text/html' } }) : net.fetch(request.url, { bypassCustomProtocolHandlers: true }));
    await win.loadFile(path.join(client, 'desk.html'));
    const sheets = [...read('desk.html').matchAll(/<link\s+rel=["']stylesheet["']\s+href=["']([^"']+)["']/g)].map(match => match[1]);
    const urls = sheets.map(file => pathToFileURL(path.join(client, file)).href);
    await js(`(async()=>{document.querySelectorAll('link[rel=stylesheet]').forEach(e=>e.remove());await Promise.all(${JSON.stringify(urls)}.map(href=>new Promise((resolve,reject)=>{const e=document.createElement('link');e.rel='stylesheet';e.href=href;e.onload=resolve;e.onerror=reject;document.head.append(e)})));})()`);
    await js(`window.toasts=[];window.petSay=value=>toasts.push(value);window.esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));window._nkIcon=()=>'';void 0;`);
    for (const file of ['api-library-local.js', 'core/api-work-plugins.js', 'api.js', 'components/panels/library-file-icons.js', 'components/panels/panels-library-dialogs.js', 'components/panels/panels-library.js']) await js(read(file) + '\nvoid 0;');
    await call('registerClient');
    const source = (await js(`SoduWorkAPI.uploadLibraryFile(new File([${JSON.stringify('exact shared text\n原文')}],'old.txt',{type:'text/plain'}),'','local')`)).item;
    await call('updateLibraryItem', source.id, { title: 'renamed' });
    const share = { requestId: crypto.randomUUID() };
    await call('shareLibraryItem', source.id, ['recipient'], 'Review', share);
    await call('shareLibraryItem', source.id, ['recipient'], 'Review', share);
    assert.deepEqual(await counts(), { LibraryItem: 0, Attachment: 1, MateMessage: 1 });
    report.cases.push('Local renamed bytes create one durable notification snapshot; retry creates no extra message or remote LibraryItem');
    await call('deleteLibraryItem', source.id); await call('purgeLibraryItem', source.id);
    await call('clientLogin', { account: 'recipient' });
    assert.equal((await call('listLibrary')).items.length, 0);
    const inbox = await call('mateMessages', 'received'); assert.equal(inbox.items.length, 1);
    const attachment = inbox.items[0].attachments[0]; assert.equal(attachment.name, 'renamed.txt');
    const metadata = await call('mateMessageFile', attachment.id);
    const binary = await js(`soduWorkAPI.readAttachmentBinary({url:SoduWorkAPI.attachmentUrl(${JSON.stringify(metadata)}),filename:'renamed.txt'})`);
    assert.equal(Buffer.from(binary.data, 'base64').toString(), 'exact shared text\n原文');
    assert.equal((await call('listLibrary')).items.length, 0);
    report.cases.push('Recipient reads authenticated signed bytes after sender purges the local source; receiving and opening never save to the library');
    await js(`window._taskStorageKey=kind=>SoduWorkAPI.taskStorageKey(kind);window.LS_KEY=()=>_taskStorageKey('tasks');void 0;`);
    const store = read('core/store.js'), first = store.indexOf('const LS_NOTICES='), end = store.indexOf('function noticeUnread()', first);
    await js(store.slice(first, end) + '\nvoid 0;');
    for (const file of ['core/mate-notice-sync.js', 'components/panels/panels-desk.js']) await js(read(file) + '\nvoid 0;');
    await js('openNoticePanel();void 0;'); await until('!!document.querySelector("[data-notice-action=save]")');
    assert.equal((await call('listLibrary')).items.length, 0);
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    await wait(320);
    fs.writeFileSync(path.join(output, 'received-save-choice.png'), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
    await click('[data-notice-action=save]'); await until('toasts.includes("已保存到本机资料库")');
    const saved = (await call('listLibrary')).items[0]; assert.equal(saved.filename, 'renamed.txt');
    assert.equal((await call('readLibraryContent', saved.id)).content, 'exact shared text\n原文');
    assert.deepEqual(await counts(), { LibraryItem: 0, Attachment: 1, MateMessage: 1 });
    report.cases.push('Only clicking Save to library writes the received file through real preload and native local storage');
    await click('[data-notice-action=save]'); await until('document.querySelector(".library-confirm-dialog")?.open');
    assert.match(await js('document.querySelector(".library-confirm-dialog").textContent'), /同名/);
    assert.equal((await call('listLibrary')).items.length, 1);
    assert.equal((await call('readLibraryContent', saved.id)).content, 'exact shared text\n原文');
    await click('.library-confirm-submit');
    report.cases.push('Saving again presents the existing themed duplicate-name dialog and preserves the original bytes');
    win.setSize(420, 650); await wait(320);
    const layout = await js(`(()=>{const button=document.querySelector('[data-notice-action=save]'),r=button.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,viewport:innerWidth,scroll:document.querySelector('.np-body').scrollWidth,client:document.querySelector('.np-body').clientWidth}})()`);
    assert(layout.left >= 0 && layout.right <= layout.viewport && layout.width > 0, JSON.stringify(layout));
    assert(layout.scroll <= layout.client + 1, JSON.stringify(layout));
    fs.writeFileSync(path.join(output, 'received-save-narrow.png'), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
    await click('[data-notice-folder=sent]'); await until('document.querySelector("[data-notice-folder=sent]").classList.contains("is-active")');
    assert.equal(await js('!!document.querySelector("[data-notice-action=save]")'), false);
    report.cases.push('Received save controls stay within the narrow notice layout; sent notifications do not offer recipient saving');
    await call('clientLogin', { account: 'other' });
    assert.equal((await call('listLibrary')).items.length, 0);
    assert.equal((await call('mateMessages', 'received')).items.length, 0);
    assert.equal(await js(`SoduWorkAPI.mateMessageFile(${JSON.stringify(attachment.id)}).then(()=>false,e=>e.status===404)`), true);
    report.cases.push('Another signed-in account cannot list the message, read its attachment, or see the recipient local library');
    report.ok = true;
  }).catch(error => { report.error = String(error.stack || error); report.serverLog = serverLog.slice(-7000); }).finally(async () => {
    if (win && !win.isDestroyed()) win.destroy();
    if (server) { const done = new Promise(resolve => server.once('exit', resolve)); server.kill(); await Promise.race([done, wait(2000)]); }
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
    app.exit(report.ok ? 0 : 1);
  });
}
