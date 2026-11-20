'use strict';
// Production api.js timeout and HTTP endpoint, with real slow WS fanout in the
// isolated Hub. No endpoint, publish method, or client timeout is replaced.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const [output,hub,...args]=process.argv.slice(2),expectRegression=args.includes('--expect-regression');
if(!path.isAbsolute(output||'')||!/^http:\/\/127\.0\.0\.1:\d+$/.test(hub||''))throw Error('Isolated target required');
fs.mkdirSync(output,{recursive:true});app.setPath('userData',path.join(output,'profile'));
const report={ok:false,expectRegression,suiteVersion:'manual-submit-race/1',sourceSHA256:crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),http:[],boundary:'Windows Electron production requirements renderer/api.js and real disposable Hub/SQLite. 97 authorized synthetic stalled WebSocket recipients exercise real 32-wide fanout and 3s send timeouts. Native generation is represented by one deterministic file. No real accounts or remote messages.'};
const wait=ms=>new Promise(r=>setTimeout(r,ms));let win,identity;
async function call(route,method='GET',body){const r=await fetch(hub+'/api/v1'+route,{method,headers:{Authorization:'Device '+identity.session,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();report.http.push({route,method,status:r.status,body,ok:data.ok,stage:data.requirementStage||data.task?.requirementStage});assert.equal(r.status,200,JSON.stringify(data));return data;}
const js=source=>win.webContents.executeJavaScript(`(async()=>{try{return await(0,eval)(${JSON.stringify(source)})}catch(e){return{fixtureError:e.stack}}})()`,true).then(v=>{if(v?.fixtureError)throw Error(v.fixtureError);return v;});
async function click(selector){const p=await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled||!e.checkVisibility())throw Error('Unavailable control');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,...p,button:'left',clickCount:1});await wait(80);}
async function until(check,label,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await wait(50);}throw Error('Timed out: '+label);}
async function shot(name){fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG());}
app.whenReady().then(async()=>{
 report.runtime={platform:process.platform,electron:process.versions.electron,node:process.versions.node};
 const enrollment=await fetch(hub+'/api/v1/clients/enroll',{method:'POST',headers:{'Content-Type':'application/json','X-Device-Key':'isolated-requirements-fixture-key-never-production'},body:JSON.stringify({device:'e2e-recipient',name:'Manual acceptance timeout fixture'})});assert.equal(enrollment.status,200);identity={hub,clientId:'e2e-recipient',session:(await enrollment.json()).session};
 const id='manual-acceptance-slow-fanout',route='/tasks/'+id;
 await call(route,'PUT',{title:'Manual acceptance with slow recipient notifications',status:'todo',triageStage:'ready',kind:'requirement',acceptanceCriteria:['Deliver final text']});
 const scope={conversationId:id+'-chat',turnId:id+'-turn',executor:'native',submissionMode:'manual'};
 for(const action of ['prepare','start'])await call(route+'/conversation-turn','POST',{...scope,action});
 const cwd=fs.mkdtempSync(path.join(output,'work-'));const since=Date.now();fs.writeFileSync(path.join(cwd,'final.txt'),'Completed manual acceptance result');
 const stream=require('../main/pi-session/event-stream').create();stream.push({type:'message_end',message:{role:'user',content:'Produce final text'}});stream.appendAssistant('Delivered [final.txt](final.txt)');
 const handle={cwd,sessionId:scope.conversationId,snapshot:()=>stream.snapshot(),outputSnapshot:()=>require('../main/pi-session/outputs').scan(cwd,0,since)};
 const delivery=require('../main/pi-session/task-delivery.cjs');const payload=await delivery.capture(handle,'completed');assert.equal(payload.files.length,1);await delivery.send(identity,route,scope,payload);await call(route+'/conversation-turn','POST',{...scope,action:'complete'});
 win=new BrowserWindow({show:false,width:1280,height:1000,webPreferences:{contextIsolation:true,sandbox:true,offscreen:true,partition:'manual-submit-race'}});
 await win.loadFile(path.join(__dirname,'fixtures/requirements-integration.html'),{query:{hub,identity:'recipient'}});assert.equal(await js('fixtureReady'),'ready');
 for(const name of ['task-trace-view','task-trace-runtime','panels-forward-options'])await js(fs.readFileSync(path.join(__dirname,'../components/panels',name+'.js'),'utf8'));
 await win.webContents.insertCSS(fs.readFileSync(path.join(__dirname,'../components/panels/task-trace-view.css'),'utf8'));
 await js(`window.submitRequests=[];const original=window.fetch;window.fetch=async(...args)=>{const target=String(args[0]).endsWith('/submit-review');const row=target?{url:String(args[0]),method:args[1]?.method,body:args[1]?.body||'',started:performance.now()}:null;if(row)submitRequests.push(row);try{const response=await original(...args);if(row){row.elapsed=performance.now()-row.started;row.status=response.status;const data=await response.clone().json();row.response={ok:data.ok,already:data.already,stage:data.task?.requirementStage};}return response;}catch(error){if(row){row.elapsed=performance.now()-row.started;row.error=String(error);row.name=error.name;}throw error;}};void 0;`);
 await js(`RequirementsDetail.open(${JSON.stringify(id)})`);await click('[data-rq-execution]>summary');
 await until(()=>js(`!!document.querySelector('[data-rq-trace] .tfd-root, [data-rq-trace] .tfd-journey, [data-rq-trace] [class]')`),'real trace mounted');
 report.traceMounted=await js(`document.querySelector('[data-rq-trace]').innerText.length>0`);
 report.slowSockets=await(await fetch(hub+'/e2e/slow-sockets',{method:'POST'})).json();assert.equal(report.slowSockets.registered,97);
 await click('.rq-detail-more>summary');await click('[data-rq-submit-review]');
 await until(()=>js('submitRequests.some(row=>row.status||row.error)'),'real HTTP submission settles');
 await wait(100);
 report.request=await js('submitRequests');report.task=await call(route);report.persisted=await(await fetch(hub+'/e2e/manual-state/'+id)).json();
 report.ui=await js(`({drawers:document.querySelectorAll('.rq-detail-backdrop').length,submitExists:!!document.querySelector('[data-rq-submit-review]'),submitDisabled:document.querySelector('[data-rq-submit-review]')?.disabled,error:document.querySelector('[data-rq-error]')?.textContent,text:document.body.innerText,errors:fixtureErrors})`);
 await shot('after-manual-submit');
 if(report.ui.drawers&&report.ui.submitDisabled===false){
  await js(`document.querySelector('[data-rq-error]').scrollIntoView({block:'center',behavior:'instant'})`);
  await shot('submission-timeout-error');
  if(!await js(`document.querySelector('.rq-detail-more').open`))await click('.rq-detail-more>summary');
  report.ui.retryVisibility=await js(`(()=>{const e=document.querySelector('[data-rq-submit-review]'),r=e.getBoundingClientRect(),s=getComputedStyle(e);return{text:e.textContent,disabled:e.disabled,checkVisibility:e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}),display:s.display,visibility:s.visibility,rect:{x:r.x,y:r.y,width:r.width,height:r.height},inViewport:r.width>0&&r.height>0&&r.top>=0&&r.bottom<=innerHeight}})()`);
  assert.equal(report.ui.retryVisibility.checkVisibility,true);assert.equal(report.ui.retryVisibility.inViewport,true);
  await shot('submission-timeout-retry-enabled');
 }
 assert.equal(report.request.length,1);assert.equal(report.task.requirementStage,'reviewing');assert.equal(report.persisted.approvalIds.length,1);assert.equal(report.persisted.artifactIds.length,1);
 if(expectRegression){assert.ok(report.request[0].elapsed>=7900);assert.ok(report.request[0].error);assert.equal(report.ui.drawers,1);assert.equal(report.ui.submitDisabled,false);report.fixInvariantPassed=false;}
 else {assert.equal(report.request[0].status,200);assert.ok(report.request[0].elapsed<8000);assert.equal(report.ui.drawers,0);assert.equal(report.ui.submitExists,false);report.fixInvariantPassed=true;}
 assert.deepEqual(report.ui.errors,[]);report.ok=true;
}).catch(async error=>{report.error=error.stack||String(error);if(win&&!win.isDestroyed()){report.failureUI=await js('({text:document.body.innerText,errors:fixtureErrors})').catch(()=>null);await shot('failure').catch(()=>{});}}).finally(async()=>{
 await fetch(hub+'/e2e/slow-sockets/disarm',{method:'POST'}).catch(()=>{});await require('../main/app-resource-cache.cjs').close();win?.destroy();fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));app.exit(report.ok?0:1);
});
