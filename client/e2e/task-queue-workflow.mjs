import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CdpPage, listPages } from './lib/cdp.mjs';
const evidence=process.env.SODUWORK_E2E_EVIDENCE, taskId=process.env.SODUWORK_E2E_TASK;
if(!evidence||!taskId)throw Error('Set evidence and dedicated fixture task');
const nextMarker='AFTER-WORKFLOW-PASS-'+taskId.slice(0,8);
const p=await CdpPage.connect((await listPages(9345)).find(x=>x.url.includes('panel=workspace')));
const results=[];
const shot=async name=>{const s=await p.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(evidence,name+'.png'),Buffer.from(s.data,'base64'));};
async function click(selector){
 const r=await p.run(selector=>{const e=document.querySelector(selector);if(!e)throw Error(selector);e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};},selector);
 await p.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...r});
 await p.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...r});
}
try{
 await p.call('Page.reload',{ignoreCache:true});
 await p.waitFor(()=>window.NativeChat&&window.SoduWorkAPI?.online,null,30000);
 const previous=JSON.parse(fs.readFileSync(path.join(evidence,'results.json'),'utf8'));
 await p.run(id=>openTaskConversation(id,'',{source:'task-list'}),previous.ids[0]);
 await p.waitFor(()=>document.querySelector('#nchatInput'),null,15000);
 const before=await p.run(()=>NativeChat.sessionInfo().sessionId);
 if (!(await p.run(id=>NativeChat.sessionInfo().taskIds.includes(id),taskId))) {
  await click('[data-queue-action="add"]');
  await p.waitFor(id=>document.querySelector('[data-collab-task-select="'+id+'"]'),taskId,15000);
  await click('[data-collab-task-select="'+taskId+'"]');
 }
 await p.waitFor(id=>document.querySelector('[data-chat-workflow-retry="'+id+'"], [data-task-confirmation="'+id+'"] [data-tfd-approval-action="approve"]'),taskId,60000);
 if (await p.run(id=>!!document.querySelector('[data-chat-workflow-retry="'+id+'"]'),taskId)) {
  await shot('workflow-missing-input-stops-queue');
  await p.run(async id=>SoduWorkAPI.uploadAttachment(id,new File(['# E2E 基线\n## 验收标准\n- 对话内确认后继续下一条消息\n- 不执行任何部署'], 'requirements.md',{type:'text/markdown'})),taskId);
  await click('[data-chat-workflow-retry="'+taskId+'"]');
 }
 await p.waitFor(id=>document.querySelector('[data-task-confirmation="'+id+'"] [data-tfd-approval-action="approve"]'),taskId,60000);
 await shot('workflow-waiting-confirmation');
 if (!(await p.run(async marker=>{const s=(await soduWorkAPI.conversationSession.snapshot(NativeChat.sessionInfo().ref)).snapshot;return (s.execution.queue||s.queue||[]).some(x=>x.text.includes(marker));},nextMarker))) {
  await p.run(marker=>{const e=document.querySelector('#nchatInput');e.value='只回复 '+marker+'，不执行工具。';e.dispatchEvent(new Event('input',{bubbles:true}));},nextMarker);
  await click('#nchatSend');
 }
 const waiting=await p.run(async()=>{const i=NativeChat.sessionInfo();const s=(await soduWorkAPI.conversationSession.snapshot(i.ref)).snapshot;return {id:i.sessionId,queue:s.execution.queue||s.queue,active:s.execution.turnQueue.activeTaskId,text:s.messages.map(m=>JSON.stringify(m)).join('\n')};});
 assert.equal(waiting.id,before);assert.equal(waiting.active,taskId);
 assert.ok(waiting.queue.some(x=>x.text.includes(nextMarker)));
 assert.ok(waiting.text.includes('无部署、无业务文件修改'));
 await shot('workflow-and-message-queued');
 await click('[data-task-confirmation="'+taskId+'"] details summary');
 const fonts=await p.run(()=>Array.from(document.querySelectorAll('.nchat-task-confirmation *')).filter(e=>e.textContent.trim()).map(e=>parseFloat(getComputedStyle(e).fontSize)));
 assert.ok(fonts.length>0 && fonts.every(x=>x>=12));
 await click('[data-task-confirmation="'+taskId+'"] [data-tfd-approval-action="approve"]');
 await p.waitFor(async id=>(await SoduWorkAPI.getTask(id)).workRouting?.conversationTurn?.state==='completed',taskId,60000);
 await p.waitFor(async marker=>{const i=NativeChat.sessionInfo();const s=(await soduWorkAPI.conversationSession.snapshot(i.ref)).snapshot;return s.messages.filter(m=>m.role==='assistant').some(m=>JSON.stringify(m.blocks).includes(marker))&&!NativeChat.isBusy();},nextMarker,60000);
 await shot('workflow-completed-next-message');
 results.push({pass:true,taskId,conversationId:before,checks:['same conversation','full task input','inline approval','next message waits','approval continues workflow','automatic next ordinary turn']});
 console.log(JSON.stringify(results));
}catch(error){await shot('workflow-failure');results.push({error:String(error.stack||error)});console.error(error);process.exitCode=1;}
finally{fs.writeFileSync(path.join(evidence,'workflow-results.json'),JSON.stringify(results,null,2));p.close();}
