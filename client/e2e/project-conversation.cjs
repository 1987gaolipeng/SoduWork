'use strict';
// Browser-generated input in real Electron; native/Hub responses are isolated fixtures.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const output=process.argv[2];if(!path.isAbsolute(output||''))throw Error('Absolute evidence path required');
fs.mkdirSync(output,{recursive:true});app.setPath('userData',path.join(output,'profile'));
const wait=ms=>new Promise(r=>setTimeout(r,ms));let win;
const report={ok:false,scope:'real Electron input; fixture native and Hub APIs',checks:[],layouts:[]};
app.whenReady().then(async()=>{
 const watchdog=setTimeout(()=>{report.error='timeout';finish(1)},60000);
 function finish(code){clearTimeout(watchdog);fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));win?.destroy();app.exit(code)}
 try{
  win=new BrowserWindow({width:1280,height:900,show:false,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true}});
  const js=s=>win.webContents.executeJavaScript(s,true);
  const click=async selector=>{
   const p=await js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled||!n.getClientRects().length)throw Error('Unavailable: '+${JSON.stringify(selector)});n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
   win.webContents.sendInputEvent({type:'mouseMove',...p});win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...p});await wait(120);
  };
  const key=async keyCode=>{win.webContents.sendInputEvent({type:'keyDown',keyCode});if(keyCode==='Return')win.webContents.sendInputEvent({type:'char',keyCode:'\r'});win.webContents.sendInputEvent({type:'keyUp',keyCode});await wait(60)};
  const choose=async(selector,value)=>{const i=await js(`Array.from(document.querySelector(${JSON.stringify(selector)}).options).findIndex(o=>o.value===${JSON.stringify(value)})`);assert.ok(i>=0);await click(selector);await key('Home');for(let n=0;n<i;n++)await key('Down');await key('Return');assert.equal(await js(`document.querySelector(${JSON.stringify(selector)}).value`),value)};
  await win.loadFile(path.join(__dirname,'../tests/task-picker.html'));
  await js(`window.errors=[];addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
   window.configureProject=()=>{resetFixture();ctx._sessionOptions={adapterId:'pi',projectId:'tea',repoId:'site',cwd:'D:/project/site',modelName:'selected'};ctx._workModel=()=> 'selected';
    for(const t of tasks){t.projectId=['design','release'].includes(t.id)?'tea':'other';t.repoId=t.projectId==='tea'?'site':'other-repo'};
    ctx.sessionInfo=()=>({...ctx._sessionOptions,sessionId:ctx._sessionId,title:'示例社区 · 长会话',model:'selected'});};configureProject();`);
  const open=async()=>{await click('#add');await wait(100)};
  const visible=()=>js(`Array.from(document.querySelectorAll('.ncollab-picker-row:not([hidden])')).map(n=>n.dataset.collabTaskSelect)`);
  await open();assert.deepEqual(await visible(),['design','release']);
  fs.writeFileSync(path.join(output,'choose-project-requirement.png'),(await win.webContents.capturePage()).toPNG());
  await choose('[data-collab-project-scope]','all');
  assert.equal((await visible()).length,5);assert.equal(await js(`document.querySelector('[data-collab-task-select="report"]').disabled`),true);
  await choose('[data-collab-project-scope]','tea');
  await click('[data-collab-task-select="design"]');
  await js(`delayDetail=350`);await click('[data-collab-picker-submit]');
  assert.equal(await js(`document.querySelector('[data-collab-picker-submit]').disabled`),true);await wait(400);
  assert.equal(await js('sent.length'),1);assert.equal(await js('sent[0].options.taskExecution.reuseConversation'),true);
  await open();assert.deepEqual(await visible(),['release']);
  await click('[data-collab-task-select="release"]');await click('[data-collab-picker-submit]');await wait(450);
  assert.deepEqual(await js('sent.map(s=>s.options.taskId)'),['design','release']);
  assert.equal(await js('ctx._sessionId'),'chat-a');assert.equal(await js('ctx._sessionOptions.cwd'),'D:/project/site');
  report.checks.push('same-project default, explicit project filter, cross-project explanation, two distinct requirements in the same native session');
  await js(`configureProject();window.originalSend=ctx._send;window.failSend=true;ctx._send=async(...args)=>failSend?false:originalSend(...args);void 0`);
  await open();await click('[data-collab-task-select="design"]');await click('[data-collab-picker-submit]');
  assert.equal(await js('ctx._collabPicker.open'),true);
  assert.equal(await js(`document.querySelector('[data-collab-task-select="design"]').getAttribute('aria-checked')`),'true');
  assert.equal(await js(`document.querySelector('[data-collab-picker-submit]').disabled`),false);
  await js('failSend=false');await click('[data-collab-picker-submit]');assert.equal(await js('sent.length'),1);
  report.checks.push('failed submission retains selection; one retry produces exactly one accepted requirement');
  await js('configureProject();ctx._send=originalSend;void 0');await open();await click('[data-collab-task-select="design"]');
  await js(`tasks.find(t=>t.id==='design').projectId='moved'`);await click('[data-collab-picker-submit]');
  assert.equal(await js('sent.length'),0);assert.match(await js(`document.querySelector('.ncollab-picker-error').textContent`),/项目|工程/);
  report.checks.push('changed project after selection is revalidated before binding');
  for(const width of [1280,800,420]){
   win.setContentSize(width,900);await wait(100);
   const m=await js(`(()=>{const n=document.querySelector('.ncollab-picker'),r=n.getBoundingClientRect();return{width:r.width,left:r.left,right:r.right,overflow:n.scrollWidth-n.clientWidth}})()`);
   assert.ok(m.left>=-1&&m.right<=width+1&&m.overflow<2,JSON.stringify(m));report.layouts.push({viewportWidth:width,...m});
   fs.writeFileSync(path.join(output,'picker-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
  }
  await click('[data-collab-picker-close]');win.setContentSize(1100,900);
  await js(`configureProject();window.choiceCalls=[];window.choiceCompleted=[];window.choiceValid=true;
    window.soduWorkAPI={conversationSession:{history:async()=>({ok:true,chats:[{id:'chat-a',title:'示例社区 · 长会话',adapterId:'pi',cwd:'D:/project/site',requirementContext:{projectId:'tea',repoId:'site'},status:'idle'},
      {id:'old-chat',title:'上一期已交付',adapterId:'pi',cwd:'D:/project/site',requirementContext:{projectId:'tea',repoId:'site'},status:'done'},
      {id:'wrong',title:'其他项目',adapterId:'pi',requirementContext:{projectId:'other'}}]})}};
    window.NativeChat={sessionInfo:ctx.sessionInfo,enqueueTask:async(id,options)=>{choiceCalls.push({id,options});return {ok:true}}};
    window.choiceHost=document.createElement('div');choiceHost.className='fwd-pop';choiceHost.style='margin:40px auto;width:min(600px,90vw);background:var(--bg-0);border:1px solid var(--line)';
    choiceHost.innerHTML='<div class="fwd-head">安排这条需求</div><div class="fwd-tabs">新的执行方式</div><div class="fwd-scroll">其他承办人</div><div class="fwd-actions"><button id="fwdConfirm">确认</button></div>';
    document.querySelector('main').hidden=true;document.body.append(choiceHost);
    RequirementSessionChoice.mount(choiceHost,tasks.find(t=>t.id==='design'),{valid:()=>choiceValid,completed:id=>choiceCompleted.push(id)});`);await wait(150);
  assert.equal(await js(`choiceHost.querySelector('select').value`),'');
  assert.equal(await js(`choiceHost.querySelector('option[value="wrong"]')===null`),true);
  await choose('.rq-session-choice select','');assert.equal(await js(`getComputedStyle(choiceHost.querySelector('.fwd-tabs')).display!=='none'`),true);
  await choose('.rq-session-choice select','old-chat');await click('.rq-session-choice textarea');await win.webContents.insertText('沿用上一期口径');
  fs.writeFileSync(path.join(output,'existing-session.png'),(await win.webContents.capturePage()).toPNG());
  await click('.rq-session-choice button');assert.deepEqual(await js('choiceCompleted'),['design']);
  assert.deepEqual(await js('choiceCalls[0].options'),{source:'requirement-session',reuseConversation:true,chatId:'old-chat',brief:'沿用上一期口径'});
  report.checks.push('assignment offers current/completed project conversations, excludes another project, can switch to another execution mode and sends the exact chosen chat/brief');
  assert.deepEqual(await js('errors'),[]);report.ok=true;finish(0);
 }catch(error){report.error=error.stack;finish(1)}
});
