'use strict';
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=process.argv[2];if(!root||!path.isAbsolute(root))throw Error('Absolute evidence directory required');
fs.mkdirSync(root,{recursive:true});app.setPath('userData',path.join(root,'handoff-profile'));
const report={ok:false,isolated:true,backend:'controlled fixture; no live task was forwarded',scenarios:[]};let win;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 try{
 win=new BrowserWindow({width:1000,height:840,show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,offscreen:true}});
 const errors=[];win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message)});
 await win.loadFile(path.join(__dirname,'fixtures/task-handoff.html'));
 const evaluate=s=>win.webContents.executeJavaScript(s,true);
 for(const kind of ['assigned','self']){
  await evaluate('openScenario('+JSON.stringify(kind)+')');
  await evaluate('document.querySelector("#cpExpand")?.click()');
  assert.equal(await evaluate('document.querySelector("#cpKind").value'),kind==='self'?'ticket':'bug');
  assert.equal(await evaluate('!!document.querySelector("[data-selbtn=scene],[data-selbtn=flow],[data-selbtn=repo]")'),false);
  assert.deepEqual(await evaluate('calls.execution'),[],'创建不依赖工作场景或在线执行器目录');
  await wait(150);
  fs.writeFileSync(path.join(root,'creation-'+kind+'.png'),(await win.webContents.capturePage()).toPNG());
  await evaluate('document.querySelector("#cpCreate").click();document.querySelector("#cpCreate").click()');
  let state;
  for(let i=0;i<100;i++){state=await evaluate('({text:document.querySelector("#cpDraft").textContent,calls})');if(state.text.includes('已创建'))break;await wait(50);}
  assert.match(state.text,/已创建/);
  assert.equal(state.calls.uploads.length,2,'all materials uploaded once');
  assert.equal(state.calls.uploads[0].name,'说明.txt');assert.ok(state.calls.uploads[0].bytes.length);
  assert.equal(state.calls.uploads[1].name,'截图.png');
  if(kind==='self'){assert.ok(state.calls.bound.length>0);assert.equal(state.calls.persisted.length,1);assert.equal(await evaluate('tasks[0].kind'),'ticket');}
  else{
   assert.equal(state.calls.created.length,1,'double click must not duplicate task');
   assert.equal(state.calls.bound.length,0,'transferred task must not bind to sender');
   assert.equal(state.calls.opened.length,0);
   assert.match(state.calls.created[0].body.note,/原始任务说明/);
   assert.match(state.calls.created[0].body.note,/图片可复制并粘贴/);
   assert.equal(state.calls.created[0].body.assigneeUserId,'recipient-1');
   assert.equal(state.calls.created[0].body.kind,'bug');
   assert.equal(state.calls.created[0].body.workScenarioKey,undefined);
   assert.doesNotMatch(state.text,/进入协作/);
   await evaluate('document.querySelector("#cpOpen").click()');
   assert.equal(await evaluate('calls.details.length'),1);
   assert.equal(await evaluate('calls.bound.length'),0);
  }
  const layout=await evaluate('(()=>{const r=document.querySelector("#cpOpen").getBoundingClientRect();const svg=document.querySelector(".cp-card-head svg").getBoundingClientRect();return {bottom:r.bottom,width:r.width,viewport:innerHeight,icon:svg.width}})()');
  assert.ok(layout.bottom<layout.viewport&&layout.width>0&&layout.icon<=32,'receipt must be visible and correctly styled');
  const screenshot=path.join(root,'handoff-'+kind+'.png');fs.writeFileSync(screenshot,(await win.webContents.capturePage()).toPNG());
  await evaluate('document.querySelector("[data-cp-receipt-close]").click()');
  assert.equal(await evaluate('document.querySelector("#cpDraft").classList.contains("show")'),false);
  report.scenarios.push({kind,success:true,creations:state.calls.created.length,bindings:state.calls.bound.length,uploaded:state.calls.uploads.map(f=>f.name),screenshot});
 }
 report.rendererErrors=errors;assert.deepEqual(errors,[]);report.ok=true;
 }catch(error){report.error=String(error.stack||error)}
 finally{fs.writeFileSync(path.join(root,'handoff-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));app.exit(report.ok?0:1)}
});
