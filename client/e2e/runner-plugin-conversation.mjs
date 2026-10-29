// Headless Electron integration: production picker/rendering + real preload/IPC
// + real isolated Runner/CLI + existing model service. Not a mocked model reply.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {CdpPage,waitForPage,delay} from './lib/cdp.mjs';
const client=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const evidence=path.resolve(process.argv[2]||path.join(os.tmpdir(),'soduwork-runner-plugin-evidence'));
const profile=process.env.SODUWORK_E2E_PROFILE;
if(!profile)throw Error('Set SODUWORK_E2E_PROFILE to an existing enrolled client profile (read-only).');
fs.mkdirSync(evidence,{recursive:true});
const root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-runner-plugin-live-'));
const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));
const port=probe.address().port;await new Promise(r=>probe.close(r));
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(path.join(client,'node_modules/electron/dist/electron.exe'),
 [path.join(client,'e2e/fixtures/plugin-runner-window.cjs'),root,profile,'--remote-debugging-port='+port],
 {windowsHide:true,env,stdio:['ignore','pipe','pipe']});
let startup='';child.stdout.on('data',x=>startup+=x);child.stderr.on('data',x=>startup+=x);
let page;const checks=[];
async function click(selector){
 const pos=await page.run(s=>{const e=document.querySelector(s);if(!e||e.disabled)throw Error('Unavailable '+s);
 e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}},selector);
 for(const type of ['mousePressed','mouseReleased'])await page.call('Input.dispatchMouseEvent',{type,...pos,button:'left',clickCount:1});
}
async function input(text){
 await page.run(text=>{const e=document.querySelector('#nchatInput');e.value=text;e.selectionStart=e.selectionEnd=text.length;e.dispatchEvent(new Event('input',{bubbles:true}));},text);
}
async function shot(name){
 const result=await page.call('Page.captureScreenshot',{format:'png'});
 fs.writeFileSync(path.join(evidence,name+'.png'),Buffer.from(result.data,'base64'));
}
async function pick(denied=false){
 await input(denied?'/授权':'/资源');
 await page.waitFor(()=>document.querySelector('.nplugin-option:not(:disabled)'),null,15000);
 await click('.nplugin-option:not(:disabled)');
 await page.waitFor(()=>document.querySelector('.nplugin-strip:not([hidden])'),null,10000);
}
async function send(text,allowFailure=false){
 const count=await page.run(()=>testState.sends.length);
 await input(text);await click('#nchatSend');
 await page.waitFor(n=>testState.sends.length>n||testState.error,count,20000);
 const result=await page.run(()=>({error:testState.error,last:testState.sends.at(-1)}));
 if(!allowFailure)assert.ok(!result.error,result.error);assert.equal(result.last.ok,true);
 return result.last;
}
async function waitReply(expected,timeout=180000){
 return page.waitFor(expected=>{
   if(testState.error)throw Error(testState.error);
   const s=testState.snapshot;
   return s&&!s.running&&s.messages.some(m=>m.role==='assistant'&&m.blocks?.some(b=>b.text?.includes(expected)))?s:false;
 },expected,timeout);
}
try{
 for(let i=0;i<60;i++){
   if(child.exitCode!==null)throw Error('Electron exited '+child.exitCode+'; '+startup.slice(-2000));
   try{page=await CdpPage.connect(await waitForPage(port,x=>x.url.endsWith('plugin-runner.html'),1000));break;}catch{await delay(200);}
 }
 assert.ok(page,'Isolated Electron did not open');
 await page.waitFor(()=>window.testState&&window.pluginTest,null,15000);
 const audit=await page.run(()=>pluginTest.audit());
 for(const adapter of ['opencode','codex-harness','pi']){
   await page.run(id=>document.querySelector('#agent').value=id,adapter);await click('#open');
   await page.waitFor(()=>testState.ref||testState.error,null,60000);
   assert.equal(await page.run(()=>testState.error),'');
   const id=await page.run(()=>testState.sessionId);
   if(adapter==='pi'){
     await send('只回复 PI-ORDINARY-PASS，不使用工具。');
     const snap=await waitReply('PI-ORDINARY-PASS');
     assert.equal(snap.messages.filter(m=>m.role==='user'&&m.plugins?.length).length,0);
     await shot('pi-ordinary-regression');checks.push('Pi ordinary chat real model regression');
     await page.run(()=>{soduWorkAPI.conversationSession.close(testState.ref);testState.ref='';});
     continue;
   }
   await pick();await shot(adapter+'-01-selected');
   await send('请执行所选插件，用工具读取本轮随包材料 first 属性，只回复这个属性的值。');
   await page.waitFor(()=>testState.snapshot?.messages.some(m=>m.role==='user'&&m.plugins?.length),null,20000);
   await shot(adapter+'-02-running');
   if(adapter==='opencode'){
     await pick();const queued=await send('请执行所选插件，用工具读取本轮随包材料 second 属性，只回复这个属性的值。');
     assert.equal(queued.queued,true,'Follow-up must actually wait behind a live turn');
     await shot('opencode-03-queued');
     await waitReply(audit.values.first);await waitReply(audit.values.second);
     checks.push('OpenCode selected plugin executed from queue automatically');
     await pick();await send('请再次执行所选插件，重新读取随包材料 followup 属性，只回复这个属性的值。');
     const snap=await waitReply(audit.values.followup);
     assert.ok(snap.tools.length>0,'Real CLI must emit tool activity');
     assert.equal(snap.messages.filter(m=>m.role==='user'&&m.plugins?.length).length,3);
     await shot('opencode-04-followup');
     await send('只回复 ORDINARY-CHAT-PASS，不使用插件，不使用工具。');
     await waitReply('ORDINARY-CHAT-PASS');
     const before=await page.run(()=>testState.snapshot.messages.filter(m=>m.role==='user').map(m=>({text:m.text,plugins:m.plugins})));
     await click('#reopen');
     await page.waitFor(()=>testState.ref&&!testState.snapshot?.running,null,30000);
     assert.equal(await page.run(()=>testState.sessionId),id);
     const after=await page.run(()=>testState.snapshot.messages.filter(m=>m.role==='user').map(m=>({text:m.text,plugins:m.plugins})));
     assert.deepEqual(after,before);
     await shot('opencode-05-restored');
     checks.push('OpenCode first/follow-up native tools, ordinary no-plugin chat, same-session reopen and badges');
     await pick(true);
     const prior=await page.run(()=>pluginTest.audit());
     await send('执行这个插件。',true);
     await page.waitFor(()=>testState.error,null,15000);
     const failure=await page.run(()=>({error:testState.error,snapshot:testState.snapshot,events:testState.events}));
     assert.match(failure.error,/操作电脑/);
     assert.ok(failure.events.some(e=>e.failureKind==='plugin-grant'));
     const next=await page.run(()=>pluginTest.audit());
     assert.equal(next.calls.filter(c=>/^job\.(dispatch|comment)$/.test(c.op)).length,
       prior.calls.filter(c=>/^job\.(dispatch|comment)$/.test(c.op)).length);
     await shot('opencode-06-denied');
     checks.push('Unauthorized plugin visibly fails before CLI dispatch');
   }else{
     const snap=await waitReply(audit.values.first);
     assert.ok(snap.tools.length>0);await shot(adapter+'-03-completed');
     checks.push('Codex Harness selected plugin reached real CLI and read packaged resource');
   }
   await page.run(()=>{soduWorkAPI.conversationSession.close(testState.ref);testState.ref='';});
 }
 const finalAudit=await page.run(()=>pluginTest.audit());
 assert.equal(finalAudit.grants,0);
 assert.ok(finalAudit.calls.some(c=>c.op==='job.dispatch'&&c.hasPluginContext));
 assert.ok(finalAudit.calls.some(c=>c.op==='job.comment'&&c.hasPluginContext));
 assert.ok(finalAudit.calls.some(c=>c.op==='job.comment'&&!c.hasPluginContext));
 const errors=page.takeRuntimeErrors();assert.deepEqual(errors,[]);
 const report={ok:true,scope:'Real headless Electron production components/preload/IPC, isolated local Runner, installed OpenCode/Codex Harness CLIs, existing model service',
   notCovered:['Manual Windows interaction (desktop automation unavailable)','Other four CLIs real execution; covered by adapter unit matrix','Enterprise MCP/workflow approvals'],checks,
   version:finalAudit.versions,root,calls:finalAudit.calls,errors};
 fs.writeFileSync(path.join(evidence,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){
 if(page){await shot('failure').catch(()=>{});const state=await page.run(()=>({state:testState,errors:document.querySelector('#status')?.textContent})).catch(()=>null);
 fs.writeFileSync(path.join(evidence,'failure-state.json'),JSON.stringify(state,null,2));}
 fs.writeFileSync(path.join(evidence,'report.json'),JSON.stringify({ok:false,error:String(error.stack||error),checks,root},null,2));
 console.error(error);process.exitCode=1;
}finally{
 if(page)await page.run(()=>pluginTest.shutdown()).catch(()=>{});
 page?.close();child.kill();
 await delay(700);
 // Remove the copied encrypted OSCrypt key from this test's own profile.
 try{fs.unlinkSync(path.join(root,'profile','Local State'));}catch{}
 // Keep the isolated Runner work directory for evidence; never delete a user profile.
 console.log('Evidence: '+evidence+'\nIsolated work: '+root);
}
