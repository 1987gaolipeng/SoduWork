'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const rules=require('../main/access-control/policy');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check){for(let n=0;n<500;n++){const value=check();if(value)return value;await delay(10);}throw Error('Timed out');}
async function harness(t,mode,options={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-access-live-'));
 const fixture=await require('../e2e/fixtures/access-sdk.cjs').create(root,mode,()=>{},{persist:true,...options});
 let live={session:fixture.session,access:fixture.access,policy:fixture.access.policy};
 const acc=require('../main/pi-session/event-stream').create(), observed=[];
 const subscribe=session=>session.subscribe(event=>{acc.push(event);if(event.type==='tool_execution_end')observed.push(structuredClone(acc.snapshot().tools.at(-1)));});
 subscribe(live.session);
 const transition=require('../main/access-control/pi-transition').create({cwd:fixture.workspace,current:()=>live,
  commitPolicy:options.liveUpgrade?policy=>{live.policy=policy;}:undefined,
  preload:options.preload,
  prepare:(p,s)=>fixture.rebuild(p,s),commit:next=>{live=next;subscribe(next.session);}});
 const control=require('../main/access-control/pi-live-change').create({current:()=>live,transition});
 t.after(async()=>{control.close();transition.close();live.access?.broker.close();await live.session.abort();live.session.dispose();await fixture.close();fs.rmSync(root,{recursive:true,force:true});});
 return {root,fixture,transition,control,acc,observed,current:()=>live,send:(tool,args)=>control.run(()=>live.session.prompt(JSON.stringify({tool,args}))),
  change:mode=>control.change(rules.next(mode,fixture.workspace,live.policy,live.policy?.revision||0),live.policy?.revision||0)};
}
test('current Pi turn resumes after full-access consent without a second user message or stale approval', {timeout:40000},async t=>{
 let operation;
 const h=await harness(t,'standard',{reply:(body,op)=>op||(/The user changed/.test(JSON.stringify(body.messages.at(-1)))?operation:null)});
 const before=h.current(),sid=before.session.sessionId;
 operation={tool:'write',args:{path:path.join(h.root,'external.txt'),content:'same turn'}};
 const running=h.send(operation.tool,operation.args);
 const old=await until(()=>before.access.broker.pending()[0]);
 assert.equal(fs.existsSync(operation.args.path),false);
 const result=await h.change('full');assert.equal(result.ok,true);assert.equal(result.effective,'current-turn');
 await running;
 assert.equal(fs.readFileSync(operation.args.path,'utf8'),'same turn');
 assert.equal(h.current().session.sessionId,sid);assert.equal(h.transition.pending(),null);
 assert.equal(before.access.broker.answer({...old,decision:'once'}).ok,false);
 assert.equal(h.current().session.state.messages.filter(m=>m.role==='user').length,1);
 assert.equal(h.current().session.state.messages.filter(m=>m.role==='toolResult'&&!m.isError).length,1);
 assert.equal(h.observed.length,2);
 assert.equal(h.observed[0].state,'cancelled');assert.equal(h.observed[0].cancelReason,'access-change');
 assert.equal(h.observed[0].isError,false);assert.equal(h.observed[1].state,'done');
 const history=h.current().session.sessionManager.getEntries();
 const retired=history.find(e=>e.message?.role==='toolResult'&&e.message.details?.soduWorkAccessChange);
 assert.equal(retired.message.isError,true,'SDK/model must not read an unexecuted call as success');
 const replay=require('../main/pi-session/event-stream').create();
 require('../main/pi-session/session')._seed(replay,h.current().session);
 assert.equal(replay.snapshot().tools[0].state,'cancelled');
 assert.equal(replay.snapshot().tools[0].isError,false);
});

test('full access releases the original pending Pi call without reload, abort or replay', {timeout:40000},async t=>{
 const h=await harness(t,'standard',{liveUpgrade:true,preload:()=>{throw Error('must not reload extensions');}});
 const before=h.current(),session=before.session;
 h.fixture.rebuild=()=>{throw Error('must not replace SDK session');};
 const target=path.join(h.root,'hot-write.txt');
 const running=h.send('write',{path:target,content:'once'});
 const pending=await until(()=>before.access.broker.pending()[0]);
 const started=performance.now();
 assert.equal((await h.change('full')).ok,true);
 assert.ok(performance.now()-started<250,'policy change must not wait for SDK reload');
 await running;
 assert.equal(h.current().session,session);assert.equal(h.current().access,before.access);
 assert.equal(h.current().access.policy.mode,'full');assert.equal(h.current().access.snapshot().appliedAccessPolicy.mode,'full');
 assert.equal(before.access.broker.answer({...pending,decision:'once'}).ok,false);
 assert.equal(h.observed.length,1);assert.equal(h.observed[0].state,'done');
 assert.equal(fs.readFileSync(target,'utf8'),'once');
 assert.equal(session.state.messages.filter(m=>m.role==='user').length,1);
 assert.equal(session.state.messages.filter(m=>m.role==='custom').length,0);
 assert.equal(h.transition.pending(),null);
 assert.equal(session.sessionManager.getEntries().filter(e=>e.customType==='soduwork.access.policy').at(-1).data.mode,'full');
});

test('full access takes effect while a previously authorized tool is still running', {timeout:40000},async t=>{
 let started=false,release,runs=0;
 const tool={name:'slow_effect',label:'test',description:'local controlled effect',parameters:{type:'object',properties:{}},
  execute:async()=>{runs++;started=true;await new Promise(r=>release=r);return{content:[{type:'text',text:'done'}],details:{}};}};
 const h=await harness(t,'standard',{liveUpgrade:true,customTools:[tool]});
 const running=h.send('slow_effect',{});
 const request=await until(()=>h.current().access.broker.pending()[0]);
 h.current().access.broker.answer({...request,decision:'once'});await until(()=>started);
 const result=await Promise.race([h.change('full'),delay(250).then(()=>({ok:false,timeout:true}))]);
 try{assert.equal(result.ok,true);assert.equal(h.current().policy.mode,'full');assert.equal(runs,1);}
 finally{release();await running;}
 assert.equal(h.observed.length,1);assert.equal(h.observed[0].state,'done');
});

test('failed hot-policy persistence leaves the pending operation and old access intact', {timeout:40000},async t=>{
 const h=await harness(t,'standard',{liveUpgrade:true});
 const target=path.join(h.root,'not-authorized.txt'),running=h.send('write',{path:target,content:'no'});
 const pending=await until(()=>h.current().access.broker.pending()[0]);
 const manager=h.current().session.sessionManager,append=manager.appendCustomEntry;
 manager.appendCustomEntry=()=>{throw Error('disk unavailable');};
 const result=await h.change('full');manager.appendCustomEntry=append;
 assert.equal(result.ok,false);assert.equal(h.current().policy.mode,'standard');
 assert.equal(h.current().access.policy.mode,'standard');assert.equal(h.current().access.broker.pending()[0].requestId,pending.requestId);
 h.current().access.broker.answer({...pending,decision:'deny'});await running;
 assert.equal(fs.existsSync(target),false);
});

test('hot upgrade preserves an in-flight model request instead of canceling and regenerating', {timeout:40000},async t=>{
 let requested=false,release,requests=0;
 const h=await harness(t,'standard',{liveUpgrade:true,reply:()=>null,beforeResponse:async()=>{
  requests++;requested=true;await new Promise(r=>release=r);
 }});
 const session=h.current().session,running=h.send('read',{path:'unused'});
 await until(()=>requested);
 const result=await Promise.race([h.change('full'),delay(250).then(()=>({ok:false}))]);
 try{assert.equal(result.ok,true);assert.equal(h.current().session,session);assert.equal(requests,1);}
 finally{release();await running;}
 assert.equal(requests,1);assert.equal(session.state.messages.filter(m=>m.role==='assistant').length,1);
 assert.equal(session.state.messages.at(-1).stopReason,'stop');
});

test('hot upgrade rejects stale revisions and later downgrade removes access again', {timeout:40000},async t=>{
 const h=await harness(t,'standard',{liveUpgrade:true});
 const old=h.current().policy,full=rules.next('full',h.fixture.workspace,old,old.revision);
 assert.equal((await h.control.change(full,old.revision-1)).ok,false);assert.equal(h.current().policy.mode,'standard');
 assert.equal((await h.change('full')).ok,true);
 assert.equal((await h.change('standard')).ok,true);
 const target=path.join(h.root,'ask-again.txt'),running=h.send('write',{path:target,content:'no'});
 const pending=await until(()=>h.current().access.broker.pending()[0]);
 assert.equal(pending.policyRevision,h.current().policy.revision);
 h.current().access.broker.answer({...pending,decision:'deny'});await running;
 assert.equal(fs.existsSync(target),false);
});
test('already-started tools settle exactly once before readonly replaces the runtime', {timeout:40000},async t=>{
 let release,started=false,runs=0;
 const tool={name:'slow_effect',label:'test',description:'isolated side effect',parameters:{type:'object',properties:{},additionalProperties:false},
  execute:async()=>{runs++;started=true;await new Promise(r=>release=r);return{content:[{type:'text',text:'completed once'}],details:{}};}};
 const h=await harness(t,'full',{customTools:[tool],reply:(_body,op)=>op});
 const running=h.send('slow_effect',{});await until(()=>started);
 let complete=false;const changing=h.change('readonly').then(r=>{complete=true;return r;});
 await delay(40);assert.equal(complete,false);assert.equal(h.current().policy.mode,'full');
 release();assert.equal((await changing).ok,true);await running;
 assert.equal(runs,1);assert.equal(h.current().policy.mode,'readonly');
 await h.send('write',{path:'denied.txt',content:'must not run'});
 assert.equal(fs.existsSync(path.join(h.fixture.workspace,'denied.txt')),false);
});
test('user stop during permission replacement cancels automatic continuation',async()=>{
 let finish,aborted,continued=0;const manager={appendCustomEntry(){}};
 let live={policy:{mode:'standard'},session:{sessionManager:manager,abort:async()=>{aborted();},sendCustomMessage:async()=>{continued++;}},access:{suspend:async()=>{}}};
 const transition={schedule(){},apply:()=>new Promise(r=>finish=r)};
 const control=require('../main/access-control/pi-live-change').create({current:()=>live,transition});
 const running=control.run(()=>new Promise(r=>aborted=r));
 const change=control.change({mode:'full'},1);await until(()=>finish);control.cancel();finish();
 await change;await running;assert.equal(continued,0);
});

test('failed replacement keeps old permissions and resumes with a fresh approval instead of granting access', {timeout:40000},async t=>{
 let operation;
 const h=await harness(t,'standard',{reply:(body,op)=>op||(/The user changed/.test(JSON.stringify(body.messages.at(-1)))?operation:null)});
 operation={tool:'write',args:{path:path.join(h.root,'denied-after-failure.txt'),content:'must not write'}};
 const running=h.send(operation.tool,operation.args),old=await until(()=>h.current().access.broker.pending()[0]);
 h.fixture.rebuild=async()=>{throw Error('isolated resource failure');};
 const reply=await h.change('full');assert.equal(reply.ok,false);assert.equal(h.current().policy.mode,'standard');assert.equal(h.transition.pending(),null);
 const fresh=await until(()=>h.current().access.broker.pending()[0]);assert.notEqual(fresh.requestId,old.requestId);
 h.current().access.broker.answer({...fresh,decision:'deny'});await running;
 assert.equal(fs.existsSync(operation.args.path),false);
});

test('readonly tool inventory is replaced within the running turn when full access is selected', {timeout:40000},async t=>{
 let release,started=false,operation;
 const read={name:'read',label:'read',description:'isolated controlled read',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']},
  execute:async()=>{started=true;await new Promise(r=>release=r);return{content:[{type:'text',text:'source read'}],details:{}};}};
 const h=await harness(t,'readonly',{restrictReadonly:true,customTools:[read],reply:(body,op)=>op||(/The user changed/.test(JSON.stringify(body.messages.at(-1)))?operation:null)});
 assert.equal(h.current().session.getActiveToolNames().includes('write'),false);
 operation={tool:'write',args:{path:path.join(h.root,'upgraded.txt'),content:'full now'}};
 const running=h.send('read',{path:'source.txt'});await until(()=>started);
 const changing=h.change('full');release();assert.equal((await changing).ok,true);await running;
 assert.equal(h.current().session.getActiveToolNames().includes('write'),true);
 assert.equal(fs.readFileSync(operation.args.path,'utf8'),'full now');
 assert.equal(h.current().session.state.messages.filter(m=>m.role==='user').length,1);
});

test('an executing tool failure during an access change remains a real error', {timeout:40000},async t=>{
 let release,started=false;
 const tool={name:'slow_failure',label:'test',description:'isolated failure',parameters:{type:'object',properties:{}},
  execute:async()=>{started=true;await new Promise(r=>release=r);throw Error('actual tool failure');}};
 const h=await harness(t,'full',{customTools:[tool],reply:(_body,op)=>op});
 const running=h.send('slow_failure',{});await until(()=>started);
 const changing=h.change('standard');release();assert.equal((await changing).ok,true);await running;
 assert.equal(h.observed[0].state,'error');assert.equal(h.observed[0].isError,true);
 assert.match(h.observed[0].result,/actual tool failure/);assert.equal(h.observed[0].cancelReason,undefined);
});
