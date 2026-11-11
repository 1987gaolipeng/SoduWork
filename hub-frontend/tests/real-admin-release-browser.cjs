// Real browser -> HTTP -> production login/permissions/release routes -> fresh
// SQLite. Run after npm run build, with SODUWORK_TEST_PYTHON if necessary.
const { app, BrowserWindow, session } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-admin-release-'));
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
let hub, win, hubLog = '';
// A stalled renderer command must still release the disposable Hub process.
const deadline = setTimeout(() => { console.error('Admin E2E deadline exceeded'); hub?.kill(); app.exit(1); }, 75000);
const results = [], errors = [];
const progress = label => fs.appendFileSync(path.join(output,'progress.log'),label+'\n');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = code => win.webContents.executeJavaScript(code, true);
async function until(code, label) {
  for (let i = 0; i < 150; i++) { if (await js(code)) return; await sleep(50); }
  throw Error('Timed out: ' + label);
}
async function input(selector, value) {
  await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}))})()`);
}
async function login(username, password = 'fixture-password-only') {
  if (!await js('!!document.querySelector(".login-card")')) await js('document.querySelector(".public-nav-login").click()');
  await until('!!document.querySelector("[name=username]")', 'login form');
  await input('[name=username]', username);await input('[name=password]', password);
  await js('document.querySelector(".login-card").requestSubmit()');
}
async function choose(value) {
  await js('document.querySelector(".side-foot").click()');
  await until('!!document.querySelector(".profile-menu .locale-language-select .select-menu-trigger")', 'language picker');
  await js('document.querySelector(".profile-menu .locale-language-select .select-menu-trigger").click()');
  await until('!!document.querySelector(".profile-menu [role=option]")', 'language options');
  await js(`[...document.querySelectorAll('.profile-menu [role=option]')].find(el=>el.textContent.trim()===${JSON.stringify(value)}).click()`);
  await js('document.querySelector(".side-foot").click()');
}
app.whenReady().then(async () => {
  progress('starting backend');
  hub = spawn(process.env.SODUWORK_TEST_PYTHON || 'python', [path.join(__dirname, 'fixtures/admin-release-hub.py'), '--root', output], { windowsHide:true, env:{...process.env,PYTHONUTF8:'1'} });
  hub.stdout.on('data', chunk => { hubLog += chunk; });hub.stderr.on('data', chunk => { hubLog += chunk; });
  hub.on('error', error => { hubLog += String(error); });
  const ready = path.join(output, 'ready.json');
  for (let i = 0; i < 300 && !fs.existsSync(ready); i++) {
    if (hub.exitCode !== null) throw Error('Fixture failed: ' + hubLog);
    await sleep(100);
  }
  assert.ok(fs.existsSync(ready), 'Fixture startup: ' + hubLog);
  const { origin } = JSON.parse(fs.readFileSync(ready));
  progress('backend ready');
  const isolated = session.fromPartition('real-admin-release-' + Date.now());
  isolated.webRequest.onBeforeRequest((detail, done) => done({cancel:!detail.url.startsWith(origin + '/') && !detail.url.startsWith('data:')}));
  win = new BrowserWindow({show:false,width:1280,height:900,webPreferences:{session:isolated,offscreen:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  win.webContents.on('console-message', event => { if (/Uncaught|React error/.test(event.message)) errors.push(event.message); });
  await win.loadURL('about:blank');
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Page.enable');
  progress('browser created');
  await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {source:`Object.defineProperty(navigator,'languages',{get:()=>['zh-CN']});Object.defineProperty(navigator,'language',{get:()=>'zh-CN'});sessionStorage.setItem('soduwork-hub-screen','client-releases');`});
  progress('browser preferences set');
  await win.loadURL(origin + '/');
  progress('landing loaded');
  await until('!!document.querySelector(".public-nav-login")', 'real served landing');
  assert.equal(await js('document.documentElement.lang'), 'zh-CN');
  await login('fixture-publisher', 'wrong-fixture-password');
  await until('!!document.querySelector(".login-error")', 'invalid credential error');
  assert.ok(await js('document.querySelector(".login-error").textContent.includes("账号或密码")'));
  await login('fixture-publisher');
  await until('!!document.querySelector(".cr-list")', 'real release list');
  assert.ok(await js('document.querySelector(".cr-notes").textContent.includes("中文发布说明")'));
  assert.equal(await js('document.querySelectorAll(".cr-notes img").length'),0);
  results.push({name:'Chinese first visit, failed login and real publisher login/list/notes',ok:true});
  for (const [label,locale,summary] of [['English','en-US','English release notes'],['日本語','ja-JP','日本語の更新内容'],['한국어','ko-KR','한국어 업데이트']]) {
    await choose(label);
    await until(`document.documentElement.lang==='${locale}'`, 'translated page');
    assert.ok(await js(`document.querySelector('.cr-notes').textContent.includes(${JSON.stringify(summary)})`));
    await win.reload();await until('!!document.querySelector(".cr-list")','authenticated reload');
    assert.equal(await js('document.documentElement.lang'),locale);
    assert.ok(await js(`document.querySelector('.cr-notes').textContent.includes(${JSON.stringify(summary)})`));
    results.push({name:'manual locale and release notes persist',locale,ok:true});
  }
  const anonymous = await js(`fetch('/api/v1/admin/client-release-notes').then(r=>r.status)`);
  assert.equal(anonymous,401);
  await js('localStorage.clear();sessionStorage.clear()');await win.reload();
  await until('!!document.querySelector(".public-nav-login")','signed out');
  await login('fixture-reader');
  await until('!!localStorage.getItem("soduwork_hub_admin_token") && !document.querySelector(".login-card")','ordinary user login');
  assert.equal(await js('!!document.querySelector(".cr-list")'),false);
  const denied = await js(`fetch('/api/v1/admin/client-release-notes',{headers:{Authorization:'Bearer '+localStorage.getItem('soduwork_hub_admin_token')}}).then(async r=>({status:r.status,body:await r.json()}))`);
  assert.equal(denied.status,403);
  results.push({name:'anonymous401 and authenticated ordinary user403 from real permission dependency',ok:true});
  assert.deepEqual(errors,[]);
  const requests=JSON.parse(fs.readFileSync(path.join(output,'requests.json')));
  assert.ok(requests.some(r=>r.path==='/api/v1/admin/login'&&r.status===401));
  assert.ok(requests.some(r=>r.path==='/api/v1/admin/client-release-notes'&&r.status===200));
  assert.ok(requests.some(r=>r.path==='/api/v1/admin/client-release-notes'&&r.status===403));
  fs.writeFileSync(path.join(output,'browser-report.json'),JSON.stringify({ok:true,platform:process.platform,results,requests,errors},null,2));
  console.log(JSON.stringify({ok:true,output,results}));
}).catch(error=>{console.error(error);console.error(hubLog.slice(-5000));process.exitCode=1;}).finally(()=>{clearTimeout(deadline);win?.destroy();hub?.kill();app.exit(process.exitCode||0);});
