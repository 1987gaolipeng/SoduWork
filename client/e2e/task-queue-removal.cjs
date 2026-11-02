'use strict';
// Real queue/picker/controller UI with durable Chromium storage in its own profile.
// Fixture APIs only: no Hub connection, real task execution or user's client restart.
const {app,BrowserWindow}=require('electron');
app.disableHardwareAcceleration();
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=process.argv[2],phase=process.argv[3]||'exercise';
if(!root||!path.isAbsolute(root))throw Error('Absolute isolated evidence directory required');
if(!['exercise','restart'].includes(phase))throw Error('Unknown phase');
fs.mkdirSync(root,{recursive:true});
app.setPath('userData',path.join(root,'profile'));
const report={phase,ok:false,electron:process.versions.electron,checks:[]};let win;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const fixture=path.join(__dirname,'fixtures/task-queue-removal.html');
const evaluate=source=>win.webContents.executeJavaScript(source,true);
async function waitFor(source){
 const end=Date.now()+10000;
 while(Date.now()<end){if(await evaluate(source))return;await delay(30)}
 throw Error('Timed out: '+source);
}
async function click(selector){
 await delay(400); // Let the product's picker entrance animation settle.
 const point=await evaluate('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');if(!e)throw Error("Missing button: "+'+JSON.stringify(selector)+');e.scrollIntoView({block:"nearest"});const r=e.getBoundingClientRect();const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);const hit=document.elementFromPoint(x,y);return{x,y,matched:e.contains(hit),hit:hit?.outerHTML.slice(0,400)}})()');
 assert.ok(point.matched,selector+' is obstructed: '+JSON.stringify(point));
 delete point.matched;delete point.hit;
 win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
 win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
 await delay(60);
}
const row=id=>'[data-queue-row="queued:'+id+'"]';
async function visible(id,wanted=true){await waitFor('!!document.querySelector('+JSON.stringify(row(id))+')==='+wanted)}
async function add(id){
 await click('[data-queue-action="add"]');
  await waitFor('!!document.querySelector(\'.ncollab-picker-row[data-collab-task-select="'+id+'"]:not([hidden])\')');
  await click('.ncollab-picker-row[data-collab-task-select="'+id+'"]');
  await waitFor('!!document.querySelector("[data-collab-picker-submit]") || !!document.querySelector('+JSON.stringify(row(id))+')');
  if(await evaluate('!!document.querySelector("[data-collab-picker-submit]")')) await click('[data-collab-picker-submit]');
  await visible(id);
}
async function shot(name){
 await delay(80);
 fs.writeFileSync(path.join(root,name+'.png'),(await win.webContents.capturePage()).toPNG());
}
app.whenReady().then(async()=>{
 try{
  win=new BrowserWindow({width:1160,height:900,show:false,webPreferences:{
   offscreen:true,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  await win.loadFile(fixture);await waitFor('window.fixtureReady===true');
  if(phase==='restart'){
   await visible('one',false);await visible('two',false);
   assert.equal(await evaluate('sent.length'),0);
   assert.equal(await evaluate('tasks.length'),2);
   assert.equal(await evaluate('ChatCollaborationStore.isQueueRemoved("chat-a","one")'),true);
   report.checks.push('new Electron process with the same isolated profile keeps both removed tasks hidden');
   await shot('05-process-restart');
  }else{
   await add('one');await add('two');
   assert.equal(await evaluate('sent.length'),2);
   assert.equal(await evaluate('sent.every(item=>item.options.taskExecution.reuseConversation===true)'),true);
   report.checks.push('explicit picker confirmation queues each task once in the current conversation');
   await shot('01-added-unsent');
   await click(row('one')+' [data-queue-action="remove"]');
   await visible('one',false);await visible('two');
   assert.equal(await evaluate('tasks.length'),2);
   report.checks.push('trash removes only the first pending queue row, not the business task');
   await evaluate('openFixture("chat-b");openFixture("chat-a")');
   await visible('one',false);await visible('two');
   report.checks.push('leave and re-enter restores only the retained pending task');
   await shot('02-reentered');
   await win.loadFile(fixture);await waitFor('window.fixtureReady===true');
   await visible('one',false);await visible('two');
   report.checks.push('document reload preserves removal despite old session bindings');
   await shot('03-reloaded');
   await add('one');
   // Reload resets the submission log while the simulated runtime keeps its pending queue.
   await waitFor('sent.length===1');
   assert.equal(await evaluate('sent[0].text'),'保留任务完整说明和材料');
   assert.equal(await evaluate('sent[0].options.taskId'),'one');
   assert.equal(await evaluate('fixtureContext._collabTasks.get("one").task.attachments[0].name'),'需求材料.txt');
   await visible('one');
   assert.equal(await evaluate('ChatCollaborationStore.isQueueRemoved("chat-a","one")'),false);
   report.checks.push('explicit re-add clears dismissal, queues once and retains materials');
   await click(row('one')+' [data-queue-action="remove"]');
   await click(row('two')+' [data-queue-action="remove"]');
   await visible('one',false);await visible('two',false);
   await win.loadFile(fixture);await waitFor('window.fixtureReady===true');
   await visible('one',false);await visible('two',false);
   assert.equal(await evaluate('tasks.length'),2);
   report.checks.push('removing every queue task stays empty after reload; both original tasks remain');
   await shot('04-all-removed');
  }
  assert.deepEqual(await evaluate('fixtureErrors'),[]);
  report.checks.push('no renderer errors or unhandled promise rejections');
  win.webContents.session.flushStorageData();
  report.ok=true;
 }catch(error){
  report.error=String(error.stack||error);
  if(win){
   report.diagnostics=await evaluate('({errors:window.fixtureErrors,notices:window.notices,picker:window.fixtureContext?._collabPicker,openError:window.fixtureContext?._taskOpenError,prompt:window.fixtureContext?._taskStartPrompt,body:document.body.innerText})').catch(()=>null);
   await shot(phase+'-failure').catch(()=>{});
  }
 }
 finally{
  fs.writeFileSync(path.join(root,phase+'-report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));if(win)win.destroy();app.exit(report.ok?0:1);
 }
});
