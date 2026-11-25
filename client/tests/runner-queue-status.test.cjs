'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createRunnerRuntimeAdapter, getRunnerSessionDetails, _uuidV5 } = require('../main/agent-runtime/runner-adapter');
const catalog = require('../main/agent-runtime/runtime-catalog');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i=0; i<500; i++) { if (check()) return; await delay(5); }
  throw Error('Runner queue state did not arrive');
}

test('native start owns execution time while independent conversations and same-chat order remain isolated', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-runner-queue-'));
  const sessions = [], states = new Map(), calls = [];
  const originalNow = Date.now;
  let now = originalNow();
  const submittedAt = now;
  Date.now = () => now;
  t.after(async () => {
    Date.now = originalNow;
    try { await Promise.all(sessions.map(session => session.dispose())); }
    finally { fs.rmSync(directory, {recursive:true,force:true}); }
  });
  const runtime = { async rpc(op, input) {
    calls.push({op,input});
    if (op === 'runtime.detect') return {ok:true,data:{}};
    if (op === 'job.dispatch') {
      const ref = _uuidV5('9af442c8-cd1d-4b91-a668-22da2b2635bf', input.dispatchId);
      const queued = input.cli === 'opencode';
      states.set(ref, {status:queued?'queued':'done',executionStartedAt:queued?0:now/1000,queuePosition:queued?2:0,items:[]});
      return {ok:true,data:{ref,state:queued?'queued':'running',queued}};
    }
    if (op === 'job.session') return {ok:true,data:{ok:true,ref:input.ref,...states.get(input.ref)}};
    if (op === 'job.comment') {
      states.set(input.ref, {status:'done',executionStartedAt:now/1000,items:[]});
      return {ok:true,data:{ok:true,state:'running'}};
    }
    if (op === 'job.stop') return {ok:true,data:{ok:true}};
    throw Error('Unexpected fixture operation: '+op);
  } };
  async function open(id) {
    const cwd = path.join(directory,id); fs.mkdirSync(cwd);
    const adapter = createRunnerRuntimeAdapter({runtimeSpec:catalog.runtime(id),runnerRuntime:runtime,
      modelConfig:{fetchModel:async()=>({ok:true,model:{id:'synthetic',key:'synthetic'}})}});
    const session = await adapter.createSession({native:{runner:{openOptions:{cwd,ref:'queue-'+id}}}});
    sessions.push(session);
    return getRunnerSessionDetails(session).handle;
  }
  const first = await open('opencode'), independent = await open('qwen');
  const firstTurn = first.submit('First user turn',[]);
  await until(()=>first.snapshot().status==='queued');
  const queuedTurn = first.submit('Ordered follow-up',[]);
  assert.equal(queuedTurn.queued,true);
  now += 808000;
  const queued = first.snapshot();
  assert.equal(queued.execution.running,false);
  assert.equal(queued.running,false);
  assert.equal(queued.execution.active,true);
  assert.equal(queued.execution.waitingForStart,true);
  assert.equal(queued.execution.queuePosition,2);
  assert.equal(queued.execution.elapsedMs,0);
  assert.equal(queued.execution.queueWaitMs,808000);
  assert.equal(queued.execution.stalled,false);
  assert.equal(queued.execution.idleMs,0);
  assert.equal((await independent.submit('Independent user turn',[]).completion).ok,true);
  assert.equal(first.snapshot().status,'queued');
  assert.equal(first.snapshot().queue.length,1);
  const ref = [...states.keys()].find(key=>states.get(key).status==='queued');
  states.set(ref,{status:'running',executionStartedAt:0,queuePosition:0,items:[]});
  await until(()=>first.snapshot().status==='streaming');
  assert.equal(first.snapshot().execution.running,false,'native preflight has not started model execution');
  assert.equal(first.snapshot().execution.elapsedMs,0);
  const startedAt = now;
  states.set(ref,{status:'running',executionStartedAt:startedAt/1000,items:[]});
  await until(()=>first.snapshot().execution.running);
  now += 7000;
  assert.equal(first.snapshot().execution.elapsedMs,7000);
  assert.equal(first.snapshot().execution.queueWaitMs,startedAt-submittedAt);
  assert.equal(first.snapshot().execution.stalled,false,'queue wait is not execution silence');
  assert.equal(calls.filter(row=>row.op==='job.comment').length,0);
  states.set(ref,{status:'done',executionStartedAt:startedAt/1000,ended:now/1000,items:[]});
  assert.equal((await firstTurn.completion).ok,true);
  assert.equal((await queuedTurn.completion).ok,true);
  assert.equal(calls.filter(row=>row.op==='job.comment').length,1);
  assert.equal(calls.find(row=>row.op==='job.comment').input.text,'Ordered follow-up');
});

