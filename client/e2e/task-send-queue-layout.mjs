import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {CdpPage,listPages} from './lib/cdp.mjs';
const evidence=process.env.SODUWORK_E2E_EVIDENCE;
if(!evidence)throw Error('Set SODUWORK_E2E_EVIDENCE');
const source=JSON.parse(fs.readFileSync(path.join(evidence,'results.json'),'utf8'));
const taskId=source.ids[0],results=[];
const p=await CdpPage.connect((await listPages(9345)).find(x=>x.url.includes('panel=workspace')));
async function shot(name){const s=await p.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(evidence,name+'.png'),Buffer.from(s.data,'base64'));}
async function click(selector) {
 const rect=await p.run(selector=>{const e=document.querySelector(selector);if(!e)throw Error(selector);e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};},selector);
 await p.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...rect});
 await p.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...rect});
}
try{
 await p.call('Page.reload',{ignoreCache:true});
 await p.waitFor(()=>window.NativeChat&&window.openTaskConversation,null,15000);
 await p.run(id=>openTaskConversation(id,'',{source:'task-list'}),taskId);
 await p.waitFor(()=>document.querySelector('[data-queue-action="history"]'),null,20000);
 await click('[data-queue-action="history"]');
 await p.waitFor(()=>document.querySelector('[data-task-receipt]'),null,4000);
 for(const width of [1440,1100]){
  await p.call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
  const before=await p.run(()=>{const r=document.querySelector('#nchatInput').getBoundingClientRect();return {x:r.x,width:r.width};});
  await click('[data-task-receipt]');
  await p.waitFor(()=>document.querySelector('[data-collab-dossier]'),null,4000);
  const layout=await p.run(()=>{
   const panel=document.querySelector('[data-collab-dossier]'),r=panel.getBoundingClientRect();
   const input=document.querySelector('#nchatInput').getBoundingClientRect();
   const fonts=[...document.querySelectorAll('#nchatQueue *,[data-collab-dossier] *')].filter(e=>e.getBoundingClientRect().height&&[...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim())).map(e=>parseFloat(getComputedStyle(e).fontSize));
   return {x:input.x,width:input.width,minFont:Math.min(...fonts),panel:{x:r.x,y:r.y,right:r.right,bottom:r.bottom},viewport:{width:innerWidth,height:innerHeight},modal:panel.getAttribute('aria-modal')};
  });
  assert.equal(layout.x,before.x);assert.equal(layout.width,before.width);assert.ok(layout.minFont>=12);
  assert.ok(layout.panel.x>=0&&layout.panel.y>=0&&layout.panel.right<=layout.viewport.width&&layout.panel.bottom<=layout.viewport.height);
  assert.equal(layout.modal,'false');await shot('details-'+width);
  await click('[data-collab-tab="execution"]');await shot('execution-'+width);
  await click('[data-collab-close]');
  await p.waitFor(()=>!document.querySelector('[data-collab-dossier]'),null,3000);
  assert.equal(await p.run(()=>document.activeElement.hasAttribute('data-task-receipt')),true);
  await click('[data-queue-action="add"]');
  await p.waitFor(()=>document.querySelector('[data-collab-search]'),null,5000);
  await shot('picker-'+width);
  await p.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});
  await p.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape'});
  await p.waitFor(()=>!document.querySelector('[data-collab-search]'),null,3000);
  results.push({width,...layout});
 }
 const errors=p.takeRuntimeErrors();assert.deepEqual(errors,[]);
 console.log('PASS queue layout, non-modal details, close/focus, task picker, 12px type minimum');
}catch(error){results.push({error:String(error.stack||error)});await shot('layout-failure');process.exitCode=1;console.error(error);}
finally{
 await p.call('Emulation.clearDeviceMetricsOverride');
 fs.writeFileSync(path.join(evidence,'layout-results.json'),JSON.stringify(results,null,2));p.close();
}
