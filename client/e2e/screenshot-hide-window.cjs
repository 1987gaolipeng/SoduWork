'use strict';

const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawnSync(electron, [__filename],
    { env, stdio: 'inherit', windowsHide: true, timeout: 90000 });
  process.exit(child.status ?? 1);
}

const { app, BrowserWindow, ipcMain, protocol, net, nativeImage } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const client = path.resolve(__dirname, '..'), ownerFile = path.join(client, 'desk.html');
const ownerURL = pathToFileURL(ownerFile).href;
const out = path.resolve(__dirname, '../../outputs/screenshot-hide-window');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-capture-hide-')));
app.on('window-all-closed', () => {});
const report = { ok: false, cases: [], snapshots: [], boundary:
  'Real isolated Electron windows, production composer/settings/preload, native visibility and screenshot service. Synthetic screen pixels, one small virtual display and isolated clipboard/save sinks; no business windows, accounts, desktop pixels or system clipboard modified.' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (fn, label) => {
  for (let attempt = 0; attempt < 200; attempt++) { const value = await fn(); if (value) return value; await delay(20); }
  throw Error('Timed out: ' + label);
};
let owner, other, service, captureFailure = false, captureBlocked = false, clips = 0;
const snapshots = [];
const js = code => owner.webContents.executeJavaScript(code);
const editors = () => BrowserWindow.getAllWindows().filter(win => win !== owner && win !== other);
async function click(selector) {
  const point = await js(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  owner.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
  owner.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
}
async function overlay() {
  const win = await until(() => editors()[0], 'capture editor created');
  await until(() => !win.isDestroyed() && win.isVisible(), 'capture editor visible'); return win;
}
async function cancel(win) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  await until(() => !editors().length, 'capture canceled');
  await until(() => js("!document.querySelector('#menu button:disabled')"), 'composer capture settled');
}
async function menu(id) {
  await js(`document.querySelector('#menu').hidden=false;document.querySelector('#menu').innerHTML=WorkComposer.screenshotRow(${JSON.stringify(id)});WorkComposer.bindScreenshot(document.getElementById(${JSON.stringify(id)}),()=>{document.querySelector('#menu').hidden=true});`);
}

app.whenReady().then(async () => {
  const html = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="theme/variables.css">' +
    '<link rel="stylesheet" href="components/panels/work-composer.css"><style>body{margin:24px;background:var(--bg-0);font-family:var(--font-ui)}#menu{width:100%;border:1px solid var(--line);border-radius:14px;padding:8px;box-sizing:border-box}button{font:inherit}</style></head>' +
    '<body><section id="shortcutsPanel" hidden></section><div id="menu"></div><script>window.notices=[];window.petSay=message=>notices.push(message);</script>' +
    '<script src="core/shortcut-bindings.js"></script><script src="components/settings/shortcut-settings.js"></script>' +
    '<script src="components/panels/work-composer.js"></script></body></html>';
  protocol.handle('file', request => request.url.split('?')[0] === ownerURL
    ? new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    : net.fetch(request.url, { bypassCustomProtocolHandlers: true }));
  electron.session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, answer) => answer({ cancel: true }));
  ipcMain.handle('window-shortcuts-state', () => ({ ok: true }));
  const display = { id: 101, label: 'Isolated display', bounds: { x: 50, y: 50, width: 600, height: 400 }, scaleFactor: 1 };
  const screen = Object.assign(new EventEmitter(), { getAllDisplays: () => [display],
    getDisplayNearestPoint: () => display, getCursorScreenPoint: () => ({ x: 60, y: 60 }) });
  const bitmap = Buffer.alloc(600 * 400 * 4, 200);
  for (let i = 3; i < bitmap.length; i += 4) bitmap[i] = 255;
  const thumbnail = nativeImage.createFromBitmap(bitmap, { width: 600, height: 400 });
  service = require('../main/screenshot-service.cjs').create({ app, BrowserWindow, ipcMain, nativeImage, screen,
    getRendererRoot: () => client, getTheme: () => ({}), timeoutMs: 1500,
    desktopCapturer: { async getSources() {
      snapshots.push({ ownerVisible: owner.isVisible(), otherVisible: other.isVisible(), bounds: owner.getBounds() });
      if (captureFailure) throw Error('Isolated acquisition failure');
      if (captureBlocked) return new Promise(() => {});
      return [{ display_id: '101', thumbnail }];
    } }, clipboard: { writeImage() { clips++; } },
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: path.join(out, 'saved.png') }) }
  });
  owner = new BrowserWindow({ width: 700, height: 300, show: false, webPreferences: {
    preload: path.join(client, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  other = new BrowserWindow({ width: 120, height: 100, show: false });
  await owner.loadFile(ownerFile); await other.loadURL('data:text/html,<p>Independent isolated window</p>');
  owner.showInactive(); other.showInactive();
  const bounds = owner.getBounds();

  for (const id of ['cpScreenshot', 'nchatScreenshot']) {
    await menu(id);
    await click('[data-screenshot-hide]');
    const win = await overlay();
    assert.equal(owner.isVisible(), false); assert.equal(other.isVisible(), true);
    assert.equal(snapshots.at(-1).ownerVisible, false); assert.equal(snapshots.at(-1).otherVisible, true);
    assert.deepEqual(owner.getBounds(), bounds);
    await cancel(win);
    await until(() => owner.isVisible() && js(`!document.getElementById('${id}').disabled`), 'owner and menu restored');
    assert.deepEqual(owner.getBounds(), bounds);
    report.cases.push(id + ': native icon click hides only owner before capture; Escape restores owner and geometry');
  }
  await menu('cpScreenshot'); await click('#cpScreenshot');
  let win = await overlay(); assert.equal(snapshots.at(-1).ownerVisible, true);
  await cancel(win); report.cases.push('Normal screenshot action retains current window in captured pixels');

  await menu('cpScreenshot');
  await js("document.querySelector('[data-screenshot-hide]').focus()");
  owner.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  owner.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
  owner.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  win = await overlay(); assert.equal(owner.isVisible(), false);
  const png = thumbnail.resize({ width: 40, height: 30 }).toDataURL();
  await win.webContents.executeJavaScript(`void (async()=>{await screenshotAPI.claim();await screenshotAPI.finish({action:'copy',dataUrl:${JSON.stringify(png)}})})();true`);
  await until(() => owner.isVisible() && clips === 1, 'restore after copy');
  report.cases.push('Keyboard activation and production overlay IPC copy restore owner exactly once');

  for (const mode of ['failure', 'timeout']) {
    captureFailure = mode === 'failure'; captureBlocked = mode === 'timeout';
    const result = await js('soduWorkAPI.startScreenshot({hideOwner:true})');
    assert.equal(result.ok, false); assert.equal(owner.isVisible(), true); assert.equal(other.isVisible(), true);
    assert.equal(snapshots.at(-1).ownerVisible, false); assert.equal(editors().length, 0);
    report.cases.push(mode + ': production IPC restores exact owner and releases capture lock');
  }
  captureFailure = captureBlocked = false;
  const saving = js('soduWorkAPI.startScreenshot({hideOwner:true})'); win = await overlay();
  await win.webContents.executeJavaScript(`void (async()=>{await screenshotAPI.claim();await screenshotAPI.finish({action:'save',dataUrl:${JSON.stringify(png)}})})();true`);
  assert.equal((await saving).action, 'save'); assert.equal(owner.isVisible(), true); assert.ok(fs.existsSync(path.join(out, 'saved.png')));
  report.cases.push('Save success restores owner and writes only selected isolated output path');

  owner.hide();
  const hidden = js('soduWorkAPI.startScreenshot({hideOwner:true})'); win = await overlay(); await cancel(win); await hidden;
  assert.equal(owner.isVisible(), false); report.cases.push('Previously hidden owner stays hidden after capture cancellation');

  owner.showInactive();
  for (const theme of ['default', 'steady', 'warm', 'minimal', 'azure']) {
    await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
    for (const width of [700, 380]) {
      owner.setSize(width, 300); await delay(80);
      for (const id of ['cpScreenshot', 'nchatScreenshot']) {
        await menu(id);
        owner.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 });
        const layout = await js(`(()=>{const row=document.querySelector('.wc-screenshot-row'),button=document.querySelector('[data-screenshot-hide]'),r=row.getBoundingClientRect(),b=button.getBoundingClientRect(),s=getComputedStyle(button);return{overflow:document.documentElement.scrollWidth>innerWidth,inside:b.right<=r.right&&b.left>=r.left,label:button.getAttribute('aria-label'),width:b.width,height:b.height,radius:parseFloat(s.borderTopLeftRadius),background:s.backgroundColor,color:s.color}})()`);
        assert.equal(layout.overflow, false); assert.equal(layout.inside, true);
        assert.ok(layout.height >= 32); assert.ok(layout.width > layout.height + 8, 'hide action has a horizontal capsule silhouette');
        assert.ok(layout.radius >= layout.height / 2, 'capsule has fully rounded ends');
        assert.notEqual(layout.background, 'rgba(0, 0, 0, 0)', 'capsule remains visible before hover');
        assert.equal(layout.label, '隐藏当前窗口后截图');
        if (id === 'nchatScreenshot') fs.writeFileSync(path.join(out, 'menu-' + theme + '-' + width + '-rest.png'), (await owner.webContents.capturePage()).toPNG());
        const hoverPoint = await js("(()=>{const r=document.querySelector('[data-screenshot-hide]').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()");
        owner.webContents.sendInputEvent({ type: 'mouseMove', ...hoverPoint });
        const hover = await js("(()=>{const b=document.querySelector('[data-screenshot-hide]'),r=b.getBoundingClientRect();return{width:r.width,height:r.height}})()");
        assert.deepEqual(hover, { width: layout.width, height: layout.height }, 'hover does not resize the action');
        owner.focus(); owner.webContents.focus();
        await js(`document.getElementById(${JSON.stringify(id)}).focus()`);
        owner.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
        owner.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
        const focus = await until(() => js("(()=>{const b=document.querySelector('[data-screenshot-hide]');if(document.activeElement!==b)return null;const s=getComputedStyle(b);return{visible:b.matches(':focus-visible'),outline:s.outlineStyle,width:parseFloat(s.outlineWidth)}})()"), 'keyboard reaches hide capsule');
        assert.equal(focus.visible, true); assert.notEqual(focus.outline, 'none'); assert.ok(focus.width >= 2);
        report.snapshots.push({ theme, viewportWidth: width, menu: id, ...layout });
      }
      fs.writeFileSync(path.join(out, 'menu-' + theme + '-' + width + '.png'), (await owner.webContents.capturePage()).toPNG());
    }
  }
  report.cases.push('Both composer menus retain visible capsules, stable hover geometry and keyboard focus across five themes and wide/narrow windows');
  report.ok = true;
}).catch(error => { report.error = error.stack || String(error); process.exitCode = 1; }).finally(() => {
  service?.dispose();
  for (const win of BrowserWindow.getAllWindows()) win.destroy();
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); app.exit(report.ok ? 0 : 1);
});
