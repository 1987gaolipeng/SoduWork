'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const gate = require('../main/pi-session/plugin-generation-gate.cjs');
const candidates = require('../main/pi-session/plugin-draft-candidates');
const cache = require('../main/app-resource-cache.cjs');
const body = {template:'method',key:'fixture-plugin',name:'Fixture plugin',version:'1.0.0',
  description:'Synthetic plugin',instructions:'Read the supplied material.'};
function fixture(t) {
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'plugin-static-gate-'));
  t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
  const file=path.join(cwd,candidates.DRAFT_NAME);
  const handle={cwd,sessionId:'synthetic-session',deliveryOwner:{account:'fixture'},inFlight:()=>true,
    outputSnapshot:()=>({since:0,files:fs.existsSync(file)?[{path:file}]:[]})};
  return {cwd,file,handle,write:(value=body)=>fs.writeFileSync(file,JSON.stringify(value))};
}
test.after(()=>cache.close());

test('packaged Skill validation retains the host runtime entry when a profile is supplied', () => {
  const script = String.raw`
    const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),Module=require('node:module');
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'packaged-skill-gate-'));
    const file=path.join(root,'fixture.skill'),profile=path.join(root,'profile');
    const realEntry=path.resolve('client/node_modules/@earendil-works/pi-coding-agent/dist/index.js');
    const exists=fs.existsSync,createRequire=Module.createRequire,load=Module._load;
    process.resourcesPath=path.join(root,'resources');
    const packagedEntry=path.join(process.resourcesPath,'pi/node_modules/@earendil-works/pi-coding-agent/dist/index.js');
    fs.existsSync=value=>String(value).includes('pi-coding-agent'+path.sep+'dist'+path.sep+'index.js')?value===packagedEntry:exists(value);
    Module.createRequire=entry=>createRequire(entry===packagedEntry?realEntry:entry);
    const cache=require('./client/main/app-resource-cache.cjs');
    let receive,reply,repairs=0;
    Module._load=function(id,...args){
      if(id==='node:worker_threads')return{parentPort:{on:(event,fn)=>{if(event==='message')receive=fn;},postMessage:value=>{reply=value;}}};
      return load.call(this,id,...args);
    };
    require('./client/main/app-resource-cache-worker.cjs');
    cache.request=async input=>{reply=null;receive({...input,id:1});if(reply.error)throw Error(reply.error);return reply.result;};
    (async()=>{
      const gate=require('./client/main/pi-session/plugin-generation-gate.cjs');
      const handle={cwd:root,sessionId:'packaged-fixture',deliveryOwner:{account:'fixture'},inFlight:()=>true,
        outputSnapshot:()=>({since:0,files:fs.existsSync(file)?[{path:file}]:[]})};
      const turn=await gate.begin({handle,app:{isPackaged:true,getPath:()=>profile},repair:async()=>{repairs++;return{ok:true};}});
      fs.writeFileSync(file,require('./client/main/conversation/zip-archive').createEntriesSync([
        {name:'SKILL.md',bytes:Buffer.from('---\nname: fixture-skill\ndescription: Synthetic skill\n---\nRead material.\n')}
      ]));
      const result=await turn.finish({ok:true});
      assert.equal(result.ok,true,result.reason);
      assert.equal(repairs,0);
      assert.equal(gate.records(handle)[0].state,'ready');
    })().catch(error=>{console.error(error.message);process.exitCode=1;}).finally(()=>{
      Module._load=load;Module.createRequire=createRequire;fs.existsSync=exists;
      fs.rmSync(root,{recursive:true,force:true});
    });
  `;
  const child = require('node:child_process').spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', windowsHide: true, timeout: 20000,
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
});
test('final malformed bytes are repaired inside one turn and reread before ready',async t=>{
  const f=fixture(t);let calls=0;
  const turn=await gate.begin({handle:f.handle,repair:async prompt=>{
    calls++;assert.match(prompt,/soduwork-plugin-draft.json/);assert.match(prompt,/JSON/);
    f.write();return {ok:true};
  }});
  fs.writeFileSync(f.file,'{\n "instructions": "an "unescaped" quote"}');
  const result=await turn.finish({ok:true});
  assert.equal(result.ok,true);assert.equal(calls,1);
  assert.equal(gate.records(f.handle)[0].state,'ready');
  assert.equal(gate.records(f.handle)[0].revision,candidates.describe(f.cwd,{path:f.file}).pluginRevision);
});
test('unchanged invalid old draft is not repaired by an unrelated turn',async t=>{
  const f=fixture(t);fs.writeFileSync(f.file,'{invalid');let calls=0;
  const turn=await gate.begin({handle:f.handle,repair:async()=>{calls++;}});
  assert.equal((await turn.finish({ok:true})).ok,true);assert.equal(calls,0);
});
test('a generated draft still requires the original validation permissions', async t => {
  const f = fixture(t);
  const preflight = t.mock.fn();
  const repair = t.mock.fn();
  let revision = 1;
  const turn = await gate.begin({handle: f.handle, validationAllowed: () => revision === 1, preflight, repair});
  assert.equal(turn.canStart(), true);
  f.write();
  revision++;

  const result = await turn.finish({ok: true});
  assert.equal(result.cancelled, true);
  assert.equal(preflight.mock.callCount(), 0);
  assert.equal(repair.mock.callCount(), 0);
  assert.deepEqual(gate.records(f.handle), []);
});

