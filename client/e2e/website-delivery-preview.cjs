'use strict';
// Actual Chromium webpage capture -> trusted filesystem index -> production
// preload/IPC -> right workbench. Isolated profile and files, no model/Hub calls.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' })
    .on('error', error => { console.error(error); process.exitCode = 1; })
    .on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, WebContentsView, ipcMain, nativeImage } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const output = path.resolve(__dirname, '../../outputs/website-delivery-preview');
  const cwd = path.join(output, 'work'), evidence = path.join(cwd, '.soduwork/evidence');
  fs.mkdirSync(evidence, { recursive: true });
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-website-screenshot-')));
  app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
  const outputs = require('../main/pi-session/outputs'), runtime = require('../main/conversation/artifact-runtime');
  const handle = { cwd, sessionId: 'website-delivery-preview', outputSnapshot: () => outputs.scan(cwd, 0, 1) };
  const report = { ok: false, cases: [], limits: ['Deterministic webpage and transcript; no paid model or Hub calls.',
    'Uses actual Chromium capture, production artifact IPC, native image decoding and mouse input.',
    'The isolated fixture replaces the desktop page trust check only for its exact main frame; delivery inspection uses production workers.',
    'Clipboard captured at browser API boundary; does not overwrite the system clipboard.'] };
  let win, capture, applicationServer; const views = [];
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = code => win.webContents.executeJavaScript(code, true);
  async function until(fn, label) {
    for (let i = 0; i < 160; i++) { if (await fn()) return; await delay(40); }
    throw Error('Timed out: ' + label);
  }
  async function click(selector) {
    const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e?.checkVisibility())throw Error('Hidden click target');
      e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
    await delay(150);
  }
  async function screenshot(name) {
    await until(() => js('Number(getComputedStyle(document.querySelector(".ncw")).opacity) >= .999'), 'preview opening transition');
    await delay(100); fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
  }
  app.whenReady().then(async () => {
    fs.writeFileSync(path.join(cwd, 'style.css'), ':root{color-scheme:light}');
    fs.writeFileSync(path.join(cwd, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Screenshot regression garden</title>
      <link rel="stylesheet" href="style.css">
      <style>body{margin:0;background:#12372e;color:#f6f5e8;font:20px system-ui;padding:54px}small{color:#b7d6ac}h1{font-size:58px;margin:18px 0}
      button{padding:14px 22px;background:#d8e7ba;border:0;border-radius:18px;font:inherit}aside{border-top:1px solid #5d7c64;margin-top:50px;padding-top:24px}</style>
      <small>WEB PREVIEW / 2026</small><h1>看见每一次生长</h1><p>网页截图应在右侧完整呈现。</p><button onclick="this.textContent='交互已验证'">查看花园</button><aside>截图回归 · 独立测试页面</aside></html>`);
    const web = runtime.snapshot(handle).items.find(file => file.kind === 'website');
    assert.ok(web);
    const started = await runtime.preview(handle, 'preview-fixture', web.artifactId); assert.equal(started.ok, true);
    capture = new BrowserWindow({ show: false, width: 800, height: 500, useContentSize: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    await capture.loadURL(started.url); await delay(200);
    const png = (await capture.webContents.capturePage()).toPNG();
    const dims = nativeImage.createFromBuffer(png).getSize(); assert.ok(dims.width >= 800 && dims.height >= 500);
    fs.writeFileSync(path.join(evidence, 'homepage.png'), png); capture.destroy(); capture = null;
    const indexed = runtime.snapshot(handle), shot = indexed.items.find(file => file.relative === '.soduwork/evidence/homepage.png');
    assert.ok(shot, 'a real webpage screenshot in the instructed evidence directory must be addressable');
    assert.equal(shot.primary, false); assert.equal(shot.processEvidence, true);
    assert.equal(indexed.delivery.items.some(file => file.artifactId === shot.artifactId), false);
    report.cases.push('Actual webpage capture is indexed as evidence without changing the HTML deliverable or acceptance list');
    require('../main/agent-runtime/pi-session-bridge').get = ref => ref === 'preview-fixture' ? handle : null;
    require('../main/pi-session/artifact-ipc').install({ app, ipcMain, BrowserWindow, session: { get: ref => ref === 'preview-fixture' ? handle : null }, workDir: () => output });
    require('../main/file-type-icons.cjs').install({ app, ipcMain });
    require('../main/work-preview').install({ ipcMain, BrowserWindow,
      WebContentsView: function (options) { const view = new WebContentsView(options); views.push(view); return view; },
      shell: { openExternal: async () => { throw Error('Unexpected external navigation'); } } });
    win = new BrowserWindow({ show: false, width: 1280, height: 860, webPreferences: {
      preload: path.join(__dirname, '../preload.js'), contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    const fixtureURL = require('node:url').pathToFileURL(path.join(__dirname, 'fixtures/website-delivery-preview.html')).href;
    require('../main/access-control/preferences').isTrusted = event => event.sender === win.webContents &&
      event.senderFrame === win.webContents.mainFrame && win.webContents.getURL() === fixtureURL;
    await win.loadFile(path.join(__dirname, 'fixtures/website-delivery-preview.html'));
    const markdown = '网站已完成。[打开网页](index.html)\n\n![网页截图](.soduwork/evidence/homepage.png)';
    const configure = () => js(`window.previewMarkdown=${JSON.stringify(markdown)};ChatOutputLinks.load(soduWorkAPI.conversationSession,'preview-fixture',[],[],null).then(configure)`);
    await configure();
    await until(() => js(`document.querySelector('.ncw-image img')?.naturalWidth===${dims.width}`), 'automatic right-side screenshot');
    assert.equal(await js('document.querySelectorAll("#list .nmsg img:not(.library-native-file-icon img)").length'), 1);
    assert.equal(await js('document.querySelectorAll(".noutput-image").length'), 1, 'Screenshots render above the output collection');
    assert.equal(await js('document.querySelectorAll(".ndelivery").length'), 1);
    assert.equal(await js(`document.querySelectorAll('[data-output-image="${shot.artifactId}"]').length`), 1);
    await until(() => js('document.querySelector("[data-delivery-files-count]")?.textContent.startsWith("2 ")'), 'website dependency inspection');
    assert.equal(await js('document.querySelector("[data-delivery-title]")?.textContent'), 'Screenshot regression garden');
    report.cases.push('Production dependency inspection includes the CSS asset and preserves the website title without counting screenshot evidence');
    assert.equal((await js('document.querySelector("[data-wb-file-location]")?.textContent'))?.replaceAll('\\','/'), path.join(evidence,'homepage.png').replaceAll('\\','/'));
    const bytes = await runtime.action(handle, 'preview-fixture', shot.artifactId, 'image-full', {});
    assert.deepEqual(Buffer.from(bytes.data, 'base64'), png);
    await screenshot('right-screenshot'); report.cases.push('A referenced screenshot shows a bounded inline thumbnail and full original pixels in the right panel');
    await click('[data-open-app="' + web.artifactId + '"]');
    await until(() => views.some(view => !view.webContents.isDestroyed() && view.webContents.getTitle() === 'Screenshot regression garden'), 'website preview');
    const address = await js('document.querySelector(".ncw-address input")?.value || document.querySelector("[data-wb-address]")?.value');
    assert.equal(address?.replaceAll('\\','/'), path.join(cwd,'index.html').replaceAll('\\','/'));
    await screenshot('website-address');
    await click('[data-wb-copy-location]');
    assert.equal((await js('clipboardWrites.at(-1)'))?.replaceAll('\\','/'), path.join(cwd,'index.html').replaceAll('\\','/'));
    report.cases.push('Website collection name comes from HTML title; displayed and copied location is its absolute file path');
    const websiteView = views.find(view => !view.webContents.isDestroyed() && view.webContents.getTitle() === 'Screenshot regression garden');
    const sourceUrl = websiteView.webContents.getURL();
    const initialTab = await js('document.querySelector("[data-wb-tab][aria-selected=true]")?.dataset.wbTab');
    await click('[data-wb-address]');
    for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Return' });
    await until(() => !websiteView.webContents.isLoading(), 'unchanged local address reload');
    assert.equal(websiteView.webContents.getURL(), sourceUrl);
    assert.equal(await js('document.querySelector("[data-wb-address]").validationMessage'), '');
    assert.equal(await js('document.querySelector("[data-wb-tab][aria-selected=true]")?.dataset.wbTab'), initialTab);
    assert.equal((await js('document.querySelector("[data-wb-address]").value')).replaceAll('\\','/'), path.join(cwd,'index.html').replaceAll('\\','/'));
    report.cases.push('Pressing Enter on the displayed local path reloads the original HTTP page and retains artifact ownership');
    // Leave address editing before simulating the application's navigation;
    // production deliberately preserves an actively edited address field.
    await click('[data-wb-copy-location]');
    const spaUrl = new URL('/garden/42?mode=edit#scene',sourceUrl).href;
    await websiteView.webContents.executeJavaScript("history.pushState({}, '', '/garden/42?mode=edit#scene')");
    await until(()=>js(`document.querySelector('[data-wb-address]')?.value===${JSON.stringify(spaUrl)}`), 'managed application route address');
    await click('[data-wb-copy-location]');
    assert.equal(await js('clipboardWrites.at(-1)'),spaUrl);
    await websiteView.webContents.executeJavaScript(`history.replaceState({}, '', ${JSON.stringify(sourceUrl)})`);
    await until(()=>js(`document.querySelector('[data-wb-address]')?.value===${JSON.stringify(path.join(cwd,'index.html').replaceAll('\\','/'))}`), 'return to static file address');
    report.cases.push('An in-page application route inside a managed preview keeps the HTTP route; returning to the actual HTML file restores its local path');
    const websiteTab = await js('document.querySelector("[data-wb-tab][aria-selected=true]")?.dataset.wbTab');
    await configure();
    assert.equal(await js('document.querySelector("[data-wb-tab][aria-selected=true]")?.dataset.wbTab'), websiteTab,
      'repeated snapshot must not steal the manually selected website');
    await click('[data-output-image="' + shot.artifactId + '"]');
    await until(() => js(`document.querySelector('.ncw-image img')?.naturalWidth===${dims.width}`), 'clicked screenshot');
    await click('[data-wb-copy-location]');
    assert.equal((await js('clipboardWrites.at(-1)'))?.replaceAll('\\','/'), path.join(evidence,'homepage.png').replaceAll('\\','/'));
    report.cases.push('Mouse switches between real HTML and screenshot; background updates preserve manual tab selection');
    await click('[data-wb-close]'); await configure();
    assert.equal(await js('ChatWorkbench.state().open'), false);
    await click('[data-output-image="' + shot.artifactId + '"]');
    await until(() => js('ChatWorkbench.state().open'), 'manual reopen');
    report.cases.push('Manual close survives index updates; clicking the inline screenshot reopens the panel');
    win.webContents.reload(); await until(() => js('typeof window.configure === "function"').catch(() => false), 'reload');
    await configure(); await until(() => js(`document.querySelector('.ncw-image img')?.naturalWidth===${dims.width}`), 'screenshot after reload');
    assert.equal(await js('document.querySelectorAll("#list .nmsg img:not(.library-native-file-icon img)").length'), 1);
    await screenshot('reopened-screenshot'); report.cases.push('Reopening restores the trusted screenshot preview without persisting image bytes in conversation markup');
    await click('[data-delivery-continue]');
    assert.equal(await js('document.activeElement.id'), 'nchatInput');
    assert.equal(await js('document.querySelector("#nchatInput").value'), '保留待发送草稿');
    report.cases.push('Continue focuses the visible conversation input and preserves its existing draft');
    applicationServer = require('node:http').createServer((_req,res)=>{
      res.setHeader('Content-Type','text/html; charset=utf-8');
      res.end('<!doctype html><title>Garden application</title><main>Running application route</main>');
    });
    await new Promise(resolve=>applicationServer.listen(0,'127.0.0.1',resolve));
    const applicationUrl = 'http://127.0.0.1:' + applicationServer.address().port + '/garden?mode=edit#scene';
    await js(`ChatWorkbench.openLink(${JSON.stringify(applicationUrl)})`);
    await until(()=>views.some(view=>view.webContents && !view.webContents.isDestroyed() && view.webContents.getTitle()==='Garden application'), 'running application route');
    assert.equal(await js('document.querySelector("[data-wb-address]").value'),applicationUrl);
    await click('[data-wb-copy-location]');
    assert.equal(await js('clipboardWrites.at(-1)'),applicationUrl);
    await screenshot('application-address');
    report.cases.push('A running application displays and copies its actual HTTP URL including route, query and hash, separately from local static files');
    await click('[data-output-image="' + shot.artifactId + '"]');
    await until(() => js(`document.querySelector('.ncw-image img')?.naturalWidth===${dims.width}`), 'return from application to image');
    await js('document.body.classList.add("dark")');
    await screenshot('dark-screenshot');
    await js('document.body.classList.remove("dark")');
    for (const width of [680, 390]) {
      win.setSize(width, 860); await delay(180);
      assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'), 'No page overflow at ' + width);
      await screenshot('width-' + width);
    }
    assert.deepEqual(await js('errors'), []); report.ok = true;
  }).catch(async error => {
    report.error = error.stack || String(error);
    if (win && !win.isDestroyed()) report.debug = await js('({errors,files,state:ChatWorkbench.state(),html:document.querySelector(".ncw")?.outerHTML})').catch(() => null);
  }).finally(() => {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, debug: report.debug ? { errors: report.debug.errors } : undefined }, null, 2));
    capture?.destroy(); win?.destroy(); runtime.closeAll(); applicationServer?.close(); app.exit(report.ok ? 0 : 1);
  });
}
