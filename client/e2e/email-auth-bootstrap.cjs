'use strict';
// Exercise the outer ClientAuth boot lifecycle with real Chromium controls.
// Enrollment, policy and account transitions are synthetic; profiles are isolated.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 45000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const { pathToFileURL } = require('node:url');
  const client = path.resolve(__dirname, '..'), root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-email-bootstrap-'));
  const out = process.argv[2] || path.resolve(client, '../outputs/account-center-20261023/email-auth-bootstrap');
  assert.ok(path.isAbsolute(out), 'The evidence directory must be absolute');
  fs.mkdirSync(out, { recursive: true });
  app.setPath('userData', path.join(root, 'profile')); app.disableHardwareAcceleration();
  const report = { ok: false, platform: process.platform, electron: process.versions.electron, cases: [], boundary: 'Actual Electron Chromium ClientAuth and EmailAuth controls, pointer clicks, typing and document reload. Synthetic enrollment, policy, account transitions and remembered-account getter. External network blocked. No real Hub, SMTP, native credential store or existing profile.' };
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
    const localeFiles = JSON.parse(fs.readFileSync(path.join(client, 'core/locales/manifest.json'), 'utf8'));
    const scripts = [...localeFiles.map(file => 'core/locales/' + file), 'core/i18n.js',
      'components/client-auth/account-ui.js', 'components/client-auth/email-auth.js', 'components/client-auth/client-auth.js'];
    const styles = ['theme/variables.css', 'components/client-auth/client-auth.css', 'components/client-auth/account-center.css'];
    fs.writeFileSync(fixture, '<!doctype html><html><head><meta charset="utf-8"><base href="' + pathToFileURL(client + path.sep).href + '">' +
      styles.map(file => '<link rel="stylesheet" href="' + file + '">').join('') + '</head><body><script>' +
      `localStorage.setItem('soduwork_work_cfg_v5_locale','zh-CN');window.requests=[];window.fixtureDevice='u-unknown';window.mailReady=true;
      window.fixtureParams=new URLSearchParams(location.search);window.policyFailures=Number(fixtureParams.get('failures')||0);
      window.fixtureHub='http://fixture.invalid';window.fixtureUser=fixtureParams.has('transition')&&sessionStorage.getItem('fixture-active')==='yes'?{id:'fixture-account'}:null;
      window.loginReplies=[];window.SoduWorkAPI={hubBase:()=>fixtureHub,hubConfig:()=>({editable:false}),
        clientAuthSnapshot:()=>({state:fixtureUser?'active':'pending',clientId:fixtureDevice,user:fixtureUser}),
        rememberedLoginAccount:()=>fixtureParams.has('transition')?(fixtureHub==='http://fixture.invalid'?'first-account':'second-account'):'',
        loginPreferences:()=>({rememberAccount:fixtureParams.has('transition'),autoLogin:false}),
        registerClient:()=>new Promise(resolve=>setTimeout(()=>{fixtureDevice='soduwork-real-device';resolve(fixtureUser?{ok:true,user:fixtureUser}:{ok:true,activationRequired:true});},20)),
        clientAuthMe:async()=>({user:fixtureUser}),clientLogin:({rememberAccount,autoLogin})=>{
          window.submittedOptions={rememberAccount,autoLogin};return new Promise(resolve=>loginReplies.push(resolve));},
        clientAuthPolicy:()=>{requests.push({kind:'policy',device:fixtureDevice});return new Promise((resolve,reject)=>setTimeout(()=>{if(policyFailures>0){policyFailures--;reject(Error('fixture HTTP failure'));}else resolve({mailReady,allowSelfRegistration:true,passwordMinLength:8});},80));},
        clientAccountAction:()=>{requests.push({kind:'unexpected-mail'});throw Error('No mail allowed in bootstrap fixture');}};` +
      '</script>' + scripts.map(file => '<script src="' + file + '"></script>').join('') + '</body></html>');
    win = new BrowserWindow({ show: false, width: 1100, height: 860,
      webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, callback) => callback({ cancel: true }));
    await win.loadFile(fixture);
    await until('ClientAuth.snapshot().policy?.mailReady === true');
    assert.equal(await js('document.querySelector("#soduWorkRememberAccount").checked || document.querySelector("#soduWorkAutoLogin").checked'), false);
    const statusText = 'document.querySelector(".soduwork-auth-status").textContent';
    await js(`SoduWorkI18n.setLocale('en-US', {persist:false,broadcast:false});
      dispatchEvent(new CustomEvent('soduwork-client-auth-required',{detail:{error:'TypeError: fetch failed'}}));`);
    assert.equal(await js(statusText), 'Cannot connect to SoduWork. Check your network and try again.');
    await js("SoduWorkI18n.setLocale('zh-CN', {persist:false,broadcast:false})");
    assert.equal(await js(statusText), '暂时无法连接 SoduWork 服务，请检查网络后重试。');
    report.cases.push('offline status is localized immediately and repaints when login language changes');
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
    await win.loadFile(fixture, { query: { transition: '1' } });
    await until('ClientAuth.snapshot().policy?.mailReady===true');
    assert.equal(await js('document.getElementById("soduWorkAuthAccount").value'), 'first-account');
    assert.equal(await js('document.getElementById("soduWorkRememberAccount").checked'), true);
    await click('#soduWorkAutoLogin');
    assert.equal(await js('document.getElementById("soduWorkAuthPassword").value'), '');
    await click('#soduWorkAuthPassword'); await win.webContents.insertText('Synthetic first password');
    await click('[type="submit"]'); await until('loginReplies.length===1');
    assert.deepEqual(await js('submittedOptions'), {rememberAccount:true,autoLogin:true});
    assert.equal(await js('document.querySelector("[type=submit]").disabled'), true);
    let loaded = 0;
    win.webContents.on('did-finish-load', () => { loaded++; });
    await js(`fixtureUser={id:'first-actor'};dispatchEvent(new CustomEvent('soduwork-device-auth',{
      detail:{state:'active',user:fixtureUser,interactiveLogin:true}}));
      fixtureUser=null;dispatchEvent(new Event('soduwork-data-scope-changed'));
      dispatchEvent(new CustomEvent('soduwork-client-auth-required',{detail:{code:'AUTH_TRANSITION_PENDING'}}));void 0;`);
    assert.equal(await js('document.getElementById("soduWorkClientAuthGate").hidden'), false);
    assert.equal(await js('document.querySelector("[type=submit]").disabled'), false);
    assert.match(await js('document.querySelector(".soduwork-auth-status").textContent'), /正在完成账号切换.*重试登录/);
    assert.equal(await js('document.getElementById("soduWorkAuthPassword").value'), '');
    assert.equal(await js('document.getElementById("soduWorkAuthAccount").value'), 'first-account');
    report.cases.push('A scope change during sign-in immediately reopens an enabled form and clears its password');
    await click('#soduWorkAuthPassword'); await win.webContents.insertText('Synthetic replacement password');
    await click('[type="submit"]'); await until('loginReplies.length===2');
    await js('loginReplies[0]({ok:true,user:{id:"first-actor"}});void 0;');
    await delay(350);
    assert.equal(loaded, 0, 'A superseded success and its cancelled timer cannot reload the replacement form');
    assert.equal(await js('document.querySelector("[type=submit]").disabled'), true);
    assert.equal(await js('document.getElementById("soduWorkAuthPassword").value'), 'Synthetic replacement password');
    await js('loginReplies[1]({ok:false,code:"PASSWORD_INCORRECT"});void 0;');
    await until('document.getElementById("soduWorkAuthPassword").getAttribute("aria-invalid")==="true"');
    assert.equal(await js('document.querySelector("[type=submit]").disabled'), false);
    report.cases.push('A delayed old success cannot clear credentials, unlock the new submission or reload it');
    await js(`fixtureHub='http://second.invalid';dispatchEvent(new Event('soduwork-data-scope-changed'));void 0;`);
    assert.equal(await js('document.getElementById("soduWorkAuthAccount").value'), 'second-account');
    assert.equal(await js('document.getElementById("soduWorkAuthPassword").value'), '');
    report.cases.push('Switching services fills only that service’s remembered account and leaves the password blank');
    await click('#soduWorkAuthPassword'); await win.webContents.insertText('Synthetic final password');
    await click('[type="submit"]'); await until('loginReplies.length===3');
    const reloaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    await js(`sessionStorage.setItem('fixture-active','yes');fixtureUser={id:'fixture-account'};
      for(let i=0;i<2;i++)dispatchEvent(new CustomEvent('soduwork-device-auth',{
        detail:{state:'active',user:fixtureUser,interactiveLogin:true}}));
      loginReplies[2]({ok:true,user:fixtureUser});void 0;`);
    await reloaded;
    await until('ClientAuth.snapshot().user?.id==="fixture-account" && document.getElementById("soduWorkClientAuthGate").hidden');
    await delay(710);
    assert.equal(loaded, 1, 'An interactive success reloads once and bootstrap restoration does not reload again');
    assert.equal(await js('document.getElementById("soduWorkAuthPassword").value'), '');
    report.cases.push('A current interactive login reloads once; restoring its session does not reload again');
    report.ok = true;
  }).catch(error => { report.error = String(error.stack || error); process.stderr.write(report.error + '\n'); })
    .finally(() => {
      fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
      if (win && !win.isDestroyed()) win.destroy();
      process.stdout.write(JSON.stringify({ ok: report.ok, cases: report.cases.length, report: path.join(out, 'report.json') }) + '\n');
      app.exit(report.ok ? 0 : 1);
    });
}
