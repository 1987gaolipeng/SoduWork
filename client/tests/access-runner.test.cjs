const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createRunnerRuntimeAdapter,getRunnerSessionDetails,_uuidV5}=require('../main/agent-runtime/runner-adapter');
const policy=require('../main/access-control/policy');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check){for(let n=0;n<300;n++){if(check())return;await delay(10);}throw Error('Condition timeout');}
test('Runner approval waits without settling; routes exact request and keeps policy on follow-up',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-access-runner-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const accessPolicy=policy.create('standard',root),alias='access-rpc-test',ref=_uuidV5('9af442c8-cd1d-4b91-a668-22da2b2635bf','chat:'+alias+':codex-harness');
 const request={requestId:'real-request-id',policyRevision:1,action:'command.execute',arguments:{command:'echo fixture'}};
 const calls=[];let approved=false;
 const adapter=createRunnerRuntimeAdapter({runnerRuntime:{async rpc(op,payload){calls.push({op,payload});
  if(op==='runtime.detect')return{ok:true,data:{accessControl:{schema:policy.SCHEMA,supported:true,modes:['standard','full','readonly']}}};
  if(op==='job.dispatch')return{ok:true,data:{ref}};
  if(op==='job.session')return{ok:true,data:{status:approved?'done':'waiting-permission',accessPolicy,pendingPermissions:approved?[]:[request],items:[]}};
  if(op==='job.permission'){approved=true;return{ok:true,data:{ok:true}};}
  if(op==='job.comment'||op==='job.stop')return{ok:true,data:{ok:true}};
  throw Error(op);
 }},modelConfig:{fetchModel:async()=>({ok:true,model:{id:'fixture',baseUrl:'http://fixture.invalid',key:'test'}})}});
 const session=await adapter.createSession({identity:{clientId:'test'},native:{runner:{openOptions:{ref:alias,cwd:root,accessPolicy}}}});
 t.after(()=>session.dispose());
 const handle=getRunnerSessionDetails(session).handle;
 const sent=session.send({text:'fixture'});let done=false;sent.completion.then(()=>done=true);
 await until(()=>handle.snapshot().pendingUi?.requestId===request.requestId);
 assert.equal(handle.snapshot().status,'waiting-user');assert.equal(handle.snapshot().running,true);assert.equal(done,false);
 assert.equal((await handle.answerUi({...request,policyRevision:2,decision:'once'})).ok,false);
 assert.equal(calls.filter(c=>c.op==='job.permission').length,0);
 assert.equal((await handle.answerUi({...request,decision:'once'})).ok,true);await sent.completion;
 assert.equal(calls.find(c=>c.op==='job.dispatch').payload.ctx.accessPolicy.mode,'standard');
 const next=session.send({text:'follow-up'});await next.completion;
 assert.equal(calls.find(c=>c.op==='job.comment').payload.cfg.accessPolicy.mode,'standard');
});
test('an old Runner cannot silently execute a new access policy',async()=>{
 const adapter=createRunnerRuntimeAdapter({runnerRuntime:{rpc:async()=>({ok:true,data:{installed:true,state:'ready'}})}});
 await assert.rejects(adapter.createSession({native:{runner:{openOptions:{cwd:os.tmpdir(),accessPolicy:policy.create('standard',os.tmpdir())}}}}),/权限模式/);
});
test('Runner detection failures are reported separately from unsupported access modes',async()=>{
 const adapter=createRunnerRuntimeAdapter({runnerRuntime:{rpc:async()=>({ok:false,error:'不认识的执行底座'})}});
 await assert.rejects(
  adapter.createSession({native:{runner:{openOptions:{cwd:os.tmpdir(),accessPolicy:policy.create('standard',os.tmpdir())}}}}),
  error=>error.code==='RUNNER_PROBE_FAILED' && /探测失败/.test(error.message) && !/权限模式/.test(error.message));
});
test('approval IPC forwards modern and legacy answers only from the currently attached window', async () => {
  const first = { id: 2 }, second = { id: 3 }, accepted = [];
  const handle = { attachedWindow: { webContents: first },
    answerUi(value) { accepted.push(value); return { ok: true }; } };
  const answer = require('../main/access-control/ipc').answerHandler({ get: () => handle });
  for (const value of [{ requestId: 'a', decision: 'deny' }, { cancelled: true }]) {
    assert.equal((await answer({ sender: second }, 'chat', value)).ok, false);
    assert.equal((await answer({ sender: first }, 'chat', value)).ok, true);
  }
  handle.attachedWindow = { webContents: second };
  const legacy = { cancelled: true };
  assert.equal((await answer({ sender: first }, 'chat', legacy)).ok, false);
  assert.equal((await answer({ sender: second }, 'chat', legacy)).ok, true);
  handle.attachedWindow = null;
  assert.equal((await answer({ sender: second }, 'chat', legacy)).ok, false);
  assert.deepEqual(accepted, [{ requestId: 'a', decision: 'deny' }, { cancelled: true }, legacy]);
});

