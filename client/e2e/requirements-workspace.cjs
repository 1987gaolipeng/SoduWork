'use strict';
// Loads the complete desk.html script/style graph against an isolated Hub.
// Native desktop IPC and model execution are outside this renderer smoke test.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const [output,hub]=process.argv.slice(2);
if(!path.isAbsolute(output||'')||!/^http:\/\/127\.0\.0\.1:\d+$/.test(hub||''))throw Error('Explicit isolated output and Hub required');
fs.mkdirSync(output,{recursive:true});app.setPath('userData',path.join(output,'profile'));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const report={ok:false,scope:'Complete desk.html renderer, isolated Hub; no production IPC or model calls',checks:[]};
let win;
const stage=value=>{report.stage=value;fs.writeFileSync(path.join(output,'progress.json'),JSON.stringify(report,null,2));};
app.whenReady().then(async()=>{
 const watchdog=setTimeout(()=>{report.error='Workspace test exceeded 60 seconds';fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));app.exit(1);},60000);
 try{
  stage('isolated-backend');
  const ready=await(await fetch(hub+'/ready',{signal:AbortSignal.timeout(5000)})).json();assert.equal(ready.isolated,true);
  stage('create-window');
  win=new BrowserWindow({width:1440,height:1000,show:false,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,partition:'requirements-workspace-'+process.pid+'-'+Date.now()}});
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(row,reply)=>reply({cancel:!row.url.startsWith(hub+'/')&&!row.url.startsWith(hub.replace('http:','ws:')+'/')}));
  await win.loadURL('about:blank');
  stage('debugger-page');
  win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Page.enable');
  stage('inject-isolated-identity');
  await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument',{source:`
   localStorage.setItem('soduwork_work_hub_environment_v1','development');
   localStorage.setItem('soduwork_work_development_hub_url_v1',${JSON.stringify(hub)});
   localStorage.setItem('soduwork_work_user_id','e2e-sender');
   // Emulate only the secure desktop enrollment bridge; call the real Hub route.
   window.soduWorkAPI={getHubConnection:async()=>({hub:${JSON.stringify(hub)},internalTest:true,editable:false}),deviceAuthBootstrap:async options=>{
    const response=await fetch(options.hub+'/api/v1/clients/enroll',{method:'POST',headers:{
     'Content-Type':'application/json','X-Device-Key':'isolated-requirements-fixture-key-never-production'
    },body:JSON.stringify({device:options.clientId,name:options.name,platform:options.platform,version:options.version})});
    const data=await response.json();if(!response.ok)throw Error(JSON.stringify(data));
    window.fixtureDeviceSession=data.session;
    return {...data,ok:!data.activationRequired,stored:true};
   }};
   window.fixtureErrors=[];
   window.addEventListener('error',event=>fixtureErrors.push(event.message));
   window.addEventListener('unhandledrejection',event=>fixtureErrors.push(String(event.reason)));
  `});
  const js=source=>win.webContents.executeJavaScript(source,true);
  const until=async source=>{for(let i=0;i<200;i++){if(await js(source))return;await delay(100);}throw Error('Timed out: '+source+'; errors='+JSON.stringify(await js('fixtureErrors')));};
  const click=async selector=>{
   // Wait for layout and hit-test the real pointer target; a freshly opened view can still be animating.
   let pos;
   for(let attempt=0;attempt<30;attempt++){
    pos=await js(`(async()=>{const n=[...document.querySelectorAll(${JSON.stringify(selector)})].find(n=>n.getClientRects().length&&!n.disabled);if(!n)return null;n.scrollIntoView({block:'nearest',behavior:'instant'});const a=n.getBoundingClientRect();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect();const x=Math.round(b.x+b.width/2),y=Math.round(b.y+b.height/2);const hit=document.elementFromPoint(x,y);return n.isConnected&&Math.abs(a.x-b.x)<1&&Math.abs(a.y-b.y)<1&&n.contains(hit)?{x,y}:null})()`);
    if(pos)break;await delay(50);
   }
   if(!pos){report.pointerTarget=await js(`([...document.querySelectorAll(${JSON.stringify(selector)})].map(n=>{const r=n.getBoundingClientRect();return {html:n.outerHTML.slice(0,500),rect:r.toJSON(),hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML.slice(0,500)}}))`);throw Error('No stable visible pointer target: '+selector);}
   win.webContents.sendInputEvent({type:'mouseMove',...pos});
   win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...pos});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...pos});await delay(150);
  };
  const load=()=>win.loadFile(path.join(__dirname,'../desk.html'),{query:{panel:'workspace',view:'history'}});
  stage('load-complete-workspace');
  await load();stage('wait-for-store');await until('!!document.querySelector("[data-view=history]")&&typeof Store!=="undefined"&&Store.taskState==="ready"&&!document.documentElement.classList.contains("soduwork-auth-pending")');
  await js("SoduWorkI18n.setLocale('zh-CN')");
  await click('button[data-rail-view="history"]');await until('!!document.querySelector("#historyBoard.show")');
  assert.equal(await js('document.querySelectorAll("[data-view=workitems]").length'),0);
  assert.equal(await js('document.querySelector("#hbTitleText").textContent'),'需求池');
  report.checks.push('complete workspace loads without retired resources or duplicate requirement navigation');
  stage('create-requirement');await click('#hbAdd[data-rq-create]');await until('!!document.querySelector("#cpTitle")');
  await click('#cpTitle');await win.webContents.insertText('完整工作区入口验证');
  assert.equal(await js('document.querySelector("#cpTitle").value'),'完整工作区入口验证');
  assert.equal(await js('!!document.querySelector("#wesAttachInput")'),true);
  assert.equal(await js('document.querySelector("#cpTriage").value'),'intake');
  assert.equal(await js('document.querySelector("#cpCreate").textContent'),'保存到需求池');
  await js('document.querySelector("#cpDue").value="2026-11-15"');
  report.checks.push('real navigation opens the unified creation form and accepts input with all production scripts loaded');
  fs.writeFileSync(path.join(output,'create.png'),(await win.webContents.capturePage()).toPNG());
  await click('#cpCreate');
  await until('tasks.some(task=>task.title==="完整工作区入口验证")');
  // The local task list includes optimistic items; validate creation against the persisted Hub receipt.
  await until('SoduWorkAPI.getTask(tasks.find(task=>task.title==="完整工作区入口验证").id).then(()=>true,()=>false)');
  const collected=await js('SoduWorkAPI.getTask(tasks.find(task=>task.title==="完整工作区入口验证").id)');
  assert.equal(collected.status,'todo');assert.equal(collected.triageStage,'intake');
  assert.equal(typeof collected.due,'number');assert.equal(new Date(collected.due).getDate(),15);
  const collectedObservation=await(await fetch(hub+'/e2e/observations')).json();
  assert.equal(collectedObservation.dispatches.filter(row=>row.id===collected.id).length,0);
  if(await js('!!document.querySelector("[data-wes-close]")'))await click('[data-wes-close]');
  // The creation receipt is a modal dialog; dismiss it with the actual close
  // button before hit-testing cards underneath it.
  if(await js('!!document.querySelector(".wes-result-dialog[open]")')){
   await click('.wes-result-dialog[open] .wes-result-close');
   await until('!document.querySelector(".wes-result-dialog[open]")');
  }
  report.checks.push('creation with optional deadline persists in collection with no Agent execution or teammate handoff');
  assert.deepEqual(await js('fixtureErrors'),[]);
  stage('requirement-assignment');
  await js('window._humanErr=(error,fallback)=>{fixtureErrors.push(String(error.stack||error));return fallback;};true');
  const taskId='navigation-'+Date.now();
  await js(`SoduWorkAPI.putTask(${JSON.stringify(taskId)},{title:'需求入口与派活验证',note:'验证同一条需求持续交付',status:'todo',triageStage:'ready',kind:'requirement',visibility:'related',acceptanceCriteria:['保留同一条需求与对应会话']})`);
  await js('RequirementsBoard.refresh()');
  await click(`[data-rq-open="${taskId}"]`);await until('!!document.querySelector("[data-rq-assign]")');
  assert.equal(await js('document.querySelectorAll("#detailPanel,#progInput,#dksInput").length'),0);
  assert.equal(await js('!!document.querySelector(".rq-detail-overview")&&!document.querySelector("#rqEditForm")'),true);
  await click('[data-rq-edit]');await until('!!document.querySelector("#rqEditForm")');
  await click('[data-rq-edit-cancel]');assert.equal(await js('!!document.querySelector("#rqEditForm")'),false);
  const original=await js(`SoduWorkAPI.getTask(${JSON.stringify(taskId)})`);
  assert.equal(original.assigneeUserId,'sender');
  // Replay assignment events with the production Store and complete workspace mounted.
  const arrivalState=await js(`(async()=>{
    const open=window.openTaskConversation, opened=[];
    const before=[...document.querySelectorAll('[data-chat-id]')].map(n=>n.dataset.chatId);
    window.openTaskConversation=(...args)=>{opened.push(args);return open(...args)};
    try {
      const task=await SoduWorkAPI.getTask(${JSON.stringify(taskId)});
      for(const event of [
        {type:'task.created',arrival:'assign',autoOpen:true},
        {type:'task.updated',arrival:'assign',autoOpen:true,__fromWindow:true},
        {type:'task.updated',arrival:'assign',autoOpen:true}
      ]) Store.applyServerEvent({...event,task});
      await new Promise(resolve=>setTimeout(resolve,150));
      return {opened,before,after:[...document.querySelectorAll('[data-chat-id]')].map(n=>n.dataset.chatId),
        drawer:!!document.querySelector('.rq-detail-overview'),state:Store.tasks.find(t=>t.id===task.id)?.status};
    } finally {window.openTaskConversation=open}
  })()`);
  assert.deepEqual(arrivalState.opened,[]);
  assert.deepEqual(arrivalState.after,arrivalState.before);
  assert.equal(arrivalState.drawer,true);assert.equal(arrivalState.state,'todo');
  report.checks.push('assignment arrival and replay preserve the active workspace and recent chats without opening a conversation');
  await click('[data-rq-edit]');await until('!!document.querySelector("#rqEditForm")');
  assert.equal(await js('document.querySelector("#rqEditForm [name=assigneeUserId]").value'),original.assigneeUserId);
  await click('#rqEditForm [name=note]');
  await js('document.querySelector("#rqEditForm [name=note]").select()');
  await win.webContents.insertText('unsaved draft preserved until an explicit decision');
  await click('[data-rq-edit-cancel]');await until('!document.querySelector("[data-rq-confirm]").hidden');
  await click('[data-rq-confirm-cancel]');
  assert.equal(await js('document.querySelector("#rqEditForm [name=note]").value'),'unsaved draft preserved until an explicit decision');
  await click('[data-rq-edit-cancel]');await until('!document.querySelector("[data-rq-confirm]").hidden');
  await click('[data-rq-confirm-discard]');await until('!document.querySelector("#rqEditForm")');
  assert.equal((await js(`SoduWorkAPI.getTask(${JSON.stringify(taskId)})`)).note,original.note);
  await click('[data-rq-edit]');await until('!!document.querySelector("#rqEditForm")');
  await click('#rqEditForm [name=note]');
  await js('document.querySelector("#rqEditForm [name=note]").select()');
  await win.webContents.insertText('editing the background keeps the current assignee');
  await click('.rq-detail-footer button[type=submit]');await until('!document.querySelector("#rqEditForm")');
  const edited=await js(`SoduWorkAPI.getTask(${JSON.stringify(taskId)})`);
  assert.equal(edited.note,'editing the background keeps the current assignee');
  assert.equal(edited.assigneeUserId,original.assigneeUserId);
  assert.deepEqual(edited.acceptanceCriteria,original.acceptanceCriteria);
  report.checks.push('real edit/cancel needs no confirmation without changes; draft confirmation preserves or discards edits; saving background preserves the assignee missing from the teammate directory');

  await click('.rq-detail-more summary');assert.equal(await js('document.querySelector(".rq-detail-more").open'),true);
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
  await until('!!document.querySelector(".rq-detail-backdrop")&&!document.querySelector(".rq-detail-more").open');
  report.checks.push('detail begins with readable title/background/criteria; explicit edit and cancel preserve data; Escape closes only the open actions menu');
  await click('.rq-detail [data-rq-assign]');await until(`!!document.querySelector('#fwdAgentSelect option[value="local:pi"]')&&!_fwdLoading.ai`);
  const geometry=await js('(()=>{const r=document.querySelector("#fwdPop").getBoundingClientRect();return {center:r.x+r.width/2,width:innerWidth,bottom:r.bottom,height:innerHeight}})()');
  assert.ok(Math.abs(geometry.center-geometry.width/2)<3);assert.ok(geometry.bottom<=geometry.height);
  const size=win.getContentSize();
  win.setContentSize(720,850);await delay(180);
  const narrow=await js('(()=>{const r=document.querySelector("#fwdPop").getBoundingClientRect();const b=document.querySelector("#fwdConfirm").getBoundingClientRect();return {left:r.left,right:r.right,bottom:b.bottom,width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollWidth}})()');
  assert.ok(narrow.left>=0&&narrow.right<=narrow.width&&narrow.bottom<=narrow.height);
  assert.ok(narrow.scroll<=narrow.width);
  fs.writeFileSync(path.join(output,'assignment-narrow.png'),(await win.webContents.capturePage()).toPNG());
  win.setContentSize(...size);await delay(180);
  await click('[data-act="fwd-close"]');
  let observed=await(await fetch(hub+'/e2e/observations')).json();
  assert.equal(observed.dispatches.filter(row=>row.id===taskId).length,0);
  await click('.rq-detail [data-rq-assign]');await until('!!document.querySelector("#fwdPop")');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
  win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
  await until('!document.querySelector(".rq-assignment-backdrop")');
  assert.equal(await js('!!document.querySelector(".rq-detail-backdrop")'),true);
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
  win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
  await until('!document.querySelector(".rq-detail-backdrop")');
  assert.equal(win.isDestroyed(),false);
  await click(`[data-rq-open="${taskId}"]`);await until('!!document.querySelector("[data-rq-assign]")');
  report.checks.push('requirement opens one drawer; centered assignment selection and cancel never dispatch');
  report.checks.push('Escape closes assignment, then requirement drawer, preserving the workspace and pool');
  // Native IPC/model execution is a boundary; retain the production picker, HTTP dispatch and route resolution.
  await js('window.navigationCalls=[];window.WorkspaceHost.open=(view,payload)=>{navigationCalls.push({view,payload});return true;};true');
  await js(`window.nativeQueueCalls=[];NativeChat.enqueueTask=async(id,options)=>{
    nativeQueueCalls.push({id,options});
    const response=await fetch(${JSON.stringify(hub)}+'/api/v1/tasks/'+encodeURIComponent(id)+'/ai-dispatch',{
      method:'POST',headers:{'Content-Type':'application/json','X-Soduwork-Device':'e2e-sender'},
      body:JSON.stringify({assigneeId:options.agentId,assigneeType:options.assigneeType,brief:options.brief,
        model:options.model,repo:options.repo,executionContext:options.executionContext})});
    const result=await response.json();if(!response.ok)throw Error(result.detail||'dispatch failed');
    return {...result,conversationId:'fixture-runtime-'+id};
  };true`);
  await click('.rq-detail [data-rq-assign]');await until(`!!document.querySelector('#fwdAgentSelect option[value="local:pi"]')&&!_fwdLoading.ai`);
  await click('[data-fwd-select="fwdAgentSelect"]');
  await click('.fwd-select-popup [role="option"][data-value="local:pi"]');
  assert.equal(await js('document.querySelector("#fwdAgentSelect").value'),'local:pi');
  await until('!document.querySelector("#fwdConfirm").disabled');
  fs.writeFileSync(path.join(output,'assignment.png'),(await win.webContents.capturePage()).toPNG());
  await click('#fwdConfirm');await until('window.navigationCalls.length===1');
  const target=(await js('navigationCalls'))[0];
  assert.equal(target.view,'create');assert.equal(target.payload.taskId,taskId);assert.equal(target.payload.navigation,true);
  assert.equal(target.payload.chatId,'fixture-runtime-'+taskId);
  observed=await(await fetch(hub+'/e2e/observations')).json();
  assert.equal(observed.dispatches.filter(row=>row.id===taskId).length,1);
  assert.equal(await js('nativeQueueCalls.length'),1);
  const updated=await js(`SoduWorkAPI.getTask(${JSON.stringify(taskId)})`);assert.equal(updated.status,'doing');
  assert.equal(await js(`RequirementAssignment.open(${JSON.stringify(taskId)})`),false);
  assert.equal(await js('document.querySelectorAll(".rq-assignment-backdrop").length'),0);
  report.checks.push('real picker and Hub dispatch execute once; same Task opens NativeChat route; running work cannot be redispatched');
  stage('existing-project-conversation');
  const nextId='project-next-'+Date.now();
  await js(`SoduWorkAPI.putTask(${JSON.stringify(nextId)},{title:'在项目长会话继续下一条需求',note:'保留已确认背景',projectId:'e2e-project',status:'todo',triageStage:'ready',kind:'requirement'})`);
  await js(`window.existingCalls=[];
   soduWorkAPI.conversationSession={history:async()=>({ok:true,chats:[{id:'long-chat',title:'项目长期会话',adapterId:'pi',cwd:'D:/isolated/project',requirementContext:{projectId:'e2e-project',repoId:''},status:'done'}]}),pickCwd:async()=>({ok:true,dir:'D:/isolated/project',name:'项目目录'})};
   NativeChat.sessionInfo=()=>({});
   NativeChat.enqueueTask=async(id,options)=>{
    if(!window.fixtureDeviceSession)throw Error('Isolated enrollment did not return a device session');
    existingCalls.push({id,options});const res=await fetch(${JSON.stringify(hub)}+'/api/v1/tasks/'+encodeURIComponent(id)+'/conversation-turn',{
     method:'POST',headers:{'Content-Type':'application/json','X-Soduwork-Device':'e2e-sender',
      Authorization:'Device '+window.fixtureDeviceSession},body:JSON.stringify({action:'prepare',conversationId:options.chatId,turnId:'turn-'+id,executor:'native'})});
    const receipt=await res.json();if(!res.ok)throw Error(receipt.detail||'receipt failed');return {ok:true,conversationId:options.chatId};};true`);
  await js('RequirementsBoard.refresh()');await click(`[data-rq-open="${nextId}"]`);await click('.rq-detail [data-rq-assign]');
  await until('!!document.querySelector(".rq-session-choice select option[value=long-chat]")');
  assert.equal(await js('document.querySelector(".rq-session-choice select").value'),'');
  const sessionSelectId=await js('document.querySelector(".rq-session-choice select").id');
  const sessionTrigger=`[data-fwd-select="${sessionSelectId}"]`;
  if(sessionSelectId&&await js(`!!document.querySelector(${JSON.stringify(sessionTrigger)})`)){
   await click(sessionTrigger);
   await click('.fwd-select-popup [role="option"][data-value="long-chat"]');
  }else{
   await click('.rq-session-choice select');
   for(const keyCode of ['End','Return'])for(const type of ['keyDown','keyUp'])win.webContents.sendInputEvent({type,keyCode});
  }
  await until('document.querySelector(".rq-session-choice select")?.value==="long-chat"');
  assert.equal(await js('getComputedStyle(document.querySelector(".fwd-tabs")).display'),'none');
  assert.equal(await js('document.querySelector(".rq-session-facts").textContent.includes("项目长期会话")'),true);
  fs.writeFileSync(path.join(output,'project-session-assignment.png'),(await win.webContents.capturePage()).toPNG());
  await click('.rq-session-choice textarea');await win.webContents.insertText('沿用已确认的设计规范');
  await click('.rq-session-choice .rq-primary');await until('existingCalls.length===1&&!document.querySelector("#fwdPop")');
  assert.deepEqual(await js('existingCalls[0].options'),{source:'requirement-session',reuseConversation:true,chatId:'long-chat',brief:'沿用已确认的设计规范'});
  const linked=await js(`SoduWorkAPI.getTask(${JSON.stringify(nextId)})`);
  assert.equal(linked.workRouting.conversationTurn.conversationId,'long-chat');
  assert.equal(linked.workRouting.conversationTurn.executor,'native');
  await until(`navigationCalls.some(row=>row.payload.taskId===${JSON.stringify(nextId)})`);
  assert.equal((await js('navigationCalls')).at(-1).payload.chatId,'long-chat');
  observed=await(await fetch(hub+'/e2e/observations')).json();assert.equal(observed.dispatches.filter(row=>row.id===nextId).length,0);
  report.checks.push('complete assignment sheet offers a finished project conversation; confirm creates one real Hub native turn in that chat without a separate dispatch');
  stage('requirement-automation');
  const automationId='automation-source-'+Date.now();
  await js(`SoduWorkAPI.putTask(${JSON.stringify(automationId)},{title:'周期需求验收',note:'保留原需求背景',status:'todo',triageStage:'ready',kind:'requirement',acceptanceCriteria:['保留完成标准']})`);
  await js(`RequirementsDetail.open(${JSON.stringify(automationId)})`);
  await click('.rq-detail-more summary');await click('[data-rq-automation]');await until('!!document.querySelector("#wazForm")');
  assert.equal(await js('document.querySelector("#wazForm [name=note]").value'),'保留原需求背景');
  assert.equal(await js('document.querySelector("#wazForm [name=acceptance]").value'),'保留完成标准');
  await click('#wazForm [name=enabled]');
  await click('[data-waz-save]');
  await until('!!document.querySelector(".waz-saved")');
  await until(`SoduWorkAPI.getTask(${JSON.stringify(automationId)}).then(task=>!!task.automationScheduleId)`);
  const automated=await js(`SoduWorkAPI.getTask(${JSON.stringify(automationId)})`);
  const schedules=await js('SoduWorkAPI.listSchedules()');
  const schedule=schedules.find(row=>row.id===automated.automationScheduleId);
  assert.ok(schedule);assert.equal(schedule.enabled,false);assert.match(schedule.note,/保留原需求背景[\s\S]*保留完成标准/);
  assert.equal(automated.status,'todo');assert.equal((await(await fetch(hub+'/e2e/observations')).json()).dispatches.filter(row=>row.id===automationId).length,0);
  await click('[data-waz-open]');
  await until(`navigationCalls.some(row=>row.view==='schedules'&&row.payload.scheduleId===${JSON.stringify(schedule.id)})`);
  await js(`RequirementsDetail.open(${JSON.stringify(automationId)})`);
  await click('.rq-detail-more summary');await click('[data-rq-automation]');
  await until(`navigationCalls.some(row=>row.view==='schedules'&&row.payload.scheduleId===${JSON.stringify(schedule.id)})`);
  await js(`openSchedulePanel({scheduleId:${JSON.stringify(schedule.id)}})`);
  await until('!!document.querySelector("#schTitle")');assert.equal(await js('document.querySelector("#schTitle").value'),'周期需求验收');
  fs.writeFileSync(path.join(output,'linked-automation.png'),(await win.webContents.capturePage()).toPNG());
  await js('closeSchedulePanel();true');
  report.checks.push('detail automation form preserves source and criteria, real preflight/create/link persist one paused schedule without dispatch, and View automation opens its exact configuration');
  stage('automation-lifecycle');
  await js(`window.automationOriginal={preflight:SoduWorkAPI.preflightSchedule,create:SoduWorkAPI.createSchedule,parse:SoduWorkAPI.parseTaskText};
    window.automationCallbacks=[];window.automationCreates=0;
    SoduWorkAPI.preflightSchedule=async()=>({state:'ready'});
    SoduWorkAPI.createSchedule=()=>{automationCreates++;return new Promise(resolve=>window.finishOldAutomation=resolve)};
    WorkAutomationSheet.open({proposal:{title:'原需求自动化',note:'原背景',assigneeId:'local:pi'},onCreated:s=>automationCallbacks.push('original:'+s.id)});void 0;`);
  await until('!!document.querySelector("#wazForm")');await click('[data-waz-save]');await until('automationCreates===1');
  assert.equal(await js('document.querySelector("[data-waz-close]").disabled'),true);
  await js(`document.querySelector('[data-waz-save]').click();void 0;`);assert.equal(await js('automationCreates'),1);
  await js(`WorkAutomationSheet.open({proposal:{title:'新的需求自动化',note:'新背景',assigneeId:'local:pi'},onCreated:s=>automationCallbacks.push('wrong:'+s.id)})`);
  await js(`finishOldAutomation({id:'old-receipt'});void 0;`);await delay(70);
  assert.deepEqual(await js('automationCallbacks'),['original:old-receipt']);
  assert.equal(await js('document.querySelector("#wazForm [name=title]").value'),'新的需求自动化');
  assert.equal(await js('!!document.querySelector(".waz-saved")'),false);
  await js(`SoduWorkAPI.parseTaskText=()=>new Promise(resolve=>window.finishOldRefinement=resolve);
    WorkAutomationSheet.refine('旧表单补充');void 0;`);await until('typeof finishOldRefinement==="function"');
  await js(`WorkAutomationSheet.open({proposal:{title:'第三条需求',note:'独立背景',assigneeId:'local:pi'}})`);
  await js(`finishOldRefinement({title:'错误的旧标题',note:'旧补充'});void 0;`);await delay(70);
  assert.equal(await js('document.querySelector("#wazForm [name=title]").value'),'第三条需求');
  await js('WorkAutomationSheet.close(true);SoduWorkAPI.preflightSchedule=automationOriginal.preflight;SoduWorkAPI.createSchedule=automationOriginal.create;SoduWorkAPI.parseTaskText=automationOriginal.parse;void 0;');
  report.checks.push('controlled slow create/refine responses cannot overwrite another requirement automation; duplicate save is blocked and receipt invokes only its original callback');
  stage('sidebar-business-project');
  await js('WorkspaceShell.setActive("create");true');
  await click('#wsProjectAdd');await until('document.querySelector("#wsBusinessProject")&&!document.querySelector("#wsBusinessProject").disabled');
  await click('#wsProjectName');await win.webContents.insertText('项目长期协作');
  await click('#wsBusinessProject');
  for(const keyCode of ['End','Return']){win.webContents.sendInputEvent({type:'keyDown',keyCode});if(keyCode==='Return')win.webContents.sendInputEvent({type:'char',keyCode:'\r'});win.webContents.sendInputEvent({type:'keyUp',keyCode});await delay(60)}
  assert.equal(await js('document.querySelector("#wsBusinessProject").value'),'e2e-project');
  await click('.ws-project-folder-add');await click('.ws-project-save');await until('!document.querySelector(".ws-project-dialog")&&!!document.querySelector(".ws-project-create:not([disabled])")');
  await click('.ws-project-create:not([disabled])');
  const projectRoute=(await js('navigationCalls')).at(-1).payload;
  assert.equal(projectRoute.projectId,'e2e-project');assert.match(projectRoute.sidebarProjectId,/^project-/);assert.equal(projectRoute.cwd,'D:/isolated/project');
  await click('.ws-project-edit');await until('!!document.querySelector("#wsBusinessProject")');
  assert.equal(await js('document.querySelector("#wsBusinessProject").value'),'e2e-project');await click('.ws-project-cancel');
  report.checks.push('sidebar links the authorized Hub project separately from its local group; reopens with the link and passes actual project/cwd to new conversations');
  await load();await until('typeof Store!=="undefined"&&Store.taskState==="ready"');
  await click('button[data-rail-view="history"]');await until('!!document.querySelector("#historyBoard.show")');
  await js(`WorkspaceHost.open('detail',{taskId:${JSON.stringify(taskId)}})`);
  await until('!!document.querySelector("#rqDetailTitle")');
  assert.notEqual(await js('document.querySelector("#rqDetailTitle").textContent'),'');
  assert.equal(await js('document.querySelector(".rq-detail-eyebrow").textContent'),'需求详情');
  assert.equal(await js('document.querySelectorAll("#detailPanel,#progInput").length'),0);
   await click('.rq-detail-more summary');
   await click('[data-rq-comments-open]');
   await until('!!document.querySelector("[data-rq-evidence-modal]:not([hidden])")&&document.querySelector("[data-rq-comment-list]").textContent!=="正在加载活动记录…"');
   assert.ok(await js('document.querySelectorAll("[data-rq-comment-list] .tfd-timeline li").length>0'), 'activity includes the real Hub task events');
   assert.doesNotMatch(await js('document.querySelector("[data-rq-comment-list]").textContent'), /部分记录未能加载|agent:conversation|release[. ·]+candidate/);
   await click('[data-rq-evidence-close]');
   await until('!!document.querySelector(".rq-detail")&&!document.querySelector("[data-rq-evidence-modal]:not([hidden])")');
  await click('[data-rq-dismiss]');
  assert.equal(await js('!!document.querySelector("#historyBoard.show")'),true);
  assert.deepEqual(await js('fixtureErrors'),[]);
  fs.writeFileSync(path.join(output,'reopened.png'),(await win.webContents.capturePage()).toPNG());
  report.checks.push('complete workspace reload returns to the same Task-backed requirement pool');report.ok=true;
 }catch(error){report.error=String(error.stack||error);if(win){report.runtimeErrors=await win.webContents.executeJavaScript('window.fixtureErrors||[]').catch(()=>[]);fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());}}
 finally{clearTimeout(watchdog);fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));app.exit(report.ok?0:1);}
});