test('an empty final scan cannot complete after a stop or change of owner', async t => {
  for (const cause of ['stop', 'owner']) {
    const f = fixture(t);
    let stopped = false;
    const turn = await gate.begin({handle: f.handle, cancelled: () => stopped});
    f.handle.outputSnapshotAsync = async () => {
      if (cause === 'stop') stopped = true;
      else f.handle.deliveryOwner = {account: 'other'};
      return f.handle.outputSnapshot();
    };
    const result = await turn.finish({ok: true});
    assert.equal(result.cancelled, true, cause);
  }
});

test('two failed repairs block completion and retain privacy-safe diagnostics',async t=>{
  const f=fixture(t);let calls=0;
  const turn=await gate.begin({handle:f.handle,repair:async()=>{calls++;return {ok:true};}});
  fs.writeFileSync(f.file,'{ "instructions": "secret-value" invalid }');
  const result=await turn.finish({ok:true});
  assert.equal(calls,2);assert.equal(result.ok,false);assert.equal(result.failureKind,'plugin-validation');
  const record=gate.records(f.handle)[0];assert.equal(record.state,'invalid');
  assert.equal(record.diagnostic.file,candidates.DRAFT_NAME);
  assert.doesNotMatch(JSON.stringify(record),/secret-value|plugin-static-gate-/);
});
test('repair runtime rejection reaches the queue receipt without replacing static draft diagnostics',async t=>{
  const {createTurnQueue}=require('../main/pi-session/turn-queue');
  const f=fixture(t),observed=[];let repairs=0;
  const queue=createTurnQueue();
  const item=queue.add({text:'Generate plugin',options:{afterTurn:(state,result)=>observed.push({state,result})}});
  const reason='模型请求被拒绝（HTTP 403）';
  const snapshot={status:'unreachable',completion:{reason:'error',error:reason,retryable:false}};
  const result=await queue.run(queue.take(),async()=>{
    const turn=await gate.begin({handle:f.handle,repair:async()=>{
      repairs++;return {ok:false,reason,retrySafe:false,snapshot};
    }});
    fs.writeFileSync(f.file,'{invalid');
    return turn.finish({ok:true,modelRecoveryGoal:true});
  });
  assert.equal(result.ok,false);assert.equal(result.failureKind,'plugin-repair');
  assert.equal(result.reason,reason);assert.equal(result.snapshot,snapshot);
  assert.equal(result.modelRecoveryGoal,true);assert.equal(result.retrySafe,false);
  assert.equal(repairs,1);assert.equal(fs.readFileSync(f.file,'utf8'),'{invalid');
  assert.equal(observed[0].state,'failed');assert.equal(observed[0].result.reason,reason);
  assert.equal(queue.state().failure.reason,reason);
  assert.equal(queue.active(),null);assert.equal(await item.completion,result);
  const record=gate.records(f.handle)[0];
  assert.equal(record.state,'invalid');assert.doesNotMatch(record.diagnostic.message,/HTTP 403|repair did not complete/);
});
test('repair exceptions publish only classified safe diagnostics and stop after one attempt',async t=>{
  for(const error of [Error('403 <html>https://fixture.invalid/private?token=synthetic-secret</html>'),
    Error('unclassified synthetic-secret')]) {
    const f=fixture(t);let calls=0;
    const turn=await gate.begin({handle:f.handle,repair:async()=>{calls++;throw error;}});
    fs.writeFileSync(f.file,'{invalid');const result=await turn.finish({ok:true});
    assert.equal(result.failureKind,'plugin-repair');assert.equal(result.ok,false);
    assert.equal(calls,1);assert.equal(result.retrySafe,false);
    assert.doesNotMatch(JSON.stringify(result),/synthetic-secret|fixture.invalid|html/);
    assert.equal(result.reason,error.message.startsWith('403')?'模型请求被拒绝（HTTP 403）':'Plugin repair failed');
  }
});
test('repair retains Runner failure metadata and native cancellation, pause and recovery receipts',async t=>{
  const failures=[
    {ok:false,failureKind:'model-auth',reason:'Expired model ticket',retrySafe:true,requiresModelChange:true},
    {ok:true,cancelled:true,manualStop:true},
    {ok:true,paused:true,reason:'Waiting for approval'},
    {ok:true,recovering:true,reason:'Native recovery pending'},
    {ok:false,paused:true,reason:'Native failure while paused',retrySafe:false},
  ];
  for(const native of failures) {
    const f=fixture(t);let calls=0;
    const snapshot={status:native.ok?'waiting-user':'unreachable'};
    const turn=await gate.begin({handle:f.handle,repair:async()=>{calls++;return {...native,snapshot};}});
    fs.writeFileSync(f.file,'{invalid');const result=await turn.finish({ok:true,modelRecoveryGoal:false});
    assert.deepEqual(result,{ok:true,modelRecoveryGoal:false,...native,snapshot});
    assert.equal(calls,1);assert.equal(gate.records(f.handle)[0].state,'invalid');
  }
});
test('changed ownership still fences a late runtime repair failure',async t=>{
  const f=fixture(t);
  const turn=await gate.begin({handle:f.handle,repair:async()=>{
    f.handle.deliveryOwner={account:'replacement'};
    return {ok:false,reason:'Previous account runtime error',snapshot:{status:'unreachable'}};
  }});
  fs.writeFileSync(f.file,'{invalid');const result=await turn.finish({ok:true});
  assert.equal(result.cancelled,true);assert.equal(result.manualStop,true);
  assert.equal(result.reason,undefined);assert.deepEqual(gate.records(f.handle),[]);
});
test('a stopped repair preserves a confirmed pause only while its permission revision remains current',async t=>{
  for(const changedPolicy of [false,true]) {
    const f=fixture(t);let stopped=false,revision=1;
    const turn=await gate.begin({handle:f.handle,cancelled:()=>stopped,
      pauseConfirmed:()=>revision===1,repair:async()=>{
        stopped=true;if(changedPolicy)revision++;
        return {ok:true,paused:true,snapshot:{status:'aborted'}};
      }});
    fs.writeFileSync(f.file,'{invalid');const result=await turn.finish({ok:true});
    assert.equal(result.ok,true);
    assert.equal(result.paused,changedPolicy ? undefined : true);
    assert.equal(result.cancelled,changedPolicy ? true : undefined);
  }
});
test('cancellation during preflight stops repair and never publishes ready',async t=>{
  const f=fixture(t);let cancelled=false,calls=0;
  const turn=await gate.begin({handle:f.handle,cancelled:()=>cancelled,
    preflight:async()=>{cancelled=true;return {ok:true};},repair:async()=>{calls++;}});
  f.write();const result=await turn.finish({ok:true});
  assert.equal(result.cancelled,true);assert.equal(calls,0);
  assert.notEqual(gate.records(f.handle)[0]?.state,'ready');
});
test('idle artifact inspection rechecks cancelled validation without resuming the cancelled turn',async t=>{
  const f=fixture(t),runtime=require('../main/conversation/artifact-runtime');
  let cancelled=false,repairs=0,release,entered;
  const waiting=new Promise(resolve=>{release=resolve;});
  const checking=new Promise(resolve=>{entered=resolve;});
  const turn=await gate.begin({handle:f.handle,cancelled:()=>cancelled,
    preflight:async()=>{entered();await waiting;return {ok:true};},
    repair:async()=>{repairs++;return {ok:true};}});
  f.write();const finish=turn.finish({ok:true});await checking;
  assert.equal(gate.records(f.handle)[0].state,'checking');
  cancelled=true;release();const result=await finish;
  assert.equal(result.cancelled,true);
  const interrupted=f.handle.outputSnapshot();interrupted.pluginValidation=gate.records(f.handle);
  assert.equal(interrupted.pluginValidation[0].state,'invalid');
  f.handle.inFlight=()=>false;
  // A retained snapshot must not override the later completed static check.
  f.handle.outputSnapshot=()=>interrupted;
  for(let read=0;read<2;read++) {
    const snapshot=await runtime.snapshotAsync(f.handle);
    const file=runtime.decorate('synthetic',{items:snapshot.items}).find(row=>row.pluginDraft);
    assert.equal(file.pluginValidation.state,'ready');
    assert.equal(file.pluginInstallable,true);
  }
  assert.equal(result.cancelled,true,'reading outputs cannot change the cancelled turn result');
  assert.equal(repairs,0,'snapshot reads must not request model repair');
});
test('idle inspection rechecks unfinished remote receipts',async t=>{
  for(const receipt of [{state:'pending'},{state:'checking'},{state:'repairing'},
    {state:'invalid',diagnostic:{message:'Validation interrupted'}}]) {
    const f=fixture(t);f.handle.inFlight=()=>false;f.write();let checks=0;
    const file=candidates.describe(f.cwd,{path:f.file});
    const snapshot={...f.handle.outputSnapshot(),pluginValidation:[{
      relative:file.relative,revision:file.pluginRevision,attempt:0,...receipt}]};
    const rows=await gate.inspect({handle:f.handle,snapshot,
      preflight:async()=>{checks++;return {ok:true};}});
    assert.equal(rows[0].state,'ready',receipt.state);
    assert.equal(checks,1,receipt.state);
  }
});
test('a rejected preflight cannot replace an interrupted receipt',async t=>{
  for(const interruption of ['dispose','cancel','owner']) {
    const f=fixture(t),runtime=require('../main/conversation/artifact-runtime');
    const owner=f.handle.deliveryOwner;
    let cancelled=false,reject,entered,repairs=0;
    const waiting=new Promise((_resolve,fail)=>{reject=fail;});
    const checking=new Promise(resolve=>{entered=resolve;});
    const turn=await gate.begin({handle:f.handle,cancelled:()=>cancelled,
      preflight:async()=>{entered();return waiting;},repair:async()=>{repairs++;return {ok:true};}});
    f.write();const finish=turn.finish({ok:true});await checking;
    if(interruption==='dispose')turn.dispose();
    else if(interruption==='cancel')cancelled=true;
    else f.handle.deliveryOwner={account:'replacement'};
    reject(Error('Preflight failed after interruption'));
    const result=await finish;
    assert.equal(result.cancelled,true,interruption);
    if(interruption==='owner') {
      assert.deepEqual(gate.records(f.handle),[],'changed owners cannot read the old receipt');
      f.handle.deliveryOwner=owner;
    }
    const interrupted=gate.records(f.handle)[0];
    assert.equal(interrupted.diagnostic.message,'Validation interrupted',interruption);
    f.handle.inFlight=()=>false;
    const snapshot=await runtime.snapshotAsync(f.handle);
    const file=runtime.decorate('synthetic',{items:snapshot.items}).find(row=>row.pluginDraft);
    assert.equal(file.pluginValidation.state,'ready',interruption);
    assert.equal(file.pluginInstallable,true,interruption);
    assert.equal(repairs,0,'snapshot reads must not request model repair');
  }
});
test('resource-only changes are checked and byte changes cannot reuse metadata receipts',async t=>{
  const f=fixture(t),relative='references/brief.txt',resource=path.join(f.cwd,relative);
  fs.mkdirSync(path.dirname(resource));fs.writeFileSync(resource,'first');
  f.write({...body,resources:[{path:relative,kind:'reference'}]});
  const before=candidates.describe(f.cwd,{path:f.file});const original=fs.statSync(resource);let checked=0;
  const turn=await gate.begin({handle:f.handle,preflight:async draft=>{
    checked++;assert.equal(Buffer.from(draft.resources[0].content,'base64').toString(),'later');return {ok:true};
  }});
  fs.writeFileSync(resource,'later');fs.utimesSync(resource,original.atime,original.mtime);
  const after=candidates.describe(f.cwd,{path:f.file});
  assert.notEqual(before.pluginRevision,after.pluginRevision);
  assert.equal((await turn.finish({ok:true})).ok,true);assert.equal(checked,1);
});
test('ownership change while validating prevents repair and readiness',async t=>{
  const f=fixture(t);let calls=0;
  const turn=await gate.begin({handle:f.handle,preflight:async()=>{f.handle.deliveryOwner={account:'other'};return {ok:true};},
    repair:async()=>{calls++;}});
  f.write();const result=await turn.finish({ok:true});
  assert.equal(result.cancelled,true);assert.equal(calls,0);assert.notEqual(gate.records(f.handle)[0]?.state,'ready');
});
test('actual installer worker rejects invalid node handoff before any install action',async t=>{
  const f=fixture(t);const turn=await gate.begin({handle:f.handle});
  f.write({...body,template:'workflow',workflow:{nodes:[{key:'discover',name:'Discover',type:'ai',dependsOn:[],
    inputs:[{key:'design_brief',type:'text'}],outputs:[],config:{prompt:'Read public design_brief'}}]}});
  const result=await turn.finish({ok:true});
  assert.equal(result.ok,false);assert.equal(result.failureKind,'plugin-validation');
  assert.equal(gate.records(f.handle)[0].state,'invalid');
});

