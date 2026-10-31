'use strict';
// Real Electron input + production HTTP API/services/SQLite/storage. Only the
// native connection configuration, conversation artifact source and OS preview/download shell are fixtures.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE', 'CHROME_DEVEL_SANDBOX']) delete env[key];
  require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' }).on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const { spawn } = require('node:child_process');
  const client = path.resolve(__dirname, '..'), backend = path.resolve(client, '../hub-backend');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-collab-e2e-'));
  const artifactDirectory = process.argv[3] ? path.resolve(process.argv[3]) : '';
  const out = path.resolve(client, '../outputs/' + (artifactDirectory ? 'collaboration-notices-live-artifacts' : 'collaboration-notices'));
  fs.mkdirSync(out, { recursive: true }); app.setPath('userData', path.join(temporary, 'profile'));
  const read = name => fs.readFileSync(path.join(client, name), 'utf8');
  const tick = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms));
  const windows = [], downloads = [], requests = [];
  const blocked = new Set();
  const report = { ok: false, cases: [], errors: [], boundary: 'Isolated real HTTP, database and stored attachment bytes; native connection configuration, conversation artifacts and OS preview/download shell are fixtures. No model or real colleague is contacted.' };
  let server, logs = '', url, current;
  const sourceFiles = (artifactDirectory ? ['collaboration-report.md', 'collaboration-report.html'].map((name, index) => ({
    artifactId: 'live-' + index, name, kind: 'document', data: fs.readFileSync(path.join(artifactDirectory, name)),
  })) : [
    { artifactId: 'report', name: '验收报告.md', kind: 'document', data: Buffer.from('# 协同验收\n\n已完成：任务与资料库交付。\n下一步：请同事复核。\n') },
    { artifactId: 'image', name: '验收截图.png', kind: 'image', data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH0UAAAAASUVORK5CYII=', 'base64') },
  ]).map(file => ({ ...file, size: file.data.length, relative: file.name, at: 1 }));
  report.artifactSource = artifactDirectory ? 'Previously verified live model delivery files' : 'Generated test fixtures';
  const liveBundle = artifactDirectory ? JSON.parse(fs.readFileSync(path.join(artifactDirectory, 'live-notification-bundle.json'), 'utf8')) : null;
  const sharedFiles = sourceFiles.concat(liveBundle ? [{ name: liveBundle.name, data: Buffer.from(liveBundle.data, 'base64') }] : []);
  const message = '协同验收：AI 已完成需求交付，成果已入资料库。\n请核对附件中的报告与截图。';
  const js = (win, code) => win.webContents.executeJavaScript(code, true);
  async function until(win, code) {
    for (let i = 0; i < 160; i++) { if (await js(win, code)) return; await tick(50); }
    throw Error('Timed out: ' + code);
  }
  async function click(win, selector) {
    current = win;
    const point = await js(win, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Missing enabled action: '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point });
    await tick();
  }
  async function type(win, selector, value) {
    await click(win, selector);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] });
    await win.webContents.insertText(value); await tick();
  }
  async function shot(win, name) {
    await js(win, 'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); await tick(130);
    fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
  }
  async function startServer() {
    const probe = require('node:net').createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    server = spawn(process.argv[2] || path.join(backend, '.venv/Scripts/python.exe'), ['-m', 'uvicorn', 'tests.collaboration_browser_server:app', '--host', '127.0.0.1', '--port', String(port)], {
      cwd: backend, windowsHide: true, env: { ...process.env, SODUWORK_COLLAB_E2E_ROOT: temporary }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', data => { logs += data; }); server.stderr.on('data', data => { logs += data; });
    url = 'http://127.0.0.1:' + port;
    for (let i = 0; i < 200; i++) {
      try { const response = await fetch(url + '/ready'); if (response.ok && (await response.json()).isolated) return; } catch (_) {}
      if (server.exitCode !== null) break; await tick();
    }
    throw Error('Collaboration fixture unavailable: ' + logs);
  }
  function css(name, seen = new Set()) {
    const full = path.resolve(client, name); if (seen.has(full)) return ''; seen.add(full);
    return read(name).replace(/@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?;/g, (_, relative) => css(path.relative(client, path.resolve(path.dirname(full), relative)), seen));
  }
  async function createWindow(identity, fixture, preload) {
    const win = new BrowserWindow({ show: false, width: 1280, height: 850, webPreferences: { preload, partition: 'collaboration-' + identity, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    windows.push(win); current = win;
    win.webContents.on('console-message', (_event, level, text) => { if (level >= 3 && !/net::ERR_(?:BLOCKED_BY_CLIENT|FAILED)/.test(text)) report.errors.push(text); });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, callback) => {
      const route = new URL(request.url).pathname;
      requests.push({ identity, method: request.method, route });
      // Cancel the transport to emulate a disconnected client. HTTP results and
      // API functions are never fabricated or replaced.
      callback({ cancel: !request.url.startsWith(url + '/') || (blocked.has(identity) && route === '/api/v1/team/messages') });
    });
    await win.loadFile(fixture);
    await js(win, `localStorage.setItem('soduwork_work_hub_environment_v1','development');localStorage.setItem('soduwork_work_development_hub_url_v1',${JSON.stringify(url)});localStorage.setItem('soduwork_work_user_id',${JSON.stringify('e2e-' + identity)});window.notices=[];window.tasks=[];window.errors=[];window.petSay=text=>document.getElementById('status').textContent=text;window.esc=text=>String(text??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));void 0;`);
    for (const file of JSON.parse(read('core/locales/manifest.json'))) await js(win, read('core/locales/' + file));
    for (const file of ['core/i18n-dom.js', 'core/i18n.js', 'core/api-work-plugins.js', 'api.js', 'core/store-lifecycle.js', 'core/store.js', 'core/mate-notice-sync.js', 'components/panels/chat-mate-mention.js', 'components/panels/panels-misc.js', 'components/panels/panels-desk.js']) {
      await js(win, read(file) + '\nvoid 0;');
      // Like normal bootstrap, hydrate the native connection before scoped stores capture their identity.
      if(file==='api.js')assert.ok(Array.isArray((await js(win,'SoduWorkAPI.listTeammates()')).mates));
    }
    await js(win, `SoduWorkI18n.setLocale('zh-CN',{persist:false,broadcast:false});window.handle=ChatMateMention.create({input:document.getElementById('input'),mates:()=>SoduWorkAPI.listTeammates(),context:()=>({ref:'conversation-isolated',api:soduWorkAPI.conversationSession,hub:SoduWorkAPI,taskIds:[]}),progress:files=>SoduWorkAPI.draftMateMessage({messages:[],outputs:files.map(f=>f.name)}),send:(uid,text,outputs)=>SoduWorkAPI.sendMateMessage(uid,text,outputs),say:petSay});document.getElementById('notices').addEventListener('click',()=>{openNoticePanel();document.getElementById('composer').hidden=true;});void 0;`);
    return win;
  }
  async function checkLayout(win, selector) {
    const state = await js(win, `(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,viewport:innerWidth,height:innerHeight,overflow:e.scrollWidth>e.clientWidth+1}})()`);
    assert(state.left >= 0 && state.right <= state.viewport + 1 && state.top >= 0 && state.bottom <= state.height + 1, JSON.stringify(state));
    assert.equal(state.overflow, false, JSON.stringify(state));
  }
  app.whenReady().then(async () => {
    await startServer();
    const preload = path.join(temporary, 'preload.cjs');
    fs.writeFileSync(preload, `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('soduWorkAPI',{getHubConnection:()=>ipcRenderer.invoke('collab-connection'),conversationSession:{outputs:ref=>ipcRenderer.invoke('collab-artifacts',ref),artifactAction:(ref,id,action)=>ipcRenderer.invoke('collab-artifact',ref,id,action)},previewAttachment:payload=>ipcRenderer.invoke('collab-file','open',payload),downloadAttachment:payload=>ipcRenderer.invoke('collab-file','download',payload)});`);
    ipcMain.handle('collab-connection',()=>({hub:url,internalTest:true,editable:false}));
    ipcMain.handle('collab-artifacts', (_event, ref) => { assert.equal(ref, 'conversation-isolated'); return { ok: true, artifacts: sourceFiles.map(({ data, ...file }) => file) }; });
    ipcMain.handle('collab-artifact', (_event, ref, id, action) => {
      assert.equal(ref, 'conversation-isolated');
      if (action === 'share-related') { assert(liveBundle); assert.equal(id, 'live-1'); return liveBundle; }
      assert.equal(action, 'share');
      const file = sourceFiles.find(item => item.artifactId === id); assert(file);
      return { ok: true, ...file, data: file.data.toString('base64') };
    });
    ipcMain.handle('collab-file', async (_event, action, payload) => {
      assert(payload.url.startsWith(url + '/api/v1/attachments/')); assert.equal(path.basename(payload.filename), payload.filename);
      const response = await fetch(payload.url); assert.equal(response.status, 200);
      const bytes = Buffer.from(await response.arrayBuffer()), file = sharedFiles.find(item => item.name === payload.filename);
      assert(file); assert.deepEqual(bytes, file.data);
      const saved = path.join(temporary, action + '-' + payload.filename); fs.writeFileSync(saved, bytes);
      assert.deepEqual(fs.readFileSync(saved), file.data);
      downloads.push({ action, name: file.name, size: bytes.length }); return { ok: true };
    });
    const styleNames = ['theme/variables.css', 'components/panels/panels-base.css', 'components/panels/panels-desk.css', 'components/panels/chat-plugin-mention.css', 'components/panels/notice-type-scale.css', 'components/panels/notice-surface.css', 'components/workspace/workspace-shell.css', 'components/workspace/workspace-page-layout.css', 'theme/workspace-experience.css', 'theme/workspace-page-heads.css'];
    const styles = styleNames.map(name => '<style>' + css(name) + '</style>').join('');
    const fixture = path.join(temporary, 'fixture.html');
    fs.writeFileSync(fixture, '<!doctype html><html data-desk-panel="workspace" data-workspace-view="notices"><meta charset="utf-8">' + styles + '<style>:root{--ws-main-left:10px;--ws-main-bg:var(--bg-0)}*{box-sizing:border-box}body{margin:0;background:var(--bg-0);font:14px var(--font-ui);color:var(--ink)}#composer{position:fixed;bottom:24px;left:24px;right:24px;max-width:920px;margin:auto}#composer>h1{font-size:20px}#composer .nbox{position:relative;border:1px solid var(--line);border-radius:16px;padding:18px}#input{display:block;width:100%;height:70px;resize:none;border:0;background:transparent;font:inherit;outline:none}#notices{padding:8px 16px;margin-bottom:14px;border:1px solid var(--line);border-radius:9px;background:var(--bg-0);color:var(--ink);font:inherit}#status{position:fixed;left:24px;bottom:4px;font:13px var(--font-ui);color:var(--ink-3)}</style><main id="composer"><h1>协同验收</h1><button id="notices">通知</button><div class="nbox work-composer"><textarea id="input" aria-label="输入消息" placeholder="输入 @ 选择同事"></textarea></div></main><div id="status" role="status"></div></html>');
    const sender = await createWindow('sender', fixture, preload);
    const directory=await js(sender,'SoduWorkAPI.listTeammates()');
    assert.ok(directory.orgUnits.length);assert.ok(directory.mates.every(row=>row.orgId));
    const recipientId=directory.mates.find(row=>row.name==='接收验收').id;
    const beforeDraft=requests.filter(row=>row.route.endsWith('/team/message-draft')).length;
    await js(sender,`input.value='保留原对话草稿';void 0;`);
    assert.equal((await js(sender,`handle.open({recipientUserId:${JSON.stringify(recipientId)},text:'即用提供的协作内容'})`)).state,'review');
    await until(sender,`!document.querySelector('.nmate-card-send').disabled`);
    assert.equal(await js(sender,'input.value'),'保留原对话草稿');
    assert.equal(await js(sender,'document.querySelectorAll(".nmate-results input:checked").length'),0);
    assert.equal(await js(sender,'document.querySelector(".nmate-card-text").value'),'即用提供的协作内容');
    assert.equal(requests.filter(row=>row.route.endsWith('/team/message-draft')).length,beforeDraft,'prefilled mention must not call AI summarization');
    assert.equal((await js(sender,`handle.open({recipientUserId:${JSON.stringify(recipientId)},text:'不能覆盖'})`)).ok,false);
    await js(sender,`dispatchEvent(new Event('soduwork-data-scope-changed'));void 0;`);
    assert.equal(await js(sender,'document.querySelector(".nmate-card").hidden'),true);
    assert.equal((await js(sender,`handle.open({query:'@接收验收',text:'按姓名定位'})`)).state,'review');
    await click(sender,'.nmate-card-close');
    report.cases.push('Programmatic app mentions use stable colleague IDs or names, preserve drafts, do not attach old outputs or call AI, reject overwriting an open card, and clear on account scope changes.');
    await type(sender, '#input', '@接收验收');
    await until(sender, `document.querySelector('.nmate-menu .nplugin-option b')?.textContent==='接收验收'`);
    await click(sender, '.nmate-menu .nplugin-option');
    await until(sender, `document.querySelectorAll('.nmate-results input:checked').length===2&&!document.querySelector('.nmate-card-send').disabled`);
    await click(sender, '.nmate-card-tools button:nth-child(2)');
    await type(sender, '.nmate-card-text', message);
    for (const [locale, theme, width] of [['zh-CN', 'default', 1280], ['en-US', 'ruby', 580]]) {
      sender.setContentSize(width, 850);
      await js(sender, `document.documentElement.dataset.theme='${theme}';SoduWorkI18n.setLocale('${locale}',{persist:false,broadcast:false});void 0;`); await tick();
      await checkLayout(sender, '.nmate-card');
      assert.equal(await js(sender, `document.querySelector('.nmate-card-text').value`), message);
      const label = await js(sender, `document.querySelector('.nmate-card-send').textContent`);
      assert.equal(label, locale === 'zh-CN' ? '发送通知' : 'Send notification');
      await shot(sender, 'send-' + locale + '-' + width);
    }
    await js(sender, `SoduWorkI18n.setLocale('zh-CN',{persist:false,broadcast:false});void 0;`);
    await click(sender, '.nmate-card-send');
    await until(sender, `document.querySelector('.nmate-card').hidden`);
    assert.equal(await js(sender, `document.querySelector('#status').textContent`), '通知已保存，对方上线后可查看');
    const sent = await js(sender, `SoduWorkAPI.mateMessages('sent').then(r=>r.items)`);
    assert.equal(sent.length, 1); assert.equal(sent[0].text, message); assert.equal(sent[0].status, 'accepted'); assert.equal(sent[0].attachments.length, 2);
    report.cases.push('Typed @接收验收, chose the real server colleague, manually edited and sent two actual fixture files; offline receipt is honestly saved and persisted in the real sent folder');
    const recipient = await createWindow('recipient', fixture, preload);
    await click(recipient, '#notices');
    await until(recipient, `document.querySelectorAll('.np-file').length===2`);
    assert.equal(await js(recipient, `document.querySelector('.np-txt').textContent`), message);
    assert.equal(await js(recipient, `document.querySelectorAll('.np-row.unread').length`), 1);
    for (const [locale, theme, width] of [['zh-CN', 'default', 1280], ['en-US', 'ruby', 580], ['zh-CN', 'ruby', 580]]) {
      recipient.setContentSize(width, 850);
      await js(recipient, `document.documentElement.dataset.theme='${theme}';SoduWorkI18n.setLocale('${locale}',{persist:false,broadcast:false});void 0;`); await tick();
      await checkLayout(recipient, '#noticePanel'); await checkLayout(recipient, '.np-row');
      assert.equal(await js(recipient, `document.querySelector('.np-txt').textContent`), message);
      assert.equal(await js(recipient, `document.querySelector('.np-subject [data-user-content]').textContent`), '发送验收');
      const tab = await js(recipient, `document.querySelector('[data-notice-folder="sent"]').textContent`);
      assert.equal(tab, locale === 'zh-CN' ? '发送的通知' : 'Sent notifications');
      if (theme === 'ruby') assert.equal(await js(recipient, `getComputedStyle(document.querySelector('.np-unread-dot')).backgroundColor`), 'rgb(230, 0, 18)');
      await shot(recipient, 'received-' + locale + '-' + theme + '-' + width);
    }
    for (let index = 1; index <= 2; index++) {
      await click(recipient, `.np-attachment:nth-child(${index}) .np-file`);
      await click(recipient, `.np-attachment:nth-child(${index}) .np-file-download`);
    }
    // The native preview/download bridge completes asynchronously. Wait for
    // all four real IPC callbacks before asserting, otherwise a fast click
    // sequence intermittently observes three completed callbacks.
    for (let i = 0; i < 40 && downloads.length < 4; i++) await tick(25);
    assert.equal(downloads.length, 4);
    assert.equal(await js(recipient, `document.querySelectorAll('.np-row.unread').length`), 1);
    report.cases.push('A separate authenticated recipient loads the persisted message; both files open and download through real signed HTTP URLs, matching every original byte');
    await click(recipient, '.np-subject');
    await until(recipient, `document.querySelectorAll('.np-row.unread').length===0`);
    const readReceipt = await js(sender, `SoduWorkAPI.mateMessages('sent').then(r=>r.items[0])`);
    assert.equal(readReceipt.status, 'read'); assert(readReceipt.readAt);
    sender.setContentSize(1280, 850); await click(sender, '#notices'); await click(sender, '[data-notice-folder="sent"]');
    await until(sender, `document.querySelector('.np-delivery.np-read')?.textContent==='已读'`);
    await shot(sender, 'sender-read-receipt');
    report.cases.push('Clicking the received notification persists a real read receipt, and the sender Sent notifications folder displays it');
    // Genuine client transport outage: preserve prior rows, expose Retry, recover.
    blocked.add('recipient'); await click(recipient, '[data-notice-folder="received"]');
    await until(recipient, `!!document.querySelector('[data-notice-retry]')`);
    assert.equal(await js(recipient, `document.querySelectorAll('.np-file').length`), 2);
    await shot(recipient, 'offline-retry-retains-files');
    blocked.delete('recipient'); await click(recipient, '[data-notice-retry]');
    await until(recipient, `!document.querySelector('.np-load-status')&&document.querySelectorAll('.np-file').length===2`);
    report.cases.push('A disconnected notice request keeps loaded messages/files and presents a working Retry control; reconnect reloads the real server without duplicates');
    const headers = { 'X-Soduwork-Device': 'e2e-other' };
    const other = await (await fetch(url + '/api/v1/team/messages?folder=received', { headers })).json();
    assert.equal(other.items.length, 0);
    for (const file of sent[0].attachments) assert.equal((await fetch(url + '/api/v1/team/message-files/' + file.id, { headers })).status, 404);
    assert.equal((await fetch(url + '/api/v1/team/messages/' + sent[0].id + '/read', { method: 'POST', headers })).status, 404);
    report.cases.push('An unrelated synthetic user cannot list these messages, obtain either file ticket, or mark the message read');
    report.cases.push('Production Chinese/English UI, blue/red theme tokens and wide/narrow layouts remain readable; human message/file names survive language switching unchanged');
    for (const win of windows) assert.deepEqual(await js(win, 'errors'), []);
    assert.deepEqual(report.errors, []);
    for (const route of ['/api/v1/team/mates', '/api/v1/team/message-draft', '/api/v1/team/message-capabilities', '/api/v1/team/mates/recipient/message', '/api/v1/team/messages']) assert(requests.some(request => request.route === route), route);
    report.requests = requests; report.downloads = downloads; report.ok = true;
  }).catch(async error => {
    report.error = String(error.stack);
    if (current) { report.rendererErrors = await js(current, 'window.errors||[]').catch(() => []); report.surface=await js(current,`({sync:!!window.MateNoticeSync,status:document.querySelector('.np-load-status')?.textContent,rows:document.querySelectorAll('.np-row').length})`).catch(()=>null); await shot(current, 'failure').catch(() => {}); }
  }).finally(() => {
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2)); fs.writeFileSync(path.join(out, 'server.log'), logs);
    console.log(JSON.stringify(report)); for (const win of windows) win.destroy(); if (server) server.kill(); app.exit(report.ok ? 0 : 1);
  });
}
