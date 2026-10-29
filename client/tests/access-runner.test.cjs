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
test('approval IPC rejects a different window and forwards exact request only for owner',async()=>{
 let called=0;const handler=require('../main/access-control/ipc').answerHandler({get:()=>({attachedWindow:{webContents:{id:2}},answerUi:()=>{called++;return{ok:true}}})});
 assert.equal((await handler({sender:{id:3}},'chat',{requestId:'a'})).ok,false);assert.equal(called,0);
 assert.equal((await handler({sender:{id:2}},'chat',{requestId:'a'})).ok,true);assert.equal(called,1);
});
