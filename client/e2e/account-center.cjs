'use strict';
// Real Chromium forms and mouse/keyboard events. Account APIs are isolated
// fixtures; no SMTP delivery, business database, or model call is represented.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 120000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { pathToFileURL } = require('node:url'), assert = require('node:assert/strict');
  const sourceManifest = require('./fixtures/account-source-manifest.cjs');
  const client = path.resolve(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-account-e2e-'));
  const out = path.resolve(process.argv[2] || path.join(client, '../outputs/account-center-20261023/client-e2e'));
  fs.mkdirSync(out, { recursive: true }); app.setPath('userData', path.join(temp, 'profile')); app.disableHardwareAcceleration();
  const report = { ok: false, cases: [], errors: [], networkRequests: [], screenshots: [],
    boundary: 'Real account UI, input validation, theme, keyboard, modal focus and mouse actions. API and mailbox fixtures only; no actual email delivery, model, real user or business database.' };
  report.sourcesAtStart = sourceManifest.snapshot();
  let win;
  const js = async code => {
    try { return await win.webContents.executeJavaScript(code, true); }
    catch (error) { process.stderr.write('Renderer action: ' + code.slice(0, 240) + '\n'); throw error; }
  };
  const frames = () => js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const record = name => { report.cases.push({ name, ok: true }); process.stdout.write('PASS ' + name + '\n'); };
  async function click(selector) {
    await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'});`); await frames();
    const point = await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)}),r=el.getBoundingClientRect();const p={x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};if(el.disabled)throw Error('Disabled: '+${JSON.stringify(selector)});if(!el.contains(document.elementFromPoint(p.x,p.y)))throw Error('Obscured: '+${JSON.stringify(selector)});return p;})()`);
    for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
    await frames();
  }
  async function fill(selector, value) {
    await click(selector);
    assert.equal(await js(`document.activeElement === document.querySelector(${JSON.stringify(selector)})`), true, 'Input must receive focus before typing');
    for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await win.webContents.debugger.sendCommand('Input.insertText', { text: value }); await frames();
    assert.equal(await js(`document.querySelector(${JSON.stringify(selector)}).value`), value, 'Typing must replace the selected input value');
  }
  async function wait(expression) {
    await js(`new Promise((resolve,reject)=>{let timer;const observer=new MutationObserver(check);function check(){if(${expression}){observer.disconnect();clearTimeout(timer);resolve(true);}}observer.observe(document.body,{childList:true,subtree:true,attributes:true,characterData:true});timer=setTimeout(()=>{observer.disconnect();reject(Error('Wait: '+${JSON.stringify(expression)}))},8000);check();})`);
  }
  async function shot(name) {
    await frames(); const image = await win.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const file = path.join(out, name + '.png'); fs.writeFileSync(file, Buffer.from(image.data, 'base64')); report.screenshots.push(file);
  }
  async function fresh(mode = 'emailCode', options = {}) {
    await js(`document.querySelectorAll('.ac-mask').forEach(e=>e.remove());window.view?.dispose();
      document.documentElement.classList.add('soduwork-auth-pending');gate.hidden=false;
      window.view=EmailAuth.mount(gate,{api:()=>SoduWorkAPI,retry:()=>{window.policyRetries=(window.policyRetries||0)+1;},success:r=>{successes.push(r);document.documentElement.classList.remove('soduwork-auth-pending');gate.hidden=true;}});
      view.setPolicy(Object.assign({},policy,${JSON.stringify(options)}));calls.length=0;successes.length=0;`);
    if (mode) await click('[data-auth-mode="' + mode + '"]');
  }
  app.whenReady().then(async () => {
    const fixture = path.join(temp, 'fixture.html');
    const sheets = ['theme/variables.css', 'components/client-auth/client-auth.css', 'components/client-auth/account-center.css', 'components/client-auth/personal-account.css'];
    fs.writeFileSync(fixture, '<!doctype html><html><head><meta charset="utf-8"><base href="' + pathToFileURL(client + path.sep).href + '">' + sheets.map(file => '<link rel="stylesheet" href="' + pathToFileURL(path.join(client, file)).href + '">').join('') + '</head><body><div id="gate" class="soduwork-auth-gate"></div></body></html>');
    win = new BrowserWindow({ show: false, width: 1180, height: 880, useContentSize: true, webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    win.webContents.debugger.attach('1.3');
    win.webContents.on('console-message', (_event, details) => {
      if (details?.level === 'error') process.stderr.write('Renderer: ' + details.message + '\n');
    });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (request, cb) => { report.networkRequests.push(request.url); cb({ cancel: true }); });
    await win.loadFile(fixture);
    await js(`window.errors=[];window.calls=[];window.successes=[];window.gate=document.querySelector('#gate');gate.id='soduWorkClientAuthGate';
      addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
      window.user={id:'fixture-user',username:'fixture',displayName:'小舟',email:'fixture@example.test',emailVerified:true,hasPassword:true};
      window.policy={allowSelfRegistration:true,mailReady:true,passwordMinLength:8,requiredConsentVersions:{terms:'v1',privacy:'v1'},legalDocuments:[{key:'terms',title:'用户协议',version:'v1',content:'这是隔离夹具的用户协议内容。'},{key:'privacy',title:'隐私政策',version:'v1',content:'这是隔离夹具的隐私政策内容。'}]};
      window.failMail=false;window.holdMail=false;window.failDeviceRemove=false;window.devices=[{id:'current',name:'当前电脑',platform:'Windows',current:true,active:true},{id:'other',name:'另一台电脑',platform:'Windows',current:false,active:true},{id:'history',name:'历史电脑',platform:'macOS',current:false,active:false}];
      window.SoduWorkAPI={hubBase:()=> 'http://fixture.invalid',clientAuthSnapshot:()=>({user}),clientAuthMe:async()=>({user}),
      clientLogin:async payload=>{calls.push({operation:'legacyLogin',payload});return {ok:true,user};},
      clientAccountAction:async(action,payload)=>{calls.push({operation:action,payload});
        if(action==='emailChallenge'){if(failMail)return {ok:false,error:'邮件服务暂不可用',status:503};if(holdMail)return new Promise(resolve=>window.finishMail=resolve);return {ok:true,challengeId:'fixture-challenge',expiresIn:300,retryAfter:60};}
        return {ok:true,user,session:'fixture-short',created:action==='register'};},
      clientAccountRequest:async(operation,payload)=>{calls.push({operation,payload});
        if(operation==='profile'){user={...user,...payload,avatarUrl:payload.avatarDataUrl??user.avatarUrl};return {user};}
        if(operation==='devices'){if(window.failNextDeviceRead){window.failNextDeviceRead=false;return {ok:false,error:'设备列表加载失败',status:503};}return {items:devices};}
        if(operation==='challenge')return {ok:true,challengeId:'sensitive-challenge',expiresIn:300,retryAfter:60};
        if(operation==='verification')return {verificationToken:'fixture-one-use-'+payload.purpose,expiresIn:300};
        if(operation==='revokeDevice'){if(failDeviceRemove)return {ok:false,error:'删除设备失败，请重试',status:503};if(window.holdDeviceRemove)return new Promise(resolve=>window.finishDeviceRemove=()=>{devices=devices.filter(x=>x.id!==payload.deviceId);resolve({ok:true,logoutRequired:false});});devices=devices.filter(x=>x.id!==payload.deviceId);if(window.failDeviceReloadOnce){window.failDeviceReloadOnce=false;window.failNextDeviceRead=true;}return {ok:true,logoutRequired:false};}
        if(operation==='privacy')return {documents:policy.legalDocuments,deletionScopeSummary:'注销后团队业务记录按必要范围保留，本机对话需自行管理。',consents:[{document:'privacy',version:'v1',acceptedAt:'2026-10-23'}],requests:[{id:'oversized-export',kind:'export',status:'failed',errorCode:'EXPORT_TOO_LARGE'}]};
        if(operation==='export')return {id:'fixture-export',status:'queued'};
        if(operation==='exportStatus')return {id:'fixture-export',status:'completed',filename:'account-export.zip'};
        if(operation==='email'||operation==='deletion')return {ok:true,logoutRequired:true};
        throw Error('Unexpected API '+operation);},
      clientAccountExportDownload:async id=>{calls.push({operation:'download',payload:{id}});return new Blob(['fixture export'],{type:'application/zip'});},
      clientLogout:()=>new Promise(resolve=>{calls.push({operation:'logout'});window.finishLogout=resolve;})};
      window.ClientAuth={updateIdentity:next=>{user=next},changePassword:()=>calls.push({operation:'changePassword'}),logout:()=>calls.push({operation:'logoutMenu'})};void 0;`);
    for (const file of ['account-ui.js', 'email-auth.js', 'account-verification.js', 'account-center.js']) await js(fs.readFileSync(path.join(client, 'components/client-auth', file), 'utf8') + '\n;void 0;');
    await fresh();
    await js("new Promise((resolve,reject)=>{const image=document.querySelector('.ac-brand img');if(image.naturalWidth)return resolve();image.onload=()=>resolve();image.onerror=()=>reject(Error('Brand image failed to load'));})");
    await js('view.setBusy(true);view.setPolicy({...policy,mailReady:false});view.setBusy(false)');
    assert.equal(await js("document.querySelector('[data-auth-password]').hidden"), false);
    assert.match(await js("document.querySelector('[data-mail-message]').textContent"), /管理员尚未配置或启用邮件服务/);
    record('mail-unavailable policy during boot falls back to password login with administrator guidance');
    await js('view.setPolicy({allowSelfRegistration:true,passwordMinLength:8})');
    assert.match(await js("document.querySelector('[data-mail-message]').textContent"), /服务版本不支持邮箱验证/);
    await click('[data-recheck-policy]'); assert.equal(await js('policyRetries'), 1);
    record('old Hub policy has a version explanation and clickable recheck action');
    await fill('#soduWorkAuthAccount', 'old@example.test'); await fill('#soduWorkAuthPassword', 'fixture-old-password'); await click('[type="submit"]');
    assert.equal(await js('calls.at(-1).operation'), 'legacyLogin');
    record('old Hub email-shaped password login uses its existing login endpoint'); await fresh();
    await js("document.documentElement.style.setProperty('--accent','#7955b8');document.documentElement.style.setProperty('--accent-hover','#6745a3');document.documentElement.style.setProperty('--accent-soft','#f1ecf8');");
    await shot('email-login-purple');
    await click('.ac-auth-footer [data-legal="privacy"]'); await wait("document.querySelector('.ac-legal-copy')?.textContent.includes('隐私政策内容')");
    assert.equal(await js("getComputedStyle(document.querySelector('.ac-legal')).visibility"), 'visible');
    await shot('legal-dialog'); await click('.ac-legal [data-ac-close]'); record('privacy document is visible and operable inside auth gate');
    await click('[type="submit"]'); assert.equal(await js('calls.length'), 0); record('invalid email never sends or authenticates');
    await fill('#soduWorkAuthAccount', 'first@example.test'); await js('failMail=true'); await click('[data-send-code]');
    await wait("document.querySelector('.soduwork-auth-status').textContent.includes('邮件服务')");
    assert.equal(await js("document.querySelector('[data-send-code]').disabled"), false); record('SMTP unavailable does not start success cooldown');
    await js('failMail=false'); await click('[data-send-code]');
    assert.equal(await js("document.querySelector('[data-send-code]').disabled"), true); record('accepted challenge applies resend cooldown');
    await fill('#acEmailCode', '123456'); await click('[type="submit"]');
    assert.equal(await js('successes.length'), 1); assert.equal(await js('calls.at(-1).operation'), 'emailCode'); record('six-digit paste and email code login');
    await fresh('register'); await fill('#soduWorkAuthAccount', 'new@example.test'); await click('[data-send-code]'); await fill('#acEmailCode', '123456');
    await fill('#soduWorkAuthPassword', 'long-fixture-password'); await fill('#acConfirmPassword', 'long-fixture-password');
    await click('[type="submit"]'); assert.equal(await js("calls.some(x=>x.operation==='register')"), false);
    assert.match(await js("document.querySelector('.soduwork-auth-status.is-error').textContent"), /请阅读并同意/); record('registration requires explicit legal consent');
    await click('#acConsent');
    assert.equal(await js("document.querySelector('.soduwork-auth-status').textContent"), '');
    assert.equal(await js("document.querySelector('.soduwork-auth-status').classList.contains('is-error')"), false);
    record('accepting valid agreements immediately clears only the consent validation error'); await shot('registration-purple');
    await fill('#acConfirmPassword', 'different-fixture-password'); await click('[type="submit"]');
    const passwordError = await js("document.querySelector('.soduwork-auth-status.is-error').textContent"); assert.match(passwordError, /密码不一致/);
    await click('#acConsent'); await click('#acConsent');
    assert.equal(await js("document.querySelector('.soduwork-auth-status.is-error').textContent"), passwordError);
    assert.equal(await js("calls.some(x=>x.operation==='register')"), false); record('agreement changes preserve unrelated password validation errors');
    await fill('#acConfirmPassword', 'long-fixture-password');
    assert.deepEqual(await js("({consent:document.querySelector('#acConsent').checked,passwordsMatch:document.querySelector('#soduWorkAuthPassword').value===document.querySelector('#acConfirmPassword').value,codeReady:/^[0-9]{6}$/.test(document.querySelector('#acEmailCode').value)})"),
      { consent: true, passwordsMatch: true, codeReady: true });
    await click('[type="submit"]');
    assert.deepEqual(await js("calls.find(x=>x.operation==='register').payload.consents"), { terms: 'v1', privacy: 'v1' }); record('registration submits exact legal versions and enters workspace');
    await fresh('resetPassword'); await fill('#soduWorkAuthAccount', 'reset@example.test'); await click('[data-send-code]'); await fill('#acEmailCode', '123456');
    await fill('#soduWorkAuthPassword', 'reset-fixture-password'); await fill('#acConfirmPassword', 'reset-fixture-password'); await click('[type="submit"]');
    await wait("document.querySelector('.soduwork-auth-status').textContent.includes('已重置')");
    assert.equal(await js("document.querySelector('[data-auth-password]').hidden"), false); assert.equal(await js('successes.length'), 0); record('password reset returns to login without claiming a session');
    await fresh('password'); await fill('#soduWorkAuthAccount', 'legacy.employee'); await fill('#soduWorkAuthPassword', 'fixture-password'); await click('[type="submit"]');
    assert.equal(await js('calls.at(-1).operation'), 'legacyLogin'); record('existing non-email account remains supported');
    await fresh('password'); await fill('#soduWorkAuthAccount', 'legacy.email@example.test'); await fill('#soduWorkAuthPassword', 'fixture-password'); await click('[type="submit"]');
    assert.equal(await js('calls.at(-1).operation'), 'password'); assert.equal(await js('successes.length'), 1); record('email-shaped legacy username uses the password compatibility endpoint');
    await fresh(); await fill('#soduWorkAuthAccount', 'late@example.test'); await js('holdMail=true'); await click('[data-send-code]');
    await fill('#soduWorkAuthAccount', 'other@example.test'); await js("holdMail=false;finishMail({ok:true,challengeId:'stale',expiresIn:300,retryAfter:60})"); await frames();
    await fill('#acEmailCode', '123456'); await click('[type="submit"]');
    assert.equal(await js('successes.length'), 0); record('late email challenge cannot bind to edited email');
    await js("document.documentElement.classList.remove('soduwork-auth-pending');gate.hidden=true;AccountCenter.open();"); await frames();
    assert.equal(await js("document.querySelectorAll('.ac-center [data-tab]').length"), 3);
    assert.equal(await js("document.querySelector('.ac-center [data-tab=security]').getAttribute('aria-selected')"), 'true');
    assert.equal(await js("document.querySelector('.ac-center [data-tab=profile]')"), null);
    await js('AccountCenter.openProfileEditor();void 0;'); await frames();
    assert.equal(await js("getComputedStyle(document.querySelector('.ac-profile-editor .ac-profile-avatar')).borderRadius"), '50%');
    assert.equal(await js("document.querySelector('.ac-profile-editor input[type=file]').accept"), 'image/png,image/jpeg,image/webp');
    await js(`(()=>{const raw=atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=');const bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));const file=new File([bytes],'avatar.png',{type:'image/png'});const transfer=new DataTransfer();transfer.items.add(file);const input=document.querySelector('.ac-profile-editor input[type=file]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await wait("!!document.querySelector('.ac-profile-editor .ac-profile-avatar img')");
    await fill('.ac-profile-editor [name="displayName"]', '新的昵称'); await click('.ac-profile-editor [type="submit"]');
    await wait("!document.querySelector('.ac-profile-editor') && user.displayName==='新的昵称'");
    assert.equal(await js('user.displayName'), '新的昵称'); record('personal nickname saves through the profile editor modal');
    assert.equal(await js("calls.find(x=>x.operation==='profile').payload.avatarDataUrl.startsWith('data:image/png;base64,')"), true); record('profile editor center-crops and submits a normalized circular avatar asset');
    await shot('account-profile-purple');
    // Reuse the existing native-theme dark compatibility palette, not a new
    // product theme. Built-in skins currently have no standalone dark preset.
    const darkTokens = { '--bg-0':'#20242a','--bg-1':'#272c33','--bg-2':'#343b44','--bg-3':'#404955',
      '--ink':'#eff3f8','--ink-2':'#dce3ed','--ink-3':'#aebdcc','--ink-4':'#aebdcc','--line':'rgba(220,230,245,.12)',
      '--line-3':'rgba(220,230,245,.2)','--accent':'#75b4f6','--accent-hover':'#8bc6ff','--accent-soft':'rgba(117,180,246,.12)',
      '--accent-soft-2':'rgba(117,180,246,.2)' };
    const originalStyle = await js('document.documentElement.style.cssText');
    await js(`Object.entries(${JSON.stringify(darkTokens)}).forEach(([key,value])=>document.documentElement.style.setProperty(key,value));document.documentElement.dataset.theme='custom-night';void 0;`);
    assert.equal(await js("getComputedStyle(document.querySelector('.ac-center .ac-dialog')).backgroundColor"), 'rgb(32, 36, 42)');
    await js('AccountCenter.openProfileEditor();void 0;'); await frames();
    assert.equal(await js("getComputedStyle(document.querySelector('.ac-profile-editor [name=displayName]')).color"), 'rgb(239, 243, 248)');
    await shot('account-profile-dark'); record('account page follows existing dark compatibility theme tokens');
    await js("document.querySelector('.ac-profile-editor [data-ac-cancel]').click();void 0;"); await frames();
    await js(`document.documentElement.style.cssText=${JSON.stringify(originalStyle)};delete document.documentElement.dataset.theme;void 0;`);
    await click('[data-tab="devices"]'); await wait("document.querySelectorAll('.ac-device-list .ac-setting-row').length===3");
    assert.equal(await js("document.querySelector('.ac-device-list .ac-setting-row').querySelectorAll('button').length"), 0, 'The currently signed-in device must not expose a logout or delete action');
    assert.equal(await js("document.querySelector('[data-device-id=history] [data-device-remove]').disabled"), false);
    assert.equal(await js("document.querySelector('[data-device-id=other] [data-device-remove]').disabled"), false);
    record('current device has no action and both active and historical other devices can be deleted');
    await shot('login-devices-purple');
    await click('[data-device-id=history] [data-device-remove]'); await click('.ac-verify [data-ac-close]');
    assert.equal(await js("document.querySelectorAll('.ac-device-list .ac-setting-row').length"), 3);
    assert.equal(await js("calls.some(x=>x.operation==='revokeDevice')"), false);
    assert.equal(await js("document.querySelector('[data-device-id=history] [data-device-remove]').disabled"), false);
    record('cancelling device identity verification keeps the historical record and restores its action');
    await js('failDeviceRemove=true');
    await click('[data-device-id=history] [data-device-remove]'); await fill('.ac-verify [name="password"]', 'fixture-password'); await click('.ac-verify [type="submit"]');
    await wait("document.querySelector('.ac-center-content .ac-status').textContent.includes('删除设备失败')");
    assert.equal(await js("document.querySelectorAll('.ac-device-list .ac-setting-row').length"), 3);
    assert.equal(await js("document.querySelector('[data-device-id=history] [data-device-remove]').disabled"), false);
    assert.equal(await js("calls.some(x=>x.operation==='logout')"), false);
    record('failed device deletion keeps the record, current session and retry action');
    await js('failDeviceRemove=false');
    await click('[data-device-id=history] [data-device-remove]'); await fill('.ac-verify [name="password"]', 'fixture-password'); await click('.ac-verify [type="submit"]');
    await wait("document.querySelectorAll('.ac-device-list .ac-setting-row').length===2");
    assert.equal(await js("document.querySelector('[data-device-id=history]')"), null);
    await click('[data-tab="security"]'); await click('[data-tab="devices"]');
    await wait("document.querySelectorAll('.ac-device-list .ac-setting-row').length===2");
    assert.equal(await js("document.querySelector('[data-device-id=history]')"), null);
    record('historical device deletion remains absent after reloading device records');
    await js("devices.push({id:'navigating',name:'待删除电脑',platform:'Windows',current:false,active:true});window.holdDeviceRemove=true;void 0;");
    await click('[data-tab="security"]'); await click('[data-tab="devices"]');
    await wait("document.querySelectorAll('.ac-device-list .ac-setting-row').length===3");
    await click('[data-device-id=navigating] [data-device-remove]'); await fill('.ac-verify [name="password"]', 'fixture-password'); await click('.ac-verify [type="submit"]');
    await wait("!document.querySelector('.ac-verify')");
    assert.equal(await js('typeof window.finishDeviceRemove'), 'function');
    await click('[data-tab="security"]'); await click('[data-tab="devices"]');
    await wait("document.querySelectorAll('.ac-device-list .ac-setting-row').length===3");
    await js('window.holdDeviceRemove=false;window.finishDeviceRemove();void 0;');
    await wait("document.querySelectorAll('.ac-device-list .ac-setting-row').length===2");
    assert.equal(await js("document.querySelector('[data-device-id=navigating]')"), null);
    assert.equal(await js('SoduWorkAPI.clientAuthSnapshot().user.id'), 'fixture-user');
    record('device deletion completed during tab navigation removes the record from the current device page');
    await js('window.failDeviceReloadOnce=true');
    await click('[data-device-id=other] [data-device-remove]'); await fill('.ac-verify [name="password"]', 'fixture-password'); await click('.ac-verify [type="submit"]');
    await wait("document.querySelectorAll('.ac-device-list .ac-setting-row').length===1");
    await wait("document.querySelector('.ac-center-content .ac-status').textContent.includes('刷新')");
    assert.match(await js("document.querySelector('.ac-center-content .ac-status').textContent"), /已删除/);
    assert.doesNotMatch(await js("document.querySelector('.ac-center-content .ac-status').textContent"), /删除设备失败/);
    assert.equal(await js("document.querySelector('[data-device-id=current]').querySelectorAll('button').length"), 0);
    assert.equal(await js("calls.find(x=>x.operation==='revokeDevice').payload.verificationToken"), 'fixture-one-use-devices');
    assert.equal(await js("calls.some(x=>x.operation==='logout')"), false);
    assert.equal(await js('SoduWorkAPI.clientAuthSnapshot().user.id'), 'fixture-user');
    record('other active device deletion requires a purpose token and preserves the current session');
    await click('[data-tab="security"]'); await click('[data-tab="devices"]');
    await wait("document.querySelectorAll('.ac-device-list .ac-setting-row').length===1");
    assert.equal(await js("document.querySelector('[data-device-id=other]')"), null);
    record('a failed list refresh after successful deletion never restores the removed row or reports deletion failure');
    await click('[data-tab="privacy"]'); await wait("!!document.querySelector('[data-delete]')");
    assert.equal(await js("document.querySelector('.ac-consent-records')"), null);
    assert.equal(await js("document.querySelector('[data-export]')"), null);
    assert.ok(await js("!!document.querySelector('.ac-danger-row')"));
    assert.match(await js("document.querySelector('.ac-data-note').textContent"), /注销后团队业务记录/);
    assert.equal(await js("calls.some(x=>['export','exportStatus','download'].includes(x.operation))"), false);
    record('privacy page keeps policy, retention scope and account deletion while removing redundant consent/export blocks');
    await shot('privacy-data-purple');
    win.setContentSize(390, 760); await frames(); await shot('privacy-data-narrow');
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true); record('narrow account page has no horizontal overflow');
    win.setContentSize(1180, 880); await frames();
    await click('[data-tab="security"]'); await click('[data-email-change]'); await fill('.ac-email-change [name="email"]', 'changed@example.test');
    await click('.ac-email-change [data-send]'); await fill('.ac-email-change [name="code"]', '123456'); await click('.ac-email-change [type="submit"]');
    await fill('.ac-verify [name="password"]', 'fixture-password'); await click('.ac-verify [type="submit"]'); await frames();
    assert.equal(await js("calls.find(x=>x.operation==='email').payload.verificationToken"), 'fixture-one-use-change_email'); record('email change needs new-mail code plus current-account verification');
    await js("document.querySelectorAll('.ac-mask').forEach(x=>x.remove());AccountCenter.open('privacy');"); await frames();
    await wait("!!document.querySelector('[data-delete]')"); await click('[data-delete]');
    await click('.ac-deletion [data-ac-cancel]');
    assert.equal(await js("document.querySelector('.ac-deletion')"), null);
    assert.equal(await js("calls.some(x=>x.operation==='deletion')"), false); record('cancelling deletion leaves the account unchanged');
    await click('[data-delete]'); await fill('.ac-deletion input', '错误确认'); await click('.ac-deletion [type="submit"]');
    assert.equal(await js("calls.some(x=>x.operation==='deletion')"), false); record('deletion rejects incomplete confirmation before verification');
    await fill('.ac-deletion input', '注销账号'); await click('.ac-deletion [type="submit"]');
    await js("document.querySelector('.ac-deletion form').requestSubmit();void 0;");
    assert.equal(await js("document.querySelectorAll('.ac-verify').length"), 1);
    await click('.ac-verify [data-ac-close]');
    assert.equal(await js("document.querySelector('.ac-deletion [type=submit]').disabled"), false);
    assert.equal(await js("calls.some(x=>x.operation==='deletion')"), false); record('repeated submission opens one identity proof; cancelling it restores the confirmation');
    await click('.ac-deletion [type="submit"]'); await fill('.ac-verify [name="password"]', 'fixture-password'); await click('.ac-verify [type="submit"]'); await frames();
    assert.equal(await js("calls.find(x=>x.operation==='deletion').payload.verificationToken"), 'fixture-one-use-delete_account'); record('deletion submits one-use token and does not claim cloud data already erased');
    await js("user={...user,id:'another-user'};window.dispatchEvent(new Event('soduwork-data-scope-changed'));void 0;");
    assert.equal(await js("document.querySelectorAll('.ac-mask').length"), 0); record('account transition closes stale personal and sensitive dialogs');
    await js(`document.body.insertAdjacentHTML('beforeend', '<section id="personalAccountPanel" class="panel personal-account-panel"><header class="personal-account-head"><h1>个人账户</h1></header><div class="personal-account-body"><div id="personalAccountSummary" class="personal-account-summary"></div><div id="personalAccountContent" class="personal-account-content ac-center"></div><section class="personal-account-device" hidden><h2>当前设备</h2><input id="boxNameInput"><button id="boxNameSave">保存</button><p id="boxBindNote"></p></section></div></section>');
      window.WorkspaceHost={open:(view,payload)=>view==='account' ? AccountCenter.openInPanel(payload?.tab||'security') : AccountCenter.closePanel()};
      user={id:'fixture-user',username:'fixture',displayName:'小舟',email:'fixture@example.test',emailVerified:true,hasPassword:true};void 0;`);
    await js('AccountCenter.open();void 0;'); await frames();
    assert.equal(await js("document.querySelector('#personalAccountPanel').classList.contains('show')"), true);
    assert.equal(await js("document.querySelectorAll('#personalAccountContent [data-tab]').length"), 3);
    assert.equal(await js("document.querySelector('#personalAccountContent [data-tab=security]').getAttribute('aria-selected')"), 'true');
    assert.equal(await js("document.querySelector('#personalAccountContent [data-tab=profile]')"), null);
    assert.equal(await js("document.querySelector('.ac-account-id-value').textContent"), 'fixture-user');
    await click('#personalAccountContent [data-tab=devices]'); await wait("document.querySelectorAll('#personalAccountContent .ac-device-list .ac-setting-row').length===1");
    assert.equal(await js("document.querySelector('#personalAccountPanel .personal-account-device').hidden"), false);
    record('workspace personal account mounts the same three management tabs and keeps device settings on the device tab');
    await js('AccountCenter.closePanel();void 0;');
    assert.equal(await js("document.querySelector('#personalAccountPanel').classList.contains('show')"), false);
    assert.equal(await js("document.querySelector('#personalAccountContent').childElementCount"), 0);
    record('leaving personal account clears its content and summary before another workspace page opens');
    report.errors = await js('errors'); assert.deepEqual(report.errors, []); assert.deepEqual(report.networkRequests, []);
    report.ok = true;
  }).catch(error => { report.error = String(error.stack || error); process.stderr.write(report.error + '\n'); }).finally(() => {
    report.sourcesAtEnd = sourceManifest.snapshot(); report.sourceChangesDuringRun = sourceManifest.changed(report.sourcesAtStart, report.sourcesAtEnd);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    if (win && !win.isDestroyed()) win.destroy();
    process.stdout.write(JSON.stringify({ ok: report.ok, cases: report.cases.length, report: path.join(out, 'report.json') }) + '\n');
    app.exit(report.ok ? 0 : 1);
  });
}
