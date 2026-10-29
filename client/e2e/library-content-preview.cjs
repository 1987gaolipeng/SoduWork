'use strict';
// Real production viewer in Electron. The library API returns isolated in-memory
// files: this checks rendering/interaction and never touches a user account.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' }).on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const client = path.resolve(__dirname, '..');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-library-content-'));
  const output = path.resolve(client, '../outputs/library-content-preview');
  fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(temporary, 'profile'));
  const report = { ok: false, boundary: 'Production viewer in a real isolated Electron renderer; synthetic library API and files. No production account, server, cloud runner or external network.', cases: [], screenshots: [], errors: [] };
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKk0AAAAASUVORK5CYII=', 'base64');
  const sources = {
    single: { 'site.html': ['text/html', '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:rgb(24,34,52);color:white}h1{font:32px sans-serif}button{padding:16px}</style></head><body><h1>Readable website</h1><button id="action">Start</button><script>window.fixtureLoaded=true;document.querySelector("#action").onclick=()=>document.querySelector("#action").textContent="Clicked";try{parent.document.body.dataset.previewLeak="yes"}catch(e){window.parentBlocked=true}</script></body></html>'] },
    bundle: {
      'site/index.html': ['text/html', '<!doctype html><html><head><link rel="stylesheet" href="assets/site.css"></head><body><h1>Packaged website</h1><img id="asset" src="assets/pixel.png"><button id="action">Start</button><script src="assets/site.js"></script></body></html>'],
      'site/assets/site.css': ['text/css', '@import "base.css";body{background:rgb(11,71,53);color:white}.asset{background-image:url("pixel.png")}'],
      'site/assets/base.css': ['text/css', 'h1{font-size:37px}'],
      'site/assets/site.js': ['text/javascript', 'window.fixtureLoaded=true;document.querySelector("#action").onclick=()=>document.querySelector("#action").textContent="Clicked";'],
      'site/assets/pixel.png': ['image/png', image.toString('base64'), true],
    },
    markdown: { 'readme.md': ['text/markdown', '# Readable report\n\n- First finding\n- Second finding\n\n<script>window.previewLeak=true</script>'] },
    image: { 'image.png': ['image/png', image.toString('base64'), true] },
    text: { 'hello.js': ['text/javascript', 'const message = "Hello from a saved file";\nconsole.log(message);'] },
    archive: { 'documents.zip': ['application/zip', Buffer.from('504b0506000000000000000000000000000000000000', 'hex').toString('base64'), true] },
    unknown: { 'original.soduworkexample': ['application/octet-stream', 'Original binary sample'] },
  };
  let win;
  const read = name => fs.readFileSync(path.join(client, name), 'utf8');
  const js = code => win.webContents.executeJavaScript(code, true);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(code) { for (let i = 0; i < 180; i++) { if (await js(code)) return; await delay(40); } throw Error('Timed out: ' + code); }
  async function click(selector) {
    const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled||!e.checkVisibility())throw Error('Unavailable '+${JSON.stringify(selector)});const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point });
    await delay(70);
  }
  async function shot(name) { await delay(100); const file = path.join(output, name + '.png'); fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG()); report.screenshots.push(file); }
  async function open(id) { await js(`LibraryDelivery.close();void LibraryDelivery.open(${JSON.stringify(id)})`); await until('!!document.querySelector(".ldelivery-dialog[open]")&&!document.querySelector(".ldelivery-loading")'); }
  async function webFrame() {
    for (let i = 0; i < 180; i++) {
      for (const frame of win.webContents.mainFrame.frames) if (!frame.isDestroyed() && await frame.executeJavaScript('Boolean(window.fixtureLoaded)').catch(() => false)) return frame;
      await delay(40);
    }
    throw Error('Generated website did not execute its own script');
  }
  async function assertWebsite(id, expectedColor) {
    await open(id); const frame = await webFrame();
    // Body-level library drawers must obey the same titlebar safe area as the
    // workspace panels. This catches regressions where a new native titlebar
    // makes the close control sit underneath the caption buttons.
    await js('document.documentElement.setAttribute("data-window-menu","")');
    const safeTop = await js('document.querySelector(".ldelivery-dialog").getBoundingClientRect().top');
    assert.ok(safeTop >= 48 - 1, 'Library delivery drawer must start below the 34px titlebar plus its outer gap');
    await js('document.documentElement.removeAttribute("data-window-menu")');
    assert.equal(await frame.executeJavaScript('getComputedStyle(document.body).backgroundColor'), expectedColor, 'HTML must retain original styles');
    const outer = await js('(()=>{const r=document.querySelector(".ldelivery-preview iframe").getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()');
    // The WebContentsView/iframe coordinate bridge is covered by the native
    // workbench suite. Here exercise the generated page's own behavior in its
    // isolated frame without relying on platform-specific input offsets.
    await frame.executeJavaScript('document.querySelector("#action").click()');
    await delay(50); assert.equal(await frame.executeJavaScript('document.querySelector("#action").textContent'), 'Clicked', 'Generated-page behavior must remain usable');
    const parentLeak = await js('document.body.dataset.previewLeak||""');
    const sameOrigin = await js('document.querySelector(".ldelivery-preview iframe").getAttribute("sandbox").includes("allow-same-origin")');
    const parentBlocked = await frame.executeJavaScript('Boolean(window.parentBlocked)');
    const h1FontSize = await frame.executeJavaScript('getComputedStyle(document.querySelector("h1")).fontSize').catch(() => '');
    const imageReady = await frame.executeJavaScript('Boolean(document.querySelector("#asset")?.complete&&document.querySelector("#asset")?.naturalWidth>0)').catch(() => false);
    assert.equal(parentLeak, '', 'Generated HTML must not access the application DOM');
    assert.equal(sameOrigin, false);
    await shot(id + '-website'); return { outer, parentLeak, sameOrigin, parentBlocked, h1FontSize, imageReady };
  }
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1366, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, done) => done({ cancel: true }));
    const fixture = path.join(temporary, 'viewer.html');
    fs.writeFileSync(fixture, '<!doctype html><meta charset="utf-8"><style>' + read('theme/variables.css') + read('components/panels/chat-deliveries.css') + '</style><style>body{margin:0;background:var(--bg-1);font-family:var(--font-ui)}*{box-sizing:border-box}</style><body></body>');
    await win.loadFile(fixture);
    await js(`window.errors=[];addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));window.fixtureSources=${JSON.stringify(sources)};window.fixtureScope='first-user';window.downloads=[];window.fixtureItems={'upload-html':{filename:'上传页面.html',contentType:'text/html',bytes:'<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:rgb(90,32,110);color:white}h1{font:32px sans-serif}button{padding:16px}</style></head><body><h1>Uploaded page</h1><button id="action">Go</button><script>window.fixtureLoaded=true;document.querySelector("#action").onclick=()=>document.querySelector("#action").textContent="Clicked";try{parent.document.body.dataset.previewLeak="yes"}catch(e){window.parentBlocked=true}</script></body></html>'},'upload-text':{filename:'说明.txt',contentType:'text/plain',bytes:'资料库上传的纯文本内容'},'upload-zip':{filename:'打包.zip',contentType:'application/zip',bytesBase64:'504b0506000000000000000000000000000000000000'}};window.SoduWorkAPI={taskStorageKey:()=>fixtureScope,getDelivery:async id=>{const rows=Object.entries(fixtureSources[id]);return {ok:true,delivery:{id,title:rows[0][0],filename:rows.length>1?'website.zip':rows[0][0],kind:rows.length>1?'bundle':'file',entryPath:rows[0][0],files:rows.map(([path,row])=>({path,contentType:row[0],role:path===rows[0][0]?'primary':'supporting',size:row[2]?atob(row[1]).length:row[1].length})),externalDependencies:[]}}},readDeliveryFile:async(id,path)=>{const row=fixtureSources[id][path];if(!row)throw Error('Missing file '+path);return new Blob([row[2]?Uint8Array.from(atob(row[1]),c=>c.charCodeAt(0)):row[1]],{type:row[0]})},downloadLibraryItem:async(id,name)=>{downloads.push({id,name});return {ok:true}},readLibraryBinary:async id=>{const row=window.fixtureItems[id];if(!row)throw Error('Missing item '+id);const data=row.bytesBase64?Uint8Array.from(atob(row.bytesBase64),c=>c.charCodeAt(0)):row.bytes;return {blob:new Blob([data],{type:row.contentType})}}};void 0;`);
    for (const name of ['vendor/markdown/marked.umd.js', 'vendor/markdown/purify.min.js']) await js(read(name) + '\nvoid 0;');
    // Load the actual dependency order from the production entry point so a
    // helper cannot pass here while being missing from the shipping page.
    const scripts = [...read('desk.html').matchAll(/<script\s+src="([^"]+)"/g)].map(m => m[1]);
    for (const name of scripts.filter(name => /components\/panels\/library-(?:delivery|preview|content)/.test(name))) await js(read(name) + '\nvoid 0;');
    const single = await assertWebsite('single', 'rgb(24, 34, 52)');
    assert.equal(single.parentBlocked, true);
    // Keep the layout check proportional to the test viewport.  A fixed 900px
    // floor made this regression flaky on small/HiDPI CI windows even though
    // the single-file layout correctly consumed the available canvas.
    const viewportWidth = await js('window.innerWidth');
    assert.ok(single.outer.width >= Math.min(900, viewportWidth * 0.72), 'Single-file website should use a broad canvas without a redundant file column');
    report.cases.push('Single HTML retains head styles and interactive behavior, app DOM stays isolated, and preview uses a broad single-file canvas');
    const bundle = await assertWebsite('bundle', 'rgb(11, 71, 53)');
    assert.equal(bundle.h1FontSize, '37px');
    assert.equal(bundle.imageReady, true);
    await click('[data-delivery-all]'); assert.equal(await js('downloads.at(-1).name'), 'website.zip');
    report.cases.push('Packaged HTML resolves relative stylesheet, imported stylesheet, script and image; original package download action remains available');
    await open('markdown'); await until('document.querySelector(".ldelivery-preview h1")?.textContent==="Readable report"');
    assert.equal(await js('window.previewLeak||false'), false); await shot('markdown');
    report.cases.push('Markdown renders readable headings/list while scripts do not enter the app document');
    await open('image'); await until('document.querySelector(".ldelivery-preview img")?.naturalWidth>0'); await shot('image');
    report.cases.push('Image decodes and displays in the preview canvas');
    await open('text'); assert.match(await js('document.querySelector(".ldelivery-preview").textContent'), /Hello from a saved file/);
    report.cases.push('Code/text displays its original contents');
    for (const id of ['archive', 'unknown']) { await open(id); assert.equal(await js('document.querySelectorAll(".ldelivery-preview iframe").length'), 0); await click('[data-delivery-single]'); assert.equal(await js('downloads.at(-1).id'), id); await shot(id); }
    report.cases.push('Archive and unsupported file types keep a clear file/download view and never show a broken webpage');
    // Plain (non-delivery) library items reuse the same viewer via openItem:
    // uploaded HTML used to always download, now it previews in the sandbox.
    await js('LibraryDelivery.close();void LibraryDelivery.openItem({id:"upload-html",filename:"上传页面.html",title:"上传页面",contentType:"text/html",size:180})');
    await until('!!document.querySelector(".ldelivery-dialog[open]")&&!document.querySelector(".ldelivery-loading")');
    assert.match(await js('document.querySelector(".ldelivery-eyebrow").textContent'), /资料预览/);
    const plainFrame = await webFrame();
    assert.equal(await plainFrame.executeJavaScript('document.querySelector("#action").textContent'), 'Go');
    await plainFrame.executeJavaScript('document.querySelector("#action").click()'); await delay(50);
    assert.equal(await plainFrame.executeJavaScript('document.querySelector("#action").textContent'), 'Clicked', 'Uploaded HTML must stay interactive');
    assert.equal(await js('document.body.dataset.previewLeak||""'), '', 'Uploaded HTML must not reach the application DOM');
    assert.equal(await js('document.querySelector(".ldelivery-preview iframe").getAttribute("sandbox").includes("allow-same-origin")'), false);
    assert.match(await js('document.querySelector("[data-delivery-title]").textContent'), /上传页面/);
    await shot('plain-html');
    await click('[data-delivery-all]'); assert.equal(await js('downloads.at(-1).id'), 'upload-html'); assert.equal(await js('downloads.at(-1).name'), '上传页面.html');
    report.cases.push('A plain uploaded HTML opens in the shared sandboxed viewer instead of always downloading, with the download action still available');
    await js('LibraryDelivery.close();void LibraryDelivery.openItem({id:"upload-text",filename:"说明.txt",contentType:"text/plain",size:33})');
    await until('!!document.querySelector(".ldelivery-dialog[open]")&&!document.querySelector(".ldelivery-loading")');
    assert.match(await js('document.querySelector(".ldelivery-preview").textContent'), /资料库上传的纯文本内容/); await shot('plain-text');
    report.cases.push('Plain text uploads preview their contents instead of downloading');
    await js('LibraryDelivery.close();void LibraryDelivery.openItem({id:"upload-zip",filename:"打包.zip",contentType:"application/zip",size:34})');
    await until('!!document.querySelector(".ldelivery-dialog[open]")&&!document.querySelector(".ldelivery-loading")');
    assert.equal(await js('document.querySelectorAll(".ldelivery-preview iframe").length'), 0);
    await click('[data-delivery-single]'); assert.equal(await js('downloads.at(-1).id'), 'upload-zip'); await shot('plain-archive');
    report.cases.push('Plain uploaded archives keep the download card inside the viewer');
    await open('markdown'); await js('fixtureScope="second-user";dispatchEvent(new Event("soduwork-data-scope-changed"));void 0;');
    assert.equal(await js('document.querySelectorAll(".ldelivery-dialog").length'), 0);
    report.cases.push('Changing account closes and releases the previous account preview');
    assert.deepEqual(await js('errors'), []); report.ok = true;
  }).catch(async error => { report.error = String(error.stack || error); if (win && !win.isDestroyed()) { report.rendererErrors = await js('window.errors||[]').catch(() => []); await shot('failure').catch(() => {}); } })
    .finally(() => { fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); if (win && !win.isDestroyed()) win.destroy(); app.exit(report.ok ? 0 : 1); });
}
