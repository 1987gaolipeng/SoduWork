'use strict';
// Real Windows regions, focus changes and production preload/shape/dock code.
// This isolated fixture does not verify system mouse input or the user's client.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawnSync(electron, [__filename, ...process.argv.slice(2)], {
    env, windowsHide: true, stdio: 'inherit', timeout: 45000,
  });
  process.exit(child.status ?? 1);
}
const { app, BrowserWindow, ipcMain, screen, globalShortcut, Notification, powerMonitor, nativeImage } = electron;
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-overlay-stability-'));
const outputAt = process.argv.indexOf('--output');
const output = outputAt >= 0 ? path.resolve(process.argv[outputAt + 1])
  : path.resolve(__dirname, '../../outputs/desktop-overlay-stability/result.json');
const venv = path.resolve(__dirname, '../../hub-backend/.venv/Scripts/python.exe');
const python = process.env.SODUWORK_TEST_PYTHON || (fs.existsSync(venv) ? venv : 'python');
const report = { ok: false, isolated: true, realNativeWindows: true, nativeMouseVerified: false,
  electron: process.versions.electron, rounds: [],
  note: 'Renderer busy time is deliberately injected fixture load, not production latency.' };
app.setPath('userData', path.join(root, 'profile'));
app.on('window-all-closed', () => {});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let controller, overlay, target, timeout;
const probes = new Set();
async function until(check, description) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await check()) return; await delay(20); }
  throw Error('Timed out: ' + description);
}
function monitor(win, point) {
  const handle = win.getNativeWindowHandle().readBigUInt64LE().toString();
  const child = spawn(python, [path.join(__dirname, 'fixtures/overlay-region-monitor.py'),
    handle, String(win.getBounds().width), String(point.x), String(point.y), '650'], { windowsHide: true });
  probes.add(child);
  let stdout = '', stderr = '', readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const done = new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.includes('READY')) readyResolve(); });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { readyReject(error); reject(error); });
    child.on('close', code => {
      probes.delete(child);
      try {
        if (code !== 0) throw Error('Native region probe failed: ' + stderr);
        if (!stdout.includes('READY')) throw Error('Native region probe did not initialize');
        resolve(JSON.parse(stdout.slice(stdout.indexOf('READY') + 5).trim()));
      } catch (error) { readyReject(error); reject(error); }
    });
  });
  // A failed launch can reject both promises before the caller awaits done.
  done.catch(() => {});
  return { ready, done };
}
function rendererHTML() {
  const file = relative => pathToFileURL(path.resolve(__dirname, '..', relative)).href;
  return `<!doctype html><html><head><meta charset="utf-8">
    <link rel="stylesheet" href="${file('theme/variables.css')}">
    <link rel="stylesheet" href="${file('components/pet/pet.css')}">
    <style>html,body{margin:0;background:transparent}#pet{left:200px;top:100px;right:auto;bottom:auto;
    width:20px;height:20px;opacity:1;transform:none;transition:none;background:#69a}</style></head><body>
    <div id="pet" class="pet"></div><div id="edgeDock" class="edge-dock"></div>
    <script>
    window.errors=[];addEventListener('error',e=>errors.push(e.message));
    window.cfg={dockVisible:true,tasksOn:true,dockX:100,dockY:100};window.saveCfg=()=>{};
    window.fixtureBusyMs=0;
    soduWorkAPI.onOverlayWindowBlur(()=>{
      const end=performance.now()+fixtureBusyMs;while(performance.now()<end){}
    });
    </script>
    <script src="${file('core/electron.js')}"></script>
    <script src="${file('components/pet/pet-dock.js')}"></script>
    <script>
    soduWorkAPI.onOverlayWindowBlur(()=>requestOverlayShapeSync(240,true));
    _syncSidebar();setInterval(()=>soduWorkAPI.sendHeartbeat(),2000);
    </script></body></html>`;
}
function finish(error) {
  if (timeout) clearTimeout(timeout);
  if (error) report.error = error.stack || String(error);
  for (const probe of probes) probe.kill();
  controller?.dispose();
  if (target && !target.isDestroyed()) target.destroy();
  if (overlay && !overlay.isDestroyed()) overlay.destroy();
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, rounds: report.rounds.length, output, error: report.error }));
  app.exit(report.ok ? 0 : 1);
}
app.whenReady().then(async () => {
  if (process.platform !== 'win32') throw Error('Native region verification requires Windows');
  timeout = setTimeout(() => finish(Error('Native overlay verification exceeded 30 seconds')), 30000);
  fs.copyFileSync(path.resolve(__dirname, '../preload.js'), path.join(root, 'preload.js'));
  fs.writeFileSync(path.join(root, 'index.html'), rendererHTML());
  controller = require('../main/desktop-overlay.cjs').create({ app, BrowserWindow, ipcMain, screen,
    globalShortcut, Notification, powerMonitor, getRendererRoot: () => root,
    getIcon: () => nativeImage.createEmpty(), translate: value => value });
  overlay = controller.createWindow();
  await new Promise(resolve => overlay.webContents.once('did-finish-load', resolve));
  const js = code => overlay.webContents.executeJavaScript(code);
  await until(() => js(`soduWorkAPI.getOverlayShape().then(info=>info.reported &&
    window.__ptState().shapeRects.length === 2)`), 'initial regions');
  await js('soduWorkAPI.notifyReady()');
  target = new BrowserWindow({ x: 400, y: 100, width: 250, height: 120, show: false,
    skipTaskbar: true, title: 'Isolated overlay focus target', webPreferences: { sandbox: true } });
  await target.loadURL('data:text/html,<body>Isolated overlay focus target</body>');
  // Settle the production startup redraw and display-bound correction before measuring blur.
  await delay(3300);
  const point = await js(`(()=>{const r=document.getElementById('edgeDock').getBoundingClientRect();
    return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  for (const busyMs of [0, 150, 150]) {
    await js('window.fixtureBusyMs=' + busyMs);
    overlay.focus();
    await until(() => overlay.isFocused(), 'fixture overlay focus');
    const probe = monitor(overlay, point);
    await probe.ready;
    const calls = [], blurStates = [];
    const original = overlay.setShape.bind(overlay);
    overlay.setShape = rects => { calls.push(rects); return original(rects); };
    const onBlur = () => blurStates.push({ focusable: overlay.isFocusable(), visible: overlay.isVisible() });
    overlay.on('blur', onBlur);
    target.show(); target.focus();
    const native = await probe.done;
    overlay.setShape = original;
    overlay.removeListener('blur', onBlur);
    report.rounds.push({ fixtureBusyMs: busyMs, blurStates, shapeCalls: calls, native });
    assert.ok(blurStates.length > 0, 'real focus change must emit blur');
    assert.ok(blurStates.every(value => !value.focusable && value.visible), 'blur releases focus and stays visible');
    assert.equal(calls.length, 0, 'unchanged geometry must not repaint or park the native region on blur');
    assert.ok(native.sampleCount > 20, 'native sampler must cover the busy interval');
    assert.ok(native.changes.every(sample => sample.regionType === 3 && sample.containsDockCenter),
      'dock center remains inside the actual Windows region across blur');
    const state = await js('soduWorkAPI.getOverlayShape()');
    assert.equal(state.awaitingShape, false, 'fresh shape acknowledgement resumes input guard');
    target.hide();
  }
  assert.deepEqual(await js('window.errors'), [], 'production renderer scripts must load without errors');
  report.ok = true;
}).then(() => finish(), finish);
