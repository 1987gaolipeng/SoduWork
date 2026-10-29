import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {CdpPage,listPages,delay} from './lib/cdp.mjs';
const [targetId,dir]=process.argv.slice(2);
assert.ok(targetId&&dir,'An isolated renderer and evidence directory are required');
const p=await CdpPage.connect((await listPages(9347)).find(x=>x.id===targetId));
const taskId='tmtplmh2sirx', chatId='01a075ea-490a-76e0-b793-96940ee2a14a', approvalId='d6ff7024-499a-4f4e-9b93-f6f074daf24a';
const checks=[];let ordinaryId;
const q=id=>'#composePanel.show [data-task-confirmation="'+taskId+'"] [data-tfd-approval-id="'+id+'"]';
async function click(selector){
  await p.waitFor(s=>{const e=document.querySelector(s);return e&&!e.disabled&&e.getClientRects().length;},selector,30000);
  const r=await p.run(async s=>{const e=document.querySelector(s);e.scrollIntoView({block:'center',inline:'nearest'});await new Promise(requestAnimationFrame);const r=e.getBoundingClientRect();
    const x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);if(!e.contains(hit))throw Error('Click covered: '+s+' by '+hit?.className);return{x,y};},selector);
  for(const type of ['mousePressed','mouseReleased'])await p.call('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...r});
}
async function shot(name){const s=await p.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(dir,name+'.png'),Buffer.from(s.data,'base64'));}
async function sameChat(label){await p.waitFor(id=>WorkspaceHost.view==='create'&&NativeChat.sessionInfo().sessionId===id,chatId,30000);
  const state=await p.run(id=>({rows:document.querySelectorAll('.ws-chat[data-chat-id="'+id+'"]').length,
    legacy:!!document.querySelector('#aiDeskPanel.show .dks-conversation'),ids:NativeChat.sessionInfo().taskIds}),chatId);
  assert.equal(state.rows,1);assert.equal(state.legacy,false);assert.ok(state.ids.includes(taskId));checks.push(label);
}
async function openTaskJourney(){
 await click('.ws-nav-item[data-view="history"]');
 const title=await p.run(async id=>{const t=await SoduWorkAPI.getTask(id);return t.requirementContent?.title||t.title;},taskId);
 assert.ok(title,'The fixture task must be readable');
 await p.run(query=>{
  const scope=document.querySelector('[data-rq-scope="all"]');
  if(scope?.getClientRects().length)scope.click();
  else{const select=document.querySelector('#rqScope');select.value='all';select.dispatchEvent(new Event('change',{bubbles:true}));}
  const kind=document.querySelector('#rqKind');kind.value='';kind.dispatchEvent(new Event('change',{bubbles:true}));
  const input=document.querySelector('#hbSearch');input.value=query;input.dispatchEvent(new Event('input',{bubbles:true}));
 },title);
 const selector='.rq-card[data-hbid="'+taskId+'"] [data-rq-open]';
 await p.waitFor(s=>!!document.querySelector(s),selector,30000);
 const collapsed=await p.run(s=>document.querySelector(s).closest('[data-rq-lane]')?.querySelector('[data-rq-collapse][aria-expanded="false"]')?.dataset.rqCollapse,selector);
 if(collapsed)await click('[data-rq-collapse="'+collapsed+'"]');
 await click(selector);
 const actual=await p.waitFor(()=>{const root=document.querySelector('.rq-detail');return root?.querySelector('[name="title"]')?.value||root?.querySelector('h3[data-user-content]')?.textContent.trim();},null,30000);
 assert.equal(actual,title,'The requirement summary must match the chosen task');
 await click('.rq-detail [data-rq-journey]');
 await p.waitFor(()=>!document.querySelector('.rq-detail-backdrop'),null,10000);
}
try{
 fs.mkdirSync(dir,{recursive:true});await p.call('Page.reload',{ignoreCache:true});
 await p.waitFor(()=>window.SoduWorkAPI?.online,null,30000);
 assert.equal(await p.run(()=>NativeChat.isBusy()),false);
 await p.call('Emulation.setDeviceMetricsOverride',{width:1680,height:1050,deviceScaleFactor:1,mobile:false});
 const baseline=(await p.run(()=>soduWorkAPI.conversationSession.history())).chats.map(x=>x.id);
 await click('.ws-nav-item[data-view="aidesk"]');await click('[data-office-enter-task="'+taskId+'"]');
 await sameChat('AI workbench task card -> exact existing ordinary chat after source restart');await shot('navigation-01-workbench-chat');
 await openTaskJourney();
 await click('#aisGo');await sameChat('Requirement pool -> requirement summary -> task details -> existing conversation');
 await openTaskJourney();
 await click('#detailPanel [data-tfd-action="live"]');await sameChat('Task execution journey -> ordinary conversation, not legacy console');
 await click('.ws-chat[data-chat-id="'+chatId+'"]');await sameChat('Left recent-chat entry is the same conversation, single click');
 await click('.ws-nav-item[data-view="history"]');await click('#hbApprovalInbox');
 await p.waitFor(()=>document.querySelector('#taskApprovalInbox:popover-open .task-confirmation-row'),null,20000);
 assert.equal(await p.run(()=>!!document.querySelector('.ws-nav-item[data-view="approvals"]')),false);
 await shot('navigation-02-confirmation-inbox');
 await click('[data-confirmation-id="'+approvalId+'"]');await sameChat('Todo confirmation inbox -> matching approval in the linked conversation');
 await p.waitFor(s=>document.querySelector(s)?.dataset.approvalAccess==='allowed',q(approvalId),20000);
 await p.waitFor(s=>document.activeElement===document.querySelector(s)&&!document.querySelector('#taskApprovalInbox:popover-open'),q(approvalId),20000);
 await p.run(s=>document.querySelector(s).scrollIntoView({block:'center'}),q(approvalId));await shot('navigation-03-inline-confirmation');
 await click(q(approvalId)+' .tfd-inline-proof>summary');
 const evidence=await p.run(s=>{const c=document.querySelector(s);return {gate:!!c.querySelector('.tfd-gate'),files:[...c.querySelectorAll('a')].map(x=>({label:x.textContent.trim(),safe:/^https?:/.test(x.href)})),
  small:[...c.querySelectorAll('*')].filter(e=>e.getClientRects().length&&[...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim())&&parseFloat(getComputedStyle(e).fontSize)<12).map(e=>e.className)}},q(approvalId));
 assert.ok(evidence.gate&&evidence.files.some(x=>x.label==='live-result.txt'&&x.safe));assert.deepEqual(evidence.small,[]);
 await p.run(s=>document.querySelector(s).scrollIntoView({block:'center'}),q(approvalId));await shot('navigation-04-expanded-evidence');
 await p.call('Emulation.setDeviceMetricsOverride',{width:1040,height:800,deviceScaleFactor:1,mobile:false});
 await p.run(s=>document.querySelector(s).scrollIntoView({block:'end'}),q(approvalId));await shot('navigation-05-compact-evidence');
 assert.ok(await p.run(()=>document.documentElement.scrollWidth<=innerWidth+1));checks.push('Inline evidence opens without navigation; 12px minimum; compact width has no page overflow');
 await p.call('Emulation.setDeviceMetricsOverride',{width:1680,height:1050,deviceScaleFactor:1,mobile:false});
 const after=(await p.run(()=>soduWorkAPI.conversationSession.history())).chats.map(x=>x.id);
 assert.deepEqual([...after].sort(),[...baseline].sort());checks.push('Viewing from all tested entries creates no duplicate conversation');
 await p.call('Page.reload',{ignoreCache:true});await p.waitFor(()=>window.SoduWorkAPI?.online,null,30000);
 await click('.ws-chat[data-chat-id="'+chatId+'"]');await sameChat('Renderer reload -> one-click history restores all task bindings and outputs');
 await click('.ws-nav-item[data-view="create"]');await p.waitFor(()=>document.querySelector('#cpInput')?.getBoundingClientRect().height>0,null,20000);
 await p.run(()=>{const e=document.querySelector('#cpInput');e.value='这是独立的回归测试，只回复 NAVIGATION-ORDINARY-PASS，不使用工具。';e.dispatchEvent(new Event('input',{bubbles:true}));});await click('#cpGo');
 await p.waitFor(async()=>{if(!NativeChat.hasSession()||NativeChat.isBusy())return false;const s=(await soduWorkAPI.conversationSession.snapshot(NativeChat.sessionInfo().ref)).snapshot;return s.messages.some(m=>m.role==='assistant'&&m.blocks.some(b=>b.kind==='text'&&b.text.includes('NAVIGATION-ORDINARY-PASS')))},null,120000);
 ordinaryId=await p.run(()=>NativeChat.sessionInfo().sessionId);assert.notEqual(ordinaryId,chatId);
 assert.deepEqual(await p.run(()=>NativeChat.sessionInfo().taskIds),[]);await shot('navigation-06-ordinary-chat');checks.push('New ordinary conversation sends successfully, has no task binding, and remains unchanged');
 await click('.ws-chat[data-chat-id="'+chatId+'"]');await sameChat('Switch from ordinary chat back to task chat');
 await click('.ws-chat[data-chat-id="'+ordinaryId+'"]');await p.waitFor(id=>NativeChat.sessionInfo().sessionId===id,ordinaryId,15000);
 checks.push('Switch back to the new ordinary chat with one click');
 const errors=p.takeRuntimeErrors();assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(dir,'navigation-results.json'),JSON.stringify({pass:true,taskId,chatId,ordinaryId,checks,errors},null,2));console.log(JSON.stringify({pass:true,checks,ordinaryId}));
}catch(e){await shot('navigation-failure');fs.writeFileSync(path.join(dir,'navigation-results.json'),JSON.stringify({pass:false,checks,error:String(e.stack)},null,2));console.error(e);process.exitCode=1;}finally{p.close();}
