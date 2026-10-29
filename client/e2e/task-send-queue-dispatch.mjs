import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {CdpPage,listPages} from './lib/cdp.mjs';
const evidence=process.env.SODUWORK_E2E_EVIDENCE;
if(!evidence)throw Error('Set SODUWORK_E2E_EVIDENCE');
const p=await CdpPage.connect((await listPages(9345)).find(x=>x.url.includes('panel=workspace')));
const title='E2E queue direct-dispatch '+Date.now(),results=[];
async function shot(name){const s=await p.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(evidence,name+'.png'),Buffer.from(s.data,'base64'));}
async function click(selector){
 const r=await p.run(selector=>{const e=document.querySelector(selector);if(!e)throw Error(selector);e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};},selector);
 await p.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...r});
 await p.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...r});
}
try{
 const source=JSON.parse(fs.readFileSync(path.join(evidence,'results.json'),'utf8'));
 await p.call('Page.reload',{ignoreCache:true});
 await p.waitFor(()=>window.NativeChat&&window.openTaskConversation&&window.SoduWorkAPI?.online,null,30000);
 await p.run(id=>openTaskConversation(id,'',{source:'task-list'}),source.ids[0]);
 await p.waitFor(()=>document.querySelector('#nchatInput'),null,15000);
 const before=await p.run(()=>NativeChat.sessionInfo().sessionId);
 await p.run(()=>{const e=document.querySelector('#nchatInput');e.value='/创建任务 新建一个不需要工程、不需要工作流的简单办公任务。直接交给 Pi，只回复 DIRECT-DISPATCH-PASS，不使用工具。';e.dispatchEvent(new Event('input',{bubbles:true}));});
 await click('#nchatSend');
 await p.waitFor(()=>document.querySelector('#wesTaskDraft #cpTitle'),null,90000);
 await click('#wesTaskDraft [data-selbtn="scene"]');
 await click('#wesTaskDraft [data-selv="scene|general-office"]');
 await click('#wesTaskDraft [data-selbtn="who"]');
 await click('#wesTaskDraft [data-selv="who|agent:local:pi"]');
 await p.run(title=>{
  const host=document.querySelector('#wesTaskDraft');
  for(const [selector,value] of [['#cpTitle',title],['#cpNote','只回复 DIRECT-DISPATCH-PASS，不使用工具，不修改文件。']]){
   const e=host.querySelector(selector);e.value=value;e.dispatchEvent(new Event('input',{bubbles:true}));
  }
  host.querySelectorAll('.cp-ck-t').forEach(e=>{e.value='返回 DIRECT-DISPATCH-PASS';e.dispatchEvent(new Event('input',{bubbles:true}));});
  window.queueOriginalDispatch=SoduWorkAPI.dispatchToAI;window.queueDispatchCalls=[];
  SoduWorkAPI.dispatchToAI=async(...args)=>{window.queueDispatchCalls.push({taskId:args[0],agentId:args[1]?.id});return window.queueOriginalDispatch.apply(SoduWorkAPI,args);};
 },title);
 await shot('direct-dispatch-confirm');
 await click('#wesTaskDraft #cpCreate');
 const task=await p.waitFor(async title=>{
  const t=(await SoduWorkAPI.getTasks()).find(t=>t.title===title);
  return t?.workRouting?.conversationTurn?.state==='completed'?{id:t.id,turn:t.workRouting.conversationTurn}:false;
 },title,90000);
 const result=await p.run(async()=>{
  const info=NativeChat.sessionInfo(),s=(await soduWorkAPI.conversationSession.snapshot(info.ref)).snapshot;
  return {conversationId:info.sessionId,dispatchCalls:window.queueDispatchCalls,assistant:s.messages.filter(m=>m.role==='assistant').map(m=>JSON.stringify(m.blocks)).join('\n')};
 });
 assert.equal(result.conversationId,before);assert.equal(task.turn.conversationId,before);
 assert.equal(result.dispatchCalls.length,1);assert.equal(result.dispatchCalls[0].taskId,task.id);
 assert.match(result.assistant,/DIRECT-DISPATCH-PASS/);
 results.push({taskId:task.id,conversationId:before,dispatchCalls:result.dispatchCalls});
 await shot('direct-dispatch-completed');console.log('PASS create-and-dispatch-to-current-conversation '+JSON.stringify(results[0]));
}catch(error){results.push({error:String(error.stack||error)});await shot('dispatch-failure');process.exitCode=1;console.error(error);}
finally{
 await p.run(()=>{if(window.queueOriginalDispatch)SoduWorkAPI.dispatchToAI=window.queueOriginalDispatch;});
 fs.writeFileSync(path.join(evidence,'dispatch-results.json'),JSON.stringify(results,null,2));p.close();
}
