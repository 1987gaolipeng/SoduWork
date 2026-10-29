// Real Electron UI -> existing conversation IPC -> local Runner -> real configured model.
// Uses an isolated profile/workspace and only reads the enrolled profile for model authorization.
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import net from 'node:net';
import assert from 'node:assert/strict';import {spawn} from 'node:child_process';
import {CdpPage,waitForPage,delay} from './lib/cdp.mjs';
const client=path.resolve(import.meta.dirname,'..'),profile=process.env.SODUWORK_E2E_PROFILE;
if(!profile)throw Error('SODUWORK_E2E_PROFILE is required; enrollment is never created by this test');
const evidence=path.resolve(process.argv[2]||path.join(os.tmpdir(),'incubator-live-'+Date.now()));
fs.mkdirSync(evidence,{recursive:true});
const root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-incubator-live-'));
const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
const env={...process.env,SODUWORK_E2E_INCUBATOR:'1'};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(path.join(client,'node_modules/electron/dist/electron.exe'),[path.join(client,'e2e/fixtures/plugin-runner-window.cjs'),root,profile,'--remote-debugging-port='+port],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
let startup='',page;child.stdout.on('data',x=>startup+=x);child.stderr.on('data',x=>startup+=x);
const checks=[],gates=[],states=[];
const brief='隔离端到端测试：做一个可运行的离线个人行动清单产品，名字叫「轻行」。本轮产品是小而完整的单文件 HTML 工具：新增/完成/删除任务、本地持久化、全部/未完成筛选、JSON 导出与安全导入、空状态和键盘操作。中文界面，响应式，字号至少12px。目标用户是个人；一次买断为未验证的商业假设。无需登录/支付/后端/外部服务，这些不在本轮范围。仅当前隔离工作目录；不访问外部网站、不购买资源、不提交或推送代码、不联系客户、不生产发布。用 Node 内置测试或本机已有浏览器验证，禁止下载依赖。本轮已明确目标；工作流审批仍需等待。接受本轮小范围真实产品，不扩张成功标准。包内保留真实源码、测试和说明。每个阶段按声明的准确文件名交付，ZIP 要真实可解压，证据引用相对路径。';
async function click(label){const p=await page.run(label=>{const e=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===label&&!e.disabled);if(!e)throw Error('Missing button '+label);e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};},label);for(const type of ['mousePressed','mouseReleased'])await page.call('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1});}
async function shot(name){const r=await page.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(evidence,name+'.png'),Buffer.from(r.data,'base64'));}
try{
 for(let i=0;i<80;i++){if(child.exitCode!==null)throw Error('Electron exited: '+startup.slice(-1000));try{page=await CdpPage.connect(await waitForPage(port,x=>x.url.endsWith('plugin-runner.html'),1000));break;}catch{await delay(250);}}
 assert.ok(page,'Electron must start');await page.waitFor(()=>window.testState&&window.pluginTest,null,15000);
 await page.run(()=>document.querySelector('#agent').value='pi');await click('新建会话');
 await page.waitFor(()=>testState.ref||testState.error,null,60000);
 assert.equal(await page.run(()=>testState.error),'');
 const sessionId=await page.run(()=>testState.sessionId);
 await page.run(async()=>{
  for(const name of ['plugin-ui-host','plugin-debug-card']){
   const style=document.createElement('link');style.rel='stylesheet';style.href='../../components/panels/'+name+'.css';document.head.append(style);
   await new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='../../components/panels/'+name+'.js';s.onload=resolve;s.onerror=reject;document.body.append(s);});
  }
  const host=document.createElement('div');host.className='nchat-draft';document.querySelector('#composer').before(host);
  await PluginDebugCard.open({ref:testState.ref,host});
 });
 await page.waitFor(()=>document.querySelector('.pdebug textarea'),null,15000);
 await page.run(brief=>{const sel=document.querySelector('.pdebug select');sel.value='local:product-incubator';sel.dispatchEvent(new Event('change',{bubbles:true}));const all=[...document.querySelectorAll('.pdebug textarea')];all.find(e=>!e.dataset.parameter).value=brief;document.querySelector('#nchatInput').value='保留普通会话草稿';},brief);
 await shot('01-selected');await click('开始本机调试');
 let last='',completed=false;
 const minutes=Number(process.env.SODUWORK_INCUBATOR_E2E_MINUTES||60);
 assert.ok(Number.isFinite(minutes)&&minutes>=1&&minutes<=120,'E2E observation budget must be 1–120 minutes');
 const until=Date.now()+minutes*60*1000;
 while(Date.now()<until){
  const data=await page.run(()=>soduWorkAPI.personalPlugins.debug(testState.ref,{command:'get'}));
  if(!data.ok)throw Error(data.reason||'Debug query failed');
  const run=data.run;
  if(!run){await delay(500);continue;}
  const current=run.nodes.find(x=>x.status!=='completed'),fingerprint=run.status+':'+current?.key+':'+current?.attempt;
  if(fingerprint!==last){last=fingerprint;states.push({status:run.status,node:current?.key,at:new Date().toISOString()});console.log(JSON.stringify(states.at(-1)));}
  if(run.status==='failed'){await shot('failed-'+current.key);throw Error('Node '+current.key+' paused: '+run.reason);}
  if(run.status==='waiting'){
   assert.equal(current.type,'human_review');assert.ok(!gates.includes(current.key));
   await delay(1800);
   const held=await page.run(()=>soduWorkAPI.personalPlugins.debug(testState.ref,{command:'get'}));
   assert.equal(held.run.status,'waiting');assert.equal(held.run.nodes.find(x=>x.status!=='completed').key,current.key);
   await shot('gate-'+current.key);gates.push(current.key);
   if(gates.length===1){await click('×');await page.run(()=>PluginDebugCard.open({ref:testState.ref,host:document.querySelector('.nchat-draft')}));await page.waitFor(()=>document.querySelector('.pdebug-confirm'),null,10000);}
   await click('确认通过并继续');
  }
  if(run.status==='completed'){completed=true;break;}await delay(1500);
 }
 assert.ok(completed,'Workflow timed out');assert.deepEqual(gates,['confirm_scope','accept_release','accept_delivery']);
 const final=await page.run(()=>soduWorkAPI.personalPlugins.debug(testState.ref,{command:'get'}));
 assert.equal(final.run.nodes.length,11);assert.ok(final.run.nodes.every(n=>n.status==='completed'));
 const state=await page.run(()=>({sessionId:testState.sessionId,draft:document.querySelector('#nchatInput').value,tools:testState.snapshot?.tools?.length||0,messages:testState.snapshot?.messages?.length||0}));
 assert.equal(state.sessionId,sessionId);assert.equal(state.draft,'保留普通会话草稿');assert.ok(state.tools>0,'Real tool output must appear in the ordinary conversation');
 checks.push('Real local Agent executes eleven-node workflow','Three UI approvals block before explicit click','Reopening approval does not restart finished work','Ordinary conversation and unsent draft preserved','Tool activity streams into the same conversation');
 await shot('completed');
 fs.writeFileSync(path.join(evidence,'report.json'),JSON.stringify({ok:true,realModel:true,root,checks,gates,states,run:final.run},null,2));
 console.log(JSON.stringify({ok:true,evidence,checks}));
}catch(error){fs.writeFileSync(path.join(evidence,'failure.json'),JSON.stringify({ok:false,realModel:true,root,states,gates,reason:error.message},null,2));console.error(startup.slice(-1600));throw error;}
finally{if(page){try{await page.run(async()=>{const r=await soduWorkAPI.personalPlugins.debug(testState.ref,{command:'get'});if(r.run&&!['completed','cancelled'].includes(r.run.status))await soduWorkAPI.personalPlugins.debug(testState.ref,{command:'cancel',revision:r.run.revision});await pluginTest.shutdown();});}catch{}page.close();}child.kill();}
