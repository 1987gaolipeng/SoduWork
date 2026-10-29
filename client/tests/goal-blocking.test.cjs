'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loop = require('../main/conversation/goal-loop');
const policy = require('../main/agent-runtime/execution-policy');
const quality = require('../main/conversation/goal-quality');
const verifier = require('../main/conversation/goal-verifier');
const review = require('../main/conversation/goal-review');
const intent = require('../components/panels/work-intent');
test('terminal-protected documents are reported as an external blocker, not corrupt output to regenerate', t => {
  const {root}=site(t,'<main>Ready</main>');
  const file=path.join(root,'protected.pdf'),header=Buffer.alloc(256);
  Buffer.from('e0a891e7d8f205ac','hex').copy(header);
  header.write('Esafenet',88,'ascii');
  fs.writeFileSync(file,header);
  const probe=verifier.artifactProbe({path:file,relative:'protected.pdf'});
  assert.equal(probe.protected,true);
  assert.match(probe.reason,/文档保护/);
  const deterministic=verifier.verify({cwd:root,outputSnapshot:{delivery:{items:[
    {path:file,relative:'protected.pdf',kind:'pdf'}
  ]}}});
  const outcome=review.outcome('',{deterministic});
  assert.equal(outcome.phase,'blocked');
  assert.equal(outcome.retryable,false);
  assert.doesNotMatch(outcome.gaps.find(x=>x.check==='artifact_integrity').action,/重新生成/);
  const decision=policy.decidePolicyReview(policy.createExecutionPolicy({goal:'交付报告'}),outcome);
  assert.equal(decision.action,'block');
  assert.equal(decision.state.cycle,1);
});

test('changed failed checks are progress even when their failure count stays one', () => {
  const verdict = command => review.outcome('', {deterministic:verifier.verify({
    evidence:quality.collectEvidence([{name:'bash',args:{command},state:'error',result:'failed'}],{})
  })});
  const first = verdict('npm test -- api.spec');
  const second = verdict('npm test -- ui.spec');
  assert.notEqual(review.fingerprint(first),review.fingerprint(second));
  assert.equal(review.fingerprint(first),review.fingerprint(JSON.parse(JSON.stringify(first))));
});
test('Pi runtime adapter retains blocked-goal continuation capability', () => {
  const {wrapPiSession}=require('../main/agent-runtime/pi-adapter');
  const native={ref:'test-blocked',snapshot:()=>({execution:{configured:true,canContinue:true,quality:{phase:'blocked'}}})};
  const wrapped=wrapPiSession(native,{});
  assert.equal(wrapped.snapshot().execution.canContinue,true);
});

const control = require('../main/pi-session/run-control');
const stages = require('../main/pi-session/goal-tool-stages');
function context(extra={}) {
  return {
    visible:()=>true, closed:()=>false, qualityPhase:()=> 'blocked',
    qualityReason:()=> 'repeated gap', limitRequest:()=>null,
    harnessView:()=>({focus:{reason:'invalid PDF',action:'regenerate report.pdf'}}),
    ...extra,
  };
}
test('blocked goals can resume with their actual gap; completed and deleted goals cannot', () => {
  const paused = control.continuation(context());
  assert.equal(paused.kind,'blocked');
  assert.match(quality.continuationPrompt({goal:'deliver report'},paused),/regenerate report.pdf/);
  for (const extra of [{qualityPhase:()=> 'reviewed'},{visible:()=>false},{closed:()=>true}]) {
    assert.equal(control.continuation(context(extra)),null);
  }
});
test('continuing retains unresolved goal evidence but excludes earlier ordinary chat', () => {
  const tools = [
    {name:'bash',args:{command:'old failing check'},state:'error',scope:'normal'},
    {name:'bash',args:{command:'npm test'},state:'error',scope:'goal-execution'},
  ];
  const state = step(loop.compile({goal:'Build a website'}),'run.started',{toolCount:1});
  const restored = loop.normalize(JSON.parse(JSON.stringify(state)));
  const from = stages.evidenceStart(restored,tools,tools.length);
  assert.equal(from,1);
  assert.equal(stages.evidenceStart({},tools,2),1);
  const evidence = quality.collectEvidence(tools.slice(from),{});
  assert.equal(evidence.failures,1);
  const repaired = quality.collectEvidence([...tools.slice(from),
    {name:'bash',args:{command:'npm test'},state:'done'}],{});
  assert.equal(repaired.failures,0);
});
test('the real Pi continuation handler resumes blocked goals only at a safe boundary', () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname,'../main/pi-session/session-handle.js'),'utf8');
  const method = source.slice(source.indexOf('continueGoal() {'),source.indexOf('pauseGoal() {'));
  let sent = [], checkpoint = [];
  const env = {
    runControl:control, _runContext:()=>context(), inFlight:false,
    run:control.createState(), turnQueue:{size:()=>0,resume:()=>{}},
    acc:{status:()=> 'idle'}, limitRequest:null, goalEnabled:false,
    failedLastTurn:true, updatedAt:0, qualityPhase:'blocked',qualityReason:'',
    goal:{goal:'deliver report'}, goalQuality:quality,
    goalPluginIds:[],goalPluginProjectId:'',
    _checkpoint:(...args)=>checkpoint.push(args),
    handle:{send:(...args)=>{sent.push(args);return Promise.resolve({ok:true});}},
  };
  env.ctx = env;
  const handler = vm.runInNewContext('({' + method + '})',env);
  assert.equal(handler.continueGoal().accepted,true);
  assert.equal(sent.length,1);
  assert.equal(sent[0][2].goalMode,true);
  assert.equal(sent[0][2].continuing,true);
  assert.match(sent[0][0],/regenerate report.pdf/);
  assert.equal(checkpoint[0][0],'run.resumed');
  env.inFlight=true;
  assert.equal(handler.continueGoal().ok,false);
  env.inFlight=false;env.acc.status=()=> 'waiting-user';
  assert.equal(handler.continueGoal().ok,false);
  assert.equal(sent.length,1);
});

