'use strict';
// Isolated desktop UI -> real workspace packaging -> HTTP -> SQLite/object store.
// No production account, business workspace, runner or model is used here.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' }).on('exit', code => process.exitCode = code ?? 1);
} else {
  const { app, BrowserWindow, ipcMain } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const { spawn } = require('node:child_process');
  const client = path.resolve(__dirname, '..'), backend = path.resolve(client, '../hub-backend');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-library-e2e-'));
  const out = path.resolve(client, '../outputs/delivery-actions-20261014'); fs.mkdirSync(out, { recursive: true });
  app.setPath('userData', path.join(root, 'profile'));
  const packages = require('../main/conversation/delivery-package'), runtime = require('../main/conversation/artifact-runtime'), outputs = require('../main/pi-session/outputs');
  const read = file => fs.readFileSync(path.join(client, file), 'utf8'), tick = () => new Promise(resolve => setTimeout(resolve, 80));
  const sessions = {}, report = { ok: false, cases: [], errors: [] }, downloads = [], locations = [];
  let win, server, url, logs = '', blockUpload = false, blockNetwork = false, cancelSave = false, uploadRequests = 0, networkRequests = 0;
  const js = code => win.webContents.executeJavaScript(code, true);
  function workspace(ref, files) {
    const cwd = path.join(root, ref); fs.mkdirSync(cwd);
    for (const [name, text] of Object.entries(files)) { const file = path.join(cwd, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
    return sessions[ref] = { cwd, sessionId: ref, snapshot: () => ({ status: 'idle' }), outputSnapshot: () => outputs.scan(cwd, 0, 1) };
  }
  workspace('single-session', { '报告.md': '# 调研报告\n\n最终结论与来源已经确认。\n\n<script>window.evil=true</script>' });
  workspace('website-session', { 'site/index.html': '<!doctype html><html><head><title>成果</title><link rel="stylesheet" href="assets/style.css"></head><body><h1>完整网站</h1><script src="assets/app.js"></script></body></html>',
    'site/assets/style.css': 'body{color:#235c4d}', 'site/assets/app.js': 'document.body.dataset.ready="true";',
    'site/说明.md': '# 使用说明\n\n打开 index.html。', '.soduwork/delivery.json': JSON.stringify({ schemaVersion: 1, deliverables: [{ path: 'site/index.html', files: ['site/说明.md'] }] }) });
  workspace('multi-session', { 'east/report.md': '# 东区交付\n\n完整内容。', 'west/report.md': '# 西区交付\n\n独立内容。' });
  async function until(code) { for (let i = 0; i < 180; i++) { if (await js(code)) return; await tick(); } throw Error('Timed out: ' + code); }
  async function click(selector) {
    const point = await js(`(()=>{window.pendingDelivery=null;const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Missing action: '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point }); await tick();
    await js('Promise.resolve(window.pendingDelivery).then(()=>true)');
  }
  async function shot(name) { await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); await tick(); fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
  async function render(ref, fresh = false) {
    const files = runtime.snapshot(sessions[ref]).items.map(item => ({ ...item, changedInTurn: true }));
    await js(`window.currentRef=${JSON.stringify(ref)};window.currentSnapshot=${JSON.stringify({ status: 'idle', deliverySync: sessions[ref].deliverySync })};window.currentFiles=${JSON.stringify(files)};if(${fresh})ChatDeliveries.settled(currentRef);window.render=()=>{messages.innerHTML=ChatOutputLinks.decorate('<article class="nmsg ai"><div class="ntext">工作已完成，文件已整理。</div></article>',currentFiles,currentRef,currentSnapshot);ChatDeliveries.hydrate(messages,{ref:currentRef,api:soduWorkAPI.conversationSession,snapshot:currentSnapshot});};render();void 0;`);
  }
  async function startServer() {
    const probe = require('node:net').createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    server = spawn(path.join(backend, '.venv/Scripts/python.exe'), ['-m', 'uvicorn', 'tests.library_browser_server:app', '--host', '127.0.0.1', '--port', String(port)], {
      cwd: backend, windowsHide: true, env: { ...process.env, SODUWORK_LIBRARY_E2E_ROOT: root }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', data => logs += data); server.stderr.on('data', data => logs += data); url = 'http://127.0.0.1:' + port;
    for (let i = 0; i < 180; i++) { try { if ((await fetch(url + '/ready')).ok) return; } catch {} if (server.exitCode !== null) break; await tick(); }
    throw Error('Isolated API unavailable: ' + logs);
  }
  app.whenReady().then(async () => {
    await startServer();
    const now = Math.floor(Date.now() / 1000), identity = { hub: url, clientId: 'e2e-alice', session: Buffer.from(JSON.stringify({typ:'device',uid:'e2e-alice',cid:'e2e-alice',iat:now,exp:now+3600})).toString('base64url') + '.' + 'a'.repeat(64) };
    Object.values(sessions).forEach(handle => { handle.deliveryOwner = require('../main/platform-connections/runtime.cjs').scope(identity); });
    const preload = path.join(root, 'preload.cjs');
    fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('soduWorkAPI',{hubGetUrl:async()=>({ok:true,url:${JSON.stringify(url)}}),hubGetConnection:async()=>({ok:true,environment:'production',hub:${JSON.stringify(url)}}),fileTypeIcon:type=>ipcRenderer.invoke('fixture-icon',type),conversationSession:{inspectDelivery:(ref,ids)=>ipcRenderer.invoke('fixture-inspect',ref,ids),openLocalDelivery:(ref,ids)=>ipcRenderer.invoke('conversation-delivery-open-local',ref,ids),prepareDelivery:(ref,ids)=>ipcRenderer.invoke('fixture-prepare',ref,ids),saveDelivery:(ref,ids,revision)=>ipcRenderer.invoke('fixture-save',ref,ids,revision)}});`);
    require('../main/conversation/local-delivery-action').install({ app,
      ipcMain: { handle(name, handler) { ipcMain.handle(name, async (event, ...args) => {
        const frame = event.sender.mainFrame;
        return handler({ senderFrame: frame, sender: { mainFrame: frame, isDestroyed: () => false,
          getURL: () => require('node:url').pathToFileURL(path.join(client, 'desk.html')).href } }, ...args);
      }); } }, session: { get: ref => sessions[ref] }, ownerOf: () => require('../main/platform-connections/runtime.cjs').scope(identity),
      shell: { showItemInFolder: file => locations.push({ file }), openPath: async folder => { locations.push({ folder }); return ''; } },
    });
    ipcMain.handle('fixture-icon', async (_event, type) => { if (!/^[a-z0-9]+$/.test(type)) return {ok:false}; const file = path.join(root, 'icon.' + type); fs.writeFileSync(file, ''); return {ok:true,dataUrl:(await app.getFileIcon(file,{size:'normal'})).toDataURL()}; });
    ipcMain.handle('fixture-prepare', async (_e, ref, ids) => { const result = await packages.prepare(sessions[ref], ids); return { ok: true, ...result, bytes: undefined, data: result.bytes.toString('base64') }; });
    // Exercise the production version check and file writer. Only the native
    // picker and trusted top-frame URL are fixtures; security is unit-tested.
    require('../main/conversation/delivery-package-ipc').install({
      ipcMain: { handle(name, handler) { if (!['conversation-delivery-save','conversation-delivery-inspect'].includes(name)) return;
        ipcMain.handle(name === 'conversation-delivery-save' ? 'fixture-save' : 'fixture-inspect', async (event, ...args) => {
          const frame = event.sender.mainFrame;
          const trusted = { senderFrame: frame, sender: { mainFrame: frame, isDestroyed: () => false,
            getURL: () => require('node:url').pathToFileURL(path.join(client, 'desk.html')).href } };
          const result = await handler(trusted, ...args);
          if (result.ok && name === 'conversation-delivery-save') downloads.push(result.filename);
          return result;
        }); } },
      session: { get: ref => sessions[ref] }, BrowserWindow: { fromWebContents: () => win },
      dialog: { showSaveDialog: async (_parent, options) => cancelSave ? { canceled: true }
        : { filePath: path.join(out, options.defaultPath) } },
    });
    win = new BrowserWindow({ show: false, width: 1120, height: 820, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.session.on('will-download', (_e, item) => { const target = path.join(out, item.getFilename()); item.setSavePath(target); item.once('done', (_event, state) => { downloads.push(item.getFilename()); if (state !== 'completed') report.errors.push('Download: ' + state); }); });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, done) => {
      networkRequests++;
      if (blockNetwork) return done({ cancel: true });
      if (request.url === url + '/api/v1/deliveries' && request.method === 'POST') { uploadRequests++; if (blockUpload) return done({ cancel: true }); }
      done({ cancel: !request.url.startsWith(url + '/') });
    });
    const html = path.join(root, 'fixture.html');
    fs.writeFileSync(html, '<!doctype html><meta charset="utf-8"><style>' + read('theme/variables.css') + read('components/panels/chat-deliveries.css') + '</style><style>body{margin:0;padding:36px;box-sizing:border-box;font:16px/1.7 var(--font-ui);color:var(--ink);background:var(--bg-0)}#messages{max-width:700px;margin:0 auto}.nmsg{margin:0 0 30px}.ntext{margin-bottom:12px}button{font:inherit}#library{margin:30px auto;max-width:700px}#library button{display:block;margin:10px 0;padding:12px}</style><main id="messages"></main><section id="library"></section>');
    await win.loadFile(html);
    await js(`window.__SODUWORK_TEST_HUB_CONFIG__={allowSwitch:true};localStorage.setItem('soduwork_work_hub_environment_v1','development');localStorage.setItem('soduwork_work_development_hub_url_v1',${JSON.stringify(url)});localStorage.setItem('soduwork_work_user_id','e2e-alice');window.errors=[];window.notices=[];window.petSay=text=>notices.push(text);addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));void 0;`);
    // Match the production asset order: the API must install the real local/Hub
    // router before exposing downloads, including immutable Hub delivery IDs.
    for (const file of ['core/api-work-plugins.js', 'api-library-local.js', 'api.js', 'vendor/markdown/marked.umd.js', 'vendor/markdown/purify.min.js', 'components/panels/library-file-icons.js', 'components/panels/chat-output-links.js', 'components/panels/chat-deliveries.js', 'components/panels/library-transfer.js', 'components/panels/library-delivery.js']) await js(read(file) + '\nvoid 0;');
    await js(`messages.addEventListener('click',e=>{const b=e.target.closest('[data-delivery-download],[data-delivery-reveal],[data-delivery-retry],[data-delivery-open]');if(b)window.pendingDelivery=ChatDeliveries.handle(b,soduWorkAPI.conversationSession);});window.showLibrary=async()=>{const response=await SoduWorkAPI.listDeliveries();library.innerHTML=response.items.map(d=>'<button data-open-delivery="'+d.id+'">'+d.title+'</button>').join('');};library.onclick=e=>{const b=e.target.closest('[data-open-delivery]');if(b)void LibraryDelivery.open(b.dataset.openDelivery)};void 0;`);
    await render('single-session');
    assert.equal(uploadRequests, 0);
    assert.equal(await js('document.querySelectorAll(".ndelivery").length'), 1);
    assert.equal(await js('document.querySelectorAll("[data-delivery-download]").length'), 0);
    assert.equal(await js('document.querySelector("[data-delivery-retry]").hidden'), false);
    assert.equal(await js('document.querySelector("[data-delivery-retry]").getAttribute("aria-label")'), '保存到资料库');
    assert.equal(await js('document.querySelector("[data-delivery-open]").hidden'), true);
    assert.equal(downloads.length,0);
    report.cases.push('PC single-file result operates the local file without a download action');
    downloads.length = 0;
    await click('[data-delivery-reveal]'); assert.equal(locations.at(-1).file, path.join(sessions['single-session'].cwd, '报告.md'));
    assert.equal(downloads.length, 0);
    await click('[data-delivery-retry]'); await until(`document.querySelector('[data-delivery-status]').textContent.includes('已保存')`);
    assert.equal(await js('document.querySelector("[data-delivery-retry]").hidden'), true);
    assert.equal(await js('document.querySelector("[data-delivery-open]").hidden'), false);
    assert.equal(await js('document.querySelector("[data-delivery-open]").getAttribute("aria-label")'), '预览已保存版本');
    assert.equal(await js('Boolean(document.querySelector("[data-delivery-open] svg circle[cx=\\"12\\"][cy=\\"12\\"][r=\\"3\\"]"))'), true);
    assert.equal((await js('SoduWorkAPI.listDeliveries()')).items.length, 1);
    report.cases.push('Local single file: preview, resolved location and explicit publish through actual API'); await shot('single-file');
    const revision = await js(`soduWorkAPI.conversationSession.prepareDelivery(currentRef,currentFiles.map(f=>f.artifactId)).then(p=>SoduWorkAPI.publishDelivery(p))`);
    assert.equal(revision.duplicate, true); assert.equal((await js('SoduWorkAPI.listDeliveries()')).items.length, 1);
    report.cases.push('Repeated same content save is idempotent');
    blockNetwork = true;
    const beforeOffline = networkRequests, beforeCancel = downloads.length;
    await click('[data-delivery-reveal]');
    assert.equal(downloads.length, beforeCancel); assert.equal(networkRequests, beforeOffline);
    assert.equal(locations.at(-1).file, path.join(sessions['single-session'].cwd, '报告.md'));
    report.cases.push('Local location works with all HTTP blocked; no save picker, package creation, copy, or network request');
    sessions['single-session'].inFlight = () => true;
    const beforeBusy = locations.length;
    await click('[data-delivery-reveal]'); delete sessions['single-session'].inFlight;
    assert.equal(networkRequests, beforeOffline); assert.equal(downloads.length, beforeCancel); assert.equal(locations.length, beforeBusy);
    assert.match(await js(`document.querySelector('[data-delivery-status]').textContent`), /仍在生成/);
    report.cases.push('Active generation blocks local location with clear feedback and never downloads a different saved result');
    blockNetwork = false;
    const firstBytes=fs.readFileSync(path.join(sessions['single-session'].cwd,'报告.md'));
    fs.writeFileSync(path.join(sessions['single-session'].cwd,'报告.md'),'# 下一轮改写后的报告');
    const beforeOldVersion = downloads.length;
    await click('[data-delivery-reveal]'); assert.equal(downloads.length,beforeOldVersion);
    assert.match(fs.readFileSync(locations.at(-1).file,'utf8'), /下一轮/);
    await click('[data-delivery-open]'); await until(`document.querySelector('.ldelivery-preview h1')?.textContent==='调研报告'`); await click('[data-delivery-close]');
    report.cases.push('Open location uses the current edited working file; saved-version preview keeps the immutable original');
    fs.unlinkSync(path.join(sessions['single-session'].cwd,'报告.md'));
    const beforeMissing = downloads.length;
    await click('[data-delivery-reveal]'); assert.equal(downloads.length,beforeMissing);
    assert.match(await js(`document.querySelector('[data-delivery-status]').textContent`), /已不存在/);
    await click('[data-delivery-open]'); await until(`document.querySelector('.ldelivery-preview h1')?.textContent==='调研报告'`);
    assert.equal(await js(`document.querySelector('[data-delivery-all]').textContent`),'打开当前本地文件');
    await click('[data-delivery-all]');
    assert.equal(downloads.length,beforeMissing);
    assert.match(await js(`document.querySelector('[data-delivery-error]').textContent`),/已不存在/);
    assert.equal(fs.existsSync(path.join(sessions['single-session'].cwd,'报告.md')), false); await click('[data-delivery-close]');
    report.cases.push('Missing local file retains immutable library preview; no download dialog or silent overwrite');
    blockUpload = true; await render('website-session', true); await click('[data-delivery-retry]'); await until(`document.querySelector('[data-delivery-status]').textContent.includes('重试')`);
    assert.equal(await js(`document.querySelector('[data-delivery-retry]').hidden`), false);
    const beforeWebsite = downloads.length;
    await click('[data-delivery-reveal]'); assert.equal(downloads.length, beforeWebsite);
    assert.equal(locations.at(-1).file, path.join(sessions['website-session'].cwd, 'site/index.html'));
    blockUpload = false; await click('[data-delivery-retry]'); await until(`document.querySelector('[data-delivery-status]').textContent.includes('已保存')`);
    await click('.ndelivery-files summary'); assert.equal(await js('document.querySelectorAll(".ndelivery-files li").length'), 4);
    assert.equal(await js(`document.querySelectorAll('[data-delivery-download]').length`), 0);
    const preparedWebsite = await js(`soduWorkAPI.conversationSession.prepareDelivery(currentRef,currentFiles.map(f=>f.artifactId))`);
    assert.equal(Buffer.from(preparedWebsite.data,'base64').readUInt32LE(0),0x04034b50);
    assert.equal(preparedWebsite.manifest.files.length,4);
    report.cases.push('Website: upload retry preserves local actions and stores a ZIP with transitive assets; no PC download'); await shot('website-package');
    // Keep another conversation visible while the main process publishes.
    // This fixture replaces auth only; HTTP, bytes, database and object storage are real.
    const background = require('../main/conversation/local-delivery-sync').create({ app, identityOf: async () => identity });
    const detached = sessions['multi-session']; detached.detached = true; detached.deliveryCaptureAtTurnBoundary = true;
    background.bind(detached, identity);
    const queue = require('../main/pi-session/turn-queue').createTurnQueue(undefined, () => detached.captureDelivery());
    const item = queue.add({text:'形成成果'}); queue.take(); await queue.run(item, async () => ({ok:true,snapshot:detached.snapshot()}));
    for (let i=0;i<180 && !['synced','failed'].includes(detached.deliverySync.state);i++) await tick();
    assert.equal(detached.deliverySync.state, 'synced', detached.deliverySync.error);
    await render('multi-session'); await until(`document.querySelector('[data-delivery-status]').textContent.includes('已保存')`);
    assert.equal(await js('document.querySelectorAll(".ndelivery").length'), 1);
    const all = await js('SoduWorkAPI.listDeliveries()'); assert.equal(all.items.length, 3);
    const multi = all.items.find(d => d.sessionId === 'multi-session'); assert.deepEqual(multi.files.map(f => f.path), ['east/report.md', 'west/report.md']);
    report.cases.push('Detached main-process completion -> real HTTP storage while another conversation is visible; returning shows saved result');
    report.cases.push('Multiple independent results in one card; identical basenames retain directories');
    await click('[data-delivery-reveal]'); assert.equal(locations.at(-1).folder, sessions['multi-session'].cwd);
    report.cases.push('Multiple local results open their validated common directory, not only the first file folder');
    await js('showLibrary()'); const single = all.items.find(d => d.sessionId === 'single-session');
    await click('[data-open-delivery="' + single.id + '"]'); await until(`document.querySelector('.ldelivery-preview h1')?.textContent==='调研报告'`);
    assert.equal(await js('Boolean(window.evil)'), false); assert.equal(await js('document.querySelectorAll(".ldelivery-preview script").length'), 0);
    const beforeLibrary = downloads.length;
    await click('[data-delivery-all]'); for (let i = 0; i < 80 && downloads.length === beforeLibrary; i++) await tick();
    assert.equal(downloads.length, beforeLibrary + 1);
    assert.deepEqual(fs.readFileSync(path.join(out, downloads.at(-1))), firstBytes);
    await shot('library-preview');
    report.cases.push('Server-backed library: Markdown sanitization, content preview, original download');
    await click('[data-delivery-close]'); await click('[data-open-delivery="' + multi.id + '"]'); await until(`document.querySelector('.ldelivery-preview h1')?.textContent?.includes('区交付')`);
    await click('[data-delivery-file="0"]'); await until(`document.querySelector('.ldelivery-preview h1')?.textContent==='东区交付'`);
    await click('[data-delivery-file="1"]'); await until(`document.querySelector('.ldelivery-preview h1')?.textContent==='西区交付'`);
    win.setContentSize(390, 760); await tick();
    assert.equal(await js(`(()=>{const d=document.querySelector('dialog'),r=d.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&d.scrollWidth<=d.clientWidth+1})()`), true);
    await shot('narrow-preview'); report.cases.push('390px width: file navigation and preview/download controls stay within viewport');
    await js(`dispatchEvent(new Event('soduwork-data-scope-changed'));void 0;`); assert.equal(await js('document.querySelectorAll("dialog").length'), 0);
    report.cases.push('Account scope change closes preview and clears delivery state');
    // A supporting-only edit must archive the new bytes even though the entry
    // artifact id, size and timestamp have not changed.
    const website = sessions['website-session']; background.bind(website, identity);
    const since = Date.now(); await tick();
    fs.writeFileSync(path.join(website.cwd,'site/assets/style.css'),'body{color:#512f80;font-size:18px}');
    website.outputSnapshot = () => outputs.scan(website.cwd,0,since);
    const beforeEntry = runtime.snapshot(website).items.find(f => f.relative==='site/index.html');
    assert.equal(beforeEntry.changedInTurn,false);
    await website.captureDelivery();
    for(let i=0;i<180 && !['synced','failed'].includes(website.deliverySync.state);i++) await tick();
    assert.equal(website.deliverySync.state,'synced',website.deliverySync.error);
    win.setContentSize(1120,820);
    const revisedFiles=runtime.snapshot(website).items;
    await js(`currentRef='website-session';currentSnapshot=${JSON.stringify({status:'idle',deliverySync:website.deliverySync})};currentFiles=${JSON.stringify(revisedFiles)};render();void 0;`);
    assert.equal(await js(`document.querySelector('[data-delivery-status]').textContent.includes('已保存')`),true);
    assert.equal(await js(`document.querySelector('[data-delivery-count]').textContent`),'4 个文件 · 保留目录结构');
    const storedCss=await fetch(url+'/api/v1/deliveries/'+website.deliverySync.delivery.id+'/files/site/assets/style.css');
    assert.equal(await storedCss.text(),'body{color:#512f80;font-size:18px}');
    report.cases.push('Supporting-only edit creates a new immutable package and correct saved card with unchanged entry id/time/size');
    // A plain-text follow-up neither duplicates the prior result nor loses its
    // storage receipt. Rebuild the actual renderer after a busy/idle cycle.
    website.deliveryCaptureAtTurnBoundary=true;
    background.observe(website,{}, {status:'streaming'});background.observe(website,{}, {status:'idle'});
    await website.captureDelivery();assert.equal(website.deliverySync.currentTurn,false);
    const entryId=revisedFiles.find(f=>f.relative==='site/index.html').artifactId;
    await js(`currentSnapshot=${JSON.stringify({status:'idle',deliverySync:website.deliverySync})};messages.innerHTML='<article class="nmsg ai" id="original-result"><button data-open-app="${entryId}">网站成果</button></article><article class="nmsg ai" id="plain-followup">不客气。</article>';ChatDeliveries.decorate(messages,currentFiles,currentRef,currentSnapshot);ChatDeliveries.hydrate(messages,{ref:currentRef,api:soduWorkAPI.conversationSession,snapshot:currentSnapshot});void 0;`);
    assert.equal(await js(`document.querySelectorAll('#plain-followup .ndelivery').length`),0);
    assert.equal(await js(`document.querySelector('#original-result [data-delivery-status]').textContent.includes('已保存')`),true);
    blockNetwork=true;const beforeFollowup=downloads.length,beforeFollowupNetwork=networkRequests;
    await click('#original-result [data-delivery-reveal]');assert.equal(downloads.length,beforeFollowup);
    assert.equal(networkRequests,beforeFollowupNetwork);blockNetwork=false;
    report.cases.push('Plain-text follow-up retains the preceding receipt and offline location action without duplicating a result card');
    const originalCount=(await js('SoduWorkAPI.listDeliveries()')).items.length;
    await js(`messages.innerHTML=ChatOutputLinks.decorate('<article class="nmsg ai" data-output-task="ordinary"><div class="ntext"><code>report.md</code></div></article>',[{artifactId:'task-output:ordinary:file-one',taskId:'ordinary',attachmentId:'file-one',role:'output',name:'report.md',relative:'report.md'}],'ordinary-session',{});void 0;`);
    assert.equal(await js(`document.querySelectorAll('.ndelivery').length`),0);
    assert.equal(await js(`document.querySelectorAll('[data-library-output]').length`),1);
    assert.equal((await js('SoduWorkAPI.listDeliveries()')).items.length,originalCount);
    report.cases.push('Ordinary task result retains the existing save action without calling cloud-conversation archive');
    // Only cloud task -> library receipt lookup is synthetic here. The rendered
    // controls, file manifest, immutable HTTP bytes and download are real.
    await js(`window.originalTaskSync=SoduWorkAPI.syncTaskDelivery;void 0;`);
    for (const delivery of [single, multi]) {
      const taskId = 'remote-' + delivery.id;
      const files = delivery.files.map((file, index) => ({artifactId:'task-output:' + taskId + ':' + index, taskId,
        attachmentId:String(index), role:'output', round:1, name:path.basename(file.path), relative:file.path, size:file.size, at:1}));
      const beforeRemote = downloads.length, beforeLocations = locations.length;
      await js(`currentRef=${JSON.stringify(taskId)};currentFiles=${JSON.stringify(files)};currentSnapshot={status:'idle',cloudHandoff:{taskId:currentRef}};SoduWorkAPI.syncTaskDelivery=async()=>({ok:true,delivery:${JSON.stringify(delivery)}});messages.innerHTML='<article class="nmsg ai" data-output-task="'+currentRef+'"><p>远程执行完成。</p></article>';ChatDeliveries.decorate(messages,currentFiles,currentRef,currentSnapshot);void 0;`);
      assert.equal(await js(`document.querySelectorAll('[data-delivery-reveal]').length`),1);
      await js(`ChatDeliveries.hydrate(messages,{api:soduWorkAPI.conversationSession,ref:currentRef,snapshot:currentSnapshot});void 0;`);
      await until(`document.querySelector('[data-delivery-status]').textContent.includes('已同步')`);
      assert.equal(await js(`document.querySelectorAll('[data-delivery-download]').length`),0);
      assert.equal(await js(`document.querySelector('[data-delivery-status]').textContent.includes('本机')`),false);
      assert.equal(downloads.length,beforeRemote);assert.equal(locations.length,beforeLocations);
      report.cases.push('Remote '+(delivery.files.length===1?'single':'multiple')+' result: shared file-row controls without PC download');
    }
    await js(`SoduWorkAPI.syncTaskDelivery=originalTaskSync;void 0;`);
    await shot('remote-results');
    const beforeLateError = await js('notices.length');
    await js(`window.lateApi={continueLocalDelivery:()=>new Promise((_,reject)=>{window.rejectOldAction=reject})};window.WorkspaceHost={open:async()=>true};window.pendingDelivery=ChatDeliveries.handle(document.querySelector('[data-delivery-local]'),lateApi);void 0;`);
    // This fixture has remote-only attachments; materialization must fail
    // before opening a local conversation, without starting any download UI.
    await js('pendingDelivery');
    await js(`localStorage.setItem('soduwork_work_user_id','e2e-other-user');dispatchEvent(new Event('soduwork-data-scope-changed'));void 0;`);
    await js('pendingDelivery');
    assert.equal(await js('notices.length'),beforeLateError+1);
    assert.match(await js('notices.at(-1)'),/尚未保存到本机/);
    report.cases.push('Remote-only legacy output cannot launch a local conversation before verified materialization');
    assert.deepEqual(await js('errors'), []); assert.deepEqual(report.errors, []);
    report.downloads = downloads; report.uploadRequests = uploadRequests; report.ok = true;
  }).catch(async error => { report.error = String(error.stack); if (win) { report.rendererErrors = await js('window.errors||[]').catch(() => []); await shot('failure').catch(() => {}); } })
    .finally(() => { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); fs.writeFileSync(path.join(out, 'server.log'), logs); console.log(JSON.stringify(report)); if (win) win.destroy(); if (server) server.kill(); app.exit(report.ok ? 0 : 1); });
}