for (const unit of ['seconds','milliseconds']) test(unit+': restoring prelaunch admission does not invent its wait duration or reuse archive submission time as execution', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-restored-queue-'));
  let session, data = {status:'queued',executionStartedAt:0,queuePosition:1,firstStarted:0,items:[]};
  t.after(async()=>{try {await session?.dispose();} finally {fs.rmSync(directory,{recursive:true,force:true});}});
  const adapter = createRunnerRuntimeAdapter({runtimeSpec:catalog.runtime('opencode'),
    modelConfig:{fetchModel:async()=>({ok:true,model:{id:'synthetic',key:'synthetic'}})},
    runnerRuntime:{async rpc(op) {
      if (op==='runtime.detect') return {ok:true,data:{}};
      if (op==='job.session') return {ok:true,data:{ok:true,...data}};
      if (op==='job.stop') return {ok:true,data:{ok:true}};
      throw Error('Unexpected fixture operation: '+op);
    }} });
  session = await adapter.resumeSession({native:{runner:{openOptions:{cwd:directory,resumePath:'restored-queue'}}}});
  await until(()=>session.snapshot().status==='queued');
  const queued = session.snapshot();
  assert.equal(queued.execution.queueWaitMs,null);
  assert.equal(queued.execution.submittedAt,null);
  assert.equal(queued.execution.elapsedMs,0);
  assert.equal(queued.execution.running,false);
  const started = Date.now()-7000;
  data = {status:'running',executionStartedAt:unit==='seconds'?started/1000:started,started:(started-86400000)/1000,items:[]};
  await until(()=>session.snapshot().execution.running);
  assert.ok(session.snapshot().execution.elapsedMs>=7000);
  assert.ok(session.snapshot().execution.elapsedMs<10000);
  assert.equal(session.snapshot().execution.queueWaitMs,null);
});

test('opening a waiting Runner turn twice keeps the timestamps of the original queue and startup', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-reopen-wait-'));
  const acceptedAt = Date.now() - 104000, preparingAt = acceptedAt + 12000;
  const sessions = [];
  t.after(async () => {
    try { await Promise.all(sessions.map(session => session.dispose())); }
    finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  let nativeStatus = 'queued';
  const adapter = createRunnerRuntimeAdapter({ runtimeSpec: catalog.runtime('qwen'),
    modelConfig: { fetchModel: async () => ({ ok: true, model: { id: 'synthetic', key: 'synthetic' } }) },
    runnerRuntime: { async rpc(op) {
      if (op === 'job.session') return { ok: true, data: { ok: true, status: nativeStatus, executionStartedAt: 0,
        queueAcceptedAt: acceptedAt / 1000, startupWaitSince: nativeStatus === 'queued' ? 0 : preparingAt / 1000,
        firstStarted: (acceptedAt - 86400000) / 1000, items: [] } };
      return { ok: true, data: {} };
    } } });
  const status = require('../components/panels/panels-chat-status');
  for (const phase of ['queued', 'running', 'running']) {
    nativeStatus = phase;
    const session = await adapter.resumeSession({ native: { runner: { openOptions: { cwd: directory, resumePath: 'waiting-run' } } } });
    sessions.push(session);
    await until(() => session.snapshot().execution.submittedAt === acceptedAt);
    const snap = session.snapshot();
    assert.equal(snap.execution.startupWaitSince, phase === 'queued' ? null : preparingAt);
    assert.equal(snap.execution.running, false);
    const clock = status.createThinking(() => ({ ref: 'reopened', snap }));
    assert.match(clock.metricsHtml(true), phase === 'queued' ? /排队中.*1m/ : /等待启动.*1m/);
  }
});
