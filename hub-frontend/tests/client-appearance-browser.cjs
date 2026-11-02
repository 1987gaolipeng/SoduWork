'use strict';
// Exercise the built admin UI with native Chromium input and an isolated HTTP fixture.
const electron = process.versions.electron ? require('electron') : require('../../client/node_modules/electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE']) delete env[name];
  const result = require('node:child_process').spawnSync(electron, [__filename, '--disable-gpu'], {
    env, windowsHide: true, stdio: 'inherit', timeout: 90000,
  });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const http = require('node:http'), assert = require('node:assert/strict');
  const dist = path.resolve(__dirname, '../dist'), output = path.resolve(__dirname, '../../outputs/client-appearance');
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-appearance-admin-')));
  app.disableHardwareAcceleration();
  let win, server, online = true, fail = false;
  const requests = [], errors = [], cases = [];
  const device = { id: 'fixture-device', name: 'Fixture device', ownerName: 'Test member', authState: 'active',
    online: true, version: '1.13.6', platform: 'win32/x64', taskTotal: 0, taskOpen: 0,
    config: { character: 'diamond', theme: 'vivid', tube: 'glass', _lastSkinId: 'diamond-ice' } };
  const user = { id: 'fixture-admin', displayName: 'Fixture administrator', isSuper: false, permissions: ['client.view', 'client.control'] };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = code => win.webContents.executeJavaScript(code, true);
  async function wait(code) {
    for (let i = 0; i < 150; i++) { if (await js(code)) return; await sleep(40); }
    throw Error('Timed out: ' + code);
  }
  const button = label => label === '关闭' ? `document.querySelector('.client-detail-modal button.mx')` :
    `[...document.querySelectorAll('button')].find(e => e.textContent.trim() === ${JSON.stringify(label)})`;
  async function click(label) {
    const point = await js(`(()=>{const e=${button(label)};if(!e)throw Error('Missing button');e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point });
  }
  app.whenReady().then(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://fixture');
      const json = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (url.pathname === '/healthz') return json({ ok: true });
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname.endsWith('/admin/me')) return json(user);
        if (url.pathname.endsWith('/admin/clients')) return json({ items: [device], total: 1, counts: { all: 1, online: 1 } });
        if (url.pathname.endsWith('/fixture-device')) return json(device);
        if (url.pathname.endsWith('/updates')) return json({ attempts: [] });
        if (url.pathname.endsWith('/fixture-device/push') && req.method === 'POST') {
          let raw = ''; req.on('data', data => { raw += data; });
          req.on('end', () => {
            const body = JSON.parse(raw); requests.push(body);
            setTimeout(() => {
              if (fail) return json({ detail: 'Fixture rejected the update' }, 500);
              if (body.type !== 'config.patch') return json({ detail: 'Expected persisted configuration' }, 400);
              Object.assign(device.config, body.patch); json({ ok: true, delivered: online });
            }, 350);
          }); return;
        }
        return json([]);
      }
      if (url.pathname === '/') {
        const seed = `<script>localStorage.setItem('soduwork_hub_admin_token','fixture');localStorage.setItem('soduwork_hub_admin_user',${JSON.stringify(JSON.stringify(user))});sessionStorage.setItem('soduwork-hub-screen','clients');localStorage.setItem('soduwork.locale','zh-CN');</script>`;
        res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
        return res.end(fs.readFileSync(path.join(dist, 'index.html'), 'utf8').replace('<head>', '<head>' + seed));
      }
      const target = path.resolve(dist, '.' + decodeURIComponent(url.pathname));
      if (!target.startsWith(dist + path.sep) || !fs.statSync(target, { throwIfNoEntry: false })?.isFile()) { res.writeHead(404); return res.end(); }
      res.setHeader('Content-Type', target.endsWith('.js') ? 'text/javascript' : target.endsWith('.css') ? 'text/css' : 'application/octet-stream');
      res.end(fs.readFileSync(target));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    win = new BrowserWindow({ show: false, width: 1280, height: 1000, webPreferences: { backgroundThrottling: false, offscreen: true } });
    win.webContents.session.webRequest.onBeforeRequest((details, done) => done({ cancel: !details.url.startsWith(origin + '/') && !details.url.startsWith('data:') }));
    win.webContents.on('console-message', event => { if (/Uncaught|React error/.test(event.message)) errors.push(event.message); });
    await win.loadURL(origin + '/');
    await wait('document.querySelectorAll(".en-table tbody tr").length === 1');
    await click('管理'); await wait(`${button('钻石')}?.getAttribute('aria-pressed') === 'true'`);
    await click('玻璃'); await wait(`${button('玻璃')}.disabled`);
    await click('五彩盒子');
    await wait(`${button('玻璃')}.getAttribute('aria-pressed') === 'true' && !${button('玻璃')}.disabled`);
    assert.equal(requests.length, 1, 'disabled controls block duplicate native clicks');
    assert.equal(device.config._lastSkinId, 'bear-vivid');
    cases.push('Native skin click selects the clicked button after persistence and blocks overlapping clicks');
    online = false;
    await click('五彩盒子'); await wait(`${button('五彩盒子')}.getAttribute('aria-pressed') === 'true' && !${button('五彩盒子')}.disabled`);
    await click('关闭'); await wait('!document.querySelector(".client-detail-modal")');
    await click('管理'); await wait(`${button('五彩盒子')}?.getAttribute('aria-pressed') === 'true'`);
    assert.equal(device.config._defaultLogoVersion, 1);
    cases.push('Offline settings persist and reopening the dialog preserves the chosen skin');
    fail = true;
    await click('钻石'); await wait(`${button('钻石')}.disabled`); await wait(`!${button('钻石')}.disabled`);
    assert.equal(await js(`${button('五彩盒子')}.getAttribute('aria-pressed')`), 'true');
    fail = false; online = true;
    await click('钻石'); await wait(`${button('钻石')}.getAttribute('aria-pressed') === 'true' && !${button('钻石')}.disabled`);
    await click('明显'); await wait(`${button('明显')}.getAttribute('aria-pressed') === 'true'`);
    cases.push('Failures retain the prior selection; retry and reminder controls remain usable');
    assert.deepEqual(errors, []);
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'appearance.png'), (await win.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ ok: true, isolated: true, cases }, null, 2));
    console.log(JSON.stringify({ ok: true, cases }));
    win.destroy(); await new Promise(resolve => server.close(resolve)); app.exit(0);
  }).catch(error => { console.error(error.stack || error); app.exit(1); });
}
