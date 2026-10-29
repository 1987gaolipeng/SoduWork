import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {CdpPage,listPages} from './lib/cdp.mjs';
const evidence=process.env.SODUWORK_E2E_EVIDENCE;
if(!evidence) throw Error('Set SODUWORK_E2E_EVIDENCE');
fs.mkdirSync(evidence,{recursive:true});
const p=await CdpPage.connect((await listPages(9345)).find(x=>x.url.includes('panel=workspace')));
const tag=Date.now(),ids=[],results=[];
async function shot(name){const s=await p.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(evidence,name+'.png'),Buffer.from(s.data,'base64'));}
async function step(name,fn){const result=await fn();results.push({name,result});console.log('PASS '+name+' '+JSON.stringify(result));}
async function click(selector){
 const rect=await p.run(selector=>{const e=document.querySelector(selector);if(!e)throw Error('Missing '+selector);e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};},selector);
 await p.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...rect});
 await p.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...rect});
}
async function send(text,initial=false){
 await p.waitFor(initial=>{const e=document.querySelector(initial?'#cpInput':'#nchatInput');return e&&e.getBoundingClientRect().height>0;},initial,20000);
 await p.run(({text,initial})=>{const e=document.querySelector(initial?'#cpInput':'#nchatInput');e.value=text;e.dispatchEvent(new Event('input',{bubbles:true}));},{text,initial});
 await click(initial?'#cpGo':'#nchatSend');
}
async function createTask(suffix,note){
 const title='E2E queue '+tag+' '+suffix;
 await send('/创建任务 创建一个用于验证会话队列的简单任务，只返回指定标记，不要改动项目文件。');
 await p.waitFor(()=>document.querySelector('#wesTaskDraft #cpTitle'),null,90000);
 await p.run(({title,note})=>{
  const host=document.querySelector('#wesTaskDraft');
  host.querySelector('[data-selbtn="who"]').click();
  host.querySelector('[data-selv="who|me"]').click();
  for(const [selector,value] of [['#cpTitle',title],['#cpNote',note]]){const e=host.querySelector(selector);e.value=value;e.dispatchEvent(new Event('input',{bubbles:true}));}
  host.querySelectorAll('.cp-ck-t').forEach(e=>{e.value='返回指定标记';e.dispatchEvent(new Event('input',{bubbles:true}));});
 },{title,note});
 await shot('draft-'+suffix);await click('#wesTaskDraft #cpCreate');
 const task=await p.waitFor(async title=>{
  const task=(await SoduWorkAPI.getTasks()).find(t=>t.title===title);
  return task && NativeChat.sessionInfo().taskIds.includes(task.id)?{id:task.id,title:task.title}:false;
 },title,20000);
 ids.push(task.id);return task;
}
try{
 await p.waitFor(()=>window.NativeChat&&window.SoduWorkAPI&&SoduWorkAPI.online,null,30000);
 await step('ordinary-conversation',async()=>{
  await click('.ws-nav-item[data-view="create"]');
  await send('Reply exactly QUEUE-CHAT-PASS. Do not use tools.',true);
  await p.waitFor(async()=>{
   const ref=NativeChat.sessionInfo().ref;if(!ref)return false;
   const s=(await soduWorkAPI.conversationSession.snapshot(ref)).snapshot;
   return s.messages.some(m=>m.role==='assistant'&&JSON.stringify(m.blocks||m.text).includes('QUEUE-CHAT-PASS'))&&!NativeChat.isBusy();
  },null,90000);
  const result=await p.run(()=>({id:NativeChat.sessionInfo().sessionId,pins:document.querySelectorAll('.ncollab-pin-trigger').length}));
  assert.ok(result.id);assert.equal(result.pins,0);await shot('ordinary');return result;
 });
 const a=await createTask('A','运行一段等待 18 秒的 Node 命令，然后回复 TASK-A-PASS，不要修改文件。');
 const b=await createTask('B','阅读附件 queue-evidence.txt，回复 TASK-B-PASS、附件中的标记和前一个任务返回的标记。可以读取附件，不要修改文件。');
 await p.run(async id=>{
  await SoduWorkAPI.uploadAttachment(id,new File(['ATTACHMENT-QUEUE-PASS'], 'queue-evidence.txt',{type:'text/plain'}));
  const canvas=document.createElement('canvas');canvas.width=400;canvas.height=160;
  const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,400,160);
  ctx.fillStyle='#172033';ctx.font='24px sans-serif';ctx.fillText('QUEUE IMAGE INPUT',30,80);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
  await SoduWorkAPI.uploadAttachment(id,new File([blob], 'queue-pixel.png',{type:'image/png'}));
 },b.id);
 const before=await p.run(()=>NativeChat.sessionInfo().sessionId);
 await step('same-conversation-serial-send',async()=>{
  await click('[data-queue-action="start"][data-task-id="'+a.id+'"]');
  await p.waitFor(async id=>(await SoduWorkAPI.getTask(id)).workRouting?.conversationTurn?.state==='running',a.id,30000);
  await click('[data-queue-action="start"][data-task-id="'+b.id+'"]');
  await p.waitFor(async id=>(await SoduWorkAPI.getTask(id)).workRouting?.conversationTurn?.state==='queued',b.id,15000);
  await step('edit-and-cancel-waiting-message',async()=>{
   await click('[data-queue-action="edit"][data-task-id="'+b.id+'"]');
   await p.run(()=>{const e=document.getElementById('nqueueEditText');e.value+='\n补充：务必保留附件标记。';});
   await click('[data-queue-action="save-edit"]');
   await send('E2E-CANCEL-ME do not execute');
   const id=await p.waitFor(async()=>{const s=(await soduWorkAPI.conversationSession.snapshot(NativeChat.sessionInfo().ref)).snapshot;
    return s.execution.queue.find(x=>x.text.includes('E2E-CANCEL-ME'))?.id;},null,5000);
   await click('[data-queue-action="remove"][data-queue-id="'+id+'"]');
   await p.waitFor(async id=>!(await soduWorkAPI.conversationSession.snapshot(NativeChat.sessionInfo().ref)).snapshot.execution.queue.some(x=>x.id===id),id,5000);
   const task=await p.run(id=>SoduWorkAPI.getTask(id),b.id);assert.ok(task.id);return {editedTask:b.id,cancelledMessage:id};
  });
  await shot('running-and-queued');
  await p.waitFor(async ids=>{
   const rows=await Promise.all(ids.map(id=>SoduWorkAPI.getTask(id)));
   return rows.every(t=>t.workRouting?.conversationTurn?.state==='completed');
  },[a.id,b.id],120000);
  const result=await p.run(async()=>{const info=NativeChat.sessionInfo();const s=(await soduWorkAPI.conversationSession.snapshot(info.ref)).snapshot;return {id:info.sessionId,text:s.messages.filter(m=>m.role==='assistant').map(m=>JSON.stringify(m.blocks||m.text)).join('\n'),pins:document.querySelectorAll('.ncollab-pin-trigger').length};});
  assert.equal(result.id,before);assert.match(result.text,/TASK-A-PASS/);assert.match(result.text,/TASK-B-PASS/);assert.match(result.text,/ATTACHMENT-QUEUE-PASS/);
  assert.doesNotMatch(result.text,/E2E-CANCEL-ME/);
  await shot('completed');return {conversationId:before,tasks:2,pins:result.pins};
 });
 await step('refresh-restores-association',async()=>{
  await p.call('Page.reload',{ignoreCache:true});
  await p.waitFor(()=>window.NativeChat&&window.openTaskConversation,null,15000);
  await p.run(id=>openTaskConversation(id,'',{source:'task-list'}),a.id);
  await p.waitFor(id=>NativeChat.sessionInfo().sessionId===id,before,20000);
  await shot('restored');return await p.run(()=>({id:NativeChat.sessionInfo().sessionId,tasks:NativeChat.sessionInfo().taskIds}));
 });
}catch(error){results.push({error:String(error.stack||error)});await shot('failure');process.exitCode=1;console.error(error);}
finally{fs.writeFileSync(path.join(evidence,'results.json'),JSON.stringify({tag,ids,results},null,2));p.close();}
