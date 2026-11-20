'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = {...process.env};
  for (const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS']) delete env[key];
  const child = require('node:child_process').spawnSync(electron,[__filename,...process.argv.slice(2)],
    {env,stdio:'inherit',timeout:90000});
  process.exit(child.status ?? 1);
}
const {app,BrowserWindow,ipcMain} = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), {pathToFileURL} = require('node:url');
const {createRunnerRuntimeAdapter,getRunnerSessionDetails,_uuidV5} = require('../main/agent-runtime/runner-adapter');
const catalog = require('../main/agent-runtime/runtime-catalog');
const client = path.resolve(__dirname,'..'), output = process.argv[2];
assert.ok(output && path.isAbsolute(output),'Absolute evidence directory required');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-runner-queue-ui-'));
fs.mkdirSync(output,{recursive:true}); app.setPath('userData',path.join(temporary,'profile')); app.disableHardwareAcceleration();
const report = {ok:false,platform:process.platform,electron:process.versions.electron,chromium:process.versions.chrome,
  checks:[],errors:[],network:[],cleanup:{ok:false},
  boundary:'Real Electron Chromium, NativeChat composer bindings and message renderer, status helpers, and production Runner adapters. Pointer input uses Chromium sendInputEvent. Runner admission/session RPC, model catalog, account and unrelated shell surfaces are synthetic. Clock is deterministic. No real provider, Windows execution, remote Runner, or production profile.'};
