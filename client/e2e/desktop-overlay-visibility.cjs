'use strict';
// Real BrowserWindow, production overlay controller, preload and geometry reporting.
// No Hub, model, Runner, existing account or desktop preference data is loaded.
// Run once with --ozone-platform=wayland and once with --ozone-platform=x11 on Linux.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawnSync(electron, [__filename, ...process.argv.slice(2)], {
    env, windowsHide: true, stdio: 'inherit', timeout: 60000 });
  process.exit(child.status ?? 1);
}
const { app, BrowserWindow, ipcMain, screen, globalShortcut, powerMonitor, nativeImage } = electron;
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
function option(name) {
  const prefix = '--' + name + '=';
  const inline = process.argv.find(arg => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const at = process.argv.indexOf('--' + name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-overlay-visibility-'));
const profile = path.resolve(option('profile') || path.join(root, 'profile'));
// Refuse existing profiles, including empty directories: every run owns a fresh profile.
fs.mkdirSync(path.dirname(profile), { recursive: true });
fs.mkdirSync(profile);
const output = path.resolve(option('output') || path.join(root, 'result.json'));
const report = { ok: false, isolated: true, realNativeWindows: true,
  shellPreviewVerified: false, physicalInputVerified: false,
  electron: process.versions.electron, platform: process.platform,
  sessionType: process.env.XDG_SESSION_TYPE || null,
  ozonePlatform: app.commandLine.getSwitchValue('ozone-platform') || 'default',
  note: 'Native visibility and production renderer geometry are verified. GNOME Shell preview enumeration and physical mouse input require separate desktop acceptance.',
  cases: [], shows: 0 };
app.setPath('userData', profile);
app.on('window-all-closed', () => {});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let controller, overlay, timeout, finished = false;
const js = source => overlay.webContents.executeJavaScript(source);
const shape = () => js('soduWorkAPI.getOverlayShape()');
async function until(check, description) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await check()) return; await delay(25); }
  throw Error('Timed out: ' + description);
}
async function check(name, visible) {
  await until(() => overlay.isVisible() === visible, name);
  // Catch delayed show callbacks or blur acknowledgements that revive an empty overlay.
  await delay(150);
  assert.equal(overlay.isVisible(), visible, name);
  const result = { name, visible: overlay.isVisible(), shape: await shape() };
  if (process.platform === 'linux' && report.ozonePlatform === 'x11') {
    const id = '0x' + overlay.getNativeWindowHandle().readUInt32LE().toString(16);
    const type = execFileSync('xprop', ['-id', id, '_NET_WM_WINDOW_TYPE'], { encoding: 'utf8', timeout: 3000 });
    const info = execFileSync('xwininfo', ['-id', id], { encoding: 'utf8', timeout: 3000 });
    result.x11 = { toolbar: type.includes('_NET_WM_WINDOW_TYPE_TOOLBAR'),
      mapState: info.match(/Map State:\s*(\S+)/)?.[1] || null };
    assert.equal(result.x11.toolbar, true, name + ': auxiliary window must advertise toolbar type');
    assert.equal(result.x11.mapState, visible ? 'IsViewable' : 'IsUnMapped', name + ': native mapping');
  }
  report.cases.push(result);
}
async function content(pet, bubble = false) {
  await js(`fixtureContent(${JSON.stringify({ pet, bubble })})`);
  await until(async () => {
    const current = await shape();
    return current.reported && !current.awaitingShape && current.requested.length === (pet ? 1 : 0);
  }, 'fresh geometry acknowledgement');
}
async function loaded() {
  await until(() => !overlay.webContents.isLoading(), 'fixture document load');
  await until(() => js('typeof fixtureContent === "function"'), 'fixture script initialization');
  await until(async () => (await shape()).reported, 'renderer geometry while hidden');
}
async function navigate(action) {
  const completion = new Promise(resolve => overlay.webContents.once('did-finish-load', resolve));
  action();
  assert.equal(overlay.isVisible(), false, 'navigation must unmap stale geometry immediately');
  await completion;
  await loaded();
}
function html() {
  const geometry = pathToFileURL(path.resolve(__dirname, '../core/electron.js')).href;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
  <style>html,body{margin:0;background:transparent}#pet{display:none;position:absolute;
    left:100px;top:100px;width:48px;height:48px;background:#7196c4;border-radius:50%}
    .pet-bubble{display:none;position:absolute;left:180px;top:100px;width:160px;height:40px;
    background:#fff;color:#222;pointer-events:none}.pet-bubble.show{display:block}</style></head><body>
  <div id="pet" class="pet"></div><div id="petBubble" class="pet-bubble">Isolated feedback</div>
  <script>window.fixtureErrors=[];addEventListener('error',e=>fixtureErrors.push(e.message));</script>
  <script src="${geometry}"></script><script>
    window.fixtureContent=({pet,bubble})=>{
      document.getElementById('pet').style.display=pet?'block':'none';
      document.getElementById('petBubble').classList.toggle('show',!!bubble);
      requestOverlayShapeSync(0,true);
    };
    soduWorkAPI.onOverlayWindowBlur(()=>requestOverlayShapeSync(0,true));
    setInterval(()=>soduWorkAPI.sendHeartbeat(),2000);
  </script></body></html>`;
}
function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  if (error) report.error = error.stack || String(error);
  controller?.dispose();
  if (overlay && !overlay.isDestroyed()) overlay.destroy();
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, cases: report.cases.length, output, error: report.error }));
  app.exit(report.ok ? 0 : 1);
}
app.whenReady().then(async () => {
  timeout = setTimeout(() => finish(Error('Native visibility verification exceeded 45 seconds')), 45000);
  fs.copyFileSync(path.resolve(__dirname, '../preload.js'), path.join(root, 'preload.js'));
  fs.writeFileSync(path.join(root, 'index.html'), html());
  controller = require('../main/desktop-overlay.cjs').create({ app, BrowserWindow, ipcMain,
    screen, globalShortcut, powerMonitor, Notification: { isSupported: () => false },
    getRendererRoot: () => root, getIcon: () => nativeImage.createEmpty(), translate: value => value });
  controller.start();
  overlay = controller.createWindow();
  overlay.on('show', () => report.shows++);
  await loaded();
  await check('empty startup stays hidden before readiness', false);
  await js('soduWorkAPI.notifyReady()');
  await check('empty startup stays hidden after readiness', false);
  assert.equal(report.shows, 0, 'empty startup never maps an auxiliary window');
  const preferences = overlay.webContents.getLastWebPreferences();
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.sandbox, true);

  await content(true);
  await check('enabling a desktop widget reveals the existing window', true);
  await content(false);
  await check('disabling the last desktop widget unmaps the window', false);
  await content(false, true);
  await check('noninteractive feedback remains visible without a desktop widget', true);
  assert.equal(await js('isPointInteractive(200,120)'), false, 'feedback must remain pointer-transparent');
  await content(false);
  await check('dismissing feedback hides the empty window again', false);

  controller.setWorkspaceMaximized(true);
  await content(true);
  await check('new widget does not appear over a maximized workspace', false);
  controller.setWorkspaceMaximized(false);
  await check('restoring workspace reveals a pending visible widget', true);
  controller.setWorkspaceMaximized(true);
  await content(false);
  controller.setWorkspaceMaximized(false);
  await check('workspace restore never resurrects empty content', false);

  await content(true);
  await check('widget available before explicit hide', true);
  controller.hide();
  await content(false);
  await content(true);
  await check('new geometry preserves explicit hiding', false);
  controller.show();
  await check('explicit show restores visible content', true);

  await navigate(() => controller.reload());
  await content(true);
  await check('reload waits for replacement renderer readiness', false);
  await js('soduWorkAPI.notifyReady()');
  await check('reload reveals only ready visible content', true);

  controller.emergencyPassthrough('Isolated visibility regression');
  await check('emergency protection hides native window', false);
  await navigate(() => controller.recoverFromEmergency());
  await js('soduWorkAPI.notifyReady()');
  await check('recovery with no widgets remains hidden', false);
  await content(true);
  await check('recovered renderer can reveal a widget', true);
  assert.deepEqual(await js('fixtureErrors'), [], 'production geometry scripts must execute without errors');
  report.ok = true;
}).then(() => finish(), async error => {
  if (overlay && !overlay.isDestroyed() && !overlay.webContents.isDestroyed()) {
    try {
      report.failureState = await js(`({ visibility:document.visibilityState,
        errors:window.fixtureErrors, geometry:typeof __ptState==='function'?__ptState():null,
        pendingFrame:typeof _shapeFrame==='undefined'?null:_shapeFrame })`);
      report.failureShape = await shape();
    } catch (_) { /* Preserve the original failure if the renderer has exited. */ }
  }
  finish(error);
});
