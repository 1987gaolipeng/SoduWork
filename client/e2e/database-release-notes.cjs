'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' })
    .on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
  const assert = require('node:assert/strict');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notes-ui-'));
  const client = path.resolve(__dirname, '..');
  const out = path.resolve(client, '../outputs/database-release-notes');
  fs.mkdirSync(out, { recursive: true });
  app.setPath('userData', path.join(root, 'profile'));
  let win, server;
  const read = file => fs.readFileSync(path.join(client, file), 'utf8');
  app.whenReady().then(async () => {
    server = http.createServer((req, res) => {
      assert.equal(req.headers.authorization, 'Device isolated');
      const locale = new URL(req.url, 'http://localhost').searchParams.get('locale');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ currentVersion: '2.0.0', nextOffset: null, releases: ['2.0.0', '1.0.0'].map(version => ({
        version, locale, summary: locale === 'en-US' ? 'English release notes' : '中文版本说明', sections: [
          { id: 'features', title: locale === 'en-US' ? 'New features' : '新增功能', items: Array.from({ length: 30 }, (_, i) => ({
            id: 'item-' + i, text: locale === 'en-US' ? 'Full update description ' + i : '完整更新内容 ' + i })) }
        ] })) }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const identity = { hub: 'http://127.0.0.1:' + server.address().port, clientId: 'fixture', session: 'isolated' };
    const fakeApp = { getPath: () => path.join(root, 'profile'), getVersion: () => '2.0.0' };
    require('../main/release-notes').register({ app: fakeApp, ipcMain, BrowserWindow, root,
      identityOf: () => identity, authenticatedIdentityOf: async () => identity });
    fs.writeFileSync(path.join(root, 'preload.cjs'), `const {contextBridge,ipcRenderer}=require('electron');
      contextBridge.exposeInMainWorld('soduWorkAPI',{releaseNotes:{
        list:l=>ipcRenderer.invoke('release-notes-list',l),version:()=>ipcRenderer.invoke('release-notes-version'),
        release:()=>ipcRenderer.invoke('release-notes-release'),acknowledge:()=>ipcRenderer.invoke('release-notes-ack')}});`);
    fs.writeFileSync(path.join(root, 'desk.html'), `<!doctype html><html><head><meta charset="utf-8"><style>
      :root{--ink:#222;--ink-3:#888;--line:#ddd;--bg-0:#fff;--ink-2:#222;--bg-1:#fff;--bg-2:#eee;--bg-3:#ddd;--accent:#387aff;--font-ui:Arial}
      body{margin:0;background:#eee;font-family:Arial}
      ${read('components/workspace/workspace-sidebar-projects.css')}
      ${read('components/release-notes/release-notes.css')}</style></head><body><button id="releaseNotesHistory">History</button>
      <script>${read('core/i18n.js')}</script><script>${read('components/release-notes/release-notes.js')}</script></body></html>`);
    win = new BrowserWindow({ show: false, width: 1100, height: 850,
      webPreferences: { preload: path.join(root, 'preload.cjs'), contextIsolation: true, sandbox: true } });
    await win.loadFile(path.join(root, 'desk.html'));
    const js = code => win.webContents.executeJavaScript(code, true);
    await js("SoduWorkI18n.setLocale('en-US'); SoduWorkReleaseNotes.openHistory()");
    assert.match(await js("document.querySelector('dialog').textContent"), /English release notes/);
    assert.doesNotMatch(await js("document.querySelector('dialog').textContent"), /中文|新增功能/);
    const bounds = await js(`(()=>{const d=document.querySelector('dialog'),r=d.getBoundingClientRect(),b=d.querySelector('.rn-content');
      return {x:r.x,y:r.y,width:r.width,height:r.height,vw:innerWidth,vh:innerHeight,scroll:b.scrollHeight>b.clientHeight,items:d.querySelectorAll('li').length}})()`);
    assert.equal(bounds.width, 520); assert.equal(bounds.height, 640);
    assert.ok(Math.abs(bounds.x - (bounds.vw - 520) / 2) <= 2);
    assert.ok(Math.abs(bounds.y - (bounds.vh - 640) / 2) <= 2);
    assert.equal(bounds.scroll, true); assert.equal(bounds.items, 60);
    await js("document.querySelector('[data-rn-focus=history]').click()");
    assert.equal(await js("document.querySelectorAll('dialog article').length"), 1);
    fs.writeFileSync(path.join(out, 'english.png'), (await win.webContents.capturePage()).toPNG());
    await js("SoduWorkI18n.setLocale('zh-CN')");
    for (let i = 0; i < 40 && !/中文版本说明/.test(await js("document.querySelector('dialog').textContent")); i++)
      await new Promise(resolve => setTimeout(resolve, 50));
    assert.match(await js("document.querySelector('dialog').textContent"), /中文版本说明/);
    win.setSize(430, 600);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await js("document.querySelector('dialog').getBoundingClientRect().width <= innerWidth"), true);
    fs.writeFileSync(path.join(out, 'chinese-narrow.png'), (await win.webContents.capturePage()).toPNG());
    await js("dispatchEvent(new CustomEvent('soduwork-device-auth', {detail: {state: 'active'}}))");
    assert.equal(await js("!!document.querySelector('dialog[open]')"), true);
    await js("dispatchEvent(new Event('soduwork-data-scope-changed'))");
    assert.equal(await js("!!document.querySelector('dialog[open]')"), false);
    console.log('PASS: real Electron IPC + authenticated loopback notes, bilingual UI, centered fixed dialog, full content scroll, history return, narrow layout');
  }).catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => {
    win?.destroy(); server?.close(); app.exit(process.exitCode || 0);
  });
}
