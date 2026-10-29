import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CdpPage, listPages } from './lib/cdp.mjs';
// Presentation fixtures only. Never creates, starts or modifies a business task.
const evidence=process.env.SODUWORK_E2E_EVIDENCE;
if(!evidence)throw Error('SODUWORK_E2E_EVIDENCE is required');
const page=await CdpPage.connect((await listPages(9345)).find(x=>x.url.includes('panel=workspace')));
const results=[];
let startupErrors=[];
const networkErrors=[];
await page.call('Network.enable');
page.ws.addEventListener('message',event=>{
 const m=JSON.parse(event.data);
 if(m.method==='Network.responseReceived'&&m.params.response.status>=400){
  const u=new URL(m.params.response.url);
  networkErrors.push({status:m.params.response.status,path:u.pathname});
 }
});
async function check(name,fn){await fn();results.push(name);console.log('PASS '+name);}
async function shot(name){
 fs.mkdirSync(evidence,{recursive:true});
 const {data}=await page.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
 fs.writeFileSync(evidence+'/'+name+'.png',Buffer.from(data,'base64'));
 if(name==='02-overview'){
  const clip=await page.run(()=>{
   const a=document.querySelector('.ncollab-pin-control').getBoundingClientRect(),b=document.querySelector('[data-collab-dossier]').getBoundingClientRect();
   const x=Math.max(0,Math.floor(a.x-12)),y=Math.max(0,Math.floor(Math.min(a.y,b.y)-18));
   return{x,y,width:Math.ceil(b.right+22-x),height:Math.ceil(Math.max(a.bottom,b.bottom)+22-y),scale:1};
  });
  const preview=await page.call('Page.captureScreenshot',{format:'png',clip,captureBeyondViewport:false});
  fs.writeFileSync(evidence+'/detail-preview.png',Buffer.from(preview.data,'base64'));
 }
}
async function click(selector){
 const point=await page.run(selector=>{const el=document.querySelector(selector);if(!el)throw Error('Missing '+selector);const r=el.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;if(!el.contains(document.elementFromPoint(x,y)))throw Error('Obstructed '+selector);return{x,y};},selector);
 for(const type of ['mousePressed','mouseReleased'])await page.call('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point});
}
async function key(key){for(const type of ['keyDown','keyUp'])await page.call('Input.dispatchKeyEvent',{type,key,code:key,windowsVirtualKeyCode:key==='Escape'?27:0});}
async function geometry(){return await page.run(()=>{
 const br=document.querySelector('.nchat-content-area').getBoundingClientRect(),r=document.querySelector('[data-collab-dossier],.ncollab-picker')?.getBoundingClientRect();
 const small=[...document.querySelectorAll('#collabVisualHost *')].filter(el=>el.getClientRects().length&&[...el.childNodes].some(n=>n.nodeType===Node.TEXT_NODE&&n.textContent.trim())&&parseFloat(getComputedStyle(el).fontSize)<12).map(el=>({tag:el.tagName,font:getComputedStyle(el).fontSize,text:el.textContent.slice(0,40)}));
 const chat=document.querySelector('.nchat-scroll').getBoundingClientRect();
 return{small,inBounds:!r||(r.x>=br.x&&r.y>=br.y-1&&r.right<=br.right+1&&r.bottom<=br.bottom+1),overflow:document.documentElement.scrollWidth>innerWidth,chat:{x:chat.x,width:chat.width}};
});}
try{
 const session=await page.run(()=>window.NativeChat?.sessionInfo());
 assert.ok(!/running|doing|executing/.test(session?.status||''),'Do not reload active work');
 await page.call('Page.reload',{ignoreCache:true});
 await page.waitFor(()=>window.ChatCollaboration&&window.NativeChat);
 await page.waitFor(()=>document.querySelector('[data-chat-id]'));
 await click('[data-chat-id]');
 await page.waitFor(()=>document.querySelector('#nchatCollab')&&document.querySelector('#nchatInput')?.getClientRects().length);
 await page.call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 await page.run(()=>{
  const host=document.createElement('div');host.id='collabVisualHost';host.className='nchat-collab-slot';
  document.querySelector('.nchat-content-area').append(host);
  const types=['running','queued','waiting_human','done','failed','todo'];
  const titles=['重构客户门户的任务协作体验','补充发布前的回归测试报告','确认合同风险分析的处理意见','整理需求访谈纪要','核对远程执行机的连接状态','准备下一轮产品原型'];
  window.__collabVisual={actions:[],state:{sessionId:'visual-fixture-only',activeTaskId:'visual-0',taskId:'visual-0',adapterId:'codex',
   tasks:types.map((status,i)=>({taskId:'visual-'+i,status,task:{id:'visual-'+i,title:titles[i],status:i===3?'doing':'todo',projectName:'客户门户',branch:'feature/task-collaboration',
    description:'让任务协作自然地融入对话：保留完整上下文，明确每一步的执行状态，最终交付可验收的结果。',
    acceptanceCriteria:['普通对话的消息流与输入框保持原样。','任务按确认的顺序执行，等待输入时不启动后续任务。','刷新、切换会话后恢复正确的任务状态与成果。']},
    execution:{status,agentName:'Codex',model:'gpt-5.6 · 高推理',host:'DESKTOP-FIXTURE',remote:false,startedAt:'2026-09-06T04:00:00Z',finishedAt:'2026-09-06T04:02:36Z',tokens:15420,retryCount:i===4?1:0},
    trace:{stages:[{name:'确认任务与验收目标',status:'done'},{name:'执行修改与自测',status:i===3?'done':status},{name:'结果复核与确认',status:'pending'}]},
    outputs:i===3?[{name:'回归测试报告.md',kind:'测试报告'},{name:'交互验证截图.png',kind:'截图证据'}]:[]})),picker:{open:false,tasks:[]}}};
  const t=__collabVisual;
  t.view=ChatCollaboration.create({host,onAction:(action,data)=>{
   t.actions.push({action,taskId:data.taskId});
   if(action==='open-task'){t.state.activeTaskId=data.taskId;t.state.taskId=data.taskId;t.state.picker.open=false;t.view.render(t.state);t.view.setPin('dossier');}
   if(action==='add-task'){t.state.picker={open:true,tasks:[{id:'candidate-a',title:'整理研发周报',status:'todo'},{id:'candidate-b',title:'检查客户门户部署结果',status:'todo'}]};t.view.render(t.state);}
   if(action==='picker-close'||action==='select-task'){t.state.picker.open=false;t.view.render(t.state);}
  }});
  t.view.render(t.state);
 });
 const baseline=(await geometry()).chat;
 startupErrors=page.takeRuntimeErrors();
 await check('six status pins and single indicator',async()=>{
  assert.equal(await page.run(()=>document.querySelectorAll('.ncollab-note').length),6);
  assert.equal(await page.run(()=>document.querySelectorAll('.ncollab-note-status').length),6);
  assert.equal(await page.run(()=>getComputedStyle(document.querySelector('.ncollab-note'),'::after').content),'none');await shot('01-pins');
 });
 await check('single click opens a non-modal overview without moving chat',async()=>{
  await click('[data-collab-task-select="visual-0"]');
  assert.equal(await page.run(()=>document.querySelector('[data-collab-dossier]').getAttribute('aria-modal')),'false');
  assert.deepEqual((await geometry()).chat,baseline);await shot('02-overview');
 });
 await check('configuration and keyboard tabs show full labels',async()=>{
  const top=await page.run(()=>document.querySelector('[data-collab-dossier]').getBoundingClientRect().top);
  await click('[data-collab-tab="execution"]');assert.ok(await page.run(()=>document.querySelector('#ncollab-panel-execution').innerText.includes('DESKTOP-FIXTURE')));await shot('03-execution');
  assert.equal(await page.run(()=>document.querySelector('[data-collab-dossier]').getBoundingClientRect().top),top);
  await key('ArrowRight');assert.equal(await page.run(()=>document.querySelector('[aria-selected=true][role=tab]').dataset.collabTab),'artifacts');
  await key('Home');assert.equal(await page.run(()=>document.querySelector('[aria-selected=true][role=tab]').dataset.collabTab),'task');
 });
 await check('scroll and focus survive execution updates',async()=>{
  await page.run(()=>{const t=__collabVisual;t.state.tasks[0].task.description='长文本验证。'.repeat(180);t.view.render(t.state);document.querySelector('.ncollab-dossier-scroll').scrollTop=120;document.querySelector('[data-collab-close]').focus();t.view.render(t.state);});
  assert.equal(await page.run(()=>document.querySelector('.ncollab-dossier-scroll').scrollTop),120);
  assert.equal(await page.run(()=>document.activeElement.hasAttribute('data-collab-close')),true);
  await page.run(()=>{const t=__collabVisual;t.state.tasks[0].task.description='让任务协作自然地融入对话：保留完整上下文，明确每一步的执行状态，最终交付可验收的结果。';t.view.render(t.state);});
 });
 await check('Escape closes and restores pin focus',async()=>{
  await key('Escape');assert.equal(await page.run(()=>!!document.querySelector('[data-collab-dossier]')),false);
  assert.equal(await page.run(()=>document.activeElement.getAttribute('data-collab-task-select')),'visual-0');
 });
 await check('pin toggles and outside click keeps chat usable',async()=>{
  await click('[data-collab-task-select="visual-0"]');await click('[data-collab-task-select="visual-0"]');
  assert.equal(await page.run(()=>!!document.querySelector('[data-collab-dossier]')),false);
  await click('[data-collab-task-select="visual-0"]');await click('#nchatInput');assert.equal(await page.run(()=>!!document.querySelector('[data-collab-dossier]')),false);
 });
 await check('task switching and waiting, retry, completion actions',async()=>{
  await click('[data-collab-task-select="visual-2"]');assert.match(await page.run(()=>document.querySelector('.ncollab-dossier-status').textContent),/等待人工/);await shot('04-waiting');
  await click('[data-collab-task-select="visual-4"]');await click('[data-collab-action="retry"]');
  assert.deepEqual(await page.run(()=>__collabVisual.actions.at(-1)),{action:'retry',taskId:'visual-4'});await shot('05-failed');
  await click('[data-collab-task-select="visual-3"]');assert.match(await page.run(()=>document.querySelector('.ncollab-dossier-status').textContent),/执行完成 · 任务待确认/);
  await click('[data-collab-tab="artifacts"]');assert.equal(await page.run(()=>document.querySelectorAll('.ncollab-evidence-row').length),2);await shot('06-artifacts');
 });
 await check('task picker replaces detail, searches and selects',async()=>{
  await click('[data-collab-add]');assert.equal(await page.run(()=>!!document.querySelector('[data-collab-dossier]')),false);
  await click('[data-collab-search]');await page.call('Input.insertText',{text:'周报'});
  assert.equal(await page.run(()=>[...document.querySelectorAll('[data-task-title]')].filter(x=>!x.hidden).length),1);await shot('07-add-task');
  await page.run(()=>__collabVisual.view.render(__collabVisual.state));assert.equal(await page.run(()=>document.querySelector('[data-collab-search]').value),'周报');
  await click('[data-collab-task-select="candidate-a"]');assert.equal(await page.run(()=>__collabVisual.actions.at(-1).action),'select-task');
  await click('[data-collab-add]');await click('[data-collab-picker-close]');assert.equal(await page.run(()=>!!document.querySelector('.ncollab-picker')),false);
 });
 await check('minimum 12px and no overflow at four desktop sizes',async()=>{
  for(const [width,height] of [[1440,1000],[1280,800],[1024,768],[800,600]]){
   await page.call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await click('[data-collab-task-select="visual-1"]');
   for(const tab of ['task','execution','artifacts']){await click('[data-collab-tab="'+tab+'"]');const g=await geometry();assert.deepEqual(g.small,[]);assert.ok(g.inBounds,width+' panel outside chat');assert.equal(g.overflow,false);}
   await shot('08-size-'+width);await key('Escape');
  }
 });
 await check('reduced motion and cleanup',async()=>{
  await page.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  assert.equal(await page.run(()=>getComputedStyle(document.querySelector('.ncollab-note-status.is-running'),'::after').animationName),'none');
  await page.run(()=>__collabVisual.view.destroy());assert.equal(await page.run(()=>document.querySelector('#collabVisualHost').innerHTML),'');
 });
 const errors=page.takeRuntimeErrors();
 fs.writeFileSync(evidence+'/results.json',JSON.stringify({kind:'UI presentation fixtures; no real task execution',passed:results,errors,startupErrors,networkErrors},null,2));
 assert.equal(errors.filter(x=>!/^Failed to load resource:/.test(x)).length,0,'No script exceptions during UI interactions');
}finally{
 await page.call('Emulation.clearDeviceMetricsOverride').catch(()=>{});
 await page.call('Emulation.setEmulatedMedia',{features:[]}).catch(()=>{});
 await page.call('Page.reload',{ignoreCache:true}).catch(()=>{});page.close();
}
