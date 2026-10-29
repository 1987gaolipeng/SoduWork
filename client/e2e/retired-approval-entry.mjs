// Read-only navigation smoke on the running source client. Never confirms an approval.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {CdpPage,listPages} from './lib/cdp.mjs';
const port=Number(process.argv[2]||9347),evidence=path.resolve(process.argv[3]||'');
assert.ok(process.argv[3],'Provide an evidence directory');
fs.mkdirSync(evidence,{recursive:true});
const target=(await listPages(port)).find(p=>p.url.includes('desk.html?panel=workspace'));
assert.ok(target,'Source workspace must already be running');
const page=await CdpPage.connect(target),checks=[];
async function click(selector){
  const p=await page.waitFor(s=>{const e=document.querySelector(s);if(!e || !e.getClientRects().length)return false;
    const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};},selector);
  for(const type of ['mousePressed','mouseReleased'])await page.call('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1});
}
async function shot(name){
  const r=await page.call('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(evidence,name+'.png'),Buffer.from(r.data,'base64'));
}
try{
  assert.equal(await page.run(()=>!!window.NativeChat?.isBusy?.()),false,'Do not interrupt an active turn');
  assert.equal(await page.run(()=>['cpInput','ncInput','chatInput'].some(id=>document.getElementById(id)?.value?.trim())),false,'Do not discard drafts');
  await page.call('Page.enable');await page.call('Page.reload',{ignoreCache:true});
  await page.waitFor(()=>document.querySelector('.ws-nav-item[data-view="history"]')&&window.TaskApprovalInbox);
  assert.equal(await page.run(()=>[...document.scripts].some(s=>s.src.includes('panels-approvals'))),false);
  assert.equal(await page.run(()=>!!document.getElementById('apPanel')),false);
  checks.push('source reload no longer loads retired approval assets');
  await click('.ws-nav-item[data-view="history"]');await click('#hbApprovalInbox');
  const state=await page.waitFor(()=>{
    const panel=document.getElementById('taskApprovalInbox');
    if(!panel?.matches(':popover-open')||panel.textContent.includes('正在读取'))return false;
    const r=panel.getBoundingClientRect();
    return {title:panel.querySelector('header b')?.textContent,failed:!!panel.querySelector('[role="alert"]'),
      count:panel.querySelectorAll('[data-confirmation-task]').length,
      validRows:[...panel.querySelectorAll('[data-confirmation-task]')].every(e=>!!e.dataset.confirmationTask),
      fits:r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight};
  });
  assert.equal(state.title,'待我确认');assert.ok(!state.failed && state.validRows && state.fits);
  await shot('01-current-confirmation-inbox');checks.push('real backend confirmation inbox loads and fits');
  await click('[data-confirmation-close]');await page.waitFor(()=>!document.getElementById('taskApprovalInbox').matches(':popover-open'));
  assert.equal(await page.run(()=>document.activeElement?.id),'hbApprovalInbox');
  checks.push('closing inbox restores keyboard focus');
  await click('.ws-nav-item[data-view="create"]');await page.waitFor(()=>document.getElementById('cpInput')?.getClientRects().length);
  assert.equal(await page.run(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await shot('02-ordinary-conversation-entry');checks.push('ordinary new conversation composer still opens');
  const errors=page.takeRuntimeErrors();
  assert.deepEqual(errors,[],'Source renderer must not throw after cleanup');
  fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({checks,approvalRows:state.count,errors,
    scope:'running source client, real backend, read-only navigation; no model turn or approval submission'},null,2));
  console.log(JSON.stringify({passed:checks.length,evidence}));
}finally{page.close()}