test('queue awaits validation before completion receipts and releases no dependent turn',async t=>{
  const {createTurnQueue}=require('../main/pi-session/turn-queue');
  const f=fixture(t),events=[];let release, enter;const checking=new Promise(resolve=>{enter=resolve;});const pending=new Promise(resolve=>{release=resolve;});
  const queue=createTurnQueue(undefined,()=>events.push('capture'));
  const item=queue.add({text:'Generate plugin',options:{afterTurn:status=>events.push(status)}});
  const run=queue.run(queue.take(),async()=>{
    const turn=await gate.begin({handle:f.handle,preflight:async()=>{events.push('checking');enter();await pending;return {ok:true};}});
    f.write();events.push('native');return turn.finish({ok:true});
  });
  await checking;
  assert.deepEqual(events,['native','checking']);assert.equal(queue.active(),item);
  release();assert.equal((await run).ok,true);assert.equal(queue.state().paused,false);
  assert.deepEqual(events,['native','checking','completed','capture']);
});
test('public artifact validation follows current bytes and never starts repair on reads',async t=>{
  const f=fixture(t),runtime=require('../main/conversation/artifact-runtime');
  const turn=await gate.begin({handle:f.handle});f.write();await turn.finish({ok:true});
  const scanned=f.handle.outputSnapshot();scanned.pluginValidation=gate.records(f.handle);
  let snapshot=runtime.snapshot(f.handle,scanned);
  let row=runtime.decorate('synthetic',{items:snapshot.items}).find(row=>row.pluginDraft);
  assert.equal(row.pluginValidation.state,'ready');assert.equal(row.pluginInstallable,true);
  f.write({...body,instructions:'Changed after validation'});
  snapshot=runtime.snapshot(f.handle,scanned);
  row=runtime.decorate('synthetic',{items:snapshot.items}).find(row=>row.pluginDraft);
  assert.equal(row.pluginValidation.state,'pending');assert.equal(row.pluginInstallable,false);
});
test('Pi gate stays inside live grants and uses a hidden internal native prompt',()=>{
  const send=fs.readFileSync(path.join(__dirname,'../main/pi-session/session-send.js'),'utf8');
  const open=fs.readFileSync(path.join(__dirname,'../main/pi-session/session-open.js'),'utf8');
  assert.match(send,/plugin-generation-gate\.cjs/);assert.match(send,/pluginGate\.finish/);
  assert.ok(send.indexOf('pluginGate.finish')<send.lastIndexOf('restoreTools()'));
  assert.match(open,/customType: 'soduwork\.plugin\.repair', display: false/);
  assert.match(send,/finally \{\s+pluginGate\?\.dispose\(\)/);
});

test('account changes on a native handle without deliveryOwner stop validation',async t=>{
  const f=fixture(t);delete f.handle.deliveryOwner;
  const identity={hub:'https://fixture.invalid',clientId:'synthetic-device'};
  const session=uid=>Buffer.from(JSON.stringify({typ:'device',cid:identity.clientId,uid})).toString('base64url')+'.signature';
  identity.session=session('original');let calls=0;
  const turn=await gate.begin({handle:f.handle,identity,preflight:async()=>{identity.session=session('replacement');return {ok:true};},
    repair:async()=>{calls++;}});
  f.write();const result=await turn.finish({ok:true});assert.equal(result.cancelled,true);assert.equal(calls,0);
});
test('embedded resource bytes do not inherit unrelated adjacent file changes',async t=>{
  const f=fixture(t),relative='references/brief.txt',resource=path.join(f.cwd,relative);
  fs.mkdirSync(path.dirname(resource));fs.writeFileSync(resource,'outside');
  f.write({...body,resources:[{path:relative,kind:'reference',encoding:'utf8',content:'embedded'}]});
  const before=candidates.describe(f.cwd,{path:f.file});let checked=0;
  const turn=await gate.begin({handle:f.handle,preflight:async()=>{checked++;return {ok:true};}});
  fs.writeFileSync(resource,'unrelated new text');
  assert.equal(candidates.describe(f.cwd,{path:f.file}).pluginRevision,before.pluginRevision);
  assert.equal((await turn.finish({ok:true})).ok,true);assert.equal(checked,0);
});
test('second repair may succeed but no third repair is launched',async t=>{
  const f=fixture(t);let calls=0;
  const turn=await gate.begin({handle:f.handle,repair:async()=>{if(++calls===2)f.write();return {ok:true};}});
  fs.writeFileSync(f.file,'{invalid');assert.equal((await turn.finish({ok:true})).ok,true);assert.equal(calls,2);
});
test('cancellation inside a repair stops the same logical turn',async t=>{
  const f=fixture(t);let cancelled=false,calls=0;
  const turn=await gate.begin({handle:f.handle,cancelled:()=>cancelled,repair:async()=>{calls++;cancelled=true;return {ok:true};}});
  fs.writeFileSync(f.file,'{invalid');assert.equal((await turn.finish({ok:true})).cancelled,true);
  assert.equal(calls,1);assert.equal(gate.records(f.handle)[0].state,'invalid');
});

test('a failed static preflight check cannot publish an installable receipt',async t=>{
  const f=fixture(t);const turn=await gate.begin({handle:f.handle,
    preflight:async()=>({ok:true,checks:[{key:'schema',ok:false,label:'workflow.nodes.discover.inputs[0].fromNode is missing'}]})});
  f.write();const result=await turn.finish({ok:true});
  assert.equal(result.ok,false);assert.equal(gate.records(f.handle)[0].state,'invalid');
  assert.match(gate.records(f.handle)[0].diagnostic.message,/discover.*fromNode/);
});
test('skill archives keep skill-library validation and never use plugin preflight',async t=>{
  const f=fixture(t),file=path.join(f.cwd,'fixture-skill.skill');let calls=0;
  f.handle.outputSnapshot=()=>({since:0,files:fs.existsSync(file)?[{path:file}]:[]});
  const turn=await gate.begin({handle:f.handle,preflight:async()=>{calls++;return {ok:true};}});
  const bytes=require('../main/conversation/zip-archive').createEntriesSync([{name:'SKILL.md',
    bytes:Buffer.from('---\nname: fixture-skill\ndescription: Synthetic validation fixture\n---\nRead supplied material.\n')}]);
  fs.writeFileSync(file,bytes);const result=await turn.finish({ok:true});
  assert.equal(result.ok,true,result.reason);assert.equal(calls,0);
  assert.equal(gate.records(f.handle)[0].state,'ready');
  assert.equal(require('../main/pi-session/plugin-draft').readCandidate({handle:f.handle,
    file:candidates.describe(f.cwd,{path:file}),at:0},undefined,{staticValidation:true}).kind,'skill');
});

test('failed original native generation never starts a repair even with ok transport',async t=>{
  const f=fixture(t);let calls=0;
  const turn=await gate.begin({handle:f.handle,repair:async()=>{calls++;return {ok:true};}});
  fs.writeFileSync(f.file,'{invalid');const original={ok:true,snapshot:{status:'error'}};
  assert.equal(await turn.finish(original),original);assert.equal(calls,0);
});

test('read-only inspection restores valid historical readiness and malformed diagnostics without repair',async t=>{
  const f=fixture(t);f.handle.inFlight=()=>false;f.write();
  let calls=0;const preflight=async()=>{calls++;return {ok:true};};
  let rows=await gate.inspect({handle:f.handle,snapshot:f.handle.outputSnapshot(),preflight});
  assert.equal(rows[0].state,'ready');assert.equal(calls,1);
  rows=await gate.inspect({handle:f.handle,snapshot:f.handle.outputSnapshot(),preflight});
  assert.equal(calls,1,'unchanged receipts are cached by source and resource bytes');
  fs.writeFileSync(f.file,'{invalid');
  rows=await gate.inspect({handle:f.handle,snapshot:f.handle.outputSnapshot(),preflight});
  assert.equal(rows[0].state,'invalid');assert.equal(rows[0].diagnostic.field,'JSON');assert.equal(calls,1);
});
test('read-only inspection cannot override an active logical gate even when native inFlight is false',async t=>{
  const f=fixture(t);f.handle.inFlight=()=>false;let resolve,enter,calls=0;const checking=new Promise(done=>{enter=done;});
  const pending=new Promise(done=>{resolve=done;});
  const turn=await gate.begin({handle:f.handle,preflight:async()=>{enter();await pending;throw Error('Invalid handoff');}});
  f.write();const finish=turn.finish({ok:true});await checking;
  const rows=await gate.inspect({handle:f.handle,snapshot:f.handle.outputSnapshot(),preflight:async()=>{calls++;return {ok:true};}});
  assert.equal(rows[0].state,'checking');assert.equal(calls,0);
  resolve();assert.equal((await finish).ok,false);
  const after=await gate.inspect({handle:f.handle,snapshot:f.handle.outputSnapshot(),preflight:async()=>{calls++;return {ok:true};}});
  assert.equal(after[0].state,'invalid');assert.equal(calls,0);
});

function includeDraft(f, file) {
  f.handle.outputSnapshot=()=>({since:0,files:[f.file,file].filter(file=>fs.existsSync(file)).map(path=>({path}))});
}
test('repair cannot hide a newly introduced invalid draft behind the repaired original',async t=>{
  const f=fixture(t),second=path.join(f.cwd,'new','soduwork-plugin-draft.json');includeDraft(f,second);let calls=0;
  const turn=await gate.begin({handle:f.handle,repair:async()=>{
    calls++;f.write();fs.mkdirSync(path.dirname(second),{recursive:true});fs.writeFileSync(second,'{invalid new final draft');return {ok:true};
  }});
  fs.writeFileSync(f.file,'{invalid original');const result=await turn.finish({ok:true});
  assert.equal(result.ok,false);assert.equal(calls,2);
  assert.equal(gate.records(f.handle).find(row=>row.relative==='new/soduwork-plugin-draft.json').state,'invalid');
});
test('final success recollects a draft created while another candidate is validated',async t=>{
  const f=fixture(t),second=path.join(f.cwd,'new','soduwork-plugin-draft.json');includeDraft(f,second);
  const turn=await gate.begin({handle:f.handle,preflight:async()=>{
    fs.mkdirSync(path.dirname(second),{recursive:true});fs.writeFileSync(second,'{invalid late candidate');return {ok:true};
  }});
  f.write();const result=await turn.finish({ok:true});assert.equal(result.ok,false);
  assert.equal(gate.records(f.handle).find(row=>row.relative==='new/soduwork-plugin-draft.json').state,'invalid');
});
test('repair can move the final draft and validates the current replacement',async t=>{
  const f=fixture(t),second=path.join(f.cwd,'new','soduwork-plugin-draft.json');includeDraft(f,second);let checked=0;
  const turn=await gate.begin({handle:f.handle,preflight:async()=>{checked++;return {ok:true};},repair:async()=>{
    fs.mkdirSync(path.dirname(second),{recursive:true});fs.renameSync(f.file,second);fs.writeFileSync(second,JSON.stringify(body));return {ok:true};
  }});
  fs.writeFileSync(f.file,'{invalid original');const result=await turn.finish({ok:true});
  assert.equal(result.ok,true,result.reason);assert.equal(checked,1);
  assert.equal(gate.records(f.handle).find(row=>row.relative==='new/soduwork-plugin-draft.json').state,'ready');
});
test('dispose after a rejected native generation releases historical inspection',async t=>{
  const f=fixture(t);f.handle.inFlight=()=>false;const turn=await gate.begin({handle:f.handle});f.write();
  await assert.rejects(async()=>{try{throw Error('Native generation failed');}finally{turn.dispose();}},/Native generation failed/);
  turn.dispose();
  const rows=await gate.inspect({handle:f.handle,snapshot:f.handle.outputSnapshot()});assert.equal(rows[0].state,'ready');
});
test('dispose during validation ends pending receipts and cannot later publish readiness',async t=>{
  const f=fixture(t);f.handle.inFlight=()=>false;let release, enter;const checking=new Promise(done=>{enter=done;});
  const waiting=new Promise(resolve=>{release=resolve;});
  const turn=await gate.begin({handle:f.handle,preflight:async()=>{enter();await waiting;return {ok:true};}});
  f.write();const finish=turn.finish({ok:true});await checking;
  assert.equal(gate.records(f.handle)[0].state,'checking');turn.dispose();
  assert.equal(gate.records(f.handle)[0].state,'invalid');release();
  assert.equal((await finish).cancelled,true);assert.equal(gate.records(f.handle)[0].state,'invalid');
});

test('native recovery retains the original logical baseline after failed send cleanup',async t=>{
  const f=fixture(t),logicalOwner={};let calls=0;
  const initial=await gate.begin({handle:f.handle,logicalOwner});fs.writeFileSync(f.file,'{invalid interrupted output');
  initial.dispose();
  const recovery=await gate.begin({handle:f.handle,logicalOwner,repair:async()=>{calls++;f.write();return {ok:true};}});
  const result=await recovery.finish({ok:true});assert.equal(result.ok,true,result.reason);assert.equal(calls,1);
});
test('native recovery shares the two-repair budget of its original logical turn',async t=>{
  const f=fixture(t),logicalOwner={};let calls=0;
  const repair=async()=>{calls++;return {ok:true};};
  const initial=await gate.begin({handle:f.handle,logicalOwner,repair});fs.writeFileSync(f.file,'{invalid');
  assert.equal((await initial.finish({ok:true})).ok,false);assert.equal(calls,2);
  const recovery=await gate.begin({handle:f.handle,logicalOwner,repair});
  assert.equal((await recovery.finish({ok:true})).ok,false);assert.equal(calls,2);
});

test('a truncated output inventory checks nested packages and avoids synchronous baseline scans', async t => {
  const f = fixture(t);
  const outputs = require('../main/pi-session/outputs');
  f.handle.outputSnapshot = () => assert.fail('The synchronous inventory must not run');
  f.handle.outputSnapshotAsync = () => outputs.scanAsync(f.cwd, 0, 0);
  const turn = await gate.begin({ handle: f.handle });
  for (let i = 0; i < 70; i++) fs.writeFileSync(path.join(f.cwd, i + '.txt'), 'report');
  const folder = path.join(f.cwd, 'packages');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, candidates.DRAFT_NAME), '{\n"items":[\n');
  assert.equal((await turn.finish({ ok: true })).ok, false);
  const [record] = gate.records(f.handle);
  assert.equal(record.relative, 'packages/' + candidates.DRAFT_NAME);
  assert.equal(record.diagnostic.line, 3);
  assert.equal(record.diagnostic.column, 1);
});

