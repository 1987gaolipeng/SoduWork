import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import http from 'node:http';import net from 'node:net';import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {CdpPage,waitForPage} from './lib/cdp.mjs';
const client=path.resolve(import.meta.dirname,'..'), evidence=path.resolve(process.argv[2]||'agent-choice-evidence');
fs.mkdirSync(evidence,{recursive:true});
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-agent-choice-'));
const clis=['pi','codex','opencode','codex-harness','dsh','qwen'],names=['Pi','Codex','OpenCode','Codex Harness','DeepSeek Harness','Qwen Code'];
const options={schemaVersion:2,selection:{projectId:'project',repoId:'general',projectLocked:true},
 scenario:{key:'office',name:'通用办公',routing:{scenarioKey:'office',requiredAgentCapabilities:['files']}},
 repos:[{id:'general',name:'通用工程',projectId:'project',branch:'develop',localDir:'general'},
 {id:'second',name:'另一个工程',projectId:'project',branch:'develop'}],
 substrates:clis.map((cli,i)=>({key:'local:'+cli,cli,name:names[i],available:true,onlineSeats:1,modelPick:true,
 note:'本机已就绪',locationMode:'local',capabilitySets:[['files','repository','terminal']]})),
 models:['chat-default','chosen-model'],defaultModel:'chat-default',blockedWorkflows:[],
 recommendation:{workflowRequired:true,strategy:'workflow',workflowBindingId:'flow',substrateKey:'local:pi'},
 workflows:[{bindingId:'flow',key:'sample',name:'需求处理工作流',version:'1.0.0',runnable:true,agentKind:'local:qwen',
 projectSpecific:true,workflow:[{type:'human_review',key:'confirm',name:'确认范围'},
 {type:'ai',key:'draft',name:'整理需求',route:{agentKind:'local:codex',model:'node-model',agentSource:'plugin',modelSource:'plugin'}},
 {type:'ai_review',key:'review',name:'独立检查',route:{agentKind:'local:pi',model:'review-model',agentSource:'plugin',modelSource:'plugin'}}]}]};
