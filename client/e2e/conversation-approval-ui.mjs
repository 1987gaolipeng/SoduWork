import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {CdpPage,listPages} from './lib/cdp.mjs';

const targetId=process.env.SODUWORK_E2E_PAGE_ID, evidence=process.env.SODUWORK_E2E_EVIDENCE;
if(!targetId||!evidence)throw Error('Explicit isolated test window and evidence directory required');
const p=await CdpPage.connect((await listPages(9345)).find(x=>x.id===targetId));
const report={checks:[]};fs.mkdirSync(evidence,{recursive:true});
async function click(selector){const r=await p.run(selector=>{const e=document.querySelector(selector);if(!e)throw Error(selector);e.scrollIntoView({block:'center'});const b=e.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2};},selector);await p.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...r});await p.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...r});}
async function shot(name){const s=await p.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(evidence,name+'.png'),Buffer.from(s.data,'base64'));}
async function rows(){return p.run(()=>[...document.querySelectorAll('.ws-chat')].map(e=>({id:e.dataset.chatId,title:e.querySelector('.ws-chat-title').textContent,task:e.dataset.taskSession==='1',pinned:e.parentElement.classList.contains('is-pinned'),height:e.getBoundingClientRect().height,left:e.querySelector('.ws-chat-title').getBoundingClientRect().left,font:getComputedStyle(e.querySelector('.ws-chat-title')).fontSize,model:getComputedStyle(e.querySelector('.ws-chat-runtime')).fontSize,active:e.getAttribute('aria-current')==='page'})));}
try{
 assert.ok(!await p.run(()=>NativeChat.isBusy()),'Do not reload while a turn is running');
 await p.call('Page.reload',{ignoreCache:true});
 await p.waitFor(()=>window.NativeChat&&document.querySelectorAll('.ws-chat').length>5,null,30000);
 await p.call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
 const first=await rows();
 assert.ok(first.some(x=>x.task)&&first.some(x=>!x.task));
 assert.equal(new Set(first.map(x=>x.height)).size,1);
 assert.equal(new Set(first.map(x=>Math.round(x.left))).size,1);
 assert.ok(first.every(x=>parseFloat(x.font)>=12&&parseFloat(x.model)>=12));
 assert.equal(new Set(first.map(x=>x.id)).size,first.length);
 const ordinary=first.find(x=>!x.task&&/^Reply exactly QUEUE|^新建对话回归测试|^E2E/.test(x.title));
 const task=first.find(x=>x.id==='01a075ea-490a-76e0-b793-96940ee2a14a');
 assert.ok(ordinary&&task,'Dedicated ordinary and collaboration history required');
 for(const [kind,row] of [['ordinary',ordinary],['collaboration',task]]){
   await click('.ws-chat[data-chat-id="'+row.id+'"]');
   await p.waitFor(id=>NativeChat.sessionInfo().sessionId===id,row.id,30000);
   assert.equal((await rows()).filter(x=>x.active).length,1);
   await shot('list-'+kind);
 }
 const after=await rows(), common=first.filter(a=>after.some(b=>a.id===b.id)).map(x=>x.id);
 assert.deepEqual(after.filter(x=>common.includes(x.id)).map(x=>x.id),common);
 report.checks.push('Ordinary/collaboration/pinned rows have equal height, aligned titles and type >=12px; one click opens each; exactly one selected; no reorder or duplicate');
 const selector='[data-task-confirmation] .tfd-inline-approval';
 await p.waitFor(selector=>document.querySelector(selector),selector,15000);
 await click(selector+' details summary');
 const values=await p.run(selector=>{const card=document.querySelector(selector);card.scrollIntoView({block:'center'});const b=card.getBoundingClientRect();return{width:b.width,x:b.x,right:b.right,viewport:innerWidth,smallFonts:[...card.querySelectorAll('*')].filter(e=>e.textContent.trim()&&e.getClientRects().length&&parseFloat(getComputedStyle(e).fontSize)<12).map(e=>e.className)};},selector);
 assert.equal(values.smallFonts.length,0);assert.ok(values.x>=0&&values.right<=values.viewport);
 await shot('approval-expanded');
 await click(selector+' details summary');await shot('approval-compact');
 await p.call('Emulation.setDeviceMetricsOverride',{width:1040,height:740,deviceScaleFactor:1,mobile:false});
 const narrow=await p.run(selector=>{const card=document.querySelector(selector);card.scrollIntoView({block:'center'});const b=card.getBoundingClientRect();return b.x>=0&&b.right<=innerWidth&&card.scrollWidth<=card.clientWidth;},selector);
 assert.ok(narrow);await shot('approval-narrow');
 report.checks.push('Approval compact/expanded/narrow layouts fit, visible text >=12px, primary action outside disclosure');
 report.metrics={rowHeight:first[0].height,titleFont:first[0].font,modelFont:first[0].model,pinned:first.filter(x=>x.pinned).length};
 report.runtimeErrors=p.takeRuntimeErrors();assert.deepEqual(report.runtimeErrors,[]);report.pass=true;
}catch(error){report.error=String(error.stack||error);await shot('ui-failure');process.exitCode=1;}
finally{await p.call('Emulation.clearDeviceMetricsOverride');fs.writeFileSync(path.join(evidence,'ui-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));p.close();}