test('deleting a rejected draft cannot transfer its obligation to an unchanged sibling', async t => {
  const f = fixture(t);
  const folder = path.join(f.cwd, 'second');
  fs.mkdirSync(folder);
  const second = path.join(folder, candidates.DRAFT_NAME);
  includeDraft(f, second);
  const turn = await gate.begin({ handle: f.handle, repair: async () => {
    fs.unlinkSync(second);
    return { ok: true };
  } });
  f.write();
  fs.writeFileSync(second, '{broken');
  const result = await turn.finish({ ok: true });
  assert.equal(result.ok, false);
  assert.match(result.reason, /second\/soduwork-plugin-draft.json: Generated plugin draft is missing/);
});

test('temporary worker failures allow another read and do not trigger model repairs', async t => {
  const f = fixture(t);
  f.handle.inFlight = () => false;
  let repairs = 0;
  const turn = await gate.begin({ handle: f.handle, repair: async () => { repairs++; } });
  const request = cache.request;
  const failure = t.mock.method(cache, 'request', input => input.action === 'draft-check'
    ? Promise.reject(Error('Worker busy')) : request(input));
  f.write();
  assert.equal((await turn.finish({ ok: true })).ok, false);
  assert.equal(repairs, 0);
  assert.equal(gate.records(f.handle)[0].state, 'pending');
  assert.equal((await gate.inspect({handle:f.handle,snapshot:f.handle.outputSnapshot()}))[0].state, 'pending');
  failure.mock.restore();
  assert.equal((await gate.inspect({handle:f.handle,snapshot:f.handle.outputSnapshot()}))[0].state, 'ready');
});

