'use strict';
// Production pointer handlers, preload and shaped native window. Mouse events
// and cursor polling are injected; physical mouse feel remains manual acceptance.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[key];
  const result = require('node:child_process').spawnSync(electron, [__filename, ...process.argv.slice(2)],
    { env, windowsHide: true, stdio: 'inherit', timeout: 30000 });
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, ipcMain, screen, nativeImage } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
const output = path.resolve(process.argv[2] || '../outputs/desktop-pet-drag');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-pet-drag-'));
app.setPath('userData', path.join(root, 'profile'));
app.on('window-all-closed', () => {});
const report = { ok: false, nativeWindow: true, syntheticMouse: true, checks: [] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let overlay, controller, timeout, ignored = true, cursor = { x: -100000, y: -100000 };
async function finish(error) {
  clearTimeout(timeout);
  if (error) report.error = error.stack || String(error);
  if (overlay && !overlay.isDestroyed()) report.lastState = await overlay.webContents.executeJavaScript('({events,errors,petPointerId,dragging,shape:__ptState(),rect:pet.getBoundingClientRect().toJSON()})').catch(() => null);
  controller?.dispose();
  if (overlay && !overlay.isDestroyed()) overlay.destroy();
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); app.exit(error ? 1 : 0);
}
app.whenReady().then(async () => {
  timeout = setTimeout(() => finish(Error('drag probe timeout')), 24000);
  const asset = relative => pathToFileURL(path.resolve(__dirname, '..', relative)).href;
  const source = fs.readFileSync(path.resolve(__dirname, '../components/pet/pet-ui.js'), 'utf8');
  const drag = source.slice(source.indexOf('/* Dragging. */'), source.indexOf('/* Double-click opens notifications;'));
  fs.writeFileSync(path.join(root, 'preload.js'), fs.readFileSync(path.resolve(__dirname, '../preload.js'), 'utf8'));
  fs.writeFileSync(path.join(root, 'index.html'), `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;background:transparent;overflow:hidden}#pet{position:absolute;left:200px;top:200px;width:80px;height:80px;background:#367bb8;touch-action:none;user-select:none}
    #petRing{position:absolute;left:0;top:0}#ring{width:25px;height:25px}#edgeDock{position:absolute;left:400px;top:200px;width:40px;height:180px;background:#777;touch-action:none}
    .ed-grip{height:30px}#edgeDock button{width:36px;height:30px}.ed-view svg{width:20px;height:20px}
    </style><div id="pet" class="pet"><span id="petRing"><button id="ring">R</button></span></div><div id="edgeDock" class="edge-dock show"></div>
    <script>window.pet=document.getElementById('pet');window.errors=[];window.addEventListener('error',e=>errors.push(e.message));window.events=[];window.clicks=0;window.opened=0;
    window.cfg={dockVisible:true,tasksOn:true,dockX:400,dockY:200};window.saveCfg=()=>{};
    window.setPetPos=(x,y)=>{pet.style.left=x+'px';pet.style.top=y+'px'};window.armGrabCursor=()=>{};window.disarmGrabCursor=()=>{};
    window.openNoticeEntry=()=>opened++;</script><script src="${asset('core/electron.js')}"></script>
    <script src="${asset('components/pet/pet-dock.js')}"></script><script>${drag}
    pet.addEventListener('pointerdown',_onPetPointerDown);ring.addEventListener('click',()=>clicks++);
    for(const type of ['pointerdown','pointermove','pointerup','gotpointercapture','lostpointercapture'])document.addEventListener(type,e=>events.push({type,id:e.pointerId,target:e.target.id,x:e.clientX,y:e.clientY}));
    soduWorkAPI.onOverlayWindowBlur(()=>requestOverlayShapeSync(0,true));_syncSidebar();soduWorkAPI.notifyReady();
    setInterval(()=>soduWorkAPI.sendHeartbeat(),2000);</script>`);
  const fixtureScreen = {
    getPrimaryDisplay: () => screen.getPrimaryDisplay(), getAllDisplays: () => screen.getAllDisplays(),
    getCursorScreenPoint: () => cursor,
    on: (...args) => screen.on(...args), removeListener: (...args) => screen.removeListener(...args),
    ...(process.platform === 'win32' ? {
      dipToScreenPoint: p => screen.dipToScreenPoint(p), dipToScreenRect: (w, r) => screen.dipToScreenRect(w, r),
    } : {}),
  };
  controller = require('../main/desktop-overlay.cjs').create({ app, BrowserWindow, ipcMain, screen: fixtureScreen,
    globalShortcut: { register: () => true, unregister() {} }, Notification: { isSupported: () => false },
    getRendererRoot: () => root, getIcon: () => nativeImage.createEmpty(), translate: x => x });
  overlay = controller.createWindow();
  const ignore = overlay.setIgnoreMouseEvents.bind(overlay);
  overlay.setIgnoreMouseEvents = (flag, ...args) => { ignored = flag; return ignore(flag, ...args); };
  await new Promise(resolve => overlay.webContents.once('did-finish-load', resolve));
  const js = code => overlay.webContents.executeJavaScript(code);
  await delay(3300); // Let the native mixed-DPI startup correction settle.
  report.displays = screen.getAllDisplays().map(d => ({ bounds: d.bounds, scaleFactor: d.scaleFactor }));
  report.bounds = overlay.getContentBounds();
  report.css = await js('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})');
  async function mouse(type, x, y, pressed = false) {
    const b = overlay.getContentBounds();
    if (process.platform === 'win32') {
      const pixels = screen.dipToScreenRect(overlay, b);
      cursor = screen.screenToDipPoint({ x: Math.round(pixels.x + x * pixels.width / b.width),
        y: Math.round(pixels.y + y * pixels.height / b.height) });
    } else cursor = { x: b.x + x, y: b.y + y };
    overlay.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left',
      clickCount: 1, modifiers: pressed ? ['leftButtonDown'] : [] });
    await delay(25);
  }
  const rect = id => js(`document.getElementById(${JSON.stringify(id)}).getBoundingClientRect().toJSON()`);
  let r = await rect('pet');
  await mouse('mouseMove', r.x + 50, r.y + 50); await delay(80); overlay.focus(); await delay(150);
  await mouse('mouseDown', r.x + 50, r.y + 50, true);
  assert.equal(await js('pet.hasPointerCapture(petPointerId)'), true, 'capture must exist before first move');
  assert.equal(ignored, false);
  await mouse('mouseMove', r.x + 950, r.y + 350, true);
  assert.equal(ignored, false, 'fast jump beyond the old shaped region must not park input');
  assert.equal(await js('pet.hasPointerCapture(petPointerId)'), true);
  assert.ok((await rect('pet')).x > r.x + 800);
  await mouse('mouseUp', r.x + 950, r.y + 350);
  assert.equal(await js('petPointerId'), null);
  report.checks.push('900px jump retains capture and reaches final position');
  await mouse('mouseMove', 30, 30); await delay(100);
  assert.equal(ignored, true, 'release restores gap passthrough');
  report.checks.push('release restores native passthrough');
  const displays = await js('soduWorkAPI.getOverlayShape().then(info=>info.displays)');
  if (displays.length > 1) {
    r = await rect('pet');
    const target = displays.reduce((a, b) => Math.abs(a.x + a.width / 2 - r.x) > Math.abs(b.x + b.width / 2 - r.x) ? a : b);
    const x = Math.round(target.x + target.width / 2), y = Math.round(target.y + target.height / 2);
    await mouse('mouseMove', r.x + 50, r.y + 50); await delay(80); overlay.focus(); await delay(150);
    await mouse('mouseDown', r.x + 50, r.y + 50, true);
    await mouse('mouseMove', x, y, true);
    assert.equal(ignored, false);
    await mouse('mouseUp', x, y);
    const placed = await rect('pet');
    assert.ok(Math.abs(placed.x - (x - 50)) <= 2 && Math.abs(placed.y - (y - 50)) <= 2);
    report.checks.push('cross-monitor jump retains position with current display scales');
  }
  r = await rect('ring');
  await mouse('mouseMove', r.x + 10, r.y + 10); await delay(80); overlay.focus(); await delay(150);
  await mouse('mouseDown', r.x + 10, r.y + 10, true);
  await mouse('mouseUp', r.x + 10, r.y + 10);
  assert.equal(await js('clicks'), 1, 'capture must not redirect a ring click');
  report.checks.push('ring action receives one ordinary click');
  r = await rect('edgeDock');
  await mouse('mouseMove', r.x + 15, r.y + 15); await delay(80); overlay.focus(); await delay(150);
  await mouse('mouseDown', r.x + 15, r.y + 15, true);
  await mouse('mouseMove', r.x + 715, r.y + 115, true);
  assert.ok((await rect('edgeDock')).x > r.x + 600);
  await mouse('mouseUp', r.x + 715, r.y + 115);
  report.checks.push('dock shares capture and follows a 700px jump');
  const button = await js('document.querySelector("[data-act=notices]").getBoundingClientRect().toJSON()');
  await mouse('mouseMove', button.x + 15, button.y + 15); await delay(80); overlay.focus(); await delay(150);
  await mouse('mouseDown', button.x + 15, button.y + 15, true);
  await mouse('mouseUp', button.x + 15, button.y + 15);
  assert.equal(await js('opened'), 1);
  report.checks.push('dock button remains clickable after drag');
  report.events = await js('events'); report.ok = true;
  await finish();
}).catch(finish);
