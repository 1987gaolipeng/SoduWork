import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {CdpPage,listPages} from './lib/cdp.mjs';
const evidence=process.env.SODUWORK_E2E_EVIDENCE;
if(!evidence)throw Error('Set SODUWORK_E2E_EVIDENCE');
const p=await CdpPage.connect((await listPages(9345)).find(x=>x.url.includes('panel=workspace')));
const results=[];
const shot=async name=>{const s=await p.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(evidence,name+'.png'),Buffer.from(s.data,'base64'));};
async function click(selector){
 const r=await p.run(selector=>{const e=document.querySelector(selector);if(!e)throw Error(selector);e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};},selector);
 await p.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...r});
 await p.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...r});
}
async function send(text){await p.run(text=>{const e=document.querySelector('#nchatInput');e.value=text;e.dispatchEvent(new Event('input',{bubbles:true}));},text);await click('#nchatSend');}
try{
 await p.waitFor(()=>window.NativeChat&&window.SoduWorkAPI?.online,null,30000);
 const previous=JSON.parse(fs.readFileSync(path.join(evidence,'results.json'),'utf8'));
 await p.run(id=>openTaskConversation(id,'',{source:'task-list'}),previous.ids[0]);
 await p.waitFor(()=>document.querySelector('#nchatInput'),null,20000);
 const before=await p.run(()=>NativeChat.sessionInfo().sessionId);
 const title='E2E controlled Runner '+Date.now();
 await send('/创建任务 创建一个简单办公测试任务，只回复 RUNNER-QUEUE-PASS，不使用工具，不修改文件。先交给我自己，不执行。');
 await p.waitFor(()=>document.querySelector('#wesTaskDraft #cpTitle'),null,90000);
 await click('#wesTaskDraft [data-selbtn="who"]');
 await click('#wesTaskDraft [data-selv="who|me"]');
 await p.run(title=>{
  const h=document.querySelector('#wesTaskDraft');
  for(const [s,v] of [['#cpTitle',title],['#cpNote','只回复 RUNNER-QUEUE-PASS，不使用工具，不修改文件。']]){const e=h.querySelector(s);e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}));}
  h.querySelectorAll('.cp-ck-t').forEach(e=>{e.value='返回 RUNNER-QUEUE-PASS';e.dispatchEvent(new Event('input',{bubbles:true}));});
 },title);
 await click('#wesTaskDraft #cpCreate');
 const task=await p.waitFor(async title=>{const t=(await SoduWorkAPI.getTasks()).find(t=>t.title===title);return t&&NativeChat.sessionInfo().taskIds.includes(t.id)?{id:t.id}:false;},title,20000);
 const dispatched=await p.run(async id=>{
  const roster=await SoduWorkAPI.listAIAgents();
  const agent=(roster.agents||[]).find(a=>/^runner:.*:pi$/.test(a.id)&&a.online!==false&&!a.busy);
  if(!agent)throw Error('No available Pi Runner; do not substitute a native turn');
  const result=await SoduWorkAPI.dispatchToAI(id,{id:agent.id,type:'agent'},'',null,'',{strategy:'direct',runner:{mode:'remote'}});
  return {ok:result?.ok!==false,runner:agent.id};
 },task.id);
 assert.equal(dispatched.ok,true);
 await p.waitFor(async id=>(await SoduWorkAPI.getTask(id)).workRouting?.conversationTurn?.state==='running',task.id,30000);
 await send('只回复 AFTER-RUNNER-PASS，不使用工具。');
 await shot('runner-queued');
 const completed=await p.waitFor(async id=>{
  const t=await SoduWorkAPI.getTask(id),receipt=t.workRouting?.conversationTurn;
  if(receipt?.state==='failed')throw Error('Controlled Runner failed; inspect task execution');
  return receipt?.state==='completed'?receipt:false;
 },task.id,180000);
 assert.equal(completed.conversationId,before);assert.equal(completed.executor,'dispatch');
 await p.waitFor(()=>document.querySelector('#nchatList')?.textContent.includes('RUNNER-QUEUE-PASS'),null,30000);
 await p.waitFor(async()=>{const i=NativeChat.sessionInfo(),s=(await soduWorkAPI.conversationSession.snapshot(i.ref)).snapshot;return s.messages.some(m=>m.role==='assistant'&&JSON.stringify(m.blocks).includes('AFTER-RUNNER-PASS'))&&!NativeChat.isBusy();},null,90000);
 assert.equal(await p.run(()=>NativeChat.sessionInfo().sessionId),before);
 await shot('runner-completed');
 results.push({taskId:task.id,conversationId:before,runner:dispatched.runner,executor:completed.executor,
  checks:['source restart restored conversation','real Runner dispatch','same conversation result stream','automatic next message'],
  limitation:'The registered Runner is this computer; this is not a second-machine E2E test.'});
 console.log('PASS controlled Runner integration '+JSON.stringify(results[0]));
}catch(error){results.push({error:String(error.stack||error)});await shot('runner-failure');process.exitCode=1;console.error(error);}
finally{fs.writeFileSync(path.join(evidence,'runner-results.json'),JSON.stringify(results,null,2));p.close();}
