'use strict';
// Isolated UI fixtures; no real authorization, clipboard writes or browser navigation.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = {...process.env};
  for (const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','ELECTRON_NO_ATTACH_CONSOLE','CHROME_CRASHPAD_PIPE_NAME','CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron,[__filename],{env,windowsHide:true,stdio:'inherit'});
  const timer=setTimeout(()=>child.kill(),90000);child.on('exit',code=>{clearTimeout(timer);process.exitCode=code??1});
} else {
  const {app,BrowserWindow}=electron,fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
  const client=path.resolve(__dirname,'..'),output=path.resolve(client,'../outputs/codex-auth-dialog');
  fs.mkdirSync(output,{recursive:true});app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-codex-auth-')));
  const report={ok:false,boundary:'Production modal and full desktop styles with synthetic machine/auth responses. External network blocked.',cases:[],screenshots:[]};
  const read=file=>fs.readFileSync(path.join(client,file),'utf8');let win;
  const js=code=>win.webContents.executeJavaScript(code,true),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  async function until(code){for(let i=0;i<150;i++){if(await js(code))return;await wait(40)}throw Error('Timeout: '+code)}
  async function click(selector){await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});const p=await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled||!e.checkVisibility())throw Error('Unavailable control');const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);for(const type of ['mouseMove','mouseDown','mouseUp'])win.webContents.sendInputEvent({type,button:'left',clickCount:1,...p});await wait(90)}
  async function shot(name){await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});await wait(90);const file=path.join(output,name+'.png');fs.writeFileSync(file,(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());report.screenshots.push(file)}
  async function open(){await js("document.querySelector('#launch').focus();CodexAuthDialog.open({runnerId:'machine-a',machine:'王维的电脑',onProbe:()=>{probeCount++}});void 0;")}
  const state=value=>until(`document.querySelector('.codex-auth-dialog')?.dataset.state===${JSON.stringify(value)}`);
  app.whenReady().then(async()=>{
    win=new BrowserWindow({show:false,width:980,height:800,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
    win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_request,done)=>done({cancel:true}));
    await win.loadFile(path.join(__dirname,'fixtures/library.html'));
    await js(`const base=document.createElement('base');base.href=${JSON.stringify(require('node:url').pathToFileURL(client+path.sep).href)};document.head.append(base);void 0;`);
    const urls=[...read('desk.html').matchAll(/<link\s+rel=["']stylesheet["']\s+href=["']([^"']+)["']/g)].map(m=>require('node:url').pathToFileURL(path.join(client,m[1])).href);
    await js(`(async()=>{document.querySelectorAll('link[rel=stylesheet]').forEach(e=>e.remove());await Promise.all(${JSON.stringify(urls)}.map(href=>new Promise((resolve,reject)=>{const e=document.createElement('link');e.rel='stylesheet';e.href=href;e.onload=resolve;e.onerror=reject;document.head.append(e)})));document.body.innerHTML='<button id="launch">连接 Codex</button>';document.documentElement.dataset.skin='box';})()`);
    await js(`window.calls=[];window.opened=[];window.copied=[];window.probeCount=0;window.fixture={auth:'authed',flow:1,state:'waiting',cancelFails:false};Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>copied.push(value)}});window.soduWorkAPI={openExternal:async url=>{opened.push(url);return{ok:true}}};window.SoduWorkAPI={
      agentSetup:async()=>({machines:[{runnerId:'machine-a',agents:[{key:'codex',installed:true,auth:fixture.auth,authStatus:fixture.authStatus,state:fixture.auth==='unauthed'?'unauthed':'ready',loginAvailable:true,loginFlowVersion:fixture.flow,isolatedLoginAvailable:fixture.isolatedAvailable}]}]}),
      agentInstall:async(key,action,runnerId,options)=>{calls.push({key,action,runnerId,options});if(action==='login-cancel'){if(fixture.cancelFails)throw Error('synthetic network failure');if(options.jobId!=='runner|machine-a|job-a')throw Error('wrong job');fixture.state=fixture.cancelResult||'cancelled';return{jobId:options.jobId,cancelled:true,state:'cancelling'}}fixture.state=fixture.startState||'waiting';if(fixture.holdStart)await new Promise(resolve=>window.releaseStart=resolve);return{jobId:'runner|machine-a|job-a'}},
      agentJob:async()=>{const result={state:['succeeded','failed','expired','cancelled'].includes(fixture.state)?'done':'running',ok:fixture.state==='succeeded',lines:['Bearer NEVER_RENDER_THIS'],auth:fixture.noMetadata?undefined:{state:fixture.state,reason:fixture.reason,verificationUrl:fixture.url||'https://auth.openai.com/codex/device',userCode:fixture.code||'ABCD-EFGH',expiresAt:Math.floor(Date.now()/1000)+180}};if(fixture.holdPoll){fixture.holdPoll=false;await new Promise(resolve=>window.releasePoll=resolve)}return result}};void 0;`);
    await js(read('components/panels/codex-auth-dialog.js')+'\nvoid 0;');
    await open();await state('succeeded');assert.equal(await js('calls.length'),0);await shot('existing-login');await click('.codex-auth-primary');assert.equal(await js('document.activeElement.id'),'launch');
    assert.equal(await js('probeCount'),1);report.cases.push('Fresh existing login is reused without starting auth; explicit connection test and focus restoration');
    await js('fixture.isolatedAvailable=true;void 0;');await open();await state('succeeded');await click('.codex-auth-secondary');await state('ready');assert.equal(await js('calls.length'),0);assert.match(await js("document.querySelector('.codex-auth-primary').textContent"),/开始独立授权/);await shot('isolated-ready');await click('.codex-auth-primary');await state('waiting');assert.deepEqual(await js('calls.at(-1)'),{key:'codex',action:'login-isolated',runnerId:'machine-a',options:undefined});await js("fixture.state='succeeded';void 0;");await state('succeeded');assert.match(await js("document.querySelector('.codex-auth-description').textContent"),/新建对话/);await click('.codex-auth-close');await js('calls.length=0;fixture.isolatedAvailable=false;void 0;');
    report.cases.push('Independent authorization requires capability and two explicit choices; uses the original runner and explains new-chat scope');
    await js("fixture.auth='unauthed';fixture.authStatus='unknown';fixture.isolatedAvailable=true;void 0;");await open();await state('ready');
    assert.equal(await js('calls.length'),0);
    assert.match(await js("document.querySelector('.codex-auth-description').textContent"),/无法确认登录状态/);
    assert.equal(await js("document.querySelector('.codex-auth-primary').textContent"),'继续检查');
    await shot('unknown-check-ready');await click('.codex-auth-primary');await state('waiting');
    assert.equal(await js('calls.at(-1).action'),'login');
    await click('.codex-auth-secondary');await until("!document.querySelector('.codex-auth-dialog')");
    await js('calls.length=0;void 0;');
    report.cases.push('Unknown inventory status permits an explicit native recheck on the selected Runner; no authorization starts on opening');
    for(const reason of ['status_unavailable','access_denied']) {
      await js(`fixture.startState='failed';fixture.reason=${JSON.stringify(reason)};void 0;`);
      await open();await state('ready');assert.equal(await js('calls.length'),0);
      await click('.codex-auth-primary');await state('failed');
      assert.equal(await js("document.querySelector('.codex-auth-device').hidden"),true);
      assert.equal(await js('opened.length'),0);
      assert.equal(await js('calls.length'),1);
      assert.match(await js("document.querySelector('.codex-auth-description').textContent"),reason==='status_unavailable'?/无法确认登录状态/:/无法访问/);
      await click('.codex-auth-close');await js('calls.length=0;void 0;');
    }
    await js('delete fixture.startState;delete fixture.reason;void 0;');
    report.cases.push('Native unknown status and access denial remain failures with no authorization URL or code shown');
    await open();await state('ready');
    await click('.codex-auth-foot button:nth-child(2)');await state('ready');
    assert.equal(await js('calls.length'),0);
    await click('.codex-auth-primary');await state('waiting');
    assert.equal(await js('calls.at(-1).action'),'login-isolated');
    await click('.codex-auth-secondary');await until("!document.querySelector('.codex-auth-dialog')");
    await js('calls.length=0;fixture.isolatedAvailable=false;delete fixture.authStatus;void 0;');
    report.cases.push('Unknown native status offers explicit independent authorization without overwriting the original login or launching automatically');
    await js("fixture.auth='unauthed';void 0;");await open();await state('ready');assert.equal(await js('calls.length'),0);await shot('ready');
    await click('.codex-auth-primary');await state('waiting');assert.equal(await js('document.body.textContent.includes("NEVER_RENDER_THIS")'),false);
    await click('.codex-auth-copy');assert.deepEqual(await js('copied'),['ABCD-EFGH']);await click('.codex-auth-primary');assert.deepEqual(await js('opened'),['https://auth.openai.com/codex/device']);await shot('waiting-wide');
    report.cases.push('Explicit consent starts scoped login, copy/open use only public code and allowlisted URL; raw logs are absent');
    win.setSize(360,620);await wait(150);await shot('waiting-narrow');const bounds=await js("(()=>{const r=document.querySelector('.codex-auth-dialog').getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,w:innerWidth,h:innerHeight}})()");assert.ok(bounds.x>=10&&bounds.y>=10&&bounds.right<=bounds.w-10&&bounds.bottom<=bounds.h-10);
    await js("document.documentElement.dataset.theme='minimal';void 0;");await shot('waiting-minimal');await js("delete document.documentElement.dataset.theme;void 0;");
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await until("!document.querySelector('.codex-auth-dialog')");
    assert.deepEqual(await js('calls.at(-1)'),{key:'codex',action:'login-cancel',runnerId:'machine-a',options:{jobId:'runner|machine-a|job-a'}});
    report.cases.push('Narrow/themed sheet stays inside viewport; Escape cancels the original qualified job before closing');
    win.setSize(980,800);await open();await state('ready');await click('.codex-auth-primary');await state('waiting');await js("fixture.state='succeeded';void 0;");await state('succeeded');await shot('success');await click('.codex-auth-primary');
    report.cases.push('Structured success replaces the code and presents a clear completion action');
    for(const terminal of ['expired','failed']){await open();await state('ready');await click('.codex-auth-primary');await state('waiting');await js(`fixture.state=${JSON.stringify(terminal)};void 0;`);await state(terminal);await shot(terminal);assert.equal(await js("document.querySelector('.codex-auth-device').hidden"),true);await click('.codex-auth-primary');await state('ready');await click('.codex-auth-secondary')}
    report.cases.push('Expired and failed attempts remove stale codes and recheck login before retry');
    await js('fixture.flow=0;void 0;');const beforeOld=await js('calls.length');await open();await state('failed');assert.match(await js("document.querySelector('.codex-auth-description').textContent"),/更新/);assert.equal(await js('calls.length'),beforeOld);await click('.codex-auth-secondary');await js('fixture.flow=1;void 0;');
    report.cases.push('Old Runner without structured login capability offers update guidance without starting legacy auth');
    await open();await state('ready');await click('.codex-auth-primary');await state('waiting');await js('fixture.cancelFails=true;void 0;');await click('.codex-auth-secondary');await state('failed');assert.equal(await js("document.querySelector('.codex-auth-dialog').open"),true);await js('fixture.cancelFails=false;void 0;');await click('.codex-auth-secondary');await until("!document.querySelector('.codex-auth-dialog')");
    report.cases.push('Cancellation failure stays visible; retry cancellation closes only after confirmed terminal state');
    await js("fixture.holdPoll=true;fixture.cancelResult='succeeded';void 0;");await open();await state('ready');await click('.codex-auth-primary');await state('starting');await until('!!window.releasePoll');await click('.codex-auth-secondary');await state('succeeded');await js('releasePoll();void 0;');await wait(150);assert.equal(await js("document.querySelector('.codex-auth-dialog').dataset.state"),'succeeded');await click('.codex-auth-close');await js('delete fixture.cancelResult;void 0;');
    report.cases.push('Late waiting status cannot overwrite a newer terminal response during cancellation');
    await js('fixture.holdStart=true;void 0;');await open();await state('ready');await click('.codex-auth-primary');await state('starting');const beforeReceipt=await js('calls.length');await click('.codex-auth-secondary');await state('cancelling');assert.equal(await js('calls.length'),beforeReceipt);await js('releaseStart();void 0;');await until("!document.querySelector('.codex-auth-dialog')");assert.deepEqual(await js('calls.at(-1)'),{key:'codex',action:'login-cancel',runnerId:'machine-a',options:{jobId:'runner|machine-a|job-a'}});await js('fixture.holdStart=false;void 0;');
    report.cases.push('Cancellation during job creation waits for its receipt, then cancels that exact job');
    for(const file of JSON.parse(read('core/locales/manifest.json')))await js(read('core/locales/'+file)+'\nvoid 0;');await js(read('core/i18n.js')+'\nvoid 0;');await js("SoduWorkI18n.setLocale('en-US');void 0;");win.setSize(360,620);await open();await state('ready');await click('.codex-auth-primary');await state('waiting');await shot('waiting-english-narrow');assert.equal(await js("document.querySelector('.codex-auth-primary').textContent"),'Open official authorization page');assert.equal(await js("document.querySelector('.codex-auth-dialog').scrollWidth<=document.querySelector('.codex-auth-dialog').clientWidth"),true);
    await js("fixture.code='ABCDEF-GHIJKL';void 0;");await until("document.querySelector('.codex-auth-code').textContent==='ABCDEF-GHIJKL'");
    for(const width of [320,400,440]){win.setContentSize(width,620);await wait(120);await shot('waiting-english-'+width);assert.equal(await js('innerWidth'),width);assert.equal(await js("document.querySelector('.codex-auth-code-row').scrollWidth<=document.querySelector('.codex-auth-code-row').clientWidth"),true,'Maximum-length code and English copy fit at '+width);assert.equal(await js("document.querySelector('.codex-auth-dialog').scrollWidth<=document.querySelector('.codex-auth-dialog').clientWidth"),true)}
    for(let i=0;i<8;i++){win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});await wait(30);assert.equal(await js("!!document.activeElement.closest('.codex-auth-dialog')"),true)}
    await click('.codex-auth-secondary');await until("!document.querySelector('.codex-auth-dialog')");
    await js("fixture.auth='';fixture.isolatedAvailable=true;void 0;");await open();await state('ready');
    for(const width of [320,400,440]) {
      win.setContentSize(width,620);await wait(120);await shot('recovery-english-'+width);
      assert.equal(await js("document.querySelector('.codex-auth-dialog').scrollWidth<=document.querySelector('.codex-auth-dialog').clientWidth"),true);
      assert.equal(await js("document.querySelector('.codex-auth-foot').scrollWidth<=document.querySelector('.codex-auth-foot').clientWidth"),true);
    }
    await click('.codex-auth-close');await js("fixture.auth='unauthed';fixture.isolatedAvailable=false;SoduWorkI18n.setLocale('zh-CN');void 0;");win.setSize(980,800);
    report.cases.push('Production English translations fit a narrow window and native Tab focus stays within the modal');
    await js('fixture.holdStart=true;void 0;');await open();await state('ready');await click('.codex-auth-primary');await state('starting');const beforeScope=await js('calls.length');await js("dispatchEvent(new Event('soduwork-data-scope-changed'));releaseStart();void 0;");await wait(150);assert.equal(await js("!!document.querySelector('.codex-auth-dialog')"),false);assert.equal(await js('calls.length'),beforeScope);
    report.cases.push('Account switch removes the sheet and rejects delayed job receipts without requests under the new identity');
    report.ok=true;
  }).catch(error=>{report.error=error.stack||String(error)}).finally(()=>{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(win&&!win.isDestroyed())win.destroy();app.exit(report.ok?0:1)});
}
