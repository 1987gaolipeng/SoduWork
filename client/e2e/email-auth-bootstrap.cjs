'use strict';
// Exercise the outer ClientAuth boot lifecycle with real Chromium controls.
// Only enrollment and policy are fixtures; no server, email or user profile is used.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 45000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const { pathToFileURL } = require('node:url');
  const client = path.resolve(__dirname, '..'), root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-email-bootstrap-'));
  const out = path.resolve(client, '../outputs/account-center-20261023/email-auth-bootstrap');
  fs.mkdirSync(out, { recursive: true });
  app.setPath('userData', path.join(root, 'profile')); app.disableHardwareAcceleration();
  const report = { ok: false, cases: [], boundary: 'Actual Chromium ClientAuth boot and EmailAuth controls with delayed enrollment/policy fixtures. No real Hub, SMTP, credentials or account changes.' };
  let win;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function js(code) { return win.webContents.executeJavaScript(code, true); }
  async function until(expression) {
    for (let i = 0; i < 100; i++) { if (await js(expression)) return; await delay(30); }
    throw Error('Wait: ' + expression + '\n' + await js('document.body.innerText'));
  }
  async function click(selector) {
    const point = await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)}),r=el.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
    await delay(30);
  }
  app.whenReady().then(async () => {
    const fixture = path.join(root, 'bootstrap.html');
    const scripts = ['components/client-auth/account-ui.js', 'components/client-auth/email-auth.js', 'components/client-auth/client-auth.js'];
    const styles = ['theme/variables.css', 'components/client-auth/client-auth.css', 'components/client-auth/account-center.css'];
    fs.writeFileSync(fixture, '<!doctype html><html><head><meta charset="utf-8"><base href="' + pathToFileURL(client + path.sep).href + '">' +
      styles.map(file => '<link rel="stylesheet" href="' + file + '">').join('') + '</head><body><script>' +
      `window.requests=[];window.fixtureDevice='u-unknown';window.mailReady=true;window.policyFailures=Number(new URLSearchParams(location.search).get('failures')||0);
      window.SoduWorkAPI={hubBase:()=> 'http://fixture.invalid',hubConfig:()=>({editable:false}),
        clientAuthSnapshot:()=>({clientId:fixtureDevice,user:null}),
        registerClient:()=>new Promise(resolve=>setTimeout(()=>{fixtureDevice='soduwork-real-device';resolve({ok:true,activationRequired:true});},20)),
        clientAuthPolicy:()=>{requests.push({kind:'policy',device:fixtureDevice});return new Promise((resolve,reject)=>setTimeout(()=>{if(policyFailures>0){policyFailures--;reject(Error('fixture HTTP failure'));}else resolve({mailReady,allowSelfRegistration:true,passwordMinLength:8});},80));},
        clientAccountAction:()=>{requests.push({kind:'unexpected-mail'});throw Error('No mail allowed in bootstrap fixture');}};` +
      '</script>' + scripts.map(file => '<script src="' + file + '"></script>').join('') + '</body></html>');
    win = new BrowserWindow({ show: false, width: 1100, height: 860,
      webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, callback) => callback({ cancel: true }));
    await win.loadFile(fixture);
    await until('ClientAuth.snapshot().policy?.mailReady === true');
    await click('[data-auth-mode="register"]');
    await click('#soduWorkAuthAccount'); await win.webContents.insertText('new-user@example.test');
    assert.equal(await js("document.querySelector('[data-send-code]').disabled"), false);
    assert.equal(await js("document.querySelector('h1').textContent"), '创建你的账号');
    assert.equal(await js("document.querySelector('#soduWorkAuthAccount').value"), 'new-user@example.test');
    assert.deepEqual(await js('requests'), [{ kind: 'policy', device: 'soduwork-real-device' }]);
    report.cases.push('device enrollment settles before policy; registration code button is enabled with a valid email');
    await delay(150);
    fs.writeFileSync(path.join(out, 'registration-ready.png'), (await win.capturePage()).toPNG());
    await js('mailReady=false;document.querySelector(".soduwork-auth-retry").click();void 0');
    await until('ClientAuth.snapshot().policy?.mailReady === false');
    await click('[data-auth-mode="register"]');
    assert.equal(await js("document.querySelector('[data-send-code]').disabled"), true);
    assert.match(await js("document.querySelector('[data-mail-message]').textContent"), /管理员尚未配置或启用邮件服务/);
    assert.equal(await js("requests.some(row=>row.kind==='unexpected-mail')"), false);
    report.cases.push('disabled mail policy remains disabled with an administrator explanation; no email action occurs');
    await win.loadFile(fixture, { query: { failures: '2' } });
    await until("document.querySelector('[data-mail-message]')?.textContent.includes('无法读取邮件服务状态')");
    await click('[data-auth-mode="register"]');
    await click('#soduWorkAuthAccount'); await win.webContents.insertText('retry-user@example.test');
    assert.equal(await js('ClientAuth.snapshot().policy'), null);
    assert.equal(await js("document.querySelector('[data-mail-availability]').hidden"), false);
    assert.equal(await js("document.querySelector('[data-send-code]').disabled"), true);
    assert.doesNotMatch(await js("document.querySelector('[data-mail-message]').textContent"), /fixture|HTTP|管理员尚未|版本不支持/);
    await click('[data-recheck-policy]');
    await until("policyFailures===0 && !document.querySelector('[data-recheck-policy]').disabled");
    assert.match(await js("document.querySelector('[data-mail-message]').textContent"), /无法读取邮件服务状态.*重新检查/);
    assert.doesNotMatch(await js("document.querySelector('.soduwork-auth-status').textContent"), /正在安全恢复/);
    assert.equal(await js("document.querySelector('[data-send-code]').disabled"), true);
    assert.equal(await js("document.querySelector('#soduWorkAuthAccount').value"), 'retry-user@example.test');
    report.cases.push('initial HTTP failure and failed recheck remain actionable without losing the registration draft');
    await delay(150);
    fs.writeFileSync(path.join(out, 'registration-policy-retry.png'), (await win.capturePage()).toPNG());
    await click('[data-recheck-policy]');
    await until("ClientAuth.snapshot().policy?.mailReady===true && !document.querySelector('[data-send-code]').disabled");
    assert.equal(await js("document.querySelector('[data-mail-availability]').hidden"), true);
    assert.equal(await js("document.querySelector('[data-mail-message]').textContent"), '');
    assert.equal(await js("document.querySelector('#soduWorkAuthAccount').value"), 'retry-user@example.test');
    assert.equal(await js("requests.some(row=>row.kind==='unexpected-mail')"), false);
    report.cases.push('successful user recheck clears failure and enables code sending with the same email draft');
    report.ok = true;
  }).catch(error => { report.error = String(error.stack || error); process.stderr.write(report.error + '\n'); })
    .finally(() => {
      fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
      if (win && !win.isDestroyed()) win.destroy();
      process.stdout.write(JSON.stringify({ ok: report.ok, cases: report.cases.length, report: path.join(out, 'report.json') }) + '\n');
      app.exit(report.ok ? 0 : 1);
    });
}