const read = file => fs.readFileSync(path.join(client,file),'utf8');
const realNow = Date.now;
let now = realNow(), win, holdNextComment = false;
const sessions = new Map(), native = new Map(), calls = [];
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
const js = code => win.webContents.executeJavaScript(code,true);
async function until(code,timeout=7000) {
  const end = realNow()+timeout;
  while(realNow()<end) {if(await js(code))return;await delay(20);}
  throw Error('Timed out: '+code+'\n'+await js('document.body.innerText'));
}
async function click(selector) {
  const p = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control');
    e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect(),p={x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};
    if(e.disabled||!e.contains(document.elementFromPoint(p.x,p.y)))throw Error('Control unavailable');return p})()`);
  for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,...p,button:'left',clickCount:1});
}
async function submit(text,keyboard=false) {
  await js(`{const e=document.querySelector('#nchatInput');e.value=${JSON.stringify(text)};e.dispatchEvent(new Event('input',{bubbles:true}));}void 0;`);
  if(keyboard) {
    await js(`document.querySelector('#nchatInput').focus();void 0;`);
    for(const type of ['keyDown','keyUp'])win.webContents.sendInputEvent({type,keyCode:'Enter'});
  } else await click('#nchatSend');
}
async function setTime(value) {now=value;await js('window.fixtureNow='+value+';void 0;');}
async function capture(name) {
  fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true})).toPNG());
}
const runtime = {async rpc(op,input) {
  calls.push({op,ref:input.ref||'',text:input.text||input.ctx?.conversationUserText||''});
  if(op==='runtime.detect')return {ok:true,data:{}};
  if(op==='job.dispatch') {
    const ref=_uuidV5('9af442c8-cd1d-4b91-a668-22da2b2635bf',input.dispatchId),queued=input.cli==='opencode';
    native.set(ref,{status:queued?'queued':'done',executionStartedAt:queued?0:now/1000,queuePosition:queued?2:0,items:queued?[]:[{seq:1,kind:'say',text:'Independent answer',at:new Date(now).toISOString()}]});
    return {ok:true,data:{ref,state:queued?'queued':'running',queued}};
  }
  if(op==='job.session')return {ok:true,data:{ok:true,ref:input.ref,...native.get(input.ref)}};
  if(op==='job.comment') {
    const queued=holdNextComment;holdNextComment=false;
    native.set(input.ref,{status:queued?'queued':'done',executionStartedAt:queued?0:now/1000,ended:now/1000,items:[]});
    return {ok:true,data:{ok:true,state:queued?'queued':'running',queued}};
  }
  if(op==='job.stop')return {ok:true,data:{ok:true}};
  throw Error('Unexpected fixture RPC: '+op);
}};
app.whenReady().then(async()=>{
  try {
    Date.now=()=>now;
    const css=[...read('desk.html').matchAll(/<link\b[^>]*href=["']([^"']+\.css)["'][^>]*>/g)].map(match=>match[1]);
    const html=path.join(temporary,'fixture.html'),preload=path.join(temporary,'preload.cjs');
    fs.writeFileSync(html,'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'+css.map(file=>
      '<link rel="stylesheet" href="'+pathToFileURL(path.join(client,file)).href+'">').join('')+
      '<style>body{margin:0;padding:20px;background:#fafafa}#composePanel{height:820px;display:block}#cpChat{display:block;height:100%}.nchat{height:100%}</style>'+
      '</head><body><main id="composePanel"><div id="cpChat"></div></main></body></html>');
    fs.writeFileSync(preload,`const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('queueFixture',{
      open:options=>ipcRenderer.invoke('queue-ui-open',options),send:(...args)=>ipcRenderer.invoke('queue-ui-send',...args),
      snapshot:ref=>ipcRenderer.invoke('queue-ui-snapshot',ref),cancel:ref=>ipcRenderer.invoke('queue-ui-cancel',ref),
      onEvent:callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('queue-ui-event',listener);return()=>ipcRenderer.removeListener('queue-ui-event',listener);}});`);
    for(const id of ['opencode','qwen']) {
      const cwd=path.join(temporary,id);fs.mkdirSync(cwd);
      const adapter=createRunnerRuntimeAdapter({runtimeSpec:catalog.runtime(id),runnerRuntime:runtime,
        modelConfig:{fetchModel:async()=>({ok:true,model:{id:'synthetic',name:'synthetic',key:'synthetic'}})}});
      const session=await adapter.createSession({native:{runner:{openOptions:{cwd,ref:'queue-ui-'+id}}}});
      const handle=getRunnerSessionDetails(session).handle;
      sessions.set(session.id,{id,session,handle,cwd});
      handle.on((event,snapshot)=>{if(win&&!win.isDestroyed())win.webContents.send('queue-ui-event',{...event,ref:session.id,snapshot});});
    }
    ipcMain.handle('queue-ui-open',(_event,options)=>{
      const entry=sessions.get(options.chatId);assert.ok(entry,'Only fixture-owned sessions can open');
      return {ok:true,ref:entry.session.id,sessionId:entry.session.id,adapterId:entry.id,
        model:{id:'synthetic',name:'synthetic',label:'Synthetic model'},workdir:{dir:entry.cwd,name:'Isolated workspace'},snapshot:entry.handle.snapshot()};
    });
    ipcMain.handle('queue-ui-snapshot',(_event,ref)=>({ok:true,snapshot:sessions.get(ref).handle.snapshot()}));
    ipcMain.handle('queue-ui-cancel',(_event,ref)=>{
      const handle=sessions.get(ref).handle,result=handle.cancel();
      return {...result,snapshot:handle.snapshot()};
    });
    ipcMain.handle('queue-ui-send',(_event,ref,text,attachments,options)=>{
      const entry=sessions.get(ref);assert.ok(entry,'Only fixture-owned sessions can send');
      const receipt=entry.handle.submit(text,attachments,options);
      void receipt.completion;
      return {ok:receipt.accepted,queued:receipt.queued,queueId:receipt.queueId,snapshot:entry.handle.snapshot()};
    });
    win=new BrowserWindow({show:false,width:1280,height:960,webPreferences:{preload,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
    win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(request,done)=>{report.network.push(request.url);done({cancel:true});});
    await win.loadFile(html);win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
    await require('./lib/conversation-send-harness.cjs').install(win,read,['chat-workspace-info','panels-chat-status']);
    await js(`window.fixtureNow=${now};Date.now=()=>fixtureNow;model={id:'synthetic',name:'synthetic',label:'Synthetic model'};
      const rows=['pi','opencode','qwen'].map(id=>({id,displayName:id,modelMode:'managed'}));
      low.runtimes=low.conversationRuntimes=async()=>({ok:true,runtimes:rows,availableRuntimes:rows});
      low.open=queueFixture.open;low.send=queueFixture.send;low.snapshot=queueFixture.snapshot;low.cancel=queueFixture.cancel;low.onEvent=queueFixture.onEvent;void 0;`);
    const first=[...sessions.values()].find(row=>row.id==='opencode'),second=[...sessions.values()].find(row=>row.id==='qwen');
    await js(`NativeChat.enter('',${JSON.stringify(first.session.id)},{adapterId:'opencode',modelName:'synthetic'})`);
    await submit('OpenCode first turn');
    await until(`fixtureContext._snap.status==='queued'&&document.querySelector('.nstatus-copy')?.textContent==='排队中 · 第 2 项'`);
    const submittedAt=now;await setTime(now+808000);
    await until(`document.querySelector('[data-thinking-elapsed]')?.textContent==='13m 28s'`);
    assert.equal(await js(`document.querySelector('[data-thinking-label]').textContent`),'排队中');
    assert.equal(await js(`!!document.querySelector('[data-thinking-tokens]')`),false);
    assert.doesNotMatch(await js(`document.querySelector('.nstatus-copy').textContent`),/理解|思考/);
    report.checks.push('Accepted but not launched OpenCode shows queue position and 13m28s waiting, without thinking, processing or token metrics');
    await capture('01-queued');
    await submit('Ordered OpenCode follow-up',true);
    await until(`fixtureContext._snap.queue.length===1`);
    await js(`NativeChat.enter('',${JSON.stringify(second.session.id)},{adapterId:'qwen',modelName:'synthetic'})`);
    await submit('Independent Qwen turn');
    await until(`fixtureContext._snap.status==='idle'&&document.body.innerText.includes('Independent answer')`);
    assert.equal(first.handle.snapshot().status,'queued');
    assert.equal(calls.filter(row=>row.op==='job.comment').length,0);
    report.checks.push('A second conversation completes while the first conversation keeps its own ordered follow-up');
    await js(`NativeChat.enter('',${JSON.stringify(first.session.id)},{adapterId:'opencode',modelName:'synthetic'})`);
    native.set(first.session.id,{status:'running',executionStartedAt:0,items:[]});
    await until(`fixtureContext._snap.status==='streaming'&&document.querySelector('.nstatus-copy')?.textContent==='等待启动'`);
    assert.equal(first.handle.snapshot().execution.running,false);
    report.checks.push('Native preflight stays waiting to start rather than claiming model execution');
    await setTime(now+90000);
    await until(`document.querySelector('.nstatus-copy')?.textContent==='执行环境启动时间较长，可停止后检查底座状态'`);
    assert.equal(first.handle.snapshot().execution.running,false);
    assert.equal(first.handle.snapshot().execution.stalled,false);
    assert.equal(first.handle.snapshot().execution.active,true);
    report.checks.push('A 90-second startup wait shows a stop-and-check diagnostic while retaining execution ownership');
    const startedAt=now;native.set(first.session.id,{status:'running',executionStartedAt:startedAt/1000,items:[]});
    await until(`fixtureContext._snap.execution.running===true&&document.querySelector('[data-thinking-elapsed]')?.textContent==='0s'`);
    await setTime(now+7000);
    await until(`document.querySelector('[data-thinking-elapsed]')?.textContent==='7s'`);
    assert.equal(first.handle.snapshot().execution.queueWaitMs,startedAt-submittedAt);
    assert.equal(await js(`document.querySelector('[data-thinking-label]').textContent`),'处理中');
    report.checks.push('Actual native start resets execution time to zero and then seven seconds; queue and startup waiting remain separately observable');
    await capture('02-running');
    native.set(first.session.id,{status:'done',executionStartedAt:startedAt/1000,ended:now/1000,items:[]});
    await until(`fixtureContext._snap.status==='idle'&&fixtureContext._snap.queue.length===0`);
    assert.equal(calls.filter(row=>row.op==='job.comment').length,1);
    assert.equal(calls.find(row=>row.op==='job.comment').text,'Ordered OpenCode follow-up');
    holdNextComment=true;
    await submit('Cancelable queued turn');
    await until(`fixtureContext._snap.status==='queued'`);
    assert.equal(await js(`document.querySelector('#nchatSend').title`),'停止生成');
    await click('#nchatSend');
    await until(`fixtureContext._snap.status==='aborted'`);
    assert.ok(calls.some(row=>row.op==='job.stop'&&row.ref===first.session.id));
    report.checks.push('A queued admission retains a working native pointer stop action without claiming the model is running');
    assert.deepEqual(await js('errors'),[]);assert.deepEqual(report.network,[]);
    report.checks.push('The queued follow-up runs once after settlement, with no external network or renderer errors');
    report.ok=true;
  } catch(error) {report.errors.push(error.stack||String(error));}
  finally {
    Date.now=realNow;
    const cleanup=await Promise.allSettled([...sessions.values()].map(row=>row.session.dispose()));
    if(win&&!win.isDestroyed())win.destroy();
    try {fs.rmSync(temporary,{recursive:true,force:true});report.cleanup={ok:cleanup.every(result=>result.status==='fulfilled')&&!fs.existsSync(temporary),sessions:cleanup.map(result=>result.status)};}
    catch(error) {report.cleanup={ok:false,error:String(error)};}
    report.ok=report.ok&&report.cleanup.ok;
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify(report,null,2));app.exit(report.ok?0:1);
  }
});
