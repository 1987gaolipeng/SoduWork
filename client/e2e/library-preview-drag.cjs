'use strict';
// Real Chromium mouse input verifies popup movement. Only cancellation/loss-of-
// focus cleanup uses injected events, explicitly recorded as a separate check.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 90000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  app.disableHardwareAcceleration();
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const client = path.resolve(__dirname, '..'), output = path.resolve(client, '../outputs/library-preview-drag');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-library-drag-'));
  fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(temporary, 'profile'));
  const report = { ok: false, boundary: 'Production preview/CSS in isolated Electron with trusted CDP mouse drag, double-click, text selection and opaque-frame interaction. Cancellation and window-blur cleanup are separately injected events. No user accounts, services or operating-system windows are changed.', cases: [], measurements: [], screenshots: [] };
  const html = '<!doctype html><html><head><style>html,body{margin:0}body{padding:24px;font:18px sans-serif;background:#edf7f3}button{font:inherit;padding:12px}p{height:700px}</style></head><body><h1>Draggable website preview</h1><button id="action">HTML interaction</button><p>Select or scroll this page without moving the popup.</p><script>window.dragFixture=true;window.clicked=0;document.querySelector("#action").onclick=()=>document.querySelector("#action").textContent="Clicked "+(++window.clicked)</script></body></html>';
  const source = 'Select this ordinary text without dragging the preview.\n第二行源码依然可以复制。\n';
  const items = [{ id: 'html', title: 'website.html', filename: 'website.html', contentType: 'text/html', size: html.length, backend: 'local', sourceType: 'conversation', sessionId: 'drag-conversation', conversationTitle: '预览测试会话' }, { id: 'text', title: 'source.txt', filename: 'source.txt', contentType: 'text/plain', size: source.length, backend: 'local', sourceType: 'upload' }];
  let win;
  const read = file => fs.readFileSync(path.join(client, file), 'utf8');
  const js = code => win.webContents.executeJavaScript(code, true);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(fn, label) { for (let i = 0; i < 160; i++) { if (await fn()) return; await delay(30); } throw Error('Timed out: ' + label); }
  async function pump() { await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }); await delay(50); }
  async function geometry(label) {
    await pump();
    const value = await js('(()=>{const p=document.querySelector(".library-preview-pane").getBoundingClientRect(),h=document.querySelector(".library-preview-head").getBoundingClientRect();return{x:p.x,y:p.y,width:p.width,height:p.height,header:{x:h.x,y:h.y,width:h.width,height:h.height},viewport:{width:innerWidth,height:innerHeight}}})()');
    if (label) report.measurements.push({ label, ...value }); return value;
  }
  function closeEnough(actual, expected, label, tolerance = 2) { assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected}, got ${actual}`); }
  function sameBox(actual, expected, label) { for (const key of ['x', 'y', 'width', 'height']) closeEnough(actual[key], expected[key], label + ' ' + key); }
  function centered(value) { closeEnough(value.x * 2 + value.width, value.viewport.width, 'Centered horizontally'); closeEnough(value.y * 2 + value.height, value.viewport.height, 'Centered vertically'); }
  async function mouse(type, point, options = {}) { await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: type === 'mouseMoved' && !options.buttons ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1, ...options }); await pump(); }
  async function point(selector) { return js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e?.checkVisibility())throw Error('Missing visible target');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`); }
  async function headerPoint() {
    const g = await geometry();
    return { x: Math.max(10, g.header.x + 12) + (Math.min(g.viewport.width - 10, g.header.x + g.header.width - 64) - Math.max(10, g.header.x + 12)) / 2, y: Math.max(4, g.header.y + 10) };
  }
  async function click(selector) { const p = await point(selector); await mouse('mouseMoved', p); await mouse('mousePressed', p); await mouse('mouseReleased', p); if (selector === '[data-preview-close]') await until(() => js('!document.querySelector(".library-preview-pane")'), 'Animated dismissal releases the modal'); }
  async function moveFrom(start, dx, dy) {
    await mouse('mouseMoved', start); await mouse('mousePressed', start);
    const end = { x: start.x + dx, y: start.y + dy };
    await mouse('mouseMoved', end, { buttons: 1 }); await mouse('mouseReleased', end); return end;
  }
  async function resetCenter() {
    const p = await headerPoint(); await mouse('mouseMoved', p);
    for (const clickCount of [1, 2]) { await mouse('mousePressed', p, { clickCount }); await mouse('mouseReleased', p, { clickCount }); }
    centered(await geometry('double-click center'));
  }
  async function open(id = 'html') {
    await js(`void fixturePreview.open(fixtureItems.find(item=>item.id===${JSON.stringify(id)}))`);
    await until(() => js('!!document.querySelector(".library-preview-pane")&&!document.querySelector("[data-preview-body]").hasAttribute("aria-busy")'), 'Preview ready');
    await js('Promise.all(document.querySelector(".library-preview-pane").getAnimations().filter(animation=>animation.animationName==="library-preview-enter").map(animation=>animation.finished.catch(()=>{})))'); await pump();
  }
  async function frame() {
    let result;
    await until(async () => { for (const child of win.webContents.mainFrame.frames) if (!child.isDestroyed() && await child.executeJavaScript('Boolean(window.dragFixture)').catch(() => false)) { result = child; return true; } return false; }, 'HTML frame ready');
    return result;
  }
  async function shot(name) { await pump(); const destination = path.join(output, name + '.png'); fs.writeFileSync(destination, (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()); report.screenshots.push(destination); }
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, done) => done({ cancel: true }));
    await win.loadFile(path.join(__dirname, 'fixtures/library.html'));
    win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    const stylesheets = [...read('desk.html').matchAll(/<link\s+rel=["']stylesheet["']\s+href=["']([^"']+)["']/g)].map(match => require('node:url').pathToFileURL(path.join(client, match[1])).href);
    await js(`(async()=>{document.querySelectorAll('link[rel=stylesheet]').forEach(link=>link.remove());await Promise.all(${JSON.stringify(stylesheets)}.map(href=>new Promise((resolve,reject)=>{const link=document.createElement('link');link.rel='stylesheet';link.href=href;link.onload=resolve;link.onerror=()=>reject(Error(href));document.head.append(link)})));})()`);
    await js(`window.errors=[];window.fixtureActions=[];window.fixtureItems=${JSON.stringify(items)};window.fixtureHTML=${JSON.stringify(html)};window.fixtureText=${JSON.stringify(source)};addEventListener('error',event=>errors.push(event.message));addEventListener('unhandledrejection',event=>errors.push(String(event.reason)));document.addEventListener('pointerdown',event=>{if(event.isTrusted)window.lastTrustedPointer=event.pointerId},true);window.SoduWorkAPI={taskStorageKey:()=>"drag-user",readLibraryContent:async id=>({content:id==='html'?fixtureHTML:fixtureText,preview:{encoding:'utf-8'}}),downloadLibraryItem:async()=>fixtureActions.push('download'),openLibraryExternally:async()=>fixtureActions.push('system'),revealLibraryItem:async()=>fixtureActions.push('reveal')};void 0;`);
    const shipped = [...read('desk.html').matchAll(/<script\s+src=["']([^"']+)["']/g)].map(match => match[1]);
    for (const file of shipped.filter(file => /components\/panels\/(?:library-delivery|library-preview[^/]*|library-file-icons)\.js$/.test(file))) await js(read(file) + '\nvoid 0;');
    await js('window.fixturePreview=SoduWorkLibraryPreview.create({root:document.body,openSource:session=>fixtureActions.push(session)});void 0;');
    await js('window.pointerTrace=[];for(const type of ["pointerdown","pointermove","pointerup","pointercancel","gotpointercapture","lostpointercapture","dblclick"]){document.addEventListener(type,event=>{pointerTrace.push({type:event.type,target:event.target.className,buttons:event.buttons,x:event.clientX,y:event.clientY,trusted:event.isTrusted,primary:event.isPrimary});if(pointerTrace.length>60)pointerTrace.shift()},true)}void 0;');
    await open(); await frame(); const initial = await geometry('initial'); centered(initial);

    let start = await headerPoint(); await moveFrom(start, 120, 80); let moved = await geometry('moved');
    closeEnough(moved.x - initial.x, 120, 'Trusted header drag horizontal delta'); closeEnough(moved.y - initial.y, 80, 'Trusted header drag vertical delta');
    closeEnough(moved.width, initial.width, 'Dragging preserves width'); closeEnough(moved.height, initial.height, 'Dragging preserves height');
    await shot('dragged'); report.cases.push('Trusted mouse drag on blank toolbar space moves a near-fullscreen popup beyond its initial margin without changing its size');

    await resetCenter(); start = await headerPoint();
    await mouse('mouseMoved', start); await mouse('mousePressed', start);
    const insideOriginalFrame = { x: start.x + 36, y: initial.y + initial.header.height + 230 };
    await mouse('mouseMoved', insideOriginalFrame, { buttons: 1 });
    const continued = { x: insideOriginalFrame.x + 42, y: insideOriginalFrame.y + 25 };
    await mouse('mouseMoved', continued, { buttons: 1 }); await mouse('mouseReleased', continued);
    moved = await geometry('capture across iframe');
    closeEnough(moved.x - initial.x, continued.x - start.x, 'Pointer capture keeps horizontal movement'); closeEnough(moved.y - initial.y, continued.y - start.y, 'Pointer capture keeps movement over the original iframe bounds');
    report.cases.push('Captured mouse drag continues across the HTML iframe bounds and releases without losing the drag');

    await resetCenter(); start = await headerPoint(); await moveFrom(start, initial.viewport.width - 9 - start.x, initial.viewport.height - 9 - start.y);
    let edge = await geometry('edge clamp');
    assert.ok(edge.header.y >= 0 && edge.header.y < edge.viewport.height - 20, 'Header must stay reachable vertically');
    assert.ok(edge.header.x < edge.viewport.width - 80 && edge.header.x + edge.header.width > 80, 'A usable portion of the title bar must stay in the viewport');
    closeEnough(edge.width, initial.width, 'Edge drag preserves original width'); closeEnough(edge.height, initial.height, 'Edge drag preserves original height');
    await shot('edge-clamped'); await resetCenter();
    await moveFrom(await headerPoint(), -250, 100); win.setSize(760, 620); await pump();
    edge = await geometry('resize clamp');
    assert.ok(edge.header.y >= 0 && edge.header.y < edge.viewport.height - 20 && edge.header.x < edge.viewport.width - 80 && edge.header.x + edge.header.width > 80, 'Resize retains a draggable title bar');
    await resetCenter(); win.setSize(1280, 900); await pump(); await resetCenter();
    report.cases.push('Dragging permits partial overflow while keeping the title bar reachable; resizing stays recoverable and title-bar double-click restores centering');

    const stable = await geometry('interactive baseline');
    await moveFrom(await point('[data-preview-close]'), -100, 25); sameBox(await geometry(), stable, 'Header close-button drag ignored');
    for (const action of ['download', 'system', 'reveal']) {
      await moveFrom(await point('[data-preview-' + action + ']'), -100, 25); sameBox(await geometry(), stable, action + ' icon drag ignored');
    }
    assert.equal(await js('document.querySelectorAll("[data-preview-source],[data-preview-tab]").length'), 0, 'Removed title/source navigation must not return during dragging');
    assert.deepEqual(await js('fixtureActions'), []);
    await js('(()=>{const input=document.createElement("input");input.id="drag-fixture-input";input.value="Header input selection";input.style.cssText="position:absolute;left:40%;top:10px;width:150px";document.querySelector(".library-preview-head").append(input)})();');
    await moveFrom(await point('#drag-fixture-input'), 45, 0); sameBox(await geometry(), stable, 'Header input drag ignored');
    await js('document.querySelector("#drag-fixture-input").remove();void 0;');
    const htmlFrame = await frame();
    const host = await js('(()=>{const r=document.querySelector("[data-preview-body] iframe").getBoundingClientRect();return{x:r.x,y:r.y,width:r.width}})()');
    const child = await htmlFrame.executeJavaScript('(()=>{const r=document.querySelector("#action").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,width:innerWidth}})()');
    const button = { x: host.x + child.x * host.width / child.width, y: host.y + child.y * host.width / child.width };
    await mouse('mouseMoved', button); await mouse('mousePressed', button); await mouse('mouseReleased', button);
    assert.equal(await htmlFrame.executeJavaScript('window.clicked'), 1); sameBox(await geometry(), stable, 'HTML interaction keeps popup stationary');
    for (const action of ['download', 'system', 'reveal']) {
      await click('[data-preview-' + action + ']'); assert.equal(await js('fixtureActions.at(-1)'), action); sameBox(await geometry(), stable, action + ' activation keeps popup stationary');
    }
    await click('[data-preview-close]'); assert.equal(await js('document.querySelectorAll(".library-preview-pane").length'), 0);
    await open('text'); const textBox = await geometry();
    const textPoint = await js('(()=>{const r=document.querySelector(".library-preview-source").getBoundingClientRect();return{x:r.x+25,y:r.y+33}})()');
    await moveFrom(textPoint, 230, 0); assert.ok((await js('getSelection().toString()')).length > 5, 'Normal text remains selectable'); sameBox(await geometry(), textBox, 'Selecting text keeps popup stationary');
    await open(); await frame();
    report.cases.push('All four icon actions, ordinary text selection and HTML interaction remain usable without starting a drag; removed source/title controls stay absent');

    for (const event of ['pointercancel', 'blur']) {
      await resetCenter(); start = await headerPoint(); await mouse('mouseMoved', start); await mouse('mousePressed', start); await mouse('mouseMoved', { x: start.x + 40, y: start.y + 35 }, { buttons: 1 });
      const stopped = await geometry();
      await js(event === 'blur' ? 'dispatchEvent(new Event("blur"));void 0;' : 'document.querySelector(".library-preview-head").dispatchEvent(new PointerEvent("pointercancel",{pointerId:lastTrustedPointer,bubbles:true}));void 0;');
      await mouse('mouseMoved', { x: start.x + 95, y: start.y + 60 }, { buttons: 1 }); await mouse('mouseReleased', { x: start.x + 95, y: start.y + 60 });
      sameBox(await geometry(), stopped, event + ' cleanup stops movement');
    }
    await resetCenter(); start = await headerPoint(); await mouse('mouseMoved', start); await mouse('mousePressed', start); await mouse('mouseMoved', { x: start.x + 65, y: start.y + 40 }, { buttons: 1 });
    await js('fixturePreview.close();void 0;'); await mouse('mouseReleased', start); await open(); centered(await geometry('reopened after active drag close'));
    const reopened = await geometry(); await mouse('mouseMoved', { x: start.x + 85, y: start.y + 70 }); sameBox(await geometry(), reopened, 'No leaked drag after closing');
    await moveFrom(await headerPoint(), 45, 30); await click('[data-preview-close]'); await open(); centered(await geometry('reopened'));
    await shot('reset-and-reopened'); assert.deepEqual(await js('errors'), []);
    report.cases.push('Explicit pointercancel/blur cleanup events stop a real in-progress drag; closing also cleans capture/listeners, and reopening always starts centered');
    report.ok = true;
  }).catch(async error => {
    report.error = String(error.stack || error);
    if (win && !win.isDestroyed()) { report.rendererErrors = await js('window.errors||[]').catch(() => []); report.pointerTrace = await js('window.pointerTrace||[]').catch(() => []); if (await js('!!document.querySelector(".library-preview-pane")').catch(() => false)) await geometry('failure').catch(() => {}); await shot('failure').catch(() => {}); }
  }).finally(() => {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ ok: report.ok, cases: report.cases, error: report.error, report: path.join(output, 'report.json') })); win?.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
