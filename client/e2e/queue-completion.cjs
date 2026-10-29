'use strict';
// Real production preload, queue/controller components and turn queue; execution/Hub replies are isolated fixtures.
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createTurnQueue}=require('../main/pi-session/turn-queue');
const root=process.argv[2];if(!root||!path.isAbsolute(root))throw Error('Absolute evidence directory required');
fs.mkdirSync(root,{recursive:true});app.setPath('userData',path.join(root,'profile'));
const queue=createTurnQueue(),started=[],messages=[],finishers=new Map(),report={ok:false,checks:[]};
let win;const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const snapshot=()=>({status:queue.active()?'streaming':'idle',messages:messages.slice(),execution:{
 running:!!queue.active(),queue:queue.view(),turnQueue:queue.state()}});
function emit(){if(win&&!win.isDestroyed())win.webContents.send('pi-session-event',{ref:'fixture-chat',snapshot:snapshot()})}
function drain(){
 if(queue.blocked())return;const item=queue.take();if(!item)return;
 const pending=queue.run(item,()=>{
  started.push(item.text);messages.push({role:'user',text:item.text});
  return new Promise(resolve=>finishers.set(item.text,()=>{
   messages.push({role:'assistant',text:'已处理：'+item.text});resolve({ok:true});
  }));
 });emit();pending.finally(()=>{emit();queueMicrotask(drain)});
}
ipcMain.handle('pi-session-send',(_event,ref,text,attachments,options)=>{
 assert.equal(ref,'fixture-chat');const busy=queue.blocked()||queue.size()>0;
 const item=queue.add({text,attachments,options});drain();emit();
 return{ok:true,queued:!!busy,queueId:item.id,snapshot:snapshot()};
});
ipcMain.handle('pi-session-snapshot',()=>({ok:true,snapshot:snapshot()}));
const js=code=>win.webContents.executeJavaScript(code,true);
async function until(code){for(let i=0;i<200;i++){if(await js(code))return;await delay(25)}throw Error('Timeout: '+code)}
async function click(selector){
 const point=await js('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');if(!e)throw Error("Missing control");const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
 win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
 win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});await delay(40);
}
async function send(text){await click('#nchatInput');await win.webContents.insertText(text);await click('#fixtureSend')}
async function shot(name){await delay(150);fs.writeFileSync(path.join(root,name+'.png'),
 (await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG())}
async function noRows(){await until('document.querySelectorAll(".nqueue-row").length===0')}
app.whenReady().then(async()=>{
 try{
  win=new BrowserWindow({width:1160,height:820,show:false,webPreferences:{offscreen:true,backgroundThrottling:false,
   preload:path.resolve(__dirname,'../preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  await win.loadFile(path.join(__dirname,'fixtures/queue-completion.html'));await until('window.fixtureReady===true');
  await noRows();assert.match(await js('document.querySelector("#nchatQueue").innerText'),/已完成 · 1/);
  report.checks.push('restored completed task with stale waiting metadata is absent from the pending queue');
  await shot('01-completed-task');
  await send('不是很精致');await until('document.querySelector("#fixtureMessages").innerText.includes("不是很精致")');
  await send('你还能做什么');await until('document.querySelectorAll(".nqueue-row").length===1');
  const rows=await js('[...document.querySelectorAll(".nqueue-row")].map(e=>({state:e.dataset.queueState,text:e.innerText}))');
  assert.equal(rows[0].state,'queued');assert.match(rows[0].text,/你还能做什么/);
  assert.doesNotMatch(rows[0].text,/制作示例企业/);assert.deepEqual(started,['不是很精致']);
  report.checks.push('two consecutive sends: first executes, only second appears pending, original task does not reappear');
  await shot('02-second-message-queued');
  win.setSize(760,820);await delay(150);
  assert.equal(await js('document.documentElement.scrollWidth>innerWidth+1'),false);await shot('03-narrow-queue');
  win.setSize(1160,820);
  finishers.get('不是很精致')();await until('document.querySelector("#fixtureMessages").innerText.includes("你还能做什么")');
  await noRows();assert.deepEqual(started,['不是很精致','你还能做什么']);
  finishers.get('你还能做什么')();await until('!fixtureContext._snap.execution.running');await noRows();
  assert.equal(queue.size(),0);assert.deepEqual(started,['不是很精致','你还能做什么']);
  report.checks.push('second message begins only after first completes; both execute once and pending queue clears');
  await shot('04-both-completed');
  await js('configureTask("doing","waiting",{executionState:"done"})');await noRows();
  assert.equal(await js('fixtureContext._collabTasks.get("site").task.status'),'doing');
  report.checks.push('delivered but unaccepted task leaves pending list without accepting the task');
  await js('configureTask("doing","idle",null)');await noRows();
  assert.doesNotMatch(await js('document.querySelector("#nchatQueue").innerText'),/等待确认|已完成/);
  assert.equal(await js('fixtureContext._collabTasks.size'),1);
  report.checks.push('idle task association is retained without inventing confirmation or completion');
  await js('configureTask("doing","waiting-user",null)');
  await until('document.querySelectorAll(".nqueue-row").length===1');
  assert.match(await js('document.querySelector(".nqueue-row").innerText'),/等待确认/);
  report.checks.push('actual wait state remains visible');
  const loaded=new Promise(resolve=>win.webContents.once('did-finish-load',resolve));
  win.reload();await loaded;await until('window.fixtureReady===true');await noRows();
  assert.equal(await js('fixtureContext._collabTasks.size'),1);
  report.checks.push('reload keeps completed task hidden and retains task association/history');
  assert.deepEqual(await js('fixtureErrors'),[]);report.ok=true;
 }catch(error){report.error=String(error.stack||error);if(win)await shot('failure').catch(()=>{})}
 finally{fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));if(win)win.destroy();app.exit(report.ok?0:1)}
});
setTimeout(()=>{fs.writeFileSync(path.join(root,'timeout.txt'),'queue completion E2E timed out');app.exit(1)},45000).unref();
