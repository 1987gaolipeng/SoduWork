import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {CdpPage,listPages} from './lib/cdp.mjs';
const evidence=process.env.SODUWORK_E2E_EVIDENCE, source=process.env.SODUWORK_E2E_SOURCE;
if(!evidence||!source)throw Error('Dedicated E2E source and evidence required');
fs.mkdirSync(evidence,{recursive:true});
const p=await CdpPage.connect((await listPages(9345)).find(x=>x.url.includes('panel=workspace')));
const report={checks:[],limitations:['The Runner is this computer, not a second physical machine.']};
const shot=async name=>{const s=await p.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(evidence,name+'.png'),Buffer.from(s.data,'base64'));};
async function click(selector){
 const r=await p.run(selector=>{const e=document.querySelector(selector);if(!e)throw Error(selector);e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};},selector);
 await p.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...r});
 await p.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...r});
}
async function send(text){await p.run(text=>{const e=document.querySelector('#nchatInput');e.value=text;e.dispatchEvent(new Event('input',{bubbles:true}));},text);await click('#nchatSend');}
try{
 await p.waitFor(()=>window.NativeChat&&window.SoduWorkAPI?.online,null,30000);
 await p.run(async id=>{const t=await SoduWorkAPI.getTask(id);if(!t.title.startsWith('E2E'))throw Error('Not an E2E task');await openTaskConversation(id,'',{source:'task-list'});},source);
 await p.waitFor(()=>document.querySelector('#nchatInput')&&!NativeChat.isBusy(),null,30000);
 report.conversationId=await p.run(()=>NativeChat.sessionInfo().sessionId);
 const title='E2E live task transcript '+Date.now();
 await send('/创建任务 创建一个简单办公验证任务，先交给我自己，不执行。验证对话内工具运行和上下文。');
 await p.waitFor(()=>document.querySelector('#wesTaskDraft #cpTitle'),null,90000);
 await click('#wesTaskDraft [data-selbtn="who"]');await click('#wesTaskDraft [data-selv="who|me"]');
 const note='这是隔离的对话集成测试。不读写业务文件，不发布，不做额外检查。先说 LIVE-START，我开始验证。然后只调用一次终端工具执行：node -e "setTimeout(()=>console.log(\'LIVE-CODE:\'+require(\'crypto\').randomBytes(4).toString(\'hex\')),15000)"。等待它完成，最后只回答该命令返回的 LIVE-CODE:随机码。不能提前生成随机码。';
 await p.run(({title,note})=>{const h=document.querySelector('#wesTaskDraft');for(const[s,v]of[['#cpTitle',title],['#cpNote',note]]){const e=h.querySelector(s);e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}));}h.querySelectorAll('.cp-ck-t').forEach(e=>{e.value='实际终端随机码和对话结果一致';e.dispatchEvent(new Event('input',{bubbles:true}));});},{title,note});
 await click('#wesTaskDraft #cpCreate');
 const task=await p.waitFor(async title=>{const t=(await SoduWorkAPI.getTasks()).find(t=>t.title===title);return t&&NativeChat.sessionInfo().taskIds.includes(t.id)?{id:t.id}:false;},title,30000);
 report.taskId=task.id;
 report.runner=await p.run(async id=>{const roster=await SoduWorkAPI.listAIAgents();const a=(roster.agents||[]).find(a=>/^runner:.*:pi$/.test(a.id)&&a.online!==false&&!a.busy);if(!a)throw Error('No Pi Runner');const r=await SoduWorkAPI.dispatchToAI(id,{id:a.id,type:'agent'},'',null,'',{strategy:'direct',runner:{mode:'remote'}});if(r?.ok===false)throw Error('Dispatch rejected');return a.id;},task.id);
 const live=await p.waitFor(async id=>{const s=(await soduWorkAPI.conversationSession.snapshot(NativeChat.sessionInfo().ref)).snapshot;const progress=s.messages.find(m=>m.role==='assistant'&&m.taskId===id&&JSON.stringify(m.blocks).includes('LIVE-START'));const tool=s.tools.find(t=>t.state==='running'&&t.id.startsWith('task:'+id+':'));return progress&&tool?{status:s.status,toolState:tool.state,text:progress.blocks.map(b=>b.text).join('')}:false;},task.id,120000);
 assert.equal(live.toolState,'running');
 assert.equal(await p.run(id=>document.querySelectorAll('[data-task-stream="'+id+'"]').length,task.id),0);
 assert.ok(await p.run(()=>document.querySelector('#nchatList')?.textContent.includes('LIVE-START')));
 report.checks.push('Actual assistant explanation and running tool visible BEFORE completion, with no detail-stream duplicate');
 await shot('01-live-progress-and-tool');
 await send('上一个任务终端返回的随机码是什么？不要运行工具，不要重新生成，只回复 LIVE-CODE: 加上刚才真实生成的8位随机码。');
 await shot('02-followup-waits');
 await p.waitFor(async id=>{const t=await SoduWorkAPI.getTask(id);if(t.workRouting?.conversationTurn?.state==='failed')throw Error('Task failed');return t.workRouting?.conversationTurn?.state==='completed';},task.id,180000);
 const result=await p.waitFor(async id=>{const s=(await soduWorkAPI.conversationSession.snapshot(NativeChat.sessionInfo().ref)).snapshot;if(NativeChat.isBusy())return false;const tools=s.tools.filter(t=>t.id.startsWith('task:'+id+':'));const code=tools.map(t=>String(t.result||'')).join('\n').match(/LIVE-CODE:([a-f0-9]{8})/);if(!code)return false;const answers=s.messages.filter(m=>m.role==='assistant').map(m=>({taskId:m.taskId,text:m.blocks.filter(b=>b.kind==='text').map(b=>b.text).join('')}));return{code:code[0],answers:answers.filter(m=>m.taskId===id||m===answers.at(-1)),toolStates:tools.map(t=>t.state)};},task.id,120000);
 assert.ok(result.answers.some(m=>m.taskId===task.id));assert.ok(result.answers.some(m=>!m.taskId));
 assert.equal(result.answers.at(-1).text.trim(),result.code,'The FINAL answer must recall the actual current tool result, not merely mention it in reasoning');
 assert.ok(result.toolStates.every(x=>x==='done'));
 report.checks.push('Tool result, actual task answer and next ordinary answer share the same random code');report.result=result;
 await shot('03-result-and-context-followup');
 await p.call('Page.reload',{ignoreCache:true});
 await p.waitFor(()=>window.NativeChat&&window.SoduWorkAPI?.online,null,30000);
 await p.run(id=>openTaskConversation(id,'',{source:'task-list'}),task.id);
 await p.waitFor(code=>document.querySelector('#nchatList')?.textContent.includes(code),result.code,30000);
 const restored=await p.run(async id=>{const s=(await soduWorkAPI.conversationSession.snapshot(NativeChat.sessionInfo().ref)).snapshot;return{conversationId:NativeChat.sessionInfo().sessionId,tools:s.tools.filter(t=>t.id.startsWith('task:'+id+':')).length,answers:s.messages.filter(m=>m.taskId===id&&m.role==='assistant').length};},task.id);
 assert.equal(restored.conversationId,report.conversationId);assert.ok(restored.tools>0&&restored.answers>0);
 report.checks.push('Refresh and reopen preserve ordinary transcript, tool history and conversation ID');
 await shot('04-restored');report.pass=true;console.log(JSON.stringify(report));
}catch(error){report.error=String(error.stack||error);await shot('failure');console.error(error);process.exitCode=1;}
finally{fs.writeFileSync(path.join(evidence,'results.json'),JSON.stringify(report,null,2));p.close();}
