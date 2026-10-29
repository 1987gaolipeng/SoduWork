'use strict';
// Real renderer clicks with an isolated capability boundary; no model or user files.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CHROME_CRASHPAD_PIPE_NAME',
    'CHROME_CRASHPAD_PIPE_HANDLE', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_DEVEL_SANDBOX']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { pathToFileURL } = require('node:url'), assert = require('node:assert/strict');
  const client = path.resolve(__dirname, '..'), out = path.resolve(client, '../outputs/permission-picker');
  fs.mkdirSync(out, { recursive: true });
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-permission-picker-')));
  const report = { ok: false, cases: [], errors: [] }; let win;
  const read = file => fs.readFileSync(path.join(client, file), 'utf8');
  const js = code => win.webContents.executeJavaScript(code, true);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(code, timeout = 5000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await js(code)) return; await delay(30); }
    throw Error('Timed out: ' + code);
  }
  async function click(selector) {
    const point = await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled||!el.checkVisibility())throw Error('Unavailable: '+${JSON.stringify(selector)});el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
    await delay(140);
  }
  async function shot(name) { await delay(160);fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1200, height: 850,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) report.errors.push(message); });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_r, cb) => cb({ cancel: true }));
    const css = ['theme/variables.css', 'components/panels/panels-base.css', 'components/panels/agent-brand.css',
      'components/panels/panels-chat.css', 'components/panels/work-composer.css', 'components/panels/access-controls.css'];
    const fixture = path.join(out, 'fixture.html');
    fs.writeFileSync(fixture, '<!doctype html><html><head><meta charset="utf-8"><base href="' +
      pathToFileURL(client + path.sep).href + '">' + css.map(f => '<link rel="stylesheet" href="' + f + '">').join('') +
      '<style>body{margin:0;font-family:var(--font-ui)}#composePanel{position:fixed;inset:0;display:block}.cp-body{display:flex;align-items:center;justify-content:center;min-height:100vh}.cp-task{width:min(900px,calc(100vw - 40px))}.cp-mid{display:block;padding:0!important}.cp-chat{display:none}.cp-hero,.cp-hero-note{display:none}*{box-sizing:border-box}</style></head><body></body></html>');
    await win.loadFile(fixture);
    await js(`window.calls=[];window.waiters=[];window.sent=[];window.notices=[];
      window.support={supported:true,schema:'soduwork.access-policy/v1',modes:['standard','readonly','full']};
      window.petSay=message=>notices.push(message);
      window.soduWorkAPI={conversationSession:{workdir:async()=>({ok:true,dir:'C:/isolated'}),setMode:async()=>({ok:true,mode:'full'}),capabilities:async()=>({ok:true,items:[]}),
        confirmNewChatAccess:async()=>({ok:true,consentId:'picker-fixture-consent'}),revokeNewChatAccess:async()=>({ok:true}),
        runtimes:async()=>({ok:true,runtimes:[{id:'pi',displayName:'Pi',accessControl:support},{id:'qwen',displayName:'Qwen Code',accessControl:support}]}),
        probe:id=>new Promise(resolve=>{calls.push(id);waiters.push({id,resolve});})}};
      window.SoduWorkAPI={myModels:async()=>({usable:[]})};
      window.attachmentGate=null;window.attachmentStarted=false;
      window.ConversationAttachments={create:()=>({names:()=>[],has:()=>false,refs:()=>{attachmentStarted=true;return attachmentGate||Promise.resolve([]);},clear:()=>{},files:()=>[],add:()=>{}})};
      window.NativeChat={reset:()=>{},hasSession:()=>false,enter:async(text,id,options)=>{sent.push({text,id,options});return true;}};void 0;`);
    for (const file of JSON.parse(read('core/locales/manifest.json'))) await js(read('core/locales/' + file));
    for (const file of ['core/i18n-dom.js', 'core/i18n.js']) await js(read(file));
    for (const file of ['agent-brand.js', 'work-composer.js', 'panels-compose-runtime.js', 'panels-compose-capabilities.js',
      'panels-compose-work-actions.js', 'compose-surface.js', 'panels-compose.js']) await js(read('components/panels/' + file) + '\nvoid 0;');
    await js('SoduWorkI18n.setLocale("zh-CN");openComposePanel();void 0;');
    await until('waiters.length===1');
    assert.equal(await js('document.querySelector("#cpPermission .wc-chevron")'), null);
    await click('#cpPermission');
    assert.equal(await js('document.querySelector("#cpPermissionPop").checkVisibility()'), true);
    assert.equal(await js('document.querySelectorAll("#cpPermissionPop [data-mode]:disabled").length'), 3);
    assert.equal(await js('ComposeRuntime.accessSupported()'), false);
    report.cases.push('Real permission-button click opens while checking; no chevron and no catalog-only permission grant');
    await js('waiters.shift().resolve({ok:true});'); await until('ComposeRuntime.accessState()==="unsupported"');
    await shot('compatibility-zh');
    assert.ok(await js('document.querySelector("#cpPermissionStatus").textContent.includes("重启客户端")'));
    await click('#cpPermission'); await click('#cpPermission');
    assert.equal(await js('document.querySelector("#cpPermissionPop").checkVisibility()'), true);
    report.cases.push('An old capability response keeps the popup usable and explains compatibility access');
    await js('SoduWorkI18n.setLocale("en-US");'); await delay(60);
    assert.ok(await js('document.querySelector("#cpPermissionStatus").textContent.includes("restart")'));
    await click('#cpPermissionRetry');
    await js('void ComposeRuntime.refreshAccess();');
    assert.equal(await js('calls.length'), 2);
    await js('waiters.shift().resolve({ok:true,accessControl:support});'); await until('ComposeRuntime.accessSupported()');
    assert.equal(await js('document.querySelectorAll("#cpPermissionPop [data-mode]:disabled").length'), 0);
    await click('#cpPermissionPop [data-mode=full]');
    assert.equal(await js('document.querySelector("#cpPermissionName").textContent'), 'Full access');
    assert.equal(await js('document.querySelector("#cpPermission").getAttribute("aria-expanded")'), 'false');
    await js('document.querySelector("#cpInput").value="Isolated send";document.querySelector("#cpInput").dispatchEvent(new Event("input",{bubbles:true}));');
    await click('#cpGo'); await until('sent.length===1');
    assert.equal(await js('sent[0].options.accessMode'), 'full');
    assert.equal(await js('sent[0].options.accessConsentId'), 'picker-fixture-consent');
    report.cases.push('Retry is deduplicated; supported selection confirms at selection time and forwards the receipt on send (isolated consent boundary)');
    await js('openComposePanel({newSession:true});void 0;');
    await click('#cpPermission');
    await click('#cpPermissionPop [data-mode=readonly]');
    assert.equal(await js('document.querySelector("#cpPermissionName").textContent'), 'Read only');
    await click('#cpPermission'); await shot('supported-en');
    await js('void ComposeRuntime.refreshAccess();'); await until('waiters.length===1');
    await js('waiters.shift().resolve({ok:false,reason:"Isolated probe failure"});'); await until('ComposeRuntime.accessState()==="unavailable"');
    assert.equal(await js('document.querySelectorAll("#cpPermissionPop [data-mode]:disabled").length'), 3);
    await click('#cpPermissionRetry'); await until('waiters.length===1');
    await js('waiters.shift().resolve({ok:true,accessControl:{supported:true,schema:"future-schema"}});');
    await until('ComposeRuntime.accessState()==="unsupported"');
    report.cases.push('Probe failure and unknown capability versions keep access choices disabled without disabling the trigger');
    await click('#cpPermissionRetry'); await until('waiters.length===1');
    await until('ComposeRuntime.accessState()==="unavailable"', 17000);
    await js('waiters.shift().resolve({ok:true,accessControl:support});'); await delay(100);
    assert.equal(await js('ComposeRuntime.accessSupported()'), false);
    await click('#cpPermissionRetry'); await js('waiters.shift().resolve({ok:true,accessControl:support});');
    await until('ComposeRuntime.accessSupported()');
    report.cases.push('A timed-out check can retry; its late successful response cannot enable permissions');
    for (const locale of ['zh-CN', 'en-US']) {
      await js('SoduWorkI18n.setLocale(' + JSON.stringify(locale) + ')');
      win.setSize(760, 800); await delay(160);
      const bounds = await js('(()=>{const e=document.querySelector("#cpPermissionPop"),r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,w:innerWidth,h:innerHeight};})()');
      assert.ok(bounds.left >= 0 && bounds.right <= bounds.w && bounds.top >= 0 && bounds.bottom <= bounds.h, JSON.stringify(bounds));
      await shot('picker-' + locale + '-small');
    }
    report.cases.push('Chinese/English popup fits a small window');
    await js('openComposePanel({newSession:true});window.attachmentGate=new Promise(resolve=>window.releaseAttachments=resolve);attachmentStarted=false;document.querySelector("#cpInput").value="Send during permission refresh";void 0;');
    await click('#cpGo'); await until('attachmentStarted');
    await click('#cpRuntime'); await click('[data-runtime=pi]'); await until('waiters.length===1');
    await js('releaseAttachments([]);'); await delay(100);
    assert.equal(await js('sent.length'), 1);
    await js('waiters.shift().resolve({ok:true,accessControl:support});'); await until('sent.length===2');
    assert.equal(await js('sent[1].options.accessMode'), 'standard');
    report.cases.push('Sending waits for a new current-Agent probe after attachment processing; default access never silently degrades to compatibility');
    report.missing = await js('SoduWorkI18n.getMissing()'); assert.deepEqual(report.missing, []);
    assert.deepEqual(report.errors, []); report.ok = true;
  }).catch(error => { report.error = error.stack; }).finally(() => {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));win?.destroy();app.exit(report.ok ? 0 : 1);
  });
}