for (const mode of ['standard', 'full', 'readonly']) test(`Runner questions require an explicit matching choice in ${mode} mode`, async t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-question-runner-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const accessPolicy=policy.create(mode,root), alias='question-'+mode;
 const ref=_uuidV5('9af442c8-cd1d-4b91-a668-22da2b2635bf','chat:'+alias+':codex-harness');
 const request={requestId:'question-1',policyRevision:1,action:'native.question',title:'Which one?',
  options:[{optionId:'q0_opt_0',name:'First',kind:'allow_once'},{optionId:'q0_opt_1',name:'Second',kind:'allow_once'},
   {optionId:'q0_skip',name:'Skip',kind:'reject_once'}]};
 const answers=[];let answered=false;
 const adapter=createRunnerRuntimeAdapter({runnerRuntime:{async rpc(op,payload){
  if(op==='runtime.detect')return{ok:true,data:{accessControl:{schema:policy.SCHEMA,supported:true,modes:['standard','full','readonly']}}};
  if(op==='job.dispatch')return{ok:true,data:{ref}};
  if(op==='job.session')return{ok:true,data:{status:answered?'done':'waiting-permission',accessPolicy,pendingPermissions:answered?[]:[request],items:[]}};
  if(op==='job.permission'){answers.push(payload);answered=true;return{ok:true,data:{ok:true}};}
  if(op==='job.stop')return{ok:true,data:{ok:true}};
  throw Error(op);
 }},modelConfig:{fetchModel:async()=>({ok:true,model:{id:'fixture',baseUrl:'http://fixture.invalid',key:'test'}})}});
 const session=await adapter.createSession({identity:{clientId:'test'},native:{runner:{openOptions:{ref:alias,cwd:root,accessPolicy}}}});
 t.after(()=>session.dispose());const handle=getRunnerSessionDetails(session).handle;
 const sent=session.send({text:'fixture'});let complete=false;sent.completion.then(()=>complete=true);
 await until(()=>handle.snapshot().pendingUi?.requestId===request.requestId);
 assert.equal(complete,false);assert.deepEqual(answers,[]);assert.deepEqual(handle.snapshot().pendingUi.options,request.options);
 for(const reply of [{decision:'once'},{decision:'session'},{decision:'answer'},{decision:'answer',optionId:'unknown'},
   {decision:'answer',optionId:'q0_opt_1',policyRevision:2}]) {
  assert.equal((await handle.answerUi({requestId:request.requestId,policyRevision:1,...reply})).ok,false);
 }
 assert.deepEqual(answers,[]);
 const decision=mode==='readonly'?'deny':'answer',optionId=mode==='full'?'q0_skip':'q0_opt_1';
 assert.equal((await handle.answerUi({requestId:request.requestId,policyRevision:1,decision,optionId})).ok,true);
 assert.deepEqual(answers,[{ref,requestId:request.requestId,policyRevision:1,decision,...(decision==='answer'?{optionId}:{})}]);
 assert.equal((await handle.answerUi({requestId:request.requestId,policyRevision:1,decision,optionId})).ok,false);
 await sent.completion;
});