const scripts=['task-execution-context','task-execution-client','requirement-fields','panels-compose-submit','task-priority','compose-selection-position','panels-compose-draft','panels-forward-plugin','panels-forward-picker','panels-forward-options','panels-forward'];
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>派活选择回归 · 隔离数据</title>
${['panels','panels-forward-plugin','panels-chat','work-composer'].map(n=>'<link rel="stylesheet" href="/components/panels/'+n+'.css">').join('')}
<link rel="stylesheet" href="/theme/workspace-experience.css">
<link rel="stylesheet" href="/components/workspace/workspace-shell.css">
<link rel="stylesheet" href="/components/workspace/workspace-page-layout.css">
<style>:root{--ink:#243044;--ink-2:#344155;--ink-3:#546276;--ink-4:#637286;--ink-5:#707b89;--line:#dde4ed;--line-2:#e3e8ef;--bg-0:#fff;--bg-1:#f7f9fc;--bg-2:#eef3f8;--bg-3:#eaf0f6;--accent:#3677ee;--accent-soft:#edf4ff;--text-xs:12px;--text-sm:14px;--font-scale:1}*{box-sizing:border-box}body{margin:0;background:var(--bg-1);color:var(--ink);font:14px/1.5 "Segoe UI","Microsoft YaHei",sans-serif}main{max-width:780px;margin:20px auto;padding:20px}button{font:inherit}#fwdPop{position:relative;inset:auto;transform:none;margin:20px auto;max-height:none;width:100%;display:none}.fwd-scroll{max-height:650px}#status{padding:12px}.cp-card{background:white}</style>
<main><h2>执行方式 · 页面回归验证</h2><p>产品真实组件，隔离任务数据；不调用模型或企业发布。</p>
<button id="requirements">新建需求并派活</button> <button id="forward">转给自己后派活</button><div id="cpDraft"></div>
<section id="fwdPop" class="fwd-pop" role="dialog" aria-label="安排任务">
<header class="fwd-head"><span><b>安排这项任务</b><small>选择工作流或直接交给 AI</small></span><button id="close">×</button></header>
<div class="fwd-scroll"><div id="fwdRepo" class="fwd-repo"><label><span>任务工程</span><select id="fwdRepoSel"></select></label><small id="fwdRepoHint"></small></div>
<div id="fwdList" class="fwd-list"></div><label id="fwdPlanWrap"><input id="fwdPlanChk" type="checkbox">先出计划</label>
<textarea id="fwdNote" placeholder="补充说明"></textarea><div id="fwdDecision" class="fwd-decision"></div><div id="fwdFoot" class="fwd-foot"></div><div id="fwdPrev" style="display:none"></div></div>
<footer class="fwd-actions"><span id="fwdStatus"></span><button id="fwdConfirm" class="fwd-confirm">确认派活</button></footer></section>
<div id="status" role="status"></div></main><script>
window.options=${JSON.stringify(options)};window.calls=[];window.tasks=[{id:"assigned",title:"转给自己的需求任务",note:"完整说明",status:"todo",tags:[]}];
window.esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
window._svg=()=>'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"><rect x="4" y="5" width="16" height="14" rx="4"/><path d="M8 10h8M8 14h5"/></svg>';
window.uid=()=>crypto.randomUUID();window.save=()=>{};window.render=()=>{};
window.petSay=text=>document.querySelector('#status').textContent=text;
window._humanErr=e=>e.message;window._flowTlCache={};window._redrawTimeline=()=>{};window.detailId='';
window.Store={persistTask:async id=>{calls.push({type:'persist',id,body:structuredClone(tasks.find(t=>t.id===id))});return true},dropTask:()=>{},applyServerEvent:e=>{tasks.push(e.task)}};
window.SoduWorkAPI={
 taskExecutionOptions:async body=>{calls.push({type:'options',body});return structuredClone(options)},
 listTeammates:async()=>({mates:[]}),workCatalog:async()=>({scenarios:[{key:'office',name:'通用办公',defaultPluginKey:'sample'}]}),
 listAttachments:async()=>[{name:'需求截图.png'},{name:'说明.txt'}],
 uploadAttachment:async(id,f,meta)=>{calls.push({type:'upload',id,name:f.name,meta});return {id:'uploaded-'+f.name}},
 dispatchToAI:async(...args)=>{calls.push({type:'dispatch',args});return {ok:true,identifier:'isolated-accepted'}},
 startTaskPlugin:async(id,body)=>{calls.push({type:'workflow',id,body});return {ok:true}}
};
</script>${scripts.map(n=>'<script src="/components/panels/'+n+'.js"></script>').join('')}<script>
const materials=[new File(['image'],'需求截图.png',{type:'image/png'}),new File(['context'],'说明.txt',{type:'text/plain'})];
document.querySelector('#requirements').onclick=()=>{
 document.querySelector('#fwdPop').style.display='none';
 ComposeDraft.openWith({title:'包含完整材料的需求',note:'第一条需求说明\\n第二条需求说明',repoId:'general',projectId:'project',
 assigneeKind:'ai',flow:'flow',checklist:['验收 A','验收 B']},
 {variant:'sheet',requirement:true,atts:()=>materials,model:()=> 'chat-default'});
};
document.querySelector('#forward').onclick=()=>{ComposeDraft.clear();document.querySelector('#fwdPop').style.display='block';_fwdReset('assigned');_fwdSwitch('assigned','ai')};
document.querySelector('#close').onclick=_closeFwd;
</script></html>`;
const server=http.createServer((req,res)=>{
 if(req.url==='/'){res.setHeader('content-type','text/html; charset=utf-8');res.end(html);return}
 const relative=decodeURIComponent(req.url.split('?')[0]).slice(1);
 if(!/^(components|theme)\/[a-z0-9/_-]+\.(css|js)$/.test(relative)){res.statusCode=404;res.end();return}
 const file=path.join(client,relative);if(!fs.existsSync(file)){res.statusCode=404;res.end();return}
 res.setHeader('content-type',relative.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(file));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(path.join(client,'node_modules/electron/dist/electron.exe'),
 [path.join(client,'e2e/fixtures/plugin-resource-window.cjs'),path.join(temp,'profile'),'http://127.0.0.1:'+server.address().port,'--remote-debugging-port='+port],
 {windowsHide:true,env,stdio:'ignore'});
let page;const checks=[];
async function click(s){
 await page.waitFor(s=>{const e=document.querySelector(s);return e&&!e.disabled&&e.getClientRects().length},s);
 const pos=await page.run(s=>{const e=document.querySelector(s);e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}},s);
 for(const type of ['mousePressed','mouseReleased'])await page.call('Input.dispatchMouseEvent',{type,...pos,button:'left',clickCount:1});
}
async function shot(name){const r=await page.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(evidence,name+'.png'),Buffer.from(r.data,'base64'))}
try{
 for(let i=0;i<60;i++){try{page=await CdpPage.connect(await waitForPage(port,p=>p.url.startsWith('http://127.0.0.1:'),1000));break}catch{await delay(150)}}
 assert.ok(page);await page.call('Page.enable');await page.call('Emulation.setFocusEmulationEnabled',{enabled:true});
 await click('#requirements');await page.waitFor(()=>document.querySelector('[data-selbtn="who"]'));
 assert.match(await page.run(()=>document.querySelector('#cpRows').textContent),/首个 AI 节点.*codex/);await shot('01-workflow-node-route');
 await click('[data-selbtn="who"]');
 const geometry=await page.run(()=>{const p=document.querySelector('.cp-selpop-who'),r=p.getBoundingClientRect();return {fits:r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth,icon:document.querySelector('.cp-mtick svg').getBoundingClientRect().width}});
 assert.ok(geometry.fits,'Assignee menu must fit the viewport');assert.ok(geometry.icon<=24,'Actual component styles must be loaded');
 assert.equal(await page.run(()=>document.querySelectorAll('[data-selv^="who|agent:"]:not([disabled])').length),6);await shot('02-all-agent-choices');
 await click('[data-selv="who|agent:local:qwen"]');
 assert.match(await page.run(()=>document.querySelector('#cpRows').textContent),/不使用工作流/);
 await click('[data-selbtn="repo"]');await click('[data-selv="repo|second"]');
 await page.waitFor(()=>document.querySelector('#cpRows').textContent.includes('另一个工程'));
 assert.match(await page.run(()=>document.querySelector('#cpRows').textContent),/Qwen Code/);
 assert.match(await page.run(()=>document.querySelector('#cpRows').textContent),/不使用工作流/);await shot('03-direct-requirement-confirm');
 await click('#cpCreate');await page.waitFor(()=>calls.some(c=>c.type==='dispatch'));
 const captured=await page.run(()=>calls),persisted=captured.filter(c=>c.type==='persist'),dispatch=captured.find(c=>c.type==='dispatch');
 assert.equal(persisted.length,1);assert.equal(captured.filter(c=>c.type==='dispatch').length,1);
 assert.equal(captured.filter(c=>c.type==='workflow').length,0);
 assert.equal(persisted[0].body.repoId,'second');assert.match(persisted[0].body.note,/第一条需求说明.*\n第二条需求说明/);
 assert.deepEqual(persisted[0].body.acceptanceCriteria,['验收 A','验收 B']);
 assert.deepEqual(captured.filter(c=>c.type==='upload').map(c=>c.name),['需求截图.png','说明.txt']);
 assert.ok(captured.filter(c=>c.type==='upload').every(c=>c.id===persisted[0].id&&c.meta.purpose==='requirement_input'));
 assert.equal(dispatch.args[0],persisted[0].id);
 assert.equal(dispatch.args[1].id,'local:qwen');assert.equal(dispatch.args[5].strategy,'direct');assert.equal(dispatch.args[5].plugin,null);
 checks.push('单一需求：切换 Qwen、切换工程，保留完整背景/截图/附件/完成标准，只创建并派活同一个 Task');
 await click('#requirements');await page.waitFor(()=>document.querySelector('[data-selbtn="flow"]'));
 await click('[data-selbtn="flow"]');await click('[data-selv="flow|"]');
 assert.match(await page.run(()=>document.querySelector('#cpRows').textContent),/不使用工作流/);checks.push('退出工作流，恢复 AI 选择');
 await click('#forward');await page.waitFor(()=>document.querySelector('[data-fwd-choice="direct"]'));
 assert.equal(await page.run(()=>document.querySelectorAll('[data-fwd-choice="direct"]:not([disabled])').length),6);
 for(const cli of clis){await click('[data-fwd-choice="direct"][data-aid="local:'+cli+'"]');assert.equal(await page.run(()=>document.querySelector('#fwdConfirm').disabled),false)}
 await shot('04-assigned-task-direct-ai');
 await click('#fwdConfirm');await page.waitFor(()=>calls.filter(c=>c.type==='dispatch').length===2);
 assert.equal(await page.run(()=>calls.filter(c=>c.type==='dispatch')[1].args[1].id),'local:qwen');
 checks.push('转给自己后派活：6 类 AI 均可选，旧 Hub workflowRequired=true 也不隐藏选项');
 await page.run(()=>{options.substrates[0].available=false;options.substrates[0].note='Runner 已离线，请重新连接'});
 await click('#forward');await page.waitFor(()=>document.querySelector('[data-aid="local:pi"]')?.disabled);
 assert.equal(await page.run(()=>document.querySelectorAll('[data-fwd-choice="direct"]:not([disabled])').length),5);
 await shot('05-offline-agent-reason');checks.push('未就绪 AI 显示原因且不能误启动，其余 AI 仍可选');
 assert.deepEqual(page.takeRuntimeErrors(),[]);console.log(JSON.stringify({ok:true,checks},null,2));
}catch(e){process.exitCode=1;checks.push({error:String(e.stack||e)});if(page)await shot('failure');console.error(e)}
finally{
 fs.writeFileSync(path.join(evidence,'report.json'),JSON.stringify({checks,scope:'真实页面组件 + 隔离接口载荷验证；不等同真实模型执行',errors:page?.takeRuntimeErrors()},null,2));
 page?.close();child.kill();await new Promise(r=>server.close(r));
}
