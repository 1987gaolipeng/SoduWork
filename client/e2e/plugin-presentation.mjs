// Isolated browser, real UI modules, deterministic data; no live client or backend writes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {CdpPage,listPages,delay} from './lib/cdp.mjs';
const output=path.resolve(process.argv[2]||path.join(os.tmpdir(),'soduwork-plugin-ui-evidence'));
fs.mkdirSync(output,{recursive:true});
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-plugin-ui-browser-'));
const child=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',[
 '--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
 '--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile,
 '--window-size=1440,1000','about:blank'],{windowsHide:true,stdio:'ignore'});
let page;const checks=[];
try{
 let port;
 for(let i=0;i<80;i++){try{port=Number(fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);if(port)break;}catch{}await delay(100);}
 assert.ok(port);
 page=await CdpPage.connect((await listPages(port))[0]);
 await page.call('Page.navigate',{url:new URL('../tests/plugin-presentation.html',import.meta.url).href});
 await page.waitFor(()=>document.querySelectorAll('.cap-plugin-card').length===7,null,10000);
 await page.call('Page.bringToFront');
 await page.call('Emulation.setFocusEmulationEnabled',{enabled:true});
 async function click(selector){
  const p=await page.run(selector=>{const e=document.querySelector(selector);assertVisible(e);
   e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};
   function assertVisible(e){if(!e||!e.getBoundingClientRect().width)throw Error('Missing visible '+selector);}
  },selector);
  for(const type of ['mousePressed','mouseReleased'])await page.call('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1});
  await delay(100);
 }
 async function key(key){
  await page.call('Input.dispatchKeyEvent',{type:'keyDown',key});
  await page.call('Input.dispatchKeyEvent',{type:'keyUp',key});
  await delay(80);
 }
 async function fill(selector,value){await click(selector);await page.run(s=>document.querySelector(s).select(),selector);await page.call('Input.insertText',{text:value});await delay(60);}
 async function shot(name){const s=await page.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(s.data,'base64'));}
 async function audit(name,selector){
  const result=await page.run(selector=>{
   const root=document.querySelector(selector);
   function visible(e){
    if(!e.getClientRects().length||getComputedStyle(e).visibility==='hidden'||e.closest('[hidden]'))return false;
    for(let p=e.parentElement;p;p=p.parentElement)
     if(p.matches('details:not([open])')&&!p.querySelector(':scope>summary').contains(e))return false;
    return true;
   }
   const small=[root,...root.querySelectorAll('*')].filter(e=>visible(e)&&(
     [...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim())||e.matches('input:not([type=checkbox]),select,textarea'))&&parseFloat(getComputedStyle(e).fontSize)<12)
     .map(e=>({tag:e.tagName,cls:e.className,font:getComputedStyle(e).fontSize,text:e.textContent.slice(0,50)}));
   const boxes=[root,...root.querySelectorAll('.cap-plugin-card,.cap-modal-body,.cap-modal-foot,.cap-detail-pane:not([hidden]),.cap-flow-line,.cap-maker-group-body,.cap-skill-options,.cap-workflow-inspector')].filter(visible);
   return{small,overflow:boxes.filter(e=>e.scrollWidth>e.clientWidth+2).map(e=>({cls:e.className,width:e.clientWidth,scroll:e.scrollWidth})),
    windowOverflow:document.documentElement.scrollWidth>innerWidth+1};
  },selector);
  assert.deepEqual(result.small,[],name+' font floor');assert.deepEqual(result.overflow,[],name+' overflow');assert.equal(result.windowOverflow,false);
  checks.push({name,...result});
 }
 const skins=await page.run(()=>SkinRegistry.getSkins().map(s=>({id:s.id,theme:s.palette,skin:s.material})));
 for(const skin of skins){
  await page.run(s=>{document.documentElement.dataset.theme=s.theme;document.documentElement.dataset.skin=s.skin},skin);
  await delay(300);
  await page.call('Emulation.setDeviceMetricsOverride',{width:1600,height:1000,deviceScaleFactor:1,mobile:false});
  await audit(skin.id+' library','#capPanel');
  if(skin.id==='bear-ruby'||skin.id==='flat-azure')await shot(skin.id+'-library');
  await click('.cap-plugin-open[data-plugin="personal-test"]');
  await audit(skin.id+' overview','.cap-plugin-detail-modal');
  if(skin.id==='bear-ruby')await shot('detail-overview');
  await click('#capDetailResourcesTab');await audit(skin.id+' resources','.cap-plugin-detail-modal');
  if(skin.id==='bear-ruby')await shot('detail-resources');
  await key('ArrowRight');
  assert.equal(await page.run(()=>document.activeElement.id),'capDetailQualityTab');
  await audit(skin.id+' quality','.cap-plugin-detail-modal');
  await click('.cap-plugin-more>summary');await audit(skin.id+' management','.cap-plugin-detail-modal');
  if(skin.id==='bear-ruby')await shot('detail-management');
  await key('Escape');assert.equal(await page.run(()=>document.querySelector('.cap-plugin-more').open),false);
  await key('Escape');assert.ok(await page.run(()=>document.querySelector('#capModalLayer').hidden));
 }
 // Actual card action follows the existing conversation callback, only navigation is mocked.
 await click('[data-plugin-use="enterprise-0"]');await delay(100);
 assert.ok(await page.run(()=>fixtureCalls.some(c=>c[0]==='create'&&c[1]?.pluginId==='enterprise-0')));
 assert.equal(await page.run(()=>document.querySelectorAll('[data-plugin-use="enterprise-3"],[data-plugin-use="enterprise-4"]').length),0);
 await click('.cap-plugin-open[data-plugin="personal-test"]');
 await click('#capPersonalEdit');
 await page.waitFor(()=>!!document.querySelector('.cap-plugin-maker-modal'));
 assert.equal(await page.run(()=>document.querySelectorAll('.cap-maker-group[open]').length),0);
 await audit('editor initial','.cap-plugin-maker-modal');await shot('editor-overview');
 assert.ok(await page.run(()=>document.querySelector('#capWorkflow').getBoundingClientRect().height>300),'workflow editor must not collapse below the long form');
 await click('[data-maker-group="dependencies"]>summary');
 assert.ok(await page.run(()=>{
  const group=document.querySelector('[data-maker-group="dependencies"]'),body=document.querySelector('#capModalBody');
  return group.getBoundingClientRect().top-body.getBoundingClientRect().top<50;
 }),'expanded group scrolls into view');
 await page.waitFor(()=>document.querySelectorAll('[data-plugin-skill]').length===43);
 await audit('editor skills','.cap-plugin-maker-modal');
 await shot('editor-skills');
 await fill('#capSkillSearch','research-02');
 assert.equal(await page.run(()=>document.querySelectorAll('[data-plugin-skill]').length),1);
 await click('[data-plugin-skill][value="research-02"]');
 await fill('#capSkillSearch','no-match');
 assert.equal(await page.run(()=>document.querySelectorAll('[data-plugin-skill]').length),0);
 assert.match(await page.run(()=>document.querySelector('#capSkillCount').textContent),/3/);
 await fill('#capSkillSearch','');
 await click('#capSkillSelectedOnly');
 assert.equal(await page.run(()=>document.querySelectorAll('[data-plugin-skill]').length),3);
 await audit('editor selected skills','.cap-plugin-maker-modal');
 await shot('editor-selected-skills');
 await click('[data-maker-group="dependencies"]>summary');
 await click('[data-maker-group="inputs"]>summary');
 await audit('editor parameters','.cap-plugin-maker-modal');
 await shot('editor-parameters');
 await click('[data-maker-group="inputs"]>summary');
 await click('[data-maker-group="quality"]>summary');
 await audit('editor quality','.cap-plugin-maker-modal');
 await click('[data-maker-group="quality"]>summary');
 await click('.cap-workflow-node[data-node-index="5"]');
 assert.match(await page.run(()=>document.querySelector('.cap-workflow-inspector').textContent),/人工验收/);
 await audit('editor workflow human review','.cap-plugin-maker-modal');await shot('editor-workflow');
 await click('.cap-workflow-node[data-node-index="0"]');
 await click('#capMakerDo');
 await page.waitFor(()=>fixtureDrafts.length===1);
 const draft=await page.run(()=>fixtureDrafts[0]);
 assert.deepEqual([...draft.skills].sort(),['missing-retained','research-01','research-02']);
 assert.equal(draft.inputs[0].key,'goal');
 assert.equal(draft.inputs[0].default,'提高研发协作效率');
 assert.equal(draft.setup.preferences[0].default,'zh');
 assert.equal(draft.resources.length,2);
 assert.equal(draft.workflow.nodes.length,7);
 assert.deepEqual(draft.entrypoints,{conversation:true,task:true,automation:true});
 assert.equal(draft.instructions,await page.run(()=>fixtureDraft.instructions));
 assert.equal(draft.version,'1.0.1');
 await audit('editor preview','.cap-plugin-maker-modal');
 await click('#capMakerDo');
 await page.waitFor(()=>fixtureCalls.some(c=>c[0]==='save'));
 assert.ok(await page.run(()=>document.querySelector('#capModalLayer').hidden));
 assert.equal(await page.run(()=>fixtureDraft.version),'1.0.0');
 for(const width of [1000,1280,2400]){
  await page.call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
  await audit(width+' library','#capPanel');
  await click('.cap-plugin-open[data-plugin="personal-test"]');
  await audit(width+' detail','.cap-plugin-detail-modal');
  await click('#capPersonalEdit');
  await page.waitFor(()=>!!document.querySelector('.cap-plugin-maker-modal'));
  await click('[data-maker-group="dependencies"]>summary');await audit(width+' editor skills','.cap-plugin-maker-modal');
  await click('[data-maker-group="inputs"]>summary');await audit(width+' editor inputs','.cap-plugin-maker-modal');
  await click('#capMakerCancel');
 }
 await click('.cap-plugin-open[data-plugin="enterprise-3"]');
 await audit('upgrade detail','.cap-plugin-detail-modal');
 assert.ok(await page.run(()=>!!document.querySelector('#capEnterpriseInstall')));
 await key('Escape');
 await click('.cap-plugin-open[data-plugin="personal-test"]');
 await page.run(()=>document.querySelector('#capPluginTry').focus());
 await key('Tab');
 assert.equal(await page.run(()=>document.activeElement.id),'capModalClose');
 await key('Escape');
 assert.equal(await page.run(()=>document.activeElement.dataset.plugin),'personal-test');
 assert.deepEqual(await page.run(()=>fixtureErrors),[]);
 assert.deepEqual(page.takeRuntimeErrors(),[]);
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({ok:true,checks,notes:[
  'real page, card, modal and editor modules; only APIs/navigation use isolated fixtures',
  '8 skins; 1000/1280/1600/2400 desktop widths',
  'all visible text >=12px, no horizontal form/card overflow',
  'detail tabs and arrow keys, management disclosure, Escape, focus restore/trap',
  'use action retains conversation payload; upgrade/disabled cards cannot bypass guards',
  'search and selected-only preserve missing/hidden Skill references',
  'collapsed parameters, preferences, workflow, resources survive preflight and mock save'
 ]},null,2));
 console.log(JSON.stringify({ok:true,checks:checks.length,output}));

}catch(error){
 if(page){
  console.error(JSON.stringify(await page.run(()=>({errors:fixtureErrors,body:document.body.innerText.slice(-2200)})).catch(()=>({}))));
  console.error(page.takeRuntimeErrors());
  try{const s=await page.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,'failure.png'),Buffer.from(s.data,'base64'));}catch{}
 }
 throw error;
}finally{
 if(page){try{await page.call('Browser.close')}catch{}page.close();}
 if(child.exitCode===null)child.kill();
}