function step(state, type, payload = {}) {
  return loop.reduce(state, loop.event(type, payload, type + ':' + state.revision, 1000 + state.revision));
}
test('failed verification blocks step four, not delivery, including historical checkpoints', () => {
  let state = step(loop.compile({ goal: 'Build a website' }), 'verification.started');
  state = step(state, 'verification.failed', { result: { gaps: [{check:'artifact_integrity',reason:'invalid PDF'}] } });
  state = step(state, 'run.blocked', { reason: 'invalid PDF' });
  assert.equal(state.phase, 'verify');
  assert.equal(state.phases[3].state, 'blocked');
  assert.equal(state.phases[4].state, 'pending');
  const restored = loop.normalize({ ...state, node:'done', phase:'deliver' });
  assert.equal(restored.phase, 'verify');
  assert.equal(intent.phaseView(restored).current, 4);
});
test('a packaging failure after a genuine verification pass stays at delivery', () => {
  let state = step(loop.compile({goal:'Build a website'}), 'verification.passed');
  state = step(state, 'run.blocked', {reason:'packaging failed'});
  assert.equal(state.phase, 'deliver');
  assert.equal(state.phases[3].state, 'completed');
  assert.equal(state.phases[4].state, 'blocked');
});
test('portable policy preserves the actual blocked checkpoint', () => {
  let state = policy.beginPolicyVerification(policy.createExecutionPolicy({goal:'Build a website'}));
  const result = {phase:'blocked',retryable:false,reason:'invalid file'};
  const decision = policy.decidePolicyReview(state, result);
  state = policy.finalizeExecutionPolicy(decision.state, decision.review);
  assert.equal(state.ledger.phase, 'verify');
});
test('an unfinished tool cannot erase an earlier failed verification', () => {
  const evidence = quality.collectEvidence([
    {name:'bash',args:{command:'npm test'},state:'error',result:'FAILED submit.spec'},
    {name:'bash',args:{command:'npm test'},state:'running'},
  ], {});
  assert.equal(evidence.failures, 1);
  assert.equal(evidence.verification, false);
});
test('repair prompt identifies the actual failed check and preserves successful reruns', () => {
  const tools = [
    {name:'bash',args:{command:'npm test -- submit.spec'},state:'error',result:'submit: expected 200 but received 500'},
    {name:'bash',args:{command:'npm run build'},state:'done'},
  ];
  const evidence = quality.collectEvidence(tools, {});
  assert.equal(evidence.unresolvedFailures[0].command, 'npm test -- submit.spec');
  const result = review.outcome('', {deterministic:verifier.verify({evidence})});
  const prompt = loop.cyclePrompt(loop.compile({goal:'Fix API'}), result);
  assert.match(prompt, /npm test -- submit.spec/);
  assert.match(prompt, /expected 200 but received 500/);
  const recovered = quality.collectEvidence([...tools, {name:'bash',args:{command:'npm test -- submit.spec'},state:'done'}], {});
  assert.equal(recovered.failures, 0);
  assert.deepEqual(recovered.unresolvedFailures, []);
});
function site(t, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-goal-block-'));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  const file = path.join(root, 'index.html');
  fs.writeFileSync(file, body);
  return {root, item:{path:file,relative:'index.html'}};
}
test('declared and runtime-verified same-origin API is not a missing static asset', t => {
  const {root,item} = site(t, '<script>fetch("/api/v1")</script>');
  const result = verifier.websiteProbe(root, item, {
    runtime:{networkPolicy:'online', externalDependencies:['/api/v1']},
  }, {launch:true});
  assert.equal(result.pass, true, JSON.stringify(result.gaps));
});
test('undeclared or unverified APIs do not silently pass delivery', t => {
  const {root,item} = site(t, '<script>fetch("/api/v1")</script>');
  assert.equal(verifier.websiteProbe(root,item,null,{launch:true}).pass, false);
  assert.equal(verifier.websiteProbe(root,item,{
    runtime:{networkPolicy:'online',externalDependencies:['/api/v1']},
  },{}).pass, false);
  assert.equal(verifier.websiteProbe(root,item,{
    runtime:{networkPolicy:'offline',externalDependencies:['/api/v1']},
  },{launch:true}).pass, false);
});
test('API declarations cannot hide missing workers, images, or sibling routes', t => {
  const {root,item} = site(t, '<img src="/api/v1/image.png"><script>new Worker("/api/v1/worker.js");fetch("/api/v10")</script>');
  const result = verifier.websiteProbe(root,item,{
    runtime:{networkPolicy:'online',externalDependencies:['/api/v1']},
  },{launch:true});
  assert.equal(result.pass,false);
  for (const name of ['image.png','worker.js','api/v10']) assert.ok(result.gaps.join(' ').includes(name));
});
test('invalid PPT and PDF remain blocked; regenerated file signatures are checked again', t => {
  const {root} = site(t, '<main>Ready</main>');
  for (const [name, good] of [['deck.pptx',Buffer.from([80,75,3,4])],['report.pdf','%PDF-1.7\n']]) {
    const file = path.join(root,name);
    fs.writeFileSync(file,'not a real document');
    assert.equal(verifier.artifactProbe({path:file,relative:name}).pass,false);
    fs.writeFileSync(file,good);
    assert.equal(verifier.artifactProbe({path:file,relative:name}).pass,true);
  }
});
