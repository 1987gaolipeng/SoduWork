'use strict';
// Production renderer, preload, native file stores, Hub routes and attachment
// transport in isolated accounts. No production services or real recipients.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 120000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain, net } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
  const assert = require('node:assert/strict'), { spawn } = require('node:child_process'), { pathToFileURL } = require('node:url');
  const client = path.resolve(__dirname, '..'), backend = path.resolve(client, '../hub-backend');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-library-e2e-mate-notices-'));
  const output = process.argv[2];
  assert(output && path.isAbsolute(output), 'An absolute evidence directory is required');
  fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(temporary, 'profile'));
  app.on('window-all-closed', () => {});
  if (process.platform === 'darwin') app.commandLine.appendSwitch('use-mock-keychain');
  const owners = Object.fromEntries(['sender', 'recipient', 'other'].map(name => [name, crypto.randomBytes(16).toString('hex')]));
  const report = { ok: false, boundary: 'Isolated real Electron, preload, native stores, SQLite Hub routes and signed attachment download. Fixture identity and organization only; no real messages.', cases: [], errors: [] };
  let win, server, origin, account = 'sender', serverLog = '';
  const read = file => fs.readFileSync(path.join(client, file), 'utf8');
  const js = code => win.webContents.executeJavaScript(code, true);
  const call = (method, ...args) => js(`SoduWorkAPI[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(code) { for (let i = 0; i < 120; i++) { if (await js(code)) return; await wait(25); } throw Error('Timed out: ' + code); }
  const downloads = path.join(temporary, 'downloads'); fs.mkdirSync(downloads, { recursive: true });
  const downloadPaths = [];
  const attachmentDialog = { showSaveDialog: async (_parent, options = {}) => {
    const filename = path.basename(options.defaultPath || 'attachment.bin');
    const target = path.join(downloads, String(downloadPaths.length + 1) + '-' + filename);
    downloadPaths.push(target); return { canceled: false, filePath: target };
  } };
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click();void 0;`);
  const identity = () => ({ ok: true, stored: true, clientId: 'fixture-device-' + account, user: { id: account }, session: 'fixture-' + account, expiresIn: 3600 });

  app.whenReady().then(async () => {
    const probe = require('node:net').createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); origin = 'http://127.0.0.1:' + port;
    const python = process.env.SODUWORK_TEST_PYTHON || path.join(backend, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
    server = spawn(python, ['-m', 'uvicorn', 'tests.mate_attachment_notice_server:app', '--host', '127.0.0.1', '--port', String(port)], {
      cwd: backend, windowsHide: true, env: { ...process.env, SODUWORK_LIBRARY_E2E_ROOT: temporary, AUTH_SECRET: crypto.randomBytes(32).toString('hex'), ADMIN_PASS: crypto.randomBytes(24).toString('hex') }, stdio: ['ignore', 'pipe', 'pipe'],
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
      // This fixture has no native push discovery; use the production HTTP fallback.
      'client-domain-read': () => ({ ok: false, code: 'DOMAIN_POLL_FALLBACK' }),
      'client-domain-invalidate': () => ({ ok: true }),
      'hub-connection-info': () => ({ hub: origin, internalTest: true, editable: false }),
      'app-version': () => 'notification-fixture', 'sys-info': () => ({ platform: process.platform }),
      'file-type-icon': () => ({ ok: false }), 'runner-configure': () => ({ ok: true }), 'device-auth-bootstrap': identity,
      'device-auth-login': (_event, input) => { assert(owners[input.account]); account = input.account; return identity(); },
    })) ipcMain.handle(channel, handler);
    require('../main/library-local.cjs').install({ app, ipcMain, BrowserWindow, ownerOf: () => owners[account], shell: { openPath: async () => { throw Error('Unexpected system execution'); } }, dialog: attachmentDialog });
    require('../main/attachment-files.js').install({ app, ipcMain, BrowserWindow, net, ownerOf: () => owners[account],
      identityOf: () => ({ hub: origin, clientId: 'fixture-device-' + account, secret: 'fixture' }), dialog: attachmentDialog, shell: { openPath: async () => { throw Error('Unexpected system execution'); } } });
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
    const content = 'Programmer joke\n程序员笑话\n<script>window.untrustedExecuted=true</script>';
    const sent = await call('sendMateMessage', 'recipient', '看看好不好笑', {
      messageId: crypto.randomUUID(), conversationId: 'fixture-conversation',
      files: [{ name: '程序员笑话.txt', data: Buffer.from(content).toString('base64') },
        { name: 'unsafe.command', data: Buffer.from('echo never-run').toString('base64') }],
    });
    assert.notEqual(sent.ok, false, JSON.stringify(sent));
    await call('clientLogin', { account: 'recipient' });
    const inbox = await call('mateMessages', 'received'); assert.equal(inbox.items.length, 1);
    const message = inbox.items[0], attachment = message.attachments.find(row => row.name.endsWith('.txt'));
    assert(attachment); assert.equal(message.attachments.length, 2);
    const metadata = await call('mateMessageFile', attachment.id);
    const response = await fetch(await js(`SoduWorkAPI.attachmentUrl(${JSON.stringify(metadata)})`));
    assert.match(response.headers.get('content-type'), /application\/octet-stream/);
    assert.equal(await response.text(), content);
    report.cases.push('A real colleague-message upload preserves the text bytes with generic binary MIME');
    await js(`window._taskStorageKey=kind=>SoduWorkAPI.taskStorageKey(kind);window.LS_KEY=()=>_taskStorageKey('tasks');void 0;`);
    const store = read('core/store.js'), first = store.indexOf('const LS_NOTICES='), end = store.indexOf('function noticeUnread()', first);
    await js(store.slice(first, end) + '\nvoid 0;');
    for (const file of ['core/mate-notice-sync.js', 'components/panels/panels-desk.js']) await js(read(file) + '\nvoid 0;');
    await js('openNoticePanel();void 0;');
    const openSelector = '[data-notice-action="open"][data-notice-file="' + attachment.id + '"]';
    await until(`!!document.querySelector(${JSON.stringify(openSelector)})`);
    let previewNumber = 0;
    async function verifyPreview(selector) {
      await js('window.toasts=[];void 0;');
      await click(selector);
      let preview;
      for (let i = 0; i < 150; i++) {
        preview = BrowserWindow.getAllWindows().find(row => row !== win && !row.isDestroyed() && /^data:text\/plain/.test(row.webContents.getURL()));
        if (preview && preview.isVisible() && !preview.webContents.isLoading()) break;
        await wait(30);
      }
      assert(preview, 'Expected a native text preview: ' + JSON.stringify(await js('toasts')));
      assert.equal(preview.webContents.getLastWebPreferences().javascript, false);
      assert.equal(preview.webContents.getLastWebPreferences().nodeIntegration, false);
      // JavaScript is disabled in this production preview, including test script execution.
      const url = preview.webContents.getURL();
      assert.equal(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64').toString('utf8'), content);
      await wait(150);
      fs.writeFileSync(path.join(output, 'text-preview-' + (++previewNumber) + '.png'), (await preview.webContents.capturePage()).toPNG());
      assert.deepEqual(await js('toasts'), []);
      preview.destroy(); await wait(100);
    }
    await verifyPreview(openSelector);
    fs.writeFileSync(path.join(output, 'recipient-message.png'), (await win.webContents.capturePage()).toPNG());
    report.cases.push('Recipient opens the TXT card in a real sandboxed static preview; embedded markup stays literal');
    const script = message.attachments.find(row => row.name.endsWith('.command'));
    const scriptMetadata = await call('mateMessageFile', script.id);
    const deniedScript = await js(`soduWorkAPI.previewAttachment({url:SoduWorkAPI.attachmentUrl(${JSON.stringify(scriptMetadata)}),filename:'unsafe.command'}).then(()=>'',error=>error.message)`);
    assert.match(deniedScript, /不支持直接打开/);
    report.cases.push('Executable attachments remain blocked from opening or system execution');
    await call('markMateMessageRead', message.id);
    await call('clientLogin', { account: 'sender' });
    // The full desktop periodically refreshes both folders; this fixture has no global tick.
    await js('MateNoticeSync.refresh()');
    await js('openNoticePanel();void 0;');
    const receiptSelector = '.nk-mate_receipt ' + openSelector;
    await until(`!!document.querySelector(${JSON.stringify(receiptSelector)})`);
    assert.match(await js('document.querySelector(".nk-mate_receipt").textContent'), /已读/);
    await verifyPreview(receiptSelector);
    fs.writeFileSync(path.join(output, 'sender-read-receipt.png'), (await win.webContents.capturePage()).toPNG());
    await js('MateNoticeSync.refresh()');
    await js('closeNoticePanel();openNoticePanel();void 0;');
    await until(`!!document.querySelector(${JSON.stringify(receiptSelector)})`);
    assert.equal(await js('document.querySelectorAll(".nk-mate_receipt").length'), 1);
    assert.equal(await js('document.querySelectorAll(".nk-mate_receipt [data-notice-action=open]").length'), 2);
    report.cases.push('Sender read receipts retain both attachment cards and authorized preview across refresh and reopening, without duplicates');
    await click('[data-notice-folder=sent]');
    await until(`!!document.querySelector(${JSON.stringify(openSelector)})`);
    await verifyPreview(openSelector);
    report.cases.push('The original sent-message card still opens the same immutable attachment');
    await call('clientLogin', { account: 'other' });
    assert.equal((await call('mateMessages', 'received')).items.length, 0);
    assert.equal((await call('mateMessages', 'sent')).items.length, 0);
    assert.equal(await js(`SoduWorkAPI.mateMessageFile(${JSON.stringify(attachment.id)}).then(()=>false,e=>e.status===404)`), true);
    await js('openNoticePanel();void 0;'); await wait(300);
    assert.equal(await js('document.querySelectorAll("[data-notice-file]").length'), 0);
    report.cases.push('An unrelated account cannot read message metadata, request an attachment ticket, or inherit previous cards');
    assert.deepEqual(report.errors, []);
    report.platform = process.platform;
    report.ok = true;
  }).catch(error => { report.error = String(error.stack || error); report.serverLog = serverLog.slice(-7000); }).finally(async () => {
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.destroy();
    if (server && server.exitCode === null) { const done = new Promise(resolve => server.once('exit', resolve)); server.kill(); await Promise.race([done, wait(2000)]); }
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
    fs.rmSync(temporary, { recursive: true, force: true });
    app.exit(report.ok ? 0 : 1);
  });
}
