'use strict';
// Isolated Electron rendering of the production rail. No backend or user profile.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw Error('Absolute evidence directory required');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-rail-art-')));
const client = path.resolve(__dirname, '..');
const asset = p => pathToFileURL(path.join(client, p)).href;
const keys = ['home', 'history', 'skills', 'schedules', 'library'];
let win;
const report = { ok: false, cases: [] };
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 1280, height: 850, webPreferences: {
    offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false,
  } });
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => { if (level === 3) errors.push(message); });
  const files = ['components/workspace/workspace-chat-history.js', 'components/workspace/workspace-chat-list.js', 'components/workspace/workspace-shell.js'];
  const html = '<!doctype html><html data-desk-panel="workspace" data-skin="flat"><head><meta charset="utf-8">' +
    '<base href="' + asset('desk.html') + '">' +
    ['theme/variables.css', 'components/workspace/workspace-shell.css', 'theme/box-theme.css'].map(p => '<link rel="stylesheet" href="' + asset(p) + '">').join('') +
    '</head><body><script>window.errors=[];addEventListener("error",e=>errors.push(e.message));window.opens=[];window.WorkspaceHost={open:key=>{opens.push(key);WorkspaceShell.setActive(key)}};</script>' +
    files.map(p => '<script src="' + asset(p) + '"></script>').join('') +
    '<script>WorkspaceShell.mount();WorkspaceShell.setActive("apps");</script></body></html>';
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html), { baseURLForDataURL: asset('desk.html') });
  const js = (fn, arg) => win.webContents.executeJavaScript('(' + fn.toString() + ')(' + JSON.stringify(arg ?? null) + ')');
  await js(async () => { await Promise.all([...document.images].map(i => i.decode().catch(() => {}))); });
  assert.deepEqual(await js(() => errors), []);
  for (const skin of ['flat', 'box']) {
    for (const theme of ['light', 'dark']) {
      await js(({ skin, theme }) => { document.documentElement.dataset.skin = skin; document.documentElement.dataset.theme = theme; }, { skin, theme });
      for (const key of keys) {
        const view = key === 'home' ? 'create' : key;
        await js(() => WorkspaceShell.setActive('apps'));
        const before = await js(key => {
          const i = document.querySelector('.ws-rail-art[data-icon="' + key + '"]');
          const line = i.closest('button').querySelector('.ws-rail-line-art');
          const r = line.getBoundingClientRect(), b = i.closest('button').getBoundingClientRect();
          return { loaded: i.complete && i.naturalWidth > 0, imageDisplay: getComputedStyle(i).display,
            lineDisplay: getComputedStyle(line).display, fill: getComputedStyle(line.querySelector('g')).fill,
            width: r.width, height: r.height, inside: r.left >= b.left && r.right <= b.right };
        }, key);
        assert.equal(before.loaded, true, key + ' loads');
        assert.equal(before.imageDisplay, 'none'); assert.equal(before.lineDisplay, 'block');
        assert.equal(before.fill, 'none', key + ' is genuine unfilled line art');
        assert.equal(before.width, 22); assert.equal(before.height, 22); assert.equal(before.inside, true);
        const pos = await js(view => {
          const r = document.querySelector('.ws-rail-top [data-rail-view="' + view + '"]').getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }, view);
        win.webContents.sendInputEvent({ type: 'mouseDown', ...pos, button: 'left', clickCount: 1 });
        win.webContents.sendInputEvent({ type: 'mouseUp', ...pos, button: 'left', clickCount: 1 });
        await new Promise(r => setTimeout(r, 30));
        const after = await js(key => {
          const i = document.querySelector('.ws-rail-art[data-icon="' + key + '"]');
          return { imageDisplay: getComputedStyle(i).display,
            lineDisplay: getComputedStyle(i.closest('button').querySelector('.ws-rail-line-art')).display,
            current: i.closest('button').getAttribute('aria-current'), opened: opens.at(-1) };
        }, key);
        assert.equal(after.imageDisplay, 'block'); assert.equal(after.lineDisplay, 'none');
        assert.equal(after.current, 'page'); assert.equal(after.opened, view);
      }
      report.cases.push(skin + '/' + theme + ': five assets, gray/color states, 22px bounds and mouse navigation pass');
    }
  }
  // Review sheet reuses the real mounted button DOM, SVG files and production CSS.
  await js(() => WorkspaceShell.setActive('apps'));
  await js(() => {
    const names = ['主页', '需求池', '插件', '自动化', '资料库'];
    const keys = ['home', 'history', 'skills', 'schedules', 'library'];
    const buttons = keys.map(k => document.querySelector('.ws-rail-art[data-icon="' + k + '"]').closest('button').outerHTML);
    const rows = (color, cls = '') => '<div class="samples ' + cls + '">' + buttons.map((b, i) => '<div class="sample">' + b.replace('ws-rail-button', 'ws-rail-button' + (color ? ' active' : '')) + '<label>' + names[i] + '</label></div>').join('') + '</div>';
    document.documentElement.removeAttribute('data-desk-panel');
    document.documentElement.dataset.skin = 'flat'; document.documentElement.dataset.theme = 'light';
    document.body.innerHTML = '<main><small>SoduWork · 实际矢量资源</small><h1>灰色线条版</h1><p>未选中：灰色线条；选中：彩色实心。</p>' +
      '<section class="large"><h2>灰色线条 · 未选中</h2>' + rows(false) + '</section>' +
      '<section class="color"><h2>彩色 · 选中</h2>' + rows(true) + '</section>' +
      '<div class="pair"><section><h2>浅色背景 · 实际 22px</h2>' + rows(false) + '</section>' +
      '<section class="dark"><h2>深色背景 · 实际 22px</h2>' + rows(false) + '</section></div></main>';
    const style = document.createElement('style');
    style.textContent = 'body{margin:0;background:#f4f5f7;color:#202633;font-family:"Microsoft YaHei",sans-serif}main{padding:38px 48px}small{color:#7a8390;font-size:14px}h1{margin:10px 0;font-size:34px}p{color:#737d8b;margin:0 0 26px}h2{font-size:16px;margin:0 0 18px;font-weight:500;color:#7a8390}section{background:#fff;border-radius:18px;padding:22px 28px;margin-bottom:18px}.samples{display:flex;justify-content:space-around;gap:24px}.sample{display:flex;flex-direction:column;align-items:center;gap:10px}label{font-size:14px;color:#747c89}.samples .ws-rail-button{background:transparent;border:0;box-shadow:none;pointer-events:none}.large .ws-rail-button,.color .ws-rail-button{width:94px;height:80px}.large .ws-rail-line-art,.color .ws-rail-art{width:70px;height:70px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:20px}.pair section{padding:24px}.dark{background:#252a34}.dark h2,.dark label{color:#adb5c3}.dark .ws-rail-button{color:#adb5c3}';
    document.head.append(style);
  });
  await js(async () => { await Promise.all([...document.images].map(i => i.decode())); });
  win.webContents.invalidate();
  await new Promise(r => setTimeout(r, 250));
  fs.writeFileSync(path.join(output, 'sidebar-outline-preview.png'), (await win.webContents.capturePage()).toPNG());
  assert.deepEqual(errors, []);
  report.ok = true;
}).catch(e => { report.error = e.stack; process.exitCode = 1; }).finally(() => {
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (win) win.destroy(); app.exit(report.ok ? 0 : 1);
});
