'use strict';
// Real Electron layout and production iframe/CSS. Synthetic HTML is isolated
// from user accounts, file storage and the user's managed business projects.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 90000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const client = path.resolve(__dirname, '..'), output = path.resolve(client, '../outputs/library-preview-width');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-library-width-'));
  fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(temporary, 'profile'));
  const report = { ok: false, boundary: 'Production library CSS/modules and real Electron layout, sandbox and mouse input. Synthetic HTML/API only; no live accounts, remote assets or external applications.', cases: [], measurements: [], screenshots: [] };
  const interaction = '<script>window.fixtureLoaded=true;document.querySelector("#action").onclick=()=>document.querySelector("#action").textContent="Clicked";try{parent.document.body.dataset.previewLeak="yes"}catch(e){window.parentBlocked=true}</script>';
  const fixed = '<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}html,body{margin:0;padding:0}body{min-width:1200px;background:#edf2f7;font:20px sans-serif}#page{width:1200px;min-height:850px;position:relative;padding:32px;background:linear-gradient(90deg,#dbeafe 24%,#f8fafc 24%)}h1{margin:0;padding:24px;background:white}.columns{display:grid;grid-template-columns:240px 1fr;gap:32px;margin-top:30px}.main{background:white;padding:36px;height:580px}#action{position:absolute;right:24px;top:120px;background:#147d64;color:white;padding:18px;border:0;font:inherit}#edge{position:absolute;right:0;top:0;width:8px;height:100%;background:#ef4444}</style></head><body><main id="page"><h1>Fixed desktop layout · 1200 px</h1><div class="columns"><nav>Sidebar<br><br>Overview<br><br>History</nav><section class="main">The full page and right edge must remain visible.</section></div><button id="action">Click right edge</button><span id="edge"></span></main>' + interaction + '</body></html>\n';
  const responsive = '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>*{box-sizing:border-box}html,body{margin:0;padding:0}body{font:16px sans-serif;background:#f8fafc}#page{width:100%;padding:20px}.columns{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.card{background:#dbeafe;min-height:160px;padding:20px}@media(max-width:700px){.columns{grid-template-columns:1fr}}#action{padding:12px;background:#147d64;color:white;border:0}#edge{display:block;width:100%;height:5px;background:#ef4444}</style></head><body><main id="page"><h1>Responsive document</h1><div class="columns"><div class="card">First card</div><div class="card">Second card</div><div class="card">Third card</div></div><button id="action">Click</button><span id="edge"></span></main>' + interaction + '</body></html>\n';
  const nested = fixed.replace('body{min-width:1200px;', 'body{overflow:hidden;');
  const relative = '<!doctype html><html><head><style>html,body{margin:0;padding:0}body{font:16px sans-serif}#page{box-sizing:content-box;width:100%;padding:24px;background:#edf2f7}#edge{display:block;width:100%;height:4px;background:#ef4444}</style></head><body><main id="page"><h1>Relative content-box width</h1><p>100% width plus padding must not keep increasing the preview viewport.</p><button id="action">Click</button><span id="edge"></span></main>' + interaction + '</body></html>\n';
  const items = [['fixed', fixed], ['responsive', responsive], ['nested', nested], ['relative', relative]].map(([id, content]) => ({ id, filename: id + '.html', title: id + '.html', contentType: 'text/html', kind: 'document', size: content.length, sourceType: 'upload', extra: {}, storage: 'local', updatedAt: '2026-10-13T08:00:00Z' }));
  let win;
  const read = file => fs.readFileSync(path.join(client, file), 'utf8');
  const js = code => win.webContents.executeJavaScript(code, true);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(fn, message) { for (let i = 0; i < 160; i++) { if (await fn()) return; await delay(30); } throw Error('Timed out: ' + message); }
  async function shot(name) {
    await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }); await delay(120);
    const file = path.join(output, name + '.png'); fs.writeFileSync(file, (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()); report.screenshots.push(file);
  }
  async function frameFor() {
    let result;
    await until(async () => {
      for (const frame of win.webContents.mainFrame.frames) if (!frame.isDestroyed() && await frame.executeJavaScript('Boolean(window.fixtureLoaded)').catch(() => false)) { result = frame; return true; }
      return false;
    }, 'HTML script executed in sandbox');
    return result;
  }
  async function open(id) {
    await js(`void fixturePreview.open(fixtureItems.find(item=>item.id===${JSON.stringify(id)}))`);
    await until(() => js('!!document.querySelector("[data-preview-body] iframe")&&!document.querySelector("[data-preview-body]").hasAttribute("aria-busy")'), 'HTML preview loaded');
    return frameFor();
  }
  async function measure(frame, label) {
    const outer = await js('(()=>{const frame=document.querySelector("[data-preview-body] iframe"),pane=document.querySelector("[data-preview-body]"),f=frame.getBoundingClientRect(),p=pane.getBoundingClientRect();return{frame:{left:f.left,right:f.right,top:f.top,bottom:f.bottom,width:f.width,height:f.height},pane:{left:p.left,right:p.right,top:p.top,bottom:p.bottom,width:p.width},hostOverflow:document.documentElement.scrollWidth-innerWidth}})()');
    const inner = await frame.executeJavaScript('(()=>{const page=document.querySelector("#page").getBoundingClientRect(),edge=document.querySelector("#edge").getBoundingClientRect(),button=document.querySelector("#action").getBoundingClientRect();return{viewport:innerWidth,page:{left:page.left,right:page.right,width:page.width},edge:{left:edge.left,right:edge.right},button:{left:button.left,right:button.right,top:button.top,bottom:button.bottom},scrollWidth:document.documentElement.scrollWidth,zoom:getComputedStyle(document.documentElement).zoom,columns:document.querySelector(".columns")?getComputedStyle(document.querySelector(".columns")).gridTemplateColumns:null}})()');
    const ratio = outer.frame.width / inner.viewport;
    const result = { label, outer, inner, projectedRight: outer.frame.left + inner.edge.right * ratio, ratio };
    report.measurements.push(result); return result;
  }
  function checkFits(metrics) {
    assert.ok(metrics.outer.hostOverflow <= 1, 'Preview must not widen the host window: ' + JSON.stringify(metrics));
    assert.ok(metrics.projectedRight <= metrics.outer.pane.right + 2, 'HTML right edge must fit the preview popup: ' + JSON.stringify(metrics));
    assert.ok(metrics.projectedRight >= metrics.outer.pane.left + Math.min(metrics.outer.pane.width * .8, metrics.inner.edge.right * .98), 'Fit must use available width without unnecessarily enlarging fixed content: ' + JSON.stringify(metrics));
  }
  async function waitFits(frame, label) {
    let settled, previous = '', quietSince = 0;
    await until(async () => {
      // A hidden window may pause compositor work after the first fit. Pump a
      // frame and require a settled fit instead of accepting one intermediate
      // measurement and immediately asserting a second, racing measurement.
      await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      const m = await measure(frame, label);
      // Keep report focused on the settled measurement, not the polling stream.
      report.measurements.pop();
      const fits = m.projectedRight <= m.outer.pane.right + 2 && m.projectedRight >= m.outer.pane.left + Math.min(m.outer.pane.width * .8, m.inner.edge.right * .98);
      const key = [m.inner.viewport, m.inner.page.width, m.outer.pane.width, m.ratio.toFixed(4)].join(':');
      if (!fits || key !== previous) quietSince = 0;
      else if (!quietSince) quietSince = Date.now();
      previous = key;
      if (quietSince && Date.now() - quietSince >= 180) { settled = m; return true; }
      return false;
    }, label + ' fits visible popup');
    report.measurements.push(settled); checkFits(settled); return settled;
  }
  async function waitStableLayout(frame, label) {
    const started = Date.now(), deadline = started + 8000;
    let previous = null, quietSince = 0;
    const observations = [];
    while (Date.now() < deadline) {
      // Hidden Electron windows may defer resize/rAF work until a compositor
      // frame is requested. Await real layout reports, not a fixed wall delay.
      await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      const metrics = await measure(frame, label); report.measurements.pop();
      const messages = await js('({count:fixtureLayoutMessages.length,last:fixtureLayoutMessages.at(-1)})');
      const current = { viewport: metrics.inner.viewport, scale: metrics.ratio, count: messages.count };
      observations.push({ elapsed: Date.now() - started, ...current, reportedViewport: messages.last?.viewport });
      const acknowledged = messages.last?.viewport === current.viewport;
      const unchanged = previous && current.viewport === previous.viewport &&
        Math.abs(current.scale - previous.scale) < .0001 && current.count === previous.count;
      if (!acknowledged || !unchanged) quietSince = 0;
      else if (!quietSince) quietSince = Date.now();
      if (quietSince && Date.now() - quietSince >= 800) {
        report.relativeSettling = { elapsed: Date.now() - started, observations };
        return;
      }
      previous = current;
      await delay(100);
    }
    report.relativeSettling = { elapsed: Date.now() - started, observations };
    throw Error(label + ' did not acknowledge and settle layout within 8 seconds: ' + JSON.stringify(observations));
  }
  async function click(selector) {
    const point = await js(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element?.checkVisibility())throw Error('Hidden target');const r=element.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point });
    await delay(75);
  }
  async function clickInFrame(frame) {
    await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }); await delay(120);
    const metrics = await measure(frame, 'mouse-hit-target');
    const p = metrics.inner.button;
    const point = { x: Math.round(metrics.outer.frame.left + (p.left + p.right) / 2 * metrics.ratio), y: Math.round(metrics.outer.frame.top + (p.top + p.bottom) / 2 * metrics.ratio) };
    assert.ok(point.x < metrics.outer.pane.right && point.y < metrics.outer.pane.bottom, 'Interactive target must be on-screen');
    await frame.executeJavaScript('window.fixturePointerEvents=[];for(const type of ["pointerdown","mousedown","click"])document.addEventListener(type,event=>fixturePointerEvents.push({type,x:event.clientX,y:event.clientY,target:event.target.id||event.target.tagName}));void 0;');
    report.hitTest = { point, host: await js(`(()=>{const target=document.elementFromPoint(${point.x},${point.y});return{tag:target?.tagName,cls:target?.className,pointerEvents:target?getComputedStyle(target).pointerEvents:null}})()`) };
    // Chromium's input router targets the opaque child frame; Electron's
    // sendInputEvent does not deliver events to it in a hidden BrowserWindow.
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point });
    try { await until(() => frame.executeJavaScript('document.querySelector("#action").textContent==="Clicked"'), 'real mouse input reaches scaled document'); }
    catch (error) { report.pointerEvents = await frame.executeJavaScript('window.fixturePointerEvents'); throw error; }
  }
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1440, height: 980, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, done) => done({ cancel: true }));
    await win.loadFile(path.join(__dirname, 'fixtures/library.html'));
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    const stylesheets = [...read('desk.html').matchAll(/<link\s+rel=["']stylesheet["']\s+href=["']([^"']+)["']/g)].map(match => require('node:url').pathToFileURL(path.join(client, match[1])).href);
    await js(`(async()=>{document.querySelectorAll('link[rel=stylesheet]').forEach(link=>link.remove());await Promise.all(${JSON.stringify(stylesheets)}.map(href=>new Promise((resolve,reject)=>{const link=document.createElement('link');link.rel='stylesheet';link.href=href;link.onload=resolve;link.onerror=()=>reject(Error('Stylesheet failed: '+href));document.head.append(link)})));})()`);
    await js(`window.errors=[];addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));window.fixtureItems=${JSON.stringify(items)};window.fixtureContents=${JSON.stringify({ fixed, responsive, nested, relative })};window.petSay=()=>{};window.SoduWorkAPI={taskStorageKey:()=> 'isolated-width-test',listLibrary:async()=>({items:fixtureItems,folders:[],breadcrumbs:[],trashCount:0}),getLibraryStorageStatus:async()=>({local:{available:true,configured:true,connected:true},minio:{available:false,configured:false,connected:false}}),readLibraryContent:async id=>({content:fixtureContents[id],preview:{encoding:'utf-8'}})};void 0;`);
    // Include preview helpers from the shipping script order when present.
    const shipped = [...read('desk.html').matchAll(/<script\s+src=["']([^"']+)["']/g)].map(match => match[1]);
    const files = shipped.filter(file => /components\/panels\/(?:library-delivery|library-preview[^/]*|library-file-icons|panels-library-dialogs|panels-library)\.js$/.test(file));
    for (const file of files) await js(read(file) + '\nvoid 0;');
    await js('window.fixtureLayoutMessages=[];addEventListener("message",event=>{if(String(event.data?.type||"").startsWith("soduwork-html"))fixtureLayoutMessages.push(event.data)});void 0;');
    await js('openLibraryPanel();void 0;'); await until(() => js('document.querySelectorAll(".library-file-card").length===4'), 'real library list loaded');
    await js('window.fixturePreview=SoduWorkLibraryPreview.create({root:document.querySelector("#libraryPanel")});void 0;');

    let frame = await open('fixed');
    const initial = await waitFits(frame, 'fixed-initial-1440');
    await shot('fixed-initial-1440'); checkFits(initial);
    await clickInFrame(frame);
    assert.equal(await frame.executeJavaScript('window.parentBlocked'), true);
    assert.equal(await js('document.body.dataset.previewLeak||""'), '');
    assert.equal(await js('document.querySelector("[data-preview-body] iframe").sandbox.contains("allow-same-origin")'), false);
    report.cases.push('A 1200 px desktop document fits the popup; real mouse clicks still hit its right-side button and sandbox isolation remains intact');

    for (const width of [1100, 760, 1680, 1440]) {
      win.setSize(width, 980); await delay(150); await waitFits(frame, 'fixed-window-' + width); await shot('fixed-window-' + width);
    }
    report.cases.push('Window widths 760, 1100, 1440 and 1680 automatically refit fixed-width HTML in the centered popup');

    await frame.executeJavaScript('document.body.style.minWidth="1640px";document.querySelector("#page").style.width="1640px";document.querySelector("h1").textContent="Expanded dynamically · 1640 px";void 0;');
    await waitFits(frame, 'dynamic-expand-1640'); await shot('dynamic-expand');
    await frame.executeJavaScript('document.body.style.minWidth="1200px";document.querySelector("#page").style.width="1200px";void 0;');
    await waitFits(frame, 'dynamic-shrink-1200');
    report.cases.push('The preview refits HTML after its content grows and shrinks dynamically');

    assert.equal(await js('document.querySelectorAll("[data-preview-tab], [data-preview-title], [data-preview-body] pre").length'), 0, 'HTML previews directly without source controls or a title row');
    win.setSize(1100, 980); await delay(120);
    await waitFits(frame, 'direct-preview-resize');
    assert.equal(await frame.executeJavaScript('document.querySelector("#action").textContent'), 'Clicked', 'Resizing direct preview must preserve HTML interaction state');
    report.cases.push('Direct preview has no title/source controls and preserves HTML interaction state while resizing');

    win.setSize(640, 980); await delay(150); frame = await open('responsive'); await waitFits(frame, 'responsive-narrow');
    const compact = await measure(frame, 'responsive-reflow-640');
    assert.equal(compact.inner.columns.trim().split(/\s+/).length, 1, 'Responsive HTML must receive the true narrow viewport and reflow');
    assert.ok(Math.abs(compact.ratio - 1) < .01, 'Responsive page must not be unnecessarily scaled');
    await shot('responsive-narrow');
    win.setSize(1900, 980); await delay(150); await waitFits(frame, 'responsive-wide');
    const wide = await measure(frame, 'responsive-reflow-1900');
    assert.equal(wide.inner.columns.trim().split(/\s+/).length, 3, 'Responsive HTML must expand its grid when the pane widens');
    assert.ok(Math.abs(wide.ratio - 1) < .01, 'Responsive wide page must stay at natural scale');
    await shot('responsive-wide');
    report.cases.push('Responsive HTML uses the actual popup viewport, reflowing from one to three columns without unnecessary scaling');

    win.setSize(1440, 980); await delay(150); frame = await open('nested');
    await waitFits(frame, 'nested-fixed-overflow-hidden'); await shot('nested-overflow-hidden');
    report.cases.push('A fixed-width inner app inside overflow-hidden body remains fully visible');

    frame = await open('relative'); await waitStableLayout(frame, 'relative-overflow-settling');
    const relativeFirst = await measure(frame, 'relative-overflow-settled');
    await delay(600); const relativeMiddle = await measure(frame, 'relative-overflow-settled-plus-600ms');
    const beforeQuiet = await js('fixtureLayoutMessages.length');
    await delay(600); const relativeLast = await measure(frame, 'relative-overflow-settled-plus-1200ms');
    report.relativeOverflow = { viewports: [relativeFirst, relativeMiddle, relativeLast].map(m => m.inner.viewport), scales: [relativeFirst, relativeMiddle, relativeLast].map(m => m.ratio), finalIntervalMessages: (await js('fixtureLayoutMessages.length')) - beforeQuiet };
    await shot('relative-overflow');
    assert.ok(Math.abs(relativeLast.inner.viewport - relativeMiddle.inner.viewport) <= 1, 'Relative width plus padding must settle instead of repeatedly widening: ' + JSON.stringify(report.relativeOverflow));
    assert.ok(Math.abs(relativeLast.ratio - relativeMiddle.ratio) < .002 && relativeLast.ratio >= .8, 'Relative overflow must stay readable instead of shrinking on each layout report: ' + JSON.stringify(report.relativeOverflow));
    assert.ok(report.relativeOverflow.finalIntervalMessages <= 4, 'An unchanged document must not retain a layout feedback loop: ' + JSON.stringify(report.relativeOverflow));
    assert.ok(relativeLast.outer.hostOverflow <= 1, 'Native document overflow must not widen the library window');
    report.cases.push('100% content-box width plus padding settles at readable scale without a resize feedback loop; native document scrolling is allowed');

    await js('fixturePreview.close();void 0;');
    assert.equal(await js('document.querySelectorAll("[data-preview-body] iframe").length'), 0);
    assert.deepEqual(await js('errors'), []);
    report.cases.push('Closing the preview removes the HTML frame without renderer errors'); report.ok = true;
  }).catch(async error => { report.error = String(error.stack || error); if (win && !win.isDestroyed()) { report.rendererErrors = await js('window.errors||[]').catch(() => []); report.layoutMessages = await js('window.fixtureLayoutMessages||[]').catch(() => []); report.frameStyle = await js('document.querySelector("[data-preview-body] iframe")?.getAttribute("style")').catch(() => ''); await shot('failure').catch(() => {}); } })
    .finally(() => { fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ ok: report.ok, cases: report.cases, error: report.error, report: path.join(output, 'report.json') })); if (win && !win.isDestroyed()) win.destroy(); app.exit(report.ok ? 0 : 1); });
}
