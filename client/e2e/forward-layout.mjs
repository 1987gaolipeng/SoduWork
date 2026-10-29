import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { CdpPage, waitForPage, delay } from './lib/cdp.mjs';
const client = path.resolve(import.meta.dirname, '..');
const out = path.resolve(process.argv[2] || 'forward-layout-evidence');
fs.mkdirSync(out, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-forward-layout-'));
const source = fs.readFileSync(path.join(client, 'components/panels/panels-detail.js'), 'utf8');
const begin = source.indexOf("_fwdHtml = '<button");
const end = source.indexOf(';', source.indexOf("class=\"fwd-confirm\"", begin));
const markup = source.slice(begin + '_fwdHtml = '.length, end);
assert.ok(markup.includes('fwdConfirm') && markup.includes('fwd-candidates') && markup.includes('fwd-settings'));
const desk = fs.readFileSync(path.join(client, 'desk.html'), 'utf8');
const links = [...desk.matchAll(/<link[^>]+rel="stylesheet"[^>]*>/g)].map(m => m[0]).join('\n');
const scripts = ['panels-icons', 'task-execution-context', 'task-execution-client', 'panels-forward-plugin', 'panels-forward-picker', 'panels-forward-options', 'panels-forward'];
const html = `<!doctype html><html lang="zh-CN" data-desk-panel="workspace" data-workspace-view="detail"><meta charset="utf-8"><title>派活布局 · 隔离测试</title>${links}
<style>body{margin:0;background:var(--bg-1)}#detailPanel{opacity:1;pointer-events:auto}#testLabel{padding:22px;color:var(--ink-4);font:14px var(--font-ui)}</style>
<div id="testLabel">派活布局验证 · 全部为隔离数据</div><div id="detailPanel" class="panel show"><div id="detailContent"></div></div>
<script>
window.esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
window.tasks=[{id:'layout-fixture',title:'整理产品需求与验收标准（隔离测试）',note:'汇总信息，保留附件并核对验收标准。',tags:[]}];
window.calls=[];window._flowTlCache={};window._humanErr=e=>e.message;
window.options={schemaVersion:2,selection:{repoId:'general'},repos:[{id:'general',name:'通用办公工程'}],scenario:{name:'通用办公'},
  substrates:Array.from({length:60},(_,i)=>({key:'agent-'+i,cli:['pi','codex','opencode'][i%3],name:i===59?'Agent 059 最后一项':(['Pi','Codex Harness','OpenCode'][i%3]+' '+String(i).padStart(3,'0')),
  available:i%7!==6,onlineSeats:3,modelPick:true,remote:i%2===1,locationLabel:i%2?'远程研发设备':'本地电脑',note:'设备 '+String(i).padStart(3,'0')+' · 按任务能力安排可用席位',capabilitySets:[['files']]})),
  workflows:[],blockedWorkflows:[],recommendation:{strategy:'direct',substrateKey:'agent-0'},models:['default-model','review-model'],defaultModel:'default-model'};
window.mates=Array.from({length:240},(_,i)=>({id:'mate-'+i,name:i===239?'末位同事 239':'测试同事 '+String(i).padStart(3,'0'),org:'部门 '+String(i%12).padStart(2,'0'),hasBox:i%5!==4,deviceCount:1}));
window.SoduWorkAPI={taskExecutionOptions:async()=>structuredClone(options),listTeammates:async()=>({ok:true,mates}),listAttachments:async()=>[],
 dispatchToAI:async(...args)=>{calls.push({type:'dispatch',args});return{ok:false,reason:'隔离校验：请求已记录，未派出真实任务。'}},
 handoffTask:async(...args)=>{calls.push({type:'handoff',args});return{ok:false,reason:'隔离校验：转交参数已记录。'}},
 aiPreview:async()=>({title:tasks[0].title,description:tasks[0].note})};
</script>${scripts.map(s=>'<script src="components/panels/'+s+'.js"></script>').join('')}
<script>
document.getElementById('detailContent').innerHTML=(${markup});
window.openPicker=tab=>{document.getElementById('fwdPop').style.display='flex';_fwdSwitch('layout-fixture',tab,{fresh:true})};
document.querySelectorAll('[data-fwdtab]').forEach(b=>b.onclick=()=>_fwdSwitch('layout-fixture',b.dataset.fwdtab));
document.querySelector('[data-act="fwd-close"]').onclick=_closeFwd;
openPicker('ai');
</script></html>`;
const server = http.createServer((req,res)=>{
 if(req.url==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);return;}
 const relative=decodeURIComponent(req.url.split('?')[0]).replace(/^\//,'');
 const file=path.resolve(client,relative);
 if(!file.startsWith(client+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.statusCode=404;res.end();return;}
 res.setHeader('Content-Type',file.endsWith('.css')?'text/css; charset=utf-8':file.endsWith('.js')?'text/javascript; charset=utf-8':'application/octet-stream');res.end(fs.readFileSync(file));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(path.join(client,'node_modules/electron/dist/electron.exe'),[path.join(client,'e2e/fixtures/plugin-resource-window.cjs'),profile,'http://127.0.0.1:'+server.address().port,'--remote-debugging-port='+port],{env,windowsHide:true,stdio:'ignore'});
let page;const result={screens:[],checks:[]};
async function click(s){
 await page.waitFor(s=>{const e=document.querySelector(s);return e&&!e.disabled&&e.checkVisibility()},s);
 const pt=await page.run(s=>{const e=document.querySelector(s);e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}},s);
 for(const type of ['mousePressed','mouseReleased'])await page.call('Input.dispatchMouseEvent',{type,...pt,button:'left',clickCount:1});
 await delay(60);
}
async function search(selector,text){await page.run(s=>{const e=document.querySelector(s);e.focus();e.select()},selector);await page.call('Input.insertText',{text});await delay(60);}
async function shot(name){const s=await page.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(s.data,'base64'));}
async function geometry(tab,w,h,scale=1){
 await page.call('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:1,mobile:false});
 await page.run(({tab,scale})=>{document.documentElement.style.setProperty('--font-scale',scale);openPicker(tab)},{tab,scale});
 await page.waitFor(()=>document.querySelectorAll('[data-fwd-choice]').length>0);await delay(100);
 const g=await page.run(()=>{
  const p=document.getElementById('fwdPop'),c=document.getElementById('fwdConfirm'),r=p.getBoundingClientRect(),b=c.getBoundingClientRect(),f=p.querySelector('.fwd-actions').getBoundingClientRect(),s=p.querySelector('.fwd-scroll').getBoundingClientRect();
  const overflows=[p,...p.querySelectorAll('.fwd-scroll,.fwd-candidates,.fwd-settings,.fwd-list,.fwd-item,.fwp-card')].filter(e=>e.checkVisibility()&&e.scrollWidth>e.clientWidth+1).map(e=>e.className);
  const fonts=[...p.querySelectorAll('*')].filter(e=>e.checkVisibility()&&(/^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName)||[...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim()))).map(e=>({tag:e.tagName,cls:e.className,size:parseFloat(getComputedStyle(e).fontSize)}));
  const candidates=[...p.querySelectorAll('[data-fwd-choice]')].filter(e=>e.checkVisibility()).map(e=>e.getBoundingClientRect());
  return{popup:{left:r.left,top:r.top,right:r.right,bottom:r.bottom},button:{top:b.top,bottom:b.bottom},contentBottom:s.bottom,footerTop:f.top,
   inViewport:r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1,
   footerHit:c.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)),overflows,
   minFont:Math.min(...fonts.map(f=>f.size)),smallFonts:fonts.filter(f=>f.size<12),
   overlap:candidates.some((r,i)=>i>0&&r.top<candidates[i-1].bottom-1),
   columns:getComputedStyle(p.querySelector('.fwd-scroll')).display};
 });
 assert.ok(g.inViewport,JSON.stringify({w,h,g}));assert.ok(g.button.bottom<=h&&g.footerHit,JSON.stringify({w,h,g}));assert.ok(g.contentBottom<=g.footerTop+1,JSON.stringify(g));
 assert.deepEqual(g.overflows,[],JSON.stringify({w,h,g}));assert.equal(g.overlap,false);assert.ok(g.minFont>=12,JSON.stringify(g.smallFonts));
 result.screens.push({tab,width:w,height:h,scale,...g});
}
try{
 for(let i=0;i<60;i++){try{page=await CdpPage.connect(await waitForPage(port,p=>p.url.startsWith('http://127.0.0.1:'),1000));break}catch{await delay(150)}}
 assert.ok(page);await page.waitFor(()=>typeof openPicker==='function',null,15000);await page.call('Emulation.setFocusEmulationEnabled',{enabled:true});
 for(const [w,h,scale] of [[1366,768,1],[1280,720,1],[1093,614,1],[960,540,1],[800,600,1],[600,700,1],[375,667,1],[1366,768,.85],[1366,768,1.5]]){
  for(const tab of ['ai','mate'])await geometry(tab,w,h,scale);
 }
 await geometry('ai',1366,768);await shot('ai-laptop');
 await search('#fwdAgentSearch','059');
 assert.equal(await page.run(()=>[...document.querySelectorAll('[data-fwd-choice="direct"]')].filter(e=>!e.hidden).length),1);
 await click('[data-aid="agent-59"]');
 assert.match(await page.run(()=>document.getElementById('fwdConfirm').textContent),/059/);
 await page.run(()=>{const m=document.getElementById('fwdModel');m.value='review-model';m.dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('fwdNote').value='保留验收标准';});
 await search('#fwdAgentSearch','no-such-agent');assert.equal(await page.run(()=>document.getElementById('fwdSearchEmpty').hidden),false);
 assert.match(await page.run(()=>document.getElementById('fwdConfirm').textContent),/059/);
 await click('#fwdSearchClear');assert.equal(await page.run(()=>document.querySelectorAll('[data-fwd-choice="direct"]:not([hidden])').length),60);
 assert.equal(await page.run(()=>document.getElementById('fwdModel').value),'review-model');
 await click('#fwdConfirm');assert.equal(await page.run(()=>calls.filter(c=>c.type==='dispatch').length),1);
 const dispatched=await page.run(()=>calls.find(c=>c.type==='dispatch').args);assert.equal(dispatched[1].id,'agent-59');assert.equal(dispatched[2],'保留验收标准');assert.equal(dispatched[4],'review-model');
 result.checks.push('60 Agents: search, last-item selection, clear, model/note preservation and single captured dispatch');
 await geometry('mate',1366,768);await shot('coworkers-laptop');
 await search('#fwdMateSearch','238');await click('[data-aid="mate-238"]');
 await click('#fwdConfirm');assert.equal(await page.run(()=>calls.filter(c=>c.type==='handoff').length),1);
 assert.equal(await page.run(()=>calls.find(c=>c.type==='handoff').args[1]),'mate-238');
 await search('#fwdMateSearch','239');assert.equal(await page.run(()=>document.querySelectorAll('[data-fwd-choice="mate"]').length),0);
 await click('[data-fwd-mate-filter="all"]');assert.equal(await page.run(()=>document.querySelector('[data-aid="mate-239"]').disabled),true);
 await search('#fwdMateSearch','部门 03');assert.ok(await page.run(()=>document.querySelectorAll('[data-fwd-choice="mate"]').length>10));
 result.checks.push('240 coworkers: search by name/department, filtered counts, last available member, unavailable member blocked, single captured handoff');
 await page.run(()=>{options.workflows=[{bindingId:'flow',name:'需求澄清与交付方法',runnable:true,version:'1.2',workflow:[{type:'ai',name:'整理需求',key:'plan',route:{agentSource:'runtime'}}]}];});
 await geometry('ai',1093,614);await click('[data-fwp-toggle]');
 await search('#fwdAgentSearch','需求澄清');assert.equal(await page.run(()=>document.querySelector('[data-fwp-card]').hidden),false);
 assert.equal(await page.run(()=>document.querySelectorAll('[data-fwd-choice="direct"]:not([hidden])').length),0);
 await shot('workflow-compact');
 await geometry('ai',375,667);await shot('narrow-ai');
 await page.run(()=>{options.substrates[0].name='非常长的执行团队与 Agent 名称'.repeat(6);options.substrates[0].note='用于核对长说明能否换行显示。'.repeat(10);options.defaultModel='long-model-name-'.repeat(12);});
 await geometry('ai',600,700,1.5);await shot('long-labels');
 const errors=page.takeRuntimeErrors();assert.deepEqual(errors,[]);
 result.checks.push('Workflow remains selectable and searchable; no renderer errors across the viewport matrix');
 fs.writeFileSync(path.join(out,'verification.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({screens:result.screens.length,checks:result.checks}));
}finally{if(page)page.close();child.kill();await new Promise(r=>server.close(r));}
