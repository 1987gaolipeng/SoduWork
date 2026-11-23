'use strict';
// Real production capture/upload/Hub acceptance and requirement-detail UI.
// Files replace model generation; all accounts and HTTP storage are isolated.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto'),zlib=require('node:zlib');
const [output,hub,...args]=process.argv.slice(2),expectRegression=args.includes('--expect-regression');
if(!path.isAbsolute(output||'')||!/^http:\/\/127\.0\.0\.1:\d+$/.test(hub||''))throw Error('Isolated target required');
fs.mkdirSync(output,{recursive:true});app.setPath('userData',path.join(output,'profile'));
const report={ok:false,expectRegression,cases:[],http:[],uploads:[],boundary:'Windows Electron production requirement renderer, capture/send, acceptance task-input and real isolated Hub/SQLite. Synthetic files replace model generation; no live account or external service.'};
const wait=ms=>new Promise(r=>setTimeout(r,ms)), hash=b=>crypto.createHash('sha256').update(b).digest('hex');
let win,identity;
const contextSummary=value=>({attachmentIds:value.attachmentIds,artifactVersionId:value.artifactVersionId,approvalId:value.approvalId,requirementVersion:value.requirementVersion,
 attachments:value.attachments?.map(f=>({id:f.id,filename:f.filename,role:f.role,category:f.category,evidenceMeta:f.evidenceMeta})),deliveryBundle:value.deliveryBundle&&{filename:value.deliveryBundle.filename,fileCount:value.deliveryBundle.fileCount,attachmentIds:value.deliveryBundle.attachmentIds}});
