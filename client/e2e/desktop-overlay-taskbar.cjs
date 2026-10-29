'use strict';
// Real Electron and Windows HWND styles; isolated profile, no user's session.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawnSync(electron, [__filename, ...process.argv.slice(2)], {
    env, windowsHide: true, stdio: 'inherit', timeout: 45000 });
  process.exit(child.status ?? 1);
}
const { app, BrowserWindow, ipcMain, screen, globalShortcut, Notification, powerMonitor } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), { execFileSync } = require('node:child_process');
const venv = path.resolve(__dirname, '../../hub-backend/.venv/Scripts/python.exe');
const python = process.env.SODUWORK_TEST_PYTHON || (fs.existsSync(venv) ? venv : 'python');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-overlay-taskbar-'));
const outputAt = process.argv.indexOf('--output');
const output = outputAt >= 0 ? path.resolve(process.argv[outputAt + 1])
  : path.resolve(__dirname, '../../outputs/desktop-overlay-taskbar/result.json');
const report = { ok: false, cases: [], realNativeWindows: true };
let controller, work, computer;
app.setPath('userData', path.join(root, 'profile'));
app.on('window-all-closed', () => {});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function style(win) {
  const handle = win.getNativeWindowHandle().readBigUInt64LE().toString();
  const source = `import ctypes,json\nfrom ctypes import wintypes\nu=ctypes.WinDLL('user32')\nu.GetWindowLongPtrW.restype=ctypes.c_ssize_t\nu.GetWindowLongPtrW.argtypes=[wintypes.HWND,ctypes.c_int]\ns=u.GetWindowLongPtrW(${handle},-20)\nprint(json.dumps({'toolWindow':bool(s&0x80),'appWindow':bool(s&0x40000),'visible':bool(u.IsWindowVisible(${handle}))}))`;
  return JSON.parse(execFileSync(python,
    ['-c', source], { encoding: 'utf8', windowsHide: true }));
}
function check(name) {
  const native = style(controller.window);
  report.cases.push({ name, ...native });
  assert.equal(native.toolWindow, true, name + ': auxiliary window must be WS_EX_TOOLWINDOW');
  assert.equal(native.appWindow, false, name + ': overlay must not advertise an application window');
  assert.equal(native.visible, true, name + ': desktop controls remain visible');
}
app.whenReady().then(async () => {
  if (process.platform !== 'win32') throw Error('Windows taskbar verification requires Windows');
  fs.copyFileSync(path.resolve(__dirname, '../preload.js'), path.join(root, 'preload.js'));
  fs.writeFileSync(path.join(root, 'index.html'), `<html><body style="margin:0;background:transparent">
    <div style="position:absolute;left:100px;top:100px;width:32px;height:32px;border-radius:50%;background:#777"></div>
    <script>
      const reportShape=()=>soduWorkAPI.setOverlayShape([{x:100,y:100,width:32,height:32}]);
      soduWorkAPI.onOverlayWindowBlur(()=>requestAnimationFrame(reportShape));
      soduWorkAPI.getOverlayShape().then(()=>{reportShape();soduWorkAPI.notifyReady()});
    </script></body></html>`);
  controller = require('../main/desktop-overlay.cjs').create({ app, BrowserWindow, ipcMain,
    screen, globalShortcut, Notification, powerMonitor, getRendererRoot: () => root,
    getIcon: () => undefined, translate: value => value });
  controller.createWindow();
  await delay(1000); check('initial render and redraw');
  work = new BrowserWindow({ width: 300, height: 220, show: false, title: 'Isolated taskbar test',
    webPreferences: { sandbox: true } });
  await work.loadURL('data:text/html,Taskbar fixture');
  assert.equal(style(work).toolWindow, false, 'normal work window remains a normal window');
  controller.window.hide(); controller.window.showInactive(); await delay(80); check('hide and restore');
  ipcMain.emit('window-set-always-on-top', { sender: controller.window.webContents }, false);
  await delay(80); check('temporary lower');
  ipcMain.emit('window-set-always-on-top', { sender: controller.window.webContents }, true);
  await delay(80); check('restore topmost');
  controller.reload(); await delay(800); check('renderer reload and recovery');
  computer = require('../main/computer-use/overlay.cjs').create({ BrowserWindow, screen,
    ipcMain, globalShortcut, onCancel: () => computer.hide() });
  await computer.show(work);
  for (const win of computer.windows()) {
    const native = style(win);
    assert.equal(native.toolWindow, true, 'computer-control HUD must be a tool window');
    assert.equal(native.appWindow, false);
    assert.equal(native.visible, true);
    assert.equal(win.isFocusable(), false);
    report.cases.push({ name: 'computer-control HUD on physical display', ...native });
  }
  computer.hide();
  assert.equal(computer.windows().length, 0);
  assert.equal(globalShortcut.isRegistered('Escape'), false);
  report.ok = true;
}).catch(error => { report.error = error.stack || String(error); }).finally(() => {
  computer?.dispose(); controller?.dispose(); work?.destroy();
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, cases: report.cases.length, error: report.error, report: output }));
  app.exit(report.ok ? 0 : 1);
});
