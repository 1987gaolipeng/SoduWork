import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {CdpPage,listPages,delay} from './lib/cdp.mjs';

// One new chat and one explicit test task; never dispatch an existing user task.
const [targetId,dir]=process.argv.slice(2);
assert.ok(targetId&&dir,'Pass an isolated target and evidence directory');
const target=(await listPages(9347)).find(x=>x.id===targetId&&x.url.includes('panel=workspace&view=history'));
assert.ok(target,'An explicitly selected isolated renderer is required');
const p=await CdpPage.connect(target), checks=[], taskId=randomUUID();
let created=false,finished=false,sessionId='';
const title='E2E 混合队列 · 验证任务材料 '+Date.now();
async function click(s){const r=await p.run(s=>{const e=document.querySelector(s);if(!e)throw Error('Missing '+s);e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};},s);
  for(const type of ['mousePressed','mouseReleased'])await p.call('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...r});}
async function shot(name){const s=await p.call('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(dir,name+'.png'),Buffer.from(s.data,'base64'));}
async function send(text,initial=false){await p.waitFor(initial=>{const e=document.querySelector(initial?'#cpInput':'#nchatInput');return e&&e.getBoundingClientRect().height>0},initial,20000);
  await p.run(({text,initial})=>{const e=document.querySelector(initial?'#cpInput':'#nchatInput');e.value=text;e.dispatchEvent(new Event('input',{bubbles:true}));},{text,initial});await click(initial?'#cpGo':'#nchatSend');}
const snap=()=>p.run(async()=>(await soduWorkAPI.conversationSession.snapshot(NativeChat.sessionInfo().ref)).snapshot);
async function idle(){await p.waitFor(()=>NativeChat.hasSession()&&!NativeChat.isBusy(),null,150000);}
async function geometry(empty){const g=await p.run(()=>{
  const r=e=>e.getBoundingClientRect().toJSON(),add=document.querySelector('[data-queue-action="add"]'),box=document.querySelector('.nbox');
  return {add:r(add),box:r(box),radius:getComputedStyle(add).borderRadius,
    fonts:[...document.querySelectorAll('#nchatQueue *')].filter(e=>r(e).height&&[...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim())).map(e=>parseFloat(getComputedStyle(e).fontSize)),
    pageOverflow:document.documentElement.scrollWidth-innerWidth};});
  assert.equal(g.radius,'999px');assert.ok(g.add.width>g.add.height*2);assert.ok(Math.min(...g.fonts)>=12);
  assert.ok(g.pageOverflow<=1);if(empty)assert.ok(Math.abs(g.add.x+g.add.width/2-g.box.x-g.box.width/2)<2);
  return g;
}
try{
  await fs.mkdir(dir,{recursive:true});await p.call('Page.reload',{ignoreCache:true});
  await p.waitFor(()=>window.NativeChat&&window.SoduWorkAPI?.online,null,20000);
  assert.equal(await p.run(()=>NativeChat.isBusy()),false,'Do not interrupt a running session');
  await p.call('Emulation.setDeviceMetricsOverride',{width:1680,height:1050,deviceScaleFactor:1,mobile:false});
  await click('.ws-nav-item[data-view="create"]');
  await send('这是独立的界面回归测试。只回复 CHAT-REFINEMENT-PASS。不使用工具、不修改文件。',true);
  await p.waitFor(()=>NativeChat.sessionInfo().ref,null,45000);await idle();
  const first=await snap();assert.ok(first.messages.some(m=>m.role==='assistant'&&JSON.stringify(m.blocks||m.text).includes('CHAT-REFINEMENT-PASS')));
  sessionId=await p.run(()=>NativeChat.sessionInfo().sessionId);checks.push({name:'Ordinary chat uses the existing message stream',passed:true,sessionId});
  checks.push({name:'Empty capsule centered above unchanged composer',...(await geometry(true))});await shot('queue-01-empty-pill');
  await click('[data-queue-action="add"]');await p.waitFor(()=>document.querySelector('[data-collab-search]'));await click('[data-collab-picker-close]');
  checks.push('Empty capsule opens and closes task picker');

  const saved=await p.run(async({taskId,title})=>{
    const auth=SoduWorkAPI.clientAuthSnapshot();
    await SoduWorkAPI.putTask(taskId,{id:taskId,title,note:'这是独立的队列验证任务。读取随任务附上的 queue-brief.txt，回复 TASK-MATERIAL-PASS 和文件中的验证标记。不修改任何业务文件，不发布。',
      status:'todo',source:'E2E 界面回归',ownerClientId:auth.clientId,createdBy:auth.user?.id||'',created:Date.now(),origin:'local'});
    await SoduWorkAPI.uploadAttachment(taskId,new File(['材料验证标记：MIXED-ATTACHMENT-PASS'],'queue-brief.txt',{type:'text/plain'}));
    return !!(await SoduWorkAPI.getTask(taskId))?.id;
  },{taskId,title});
  assert.ok(saved);created=true;
  await send('仅执行一次 node -e "setTimeout(()=>console.log(\'WAIT-REFINEMENT-DONE\'),60000)"，等待结束后只回复 WAIT-REFINEMENT-DONE。不要读写文件。');
  await p.waitFor(async()=>{const s=(await soduWorkAPI.conversationSession.snapshot(NativeChat.sessionInfo().ref)).snapshot;return s.tools.some(t=>t.state==='running')||s.runtimeError},null,60000);
  assert.ok((await snap()).tools.some(t=>t.state==='running'),'A real tool turn must still be executing');
  await send('只回复 FOLLOW-UP-PASS，不使用工具。');
  await click('[data-queue-action="add"]');
  await p.waitFor(id=>document.querySelector('[data-collab-task-select="'+id+'"]'),taskId,10000);
  await shot('queue-02-task-picker');await click('[data-collab-task-select="'+taskId+'"]');
  await p.waitFor(async id=>(await soduWorkAPI.conversationSession.snapshot(NativeChat.sessionInfo().ref)).snapshot.execution.queue.some(r=>r.taskId===id),taskId,15000);
  await send('REMOVE-THIS-QUEUED-TURN，不要执行。');
  await p.waitFor(async()=>(await soduWorkAPI.conversationSession.snapshot(NativeChat.sessionInfo().ref)).snapshot.execution.queue.length===3,null,10000);
  const q=(await snap()).execution.queue, task=q.find(r=>r.taskId===taskId), message=q.find(r=>r.text.includes('FOLLOW-UP-PASS')),removed=q.find(r=>r.text.includes('REMOVE-THIS'));
  assert.ok(task.attachments.includes('queue-brief.txt'));
  await click('[data-queue-action="remove"][data-queue-id="'+removed.id+'"]');
  await click('[data-queue-action="edit"][data-queue-id="'+task.id+'"]');
  await p.run(()=>{document.querySelector('#nqueueEditText').value+='\n补充要求：务必返回 TASK-MATERIAL-PASS 和附件标记。';});
  await click('[data-queue-action="save-edit"]');
  const points=await p.run(({from,to})=>{const a=document.querySelector('[data-queue-grip="'+from+'"]').getBoundingClientRect(),b=document.querySelector('[data-queue-row="'+to+'"]').getBoundingClientRect();return {from:{x:a.x+a.width/2,y:a.y+a.height/2},to:{x:a.x+a.width/2,y:b.y+5}}},{from:task.id,to:message.id});
  await p.call('Input.dispatchMouseEvent',{type:'mouseMoved',...points.from});
  await p.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...points.from});
  for(let n=1;n<=12;n++)await p.call('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:points.from.x,y:points.from.y+(points.to.y-points.from.y)*n/12});
  await p.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',...points.to});
  await p.waitFor(async id=>(await soduWorkAPI.conversationSession.snapshot(NativeChat.sessionInfo().ref)).snapshot.execution.queue[0]?.id===id,task.id,7000);
  assert.equal(await p.run(()=>NativeChat.sessionInfo().sessionId),sessionId);
  assert.deepEqual(await p.run(()=>[...document.querySelectorAll('[data-queue-draggable]')].map(e=>e.dataset.queueKind)),['task','message']);
  checks.push({name:'Real task + ordinary message in one queue; edit, remove and pointer drag preserve task attachment and conversation',passed:true});
  await p.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:700,y:150});await shot('queue-03-mixed');await geometry(false);
  await p.call('Emulation.setDeviceMetricsOverride',{width:1000,height:800,deviceScaleFactor:1,mobile:false});await geometry(false);await shot('queue-04-compact');
  await p.call('Emulation.setDeviceMetricsOverride',{width:1680,height:1050,deviceScaleFactor:1,mobile:false});
  await idle();const final=await snap(),users=final.messages.filter(m=>m.role==='user').map(m=>m.text||''),assistant=final.messages.filter(m=>m.role==='assistant').map(m=>JSON.stringify(m.blocks||m.text)).join('\n');
  assert.match(assistant,/TASK-MATERIAL-PASS/);assert.match(assistant,/MIXED-ATTACHMENT-PASS/);assert.match(assistant,/FOLLOW-UP-PASS/);
  assert.ok(users.findIndex(t=>t.includes('TASK-MATERIAL-PASS'))<users.indexOf('只回复 FOLLOW-UP-PASS，不使用工具。'));
  assert.equal(users.some(t=>t.includes('REMOVE-THIS')),false);assert.equal(final.execution.queue.length,0);
  const completed=await p.run(id=>SoduWorkAPI.getTask(id),taskId);assert.equal(completed.workRouting?.conversationTurn?.state,'completed');
  finished=true;checks.push({name:'Real Agent automatic serial execution; task attachment read; task receipt completed; normal follow-up returned',passed:true});
  await shot('queue-05-completed');
  await p.call('Page.reload',{ignoreCache:true});await p.waitFor(id=>document.querySelector('.ws-chat[data-chat-id="'+id+'"]'),sessionId,20000);
  await click('.ws-chat[data-chat-id="'+sessionId+'"]');await p.waitFor(id=>NativeChat.sessionInfo().sessionId===id,sessionId,20000);
  await p.waitFor(id=>NativeChat.sessionInfo().taskIds.includes(id),taskId,15000);assert.equal((await snap()).execution.queue.length,0);
  await shot('queue-06-restored');checks.push('Reload restores one conversation, task association and completed history with no duplicate queue');
  console.log(JSON.stringify(checks,null,2));
}catch(error){checks.push({error:String(error.stack)});await shot('queue-failure').catch(()=>{});console.error(error);process.exitCode=1;}
finally{
  // Keep the verified chat as evidence, but archive only this new test task so
  // it does not stay in the user's active to-do list. Never approve user work.
  if(created&&finished)await p.run(id=>SoduWorkAPI.patchTask(id,{status:'done'}),taskId).catch(e=>checks.push({cleanup:String(e)}));
  await fs.writeFile(path.join(dir,'mixed-queue-results.json'),JSON.stringify({taskId,sessionId,created,finished,checks,console:p.takeRuntimeErrors()},null,2));p.close();
}
