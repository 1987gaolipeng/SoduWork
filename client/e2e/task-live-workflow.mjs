import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {CdpPage,listPages} from './lib/cdp.mjs';
const evidence=process.env.SODUWORK_E2E_EVIDENCE, taskId=process.env.SODUWORK_E2E_TASK, source=process.env.SODUWORK_E2E_SOURCE;
if(!evidence||!taskId||!source)throw Error('Dedicated E2E task/source/evidence required');
fs.mkdirSync(evidence,{recursive:true});
const p=await CdpPage.connect((await listPages(Number(process.env.SODUWORK_E2E_PORT || 9345))).find(x=>process.env.SODUWORK_E2E_PAGE_ID ? x.id===process.env.SODUWORK_E2E_PAGE_ID : x.url.includes('panel=workspace')));
const report={taskId,checks:[]};
const afterMarker='AFTER-LIVE-WORKFLOW-'+taskId;
const resume=process.env.SODUWORK_E2E_RESUME==='1';
const shot=async name=>{const s=await p.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(evidence,name+'.png'),Buffer.from(s.data,'base64'));};
async function click(selector){const r=await p.run(selector=>{const e=document.querySelector(selector);if(!e)throw Error(selector);e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};},selector);await p.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...r});await p.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...r});}
async function live(marker){return p.waitFor(async({id,marker})=>{const s=(await soduWorkAPI.conversationSession.snapshot(NativeChat.sessionInfo().ref)).snapshot;const m=s.messages.find(m=>m.taskId===id&&m.role==='assistant'&&m.blocks.some(b=>b.kind==='text'&&b.text.includes(marker)));const tool=s.tools.find(t=>t.id.startsWith('task:'+id+':')&&t.state==='running');return m&&tool;},{id:taskId,marker},180000);}
try{
 await p.waitFor(()=>window.NativeChat&&window.SoduWorkAPI?.online,null,30000);
 await p.run(async id=>{const t=await SoduWorkAPI.getTask(id);if(!t.title.startsWith('E2E'))throw Error('Not an E2E source');await openTaskConversation(id,'',{source:'task-list'});},source);
 await p.waitFor(resume=>document.querySelector('#nchatInput')&&(resume||!NativeChat.isBusy()),resume,30000);
 report.conversationId=await p.run(()=>NativeChat.sessionInfo().sessionId);
 if(!resume){
  await click('[data-queue-action="add"]');
  await p.waitFor(id=>document.querySelector('[data-collab-task-select="'+id+'"]'),taskId,20000);
  await click('[data-collab-task-select="'+taskId+'"]');
  await live('NODE-A-LIVE'); await shot('workflow-01-node-a-live');
 }else assert.ok(fs.existsSync(path.join(evidence,'workflow-01-node-a-live.png')),'Resume requires previously captured live evidence');
 report.checks.push('First workflow AI node explanation and running tool in ordinary message stream');
 await p.waitFor(id=>document.querySelector('[data-task-confirmation="'+id+'"] [data-tfd-approval-action="approve"]'),taskId,180000);
 const alreadyQueued=await p.run(async marker=>{const s=(await soduWorkAPI.conversationSession.snapshot(NativeChat.sessionInfo().ref)).snapshot;return(s.execution?.queue||s.queue||[]).some(x=>x.text.includes(marker));},afterMarker);
 if(!alreadyQueued){await p.run(marker=>{const e=document.querySelector('#nchatInput');e.value='不要调用工具，只回复 '+marker;e.dispatchEvent(new Event('input',{bubbles:true}));},afterMarker);await click('#nchatSend');}
 const waiting=await p.waitFor(async marker=>{const s=(await soduWorkAPI.conversationSession.snapshot(NativeChat.sessionInfo().ref)).snapshot;return{queued:(s.execution?.queue||s.queue||[]).some(x=>x.text.includes(marker)),answered:s.messages.some(m=>m.role==='assistant'&&m.blocks.some(b=>b.kind==='text'&&b.text.includes(marker)))};},afterMarker,10000);
 assert.ok(waiting.queued&&!waiting.answered);await shot('workflow-02-inline-confirmation');
 const gateSelector='[data-task-confirmation="'+taskId+'"]';
 const compact=await p.run(selector=>{const c=document.querySelector(selector),b=c.querySelector('[data-tfd-approval-action="approve"]');const r=b.getBoundingClientRect();return{folded:!c.querySelector('details').open,buttonVisible:r.width>0&&r.height>0&&!b.closest('details'),smallFonts:[...c.querySelectorAll('*')].filter(e=>e.textContent.trim()&&e.getClientRects().length&&parseFloat(getComputedStyle(e).fontSize)<12).map(e=>e.className)};},gateSelector);
 assert.ok(compact.folded&&compact.buttonVisible);assert.deepEqual(compact.smallFonts,[]);
 await p.waitFor(selector=>{const b=document.querySelector(selector+' [data-tfd-approval-action="reject"]');return b&&!b.disabled;},gateSelector,30000);
 await click(gateSelector+' [data-tfd-approval-action="reject"]');
 const missingNote=await p.run(selector=>{const c=document.querySelector(selector);return{open:c.querySelector('details').open,error:!c.querySelector('[data-tfd-approval-error]').hidden,focused:document.activeElement===c.querySelector('textarea')};},gateSelector);
 assert.ok(missingNote.open&&missingNote.error&&missingNote.focused);await shot('workflow-02b-reject-needs-note');
 await p.call('Input.insertText',{text:'E2E 已核对测试材料，仅用于隔离流程验证。'});
 await p.run(selector=>{window.__approvalNoteForTest=document.querySelector(selector+' textarea');},gateSelector);
 await new Promise(resolve=>setTimeout(resolve,7500));
 const preserved=await p.run(selector=>{const note=document.querySelector(selector+' textarea');return note===window.__approvalNoteForTest&&note.value.includes('E2E 已核对')&&document.activeElement===note&&document.querySelector(selector+' details').open;},gateSelector);
 assert.ok(preserved,'Polling must preserve the expanded form, note and focus');
 await click(gateSelector+' details summary');
 const blocked=await p.run(async id=>{const trace=await SoduWorkAPI.taskTrace(id);const s=(await soduWorkAPI.conversationSession.snapshot(NativeChat.sessionInfo().ref)).snapshot;return{pending:trace.approvals.some(a=>a.status==='pending'),startedNext:s.messages.some(m=>m.taskId===id&&m.role==='assistant'&&m.blocks.some(b=>b.kind==='text'&&b.text.includes('NODE-B-LIVE')))};},taskId);
 assert.ok(blocked.pending&&!blocked.startedNext);report.checks.push('Compact actions visible with folded evidence, empty rejection focuses note, closing form does not approve or release next node');
 await click('[data-task-confirmation="'+taskId+'"] [data-tfd-approval-action="approve"]');
 await live('NODE-B-LIVE');await shot('workflow-03-node-b-live');
 report.checks.push('Inline approval holds the next ordinary turn, approval starts second node live');
 await p.waitFor(async id=>{const t=await SoduWorkAPI.getTask(id);return t.workRouting?.conversationTurn?.state==='completed';},taskId,180000);
 await p.waitFor(async marker=>{const s=(await soduWorkAPI.conversationSession.snapshot(NativeChat.sessionInfo().ref)).snapshot;return!NativeChat.isBusy()&&s.messages.at(-1)?.blocks.some(b=>b.kind==='text'&&b.text.includes(marker));},afterMarker,90000);
 const result=await p.run(async id=>{const s=(await soduWorkAPI.conversationSession.snapshot(NativeChat.sessionInfo().ref)).snapshot;const t=await SoduWorkAPI.getTask(id);return{conversationId:NativeChat.sessionInfo().sessionId,tools:s.tools.filter(t=>t.id.startsWith('task:'+id+':')).map(t=>({id:t.id,state:t.state})),text:s.messages.filter(m=>m.taskId===id&&m.role==='assistant').flatMap(m=>m.blocks.filter(b=>b.kind==='text').map(b=>b.text)).join('\n'),attachments:(t.attachments||[]).map(a=>a.name||a.filename),detailStreams:document.querySelectorAll('[data-task-stream="'+id+'"]').length};},taskId);
 assert.equal(result.conversationId,report.conversationId);assert.match(result.text,/NODE-A-DONE/);assert.match(result.text,/NODE-B-DONE/);
 assert.ok(result.tools.length>=4&&result.tools.every(t=>t.state==='done'));assert.equal(result.detailStreams,0);
 await shot('workflow-04-complete');report.result=result;report.pass=true;report.checks.push('Both node outputs and tools retained, next ordinary turn released after whole workflow completion');console.log(JSON.stringify(report));
}catch(error){report.error=String(error.stack||error);await shot('workflow-failure');console.error(error);process.exitCode=1;}
finally{fs.writeFileSync(path.join(evidence,'workflow-results.json'),JSON.stringify(report,null,2));p.close();}
