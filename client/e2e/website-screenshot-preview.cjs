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
  const output = path.resolve(__dirname, '../../outputs/website-screenshot-preview');
  const cwd = path.join(output, 'work'), evidence = path.join(cwd, '.soduwork/evidence');
  fs.mkdirSync(evidence, { recursive: true });
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-website-screenshot-')));
  app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
  const outputs = require('../main/pi-session/outputs'), runtime = require('../main/conversation/artifact-runtime');
  const handle = { cwd, outputSnapshot: () => outputs.scan(cwd, 0, 1) };
  const report = { ok: false, cases: [], limits: ['Deterministic webpage and transcript; no paid model or Hub calls.',
    'Uses actual Chromium capture, production artifact IPC, native image decoding and mouse input.'] };
  let win, capture; const views = [];
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
    fs.writeFileSync(path.join(cwd, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Screenshot regression garden</title>
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
    require('../main/work-preview').install({ ipcMain, BrowserWindow,
      WebContentsView: function (options) { const view = new WebContentsView(options); views.push(view); return view; },
      shell: { openExternal: async () => { throw Error('Unexpected external navigation'); } } });
    win = new BrowserWindow({ show: false, width: 1280, height: 860, webPreferences: {
      preload: path.join(__dirname, '../preload.js'), contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    await win.loadFile(path.join(__dirname, 'fixtures/output-preview.html'));
    const markdown = '网站已完成。[打开网页](index.html)\n\n![网页截图](.soduwork/evidence/homepage.png)';
    const configure = () => js(`window.previewMarkdown=${JSON.stringify(markdown)};ChatOutputLinks.load(soduWorkAPI.conversationSession,'preview-fixture',[],[],null).then(configure)`);
    await configure();
    await until(() => js(`document.querySelector('.ncw-image img')?.naturalWidth===${dims.width}`), 'automatic right-side screenshot');
    assert.equal(await js('document.querySelectorAll("#list .nmsg img").length'), 1);
    assert.equal(await js('document.querySelectorAll("[data-output-image]").length'), 1);
    assert.equal(await js('document.querySelector("[data-output-image]").getBoundingClientRect().height>80'), true);
    const bytes = await runtime.action(handle, 'preview-fixture', shot.artifactId, 'image-full', {});
    assert.deepEqual(Buffer.from(bytes.data, 'base64'), png);
    await screenshot('right-screenshot'); report.cases.push('A referenced screenshot shows a bounded inline thumbnail and full original pixels in the right panel');
    await click('[data-open-app="' + web.artifactId + '"]');
    await until(() => views.some(view => !view.webContents.isDestroyed() && view.webContents.getTitle() === 'Screenshot regression garden'), 'website preview');
    const websiteTab = await js('document.querySelector("[data-wb-tab][aria-selected=true]")?.dataset.wbTab');
    await configure();
    assert.equal(await js('document.querySelector("[data-wb-tab][aria-selected=true]")?.dataset.wbTab'), websiteTab,
      'repeated snapshot must not steal the manually selected website');
    await click('[data-output-image="' + shot.artifactId + '"]');
    await until(() => js(`document.querySelector('.ncw-image img')?.naturalWidth===${dims.width}`), 'clicked screenshot');
    report.cases.push('Mouse switches between real HTML and screenshot; background updates preserve manual tab selection');
    await click('[data-wb-close]'); await configure();
    assert.equal(await js('ChatWorkbench.state().open'), false);
    await click('[data-output-image="' + shot.artifactId + '"]');
    await until(() => js('ChatWorkbench.state().open'), 'manual reopen');
    report.cases.push('Manual close survives index updates; clicking the inline screenshot reopens the panel');
    win.webContents.reload(); await until(() => js('typeof window.configure === "function"').catch(() => false), 'reload');
    await configure(); await until(() => js(`document.querySelector('.ncw-image img')?.naturalWidth===${dims.width}`), 'screenshot after reload');
    assert.equal(await js('document.querySelectorAll("#list .nmsg img").length'), 1);
    await screenshot('reopened-screenshot'); report.cases.push('Reopening restores the trusted screenshot preview without persisting image bytes in conversation markup');
    assert.deepEqual(await js('errors'), []); report.ok = true;
  }).catch(async error => {
    report.error = error.stack || String(error);
    if (win && !win.isDestroyed()) report.debug = await js('({errors,files,state:ChatWorkbench.state(),html:document.querySelector(".ncw")?.outerHTML})').catch(() => null);
  }).finally(() => {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, debug: report.debug ? { errors: report.debug.errors } : undefined }, null, 2));
    capture?.destroy(); win?.destroy(); runtime.closeAll(); app.exit(report.ok ? 0 : 1);
  });
}
