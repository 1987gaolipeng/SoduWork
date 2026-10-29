'use strict';
// Exercise production cards, drawer and styles without contacting live services.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' })
    .on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
  const client = path.resolve(__dirname, '..'), out = path.resolve(client, '../outputs/agent-state-20261023');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-agent-state-'));
  app.setPath('userData', profile);
  const report = { ok: false, cases: [], errors: [] };
  let win;
  const js = s => win.webContents.executeJavaScript(s, true);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  app.whenReady().then(async () => {
    fs.mkdirSync(out, { recursive: true });
    win = new BrowserWindow({ show: false, width: 1280, height: 1000,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_r, done) => done({cancel:true}));
    const file = path.join(profile, 'state.html');
    fs.writeFileSync(file, '<!doctype html><html data-desk-panel="agents" data-window-menu=""><meta charset="utf-8"><base href="' + pathToFileURL(client + path.sep).href + '"><body></body></html>');
    await win.loadFile(file);
    const styles = Array.from(fs.readFileSync(path.join(client,'desk.html'),'utf8').matchAll(/<link rel="stylesheet" href="([^"]+)"/g), match => match[1]);
    for (const file of styles) {
      await js(`new Promise((resolve,reject)=>{const e=document.createElement('link');e.rel='stylesheet';e.href=${JSON.stringify(pathToFileURL(path.join(client,file)).href)};e.onload=()=>resolve(true);e.onerror=()=>reject(Error('Style failed'));document.head.appendChild(e)})`);
    }
    await js(`window.errors=[];addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));window.esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');window.petSay=()=>{};window.requests=[];window.loginCancelled=false;window.SoduWorkAPI={agentSetup:async()=>window.fixture,agentInstall:async(key,action,runner,options)=>{requests.push({key,action,runner,...(options?{options}:{})});if(action==='login-cancel'){loginCancelled=true;return{jobId:options.jobId,cancelled:true,state:'cancelling'}}return{jobId:action==='login'?'fixture-login':'fixture-job'}},agentJob:async id=>id==='fixture-login'?{state:loginCancelled?'done':'running',auth:{state:loginCancelled?'cancelled':'waiting',verificationUrl:'https://auth.openai.com/codex/device',userCode:'ABCD-EFGH',expiresAt:Date.now()/1000+180}}:{state:'done',ok:true,lines:['Fixture completed']}};void 0;`);
    for (const file of ['components/panels/agent-brand.js','components/panels/panels-agents.js','components/panels/codex-auth-dialog.js'])
      await js(fs.readFileSync(path.join(client,file),'utf8')+'\nvoid 0;');
    const agents = [
      {key:'opencode',name:'OpenCode',state:'missing',setupState:'missing',installed:false,present:false},
      {key:'harness2',name:'Google Harness²',state:'missing',setupState:'setup',installed:false,present:true,bundled:true,version:'0.1.0',why:'内置核心已就绪，需要准备 OpenCode 执行组件。'},
      {key:'qwen',name:'Qwen Code',state:'missing',setupState:'broken',installed:false,present:true,version:'0.25.0',runtimeIssue:'执行组件启动自检失败，请修复安装。'},
      {key:'codex',name:'Codex',state:'unauthed',auth:'unauthed',setupState:'unauthed',installed:true,present:true,version:'0.164.0',loginAvailable:true,loginFlowVersion:1},
      {key:'codex-harness',name:'Codex Harness',state:'ready',setupState:'ready',installed:true,present:true,version:'2.2.2'},
      {key:'pi',name:'Pi',state:'ready',setupState:'ready',installed:true,present:true,bundled:true,version:'0.84.3',probe:{ok:false,at:100,historical:true,detail:'Earlier connection failed'}},
      {key:'dsh',name:'DeepSeek Harness',state:'nollm',setupState:'nollm',installed:true,present:true,version:'0.4.39',modelPick:true}
    ].map(a=>({...a,modelPick:!['codex'].includes(a.key),blurb:'按当前执行机器的安装与配置状态显示。'}));
    await js(`window.fixture=${JSON.stringify({modelCount:1,models:[{name:'fixture-model'}],machines:[{runnerId:'fixture-runner',label:'测试电脑',env:{ok:true,node:'24',npm:'11'},agents}]})};openAgentsPanel();void 0;`);
    await delay(180);
    for (const width of [1280,600]) {
      win.setSize(width,1000); await delay(100);
      const cards = await js(`Array.from(document.querySelectorAll('.ag-row')).map(e=>({state:e.dataset.agstate,badges:e.querySelectorAll('.ag-row-st').length,flags:e.querySelectorAll('.ag-flag').length,overflow:e.scrollWidth>e.clientWidth+1,action:e.querySelector('.ag-quick button').textContent}))`);
      assert.equal(cards.length,7);
      assert.ok(cards.every(c=>c.badges===1 && c.flags===0 && !c.overflow), JSON.stringify(cards));
      assert.equal(cards.find(c=>c.state==='setup').action,'准备组件');
      assert.equal(cards.find(c=>c.state==='broken').action,'修复安装');
      fs.writeFileSync(path.join(out,`cards-${width}.png`),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
      report.cases.push({width,cards});
      await js(`document.querySelector('[data-atoggle="fixture-runner~harness2"]').click()`); await delay(100);
      assert.equal(await js(`document.querySelector('.ag-drawer .cfg-state').textContent`),'待准备组件');
      assert.equal(await js(`document.querySelector('.ag-drawer').scrollWidth>document.querySelector('.ag-drawer').clientWidth+1`),false);
      fs.writeFileSync(path.join(out,`drawer-${width}.png`),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
      await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
      assert.equal(await js(`!!document.getElementById('agDrawerWrap')`),false);
    }
    await js(`document.querySelector('[data-ainstall="fixture-runner~harness2"]').click()`);
    assert.deepEqual(await js('requests'),[{key:'harness2',action:'install',runner:'fixture-runner'}]);
    await js('closeAgentsPanel();openAgentsPanel();void 0;'); await delay(1100);
    assert.equal(await js(`_agJobs['fixture-runner~harness2'].state`),'done');
    await js(`dispatchEvent(new Event('soduwork-data-scope-changed'));void 0;`);
    assert.equal(await js('Object.keys(_agJobs).length'),0);
    await js(`openAgentsPanel();void 0;`); await delay(180);
    await js(`document.querySelector('[data-atoggle="fixture-runner~codex"]').click()`);
    await delay(180);
    assert.equal(await js(`document.querySelectorAll('.ag-drawer [data-alogin]').length`),1);
    assert.equal(await js(`document.querySelector('.ag-drawer').scrollWidth>document.querySelector('.ag-drawer').clientWidth+1`),false);
    assert.match(await js(`document.querySelector('.ag-drawer').textContent`),/优先使用这台机器已有的 Codex 登录/);
    await js(`document.querySelector('.ag-drawer [data-alogin]').click()`); await delay(180);
    assert.equal(await js(`document.querySelector('.codex-auth-dialog').dataset.state`),'ready');
    assert.equal(await js('requests.length'),1);
    await js(`document.querySelector('.codex-auth-primary').click()`); await delay(180);
    assert.deepEqual((await js('requests')).at(-1),{key:'codex',action:'login',runner:'fixture-runner'});
    assert.equal(await js(`document.querySelector('.codex-auth-dialog').dataset.state`),'waiting');
    fs.writeFileSync(path.join(out,'codex-login-600.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    await js(`document.querySelector('.codex-auth-secondary').click()`); await delay(180);
    assert.equal(await js(`!!document.querySelector('.codex-auth-dialog')`),false);
    assert.deepEqual((await js('requests')).at(-1),{key:'codex',action:'login-cancel',runner:'fixture-runner',options:{jobId:'fixture-login'}});
    await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));document.querySelector('[data-atoggle="fixture-runner~codex-harness"]').click()`);
    assert.equal(await js(`document.querySelectorAll('.ag-drawer [data-alogin]').length`),0);
    report.cases.push({loginCapability:true,selectedRunner:true,explicitConsent:true,scopedCancellation:true,enterpriseUnchanged:true});
    report.errors = await js('errors'); assert.deepEqual(report.errors,[]);
    report.ok = true;
  }).catch(e=>{report.errors.push(String(e.stack||e));process.exitCode=1;}).finally(()=>{
    fs.writeFileSync(path.join(out,'ui-report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({ok:report.ok,layouts:report.cases.length,errors:report.errors}));
    if(win&&!win.isDestroyed()) win.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