const originalFetch=global.fetch;
global.fetch=async(url,options)=>{
 if(String(url).endsWith('/conversation-delivery')&&options?.body instanceof FormData){const form=options.body,files=[];for(const f of form.getAll('files'))files.push({name:f.name,type:f.type,sha256:hash(Buffer.from(await f.arrayBuffer()))});report.uploads.push({url:String(url),method:options.method,conversationId:form.get('conversationId'),turnId:form.get('turnId'),paths:form.getAll('paths'),categories:form.getAll('categories'),files});}
 return originalFetch(url,options);
};
async function json(route,method='GET',body){const r=await fetch(hub+'/api/v1'+route,{method,headers:{Authorization:'Device '+identity.session,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();report.http.push({route,method,status:r.status,request:body,response:{ok:data.ok,id:data.id,stage:data.requirementStage||data.task?.requirementStage,artifactVersionId:data.artifactVersionId,attachmentIds:data.attachmentIds}});assert.equal(r.status,200,JSON.stringify(data));return data;}
function zipNames(bytes){const result=[];let at=0;while(bytes.readUInt32LE(at)===0x04034b50){assert.equal(bytes.readUInt16LE(at+6)&8,0);const method=bytes.readUInt16LE(at+8),size=bytes.readUInt32LE(at+18),n=bytes.readUInt16LE(at+26),e=bytes.readUInt16LE(at+28),start=at+30+n+e;const name=bytes.subarray(at+30,at+30+n).toString();const raw=bytes.subarray(start,start+size);result.push({name,sha256:hash(method===8?zlib.inflateRawSync(raw):raw)});at=start+size;}return result;}
const js=source=>win.webContents.executeJavaScript(`(async()=>{try{return await(0,eval)(${JSON.stringify(source)})}catch(e){return{fixtureError:e.stack}}})()`,true).then(v=>{if(v?.fixtureError)throw Error(v.fixtureError);return v;});
async function click(selector){const p=await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled||!e.checkVisibility())throw Error('Unavailable control');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,...p,button:'left',clickCount:1});await wait(100);}
async function until(check,label){for(let i=0;i<100;i++){if(await check())return;await wait(50);}throw Error('Timed out: '+label);}
async function shot(name){fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG());}
app.whenReady().then(async()=>{
 report.runtime={platform:process.platform,electron:process.versions.electron,node:process.versions.node};
 const enrollment=await fetch(hub+'/api/v1/clients/enroll',{method:'POST',headers:{'Content-Type':'application/json','X-Device-Key':'isolated-requirements-fixture-key-never-production'},body:JSON.stringify({device:'e2e-recipient',name:'Renamed rework fixture'})});assert.equal(enrollment.status,200);
 identity={hub,clientId:'e2e-recipient',session:(await enrollment.json()).session};
 win=new BrowserWindow({show:false,width:1280,height:1000,webPreferences:{contextIsolation:true,sandbox:true,offscreen:true,partition:'renamed-rework'}});
 await win.loadFile(path.join(__dirname,'fixtures/requirements-integration.html'),{query:{hub,identity:'recipient'}});assert.equal(await js('fixtureReady'),'ready');
 await js(`window.submissions=[];const original=window.fetch;window.fetch=async(...args)=>{const response=await original(...args);if(String(args[0]).includes('/submit-review')){const data=await response.clone().json();submissions.push({url:String(args[0]),method:args[1]?.method,body:args[1]?.body||'',status:response.status,response:{ok:data.ok,already:data.already,stage:data.task?.requirementStage,approvalId:data.request?.id}});}return response;};void 0;`);
 const capture=require('../main/pi-session/task-delivery.cjs');
 const scenarios=[{key:'auto',mode:'auto'},{key:'manual',mode:'manual'},
  {key:'multiple-linked',mode:'auto',multiple:true},{key:'website-dependency',mode:'auto',dependency:true}];
 for(const scenario of scenarios){
  const {mode}=scenario,id='ordinary-renamed-'+scenario.key,route='/tasks/'+id,cwd=fs.mkdtempSync(path.join(output,'work-'+scenario.key+'-'));
  if(scenario.dependency){fs.mkdirSync(path.join(cwd,'assets'));fs.writeFileSync(path.join(cwd,'assets/style.css'),'body{color:navy}');const old=new Date(Date.now()-30000);fs.utimesSync(path.join(cwd,'assets/style.css'),old,old);}
  await json(route,'PUT',{title:'Ordinary renamed revision '+mode,status:'todo',triageStage:'ready',kind:'requirement',acceptanceCriteria:['The revised final report uses the corrected amount.']});
  const accumulator=require('../main/pi-session/event-stream').create();let since=Date.now();const conversationId=id+'-chat';
  const handle={cwd,sessionId:conversationId,snapshot:()=>accumulator.snapshot(),outputSnapshot:()=>require('../main/pi-session/outputs').scan(cwd,0,since)};
  const evidence={key:scenario.key,mode,rounds:[]};report.cases.push(evidence);
  for(const round of [1,2]){
   if(round===2)await wait(30);since=Date.now();
   const scope={conversationId,turnId:id+'-turn-'+round,executor:'native',submissionMode:mode};
   for(const action of ['prepare','start'])await json(route+'/conversation-turn','POST',{...scope,action});
   const name=round===1?'report.md':scenario.dependency?'report-v2.html':'report-v2.md';
   const bytes=Buffer.from(round===1?'# Report\nREJECTED amount: 10':scenario.dependency?'<html><head><link rel="stylesheet" href="assets/style.css"></head><body>FINAL corrected amount: 20</body></html>':'# Final report\nFINAL corrected amount: 20');
   if(round===2)fs.writeFileSync(path.join(cwd,'report.md'),'# Intermediate edit\nREJECTED: intermediate working draft, not the final delivery');
   fs.writeFileSync(path.join(cwd,name),bytes);
   if(round===2&&scenario.multiple)fs.writeFileSync(path.join(cwd,'handoff.md'),'# Handoff\nBoth linked deliverables are required.');
   const expected=round===1?['report.md']:[name,...(scenario.multiple?['handoff.md']:scenario.dependency?['assets/style.css']:[])].sort();
   accumulator.push({type:'message_end',message:{role:'user',content:round===1?'Create the report.':'The amount in paragraph two is incorrect. Please revise it to 20.'}});
   accumulator.push({type:'message_start',message:{role:'assistant'}});
   accumulator.push({type:'message_update',assistantMessageEvent:{type:'text_end',contentIndex:0,content:'Completed report: ['+name+']('+name+')'+(round===2&&scenario.multiple?' and [handoff](handoff.md)':'')}});
   accumulator.push({type:'message_end',message:{role:'assistant',stopReason:'stop'}});accumulator.push({type:'agent_settled'});
   const payload=await capture.capture(handle,'completed');assert.ok(payload);
   const upload=await capture.send(identity,route,scope,payload);await json(route+'/conversation-turn','POST',{...scope,action:'complete'});
   if(mode==='manual'){
    await js(`(async()=>{await Store.refreshTasks();await RequirementsDetail.open(${JSON.stringify(id)})})()`);
    await click('.rq-detail-more>summary');await click('[data-rq-submit-review]');
    await until(()=>js(`document.querySelectorAll('.rq-detail-backdrop').length===0`),'manual submission closes detail');
   }
   const context=await json(route+'/acceptance-context');
   const prepared=await require('../main/pi-session/task-input').prepare(identity,id,id+'-review-'+round,'review','Review the corrected report',{acceptanceOnly:true,acceptanceMode:'auto'},{handle:{cwd,sessionId:id+'-review-'+round}});
   await prepared.beforeTurn();
   const record={round,name,expected,actualEventSnapshot:accumulator.snapshot().messages,filesStillOnDisk:fs.readdirSync(cwd),captured:payload.files.map(f=>({name:f.name,sha256:hash(Buffer.from(f.data,'base64'))})),upload:{ok:upload.ok,files:upload.files,round:upload.round},context:contextSummary(context),
    runtimeInputs:prepared.attachments.map(f=>({name:f.name,mimeType:f.mimeType,sha256:hash(f.data),sourceAttachmentIds:f.evidenceMeta?.sourceAttachmentIds,zipEntries:f.mimeType==='application/zip'?zipNames(f.data):undefined}))};
   evidence.rounds.push(record);
   await js(`(async()=>{await Store.refreshTasks();await RequirementsDetail.open(${JSON.stringify(id)})})()`);
   record.visibleCurrent=await js(`document.querySelector('[data-rq-material-group="output"]').textContent`);
   record.visibleFiles=await js(`Array.from(document.querySelectorAll('[data-rq-material-group="output"] [data-rq-file-id]'),e=>e.dataset.rqFileId)`);
   await click('[data-rq-material-group="output"]>summary');await shot(scenario.key+'-round-'+round);
   await js('RequirementsDetail.close(true)');
   if(round===1)await json('/approvals/'+context.approvalId+'/decision','POST',{decision:'reject',note:'The amount in paragraph two is incorrect. Please revise it to 20.'});
   else {
    const names=context.attachments.map(f=>f.filename);
    if(expectRegression){assert.deepEqual(names.slice().sort(),[...expected,'report.md'].sort());assert.equal(prepared.attachments[0].mimeType,'application/zip');evidence.fixInvariantPassed=false;}
    else {
     assert.deepEqual(names.slice().sort(),expected);assert.equal(prepared.attachments.length,1);
     if(expected.length===1){assert.equal(context.deliveryBundle,null);assert.equal(prepared.attachments[0].name,name);assert.deepEqual(prepared.attachments[0].data,bytes);}
     else {assert.equal(prepared.attachments[0].mimeType,'application/zip');assert.deepEqual(zipNames(prepared.attachments[0].data).map(f=>f.name).sort(),expected);}
     assert.doesNotMatch(record.visibleCurrent,/report\.md/);evidence.fixInvariantPassed=true;
    }
    assert.equal(fs.readFileSync(path.join(cwd,'report.md'),'utf8').includes('REJECTED'),true,'History is retained on disk');
   }
  }
 }
 report.rendererRequests=await js('submissions');assert.deepEqual(await js('fixtureErrors'),[]);report.ok=true;
}).catch(async error=>{report.error=error.stack||String(error);if(win&&!win.isDestroyed()){report.rendererRequests=await js('submissions').catch(()=>[]);report.ui=await js('({text:document.body.innerText,errors:fixtureErrors})').catch(()=>null);await shot('failure').catch(()=>{});}}).finally(async()=>{
 global.fetch=originalFetch;await require('../main/app-resource-cache.cjs').close();win?.destroy();fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));app.exit(report.ok?0:1);
});