test('a newly created unrelated package cannot replace a deleted malformed draft', async t => {
  const f = fixture(t);
  const second = path.join(f.cwd, 'new', candidates.DRAFT_NAME);
  fs.mkdirSync(path.dirname(second));
  includeDraft(f, second);
  const turn = await gate.begin({ handle:f.handle, repair:async () => {
    fs.writeFileSync(second, JSON.stringify(body));
    fs.unlinkSync(f.file);
    return {ok:true};
  } });
  fs.writeFileSync(f.file, '{invalid');
  assert.match((await turn.finish({ok:true})).reason, /Generated plugin draft is missing/);
});

test('worker preflight cannot grant readiness to bytes that were swapped out and restored', async t => {
  for (const changeManifest of [true, false]) {
    const f = fixture(t);
    const relative = 'templates/report.txt';
    const resource = path.join(f.cwd, relative);
    fs.mkdirSync(path.dirname(resource));
    fs.writeFileSync(resource, 'original content');
    f.write({ ...body, resources:[{path:relative,kind:'template'}] });
    f.handle.inFlight = () => false;
    const original = fs.readFileSync(f.file);
    const request = cache.request;
    const swap = t.mock.method(cache, 'request', async packet => {
      if (packet.action !== 'draft-check') return request(packet);
      if (changeManifest) f.write({...body,name:'Temporary version'});
      else fs.writeFileSync(resource, 'temporary content');
      try { return await request(packet); }
      finally { fs.writeFileSync(f.file, original); fs.writeFileSync(resource, 'original content'); }
    });
    const [stale] = await gate.inspect({handle:f.handle,snapshot:f.handle.outputSnapshot()});
    assert.equal(stale.state, 'pending');
    swap.mock.restore();
    const [fresh] = await gate.inspect({handle:f.handle,snapshot:f.handle.outputSnapshot()});
    assert.equal(fresh.state, 'ready');
  }
});

test('discovery isolates an unreadable old draft and respects the aggregate resource byte limit', t => {
  const f = fixture(t);
  const assets = path.join(f.cwd, 'assets');
  fs.mkdirSync(assets);
  const resourcePaths = ['one', 'two', 'three'].map(name => 'assets/' + name);
  for (const relative of resourcePaths) fs.writeFileSync(path.join(f.cwd, relative), Buffer.alloc(4 * 1024 * 1024));
  f.write({ ...body, resources: resourcePaths.map(path => ({ path, kind: 'asset' })) });
  let bytes = 0, locked = false;
  const resources = require('../main/plugin-resources');
  const read = resources.readSized;
  t.mock.method(resources, 'readSized', (file, ...args) => {
    if (locked && file === f.file) throw Object.assign(Error('File locked'), {code:'EBUSY'});
    const data = read(file, ...args);
    if (typeof file === 'string' && file.startsWith(assets + path.sep)) bytes += data.length;
    return data;
  });
  assert.ok(candidates.describe(f.cwd, {path:f.file}).pluginRevision);
  assert.equal(bytes, require('../main/plugin-resources').MAX_BYTES);
  locked = true;
  assert.equal(candidates.collect(f.cwd, f.handle.outputSnapshot())[0].unavailable, true);
});
