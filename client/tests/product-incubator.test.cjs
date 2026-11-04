'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const personal = require('../main/personal-plugins');
const incubator = require('../main/product-incubator-plugin');
const core = require('../main/personal-plugin-debug');
const { verify } = require('../main/personal-plugin-debug-runner');
const { check, digest } = require('../../skills/product-incubator/scripts/release-check.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-incubator-'));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  const write = (name, value) => { const target=path.join(root,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,typeof value==='string'?value:JSON.stringify(value)); };
  write('release-candidate.zip','candidate-fixture');write('evidence/core.log','1 test passed');
  const hash = digest(fs.readFileSync(path.join(root,'release-candidate.zip')));
  const acceptance={schemaVersion:1,criteria:[{id:'core',description:'Core journey',required:true}]};
  const evidence={schemaVersion:1,candidate:{path:'release-candidate.zip',sha256:hash},checks:[{criterionId:'core',status:'passed',command:'node --test',exitCode:0,checkedAt:new Date().toISOString(),candidateSha256:hash,log:{path:'evidence/core.log',sha256:digest('1 test passed')}}]};
  const save=()=>{write('acceptance.json',acceptance);write('quality-evidence.json',evidence);};
  save(); return {root,write,save,acceptance,evidence,app:{getPath:()=>root}};
}
test('catalog is offline, portable, complete and does not persist a second personal plugin', t=>{
  const f=fixture(t), item=personal.get(f.app,personal.PRODUCT_INCUBATOR_ID);
  assert.equal(item.name,'产品孵化');assert.equal(item.builtIn,true);
  assert.equal(item.version,require('../../hub-backend/plugins/product-incubator.json').version);
  assert.equal(item.entrypoints.conversation,true);
  // Formal tasks use the reviewed enterprise version, not device-local definitions.
  assert.equal(item.entrypoints.task,false);assert.equal(item.entrypoints.automation,false);
  assert.deepEqual(incubator.body({}).entrypoints,{conversation:true,task:true,automation:true});
  assert.equal(item.capabilities.hasWorkflow,true);assert.equal(item.localDraft.workflow.nodes.length,11);
  assert.equal(item.capabilities.resources.length,3);
  assert.equal(fs.existsSync(path.join(f.root,'personal-plugins.json')),false);
  const result=personal.resolve(f.app,[item.pluginId],{cwd:f.root});
  assert.match(result.items[0].context,/references\/incubator\/GUIDE.md/);
  for(const node of item.localDraft.workflow.nodes){
    assert.ok(!node.config.agentKind&&!node.config.model&&!node.config.runnerId);
    for(const input of node.inputs)assert.ok(node.dependsOn.includes(input.fromNode));
    if(node.type==='ai_review')assert.equal(node.outputs.filter(o=>o.kind==='decision'&&o.required).length,1);
  }
});
test('canonical manifest is packaged verbatim and cached body cannot leak mutations', ()=>{
  const canonical=require('../../hub-backend/plugins/product-incubator.json');
  const first=incubator.body({});assert.deepEqual(first.workflow,canonical.workflow);
  assert.equal(first.version,canonical.version);
  assert.match(first.instructions,/\.soduwork\/product-incubation\.json/);
  assert.match(first.workflow.nodes.find(node=>node.key==='deliver').config.prompt,/\.soduwork\/delivery\.json/);
  first.workflow.nodes[0].name='mutated';
  assert.notEqual(incubator.body({}).workflow.nodes[0].name,'mutated');
  assert.ok(require('../package.json').build.extraResources.some(x=>x.from==='../hub-backend/plugins/product-incubator.json'&&x.to==='product-incubator-plugin.json'));
});
test('evidence success does not claim runtime tests or deployment approval',t=>{
  const f=fixture(t),result=check(f.root);assert.equal(result.outcome,'proceed');
  assert.equal(result.runtimeTested,false);assert.equal(result.deploymentAuthorized,false);
});
for(const [name,change] of [
 ['absent check', f=>f.evidence.checks=[]],
 ['failed exit code', f=>f.evidence.checks[0].exitCode=1],
 ['unsupported skip', f=>f.evidence.checks[0].status='skipped'],
 ['old candidate evidence', f=>f.evidence.checks[0].candidateSha256='a'.repeat(64)],
 ['missing log', f=>f.evidence.checks[0].log.path='missing.log'],
 ['tampered log', f=>f.write('evidence/core.log','changed')],
 ['outside log path', f=>f.evidence.checks[0].log.path='../outside.log'],
 ['future evidence', f=>f.evidence.checks[0].checkedAt='2099-01-01'],
 ['empty command', f=>f.evidence.checks[0].command=' '],
]){
 test('required criterion blocks: '+name,t=>{const f=fixture(t);change(f);f.save();assert.equal(check(f.root).outcome,'blocked');});
}
for(const [name,change] of [
 ['candidate tampering',f=>f.write('release-candidate.zip','changed')],
 ['duplicate criterion',f=>f.acceptance.criteria.push({...f.acceptance.criteria[0]})],
 ['duplicate check',f=>f.evidence.checks.push({...f.evidence.checks[0]})],
 ['no required criteria',f=>f.acceptance.criteria[0].required=false],
 ['unknown criterion',f=>f.evidence.checks[0].criterionId='unknown'],
 ['absolute candidate',f=>f.evidence.candidate.path='C:/outside.zip'],
]){
 test('rejects invalid evidence: '+name,t=>{const f=fixture(t);change(f);f.save();assert.throws(()=>check(f.root));});
}
test('script is read only and will never execute command fields',t=>{
 const f=fixture(t);f.evidence.checks[0].command='node -e "require(\'fs\').writeFileSync(\'MUST-NOT-EXIST\',\'bad\')"';f.save();
 const result=spawnSync(process.execPath,[path.resolve(__dirname,'../../skills/product-incubator/scripts/release-check.cjs'),f.root],{encoding:'utf8',cwd:f.root});
 assert.equal(result.status,0,result.stderr);assert.equal(fs.existsSync(path.join(f.root,'MUST-NOT-EXIST')),false);
});
test('junctions cannot smuggle external evidence into validation',t=>{
 const f=fixture(t),outside=fs.mkdtempSync(path.join(os.tmpdir(),'incubator-external-'));
 t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
 fs.writeFileSync(path.join(outside,'proof.log'),'1 test passed');
 fs.symlinkSync(outside,path.join(f.root,'linked'),process.platform==='win32'?'junction':'dir');
 f.evidence.checks[0].log.path='linked/proof.log';f.save();assert.equal(check(f.root).outcome,'blocked');
});
const tick=()=>new Promise(r=>setImmediate(r));
async function until(fn){for(let i=0;i<200;i++){if(fn())return;await tick();}assert.fail('state timeout');}
test('full workflow blocks, retries, restores approval and finishes once, retaining real files',async t=>{
 const f=fixture(t),plugin=personal.get(f.app,personal.PRODUCT_INCUBATOR_ID);
 let record=core.createRecord(plugin,'incubator-chat','Build the demo without external publishing');
 const journal=core.store(path.join(f.root,'journal'),'incubator-chat'),calls=[];
 let failReview=true;
 const executeNode=async(node)=>{
   calls.push(node.key);
   const dir=path.join(f.root,node.key+'-'+node.attempt);fs.mkdirSync(dir,{recursive:true});
   for(const output of node.outputs){
     const content=output.kind==='decision'?JSON.stringify({schemaVersion:1,outcome:failReview&&node.key==='review'?'blocked':'proceed',reasonCode:failReview&&node.key==='review'?'other':'ready',summary:'Controlled test evidence',evidence:['fixture'],nextAction:'repair missing evidence'}):'real fixture '+output.key;
     fs.writeFileSync(path.join(dir,output.path),content);
   }
   return verify(node,dir,f.root,'controlled fixture execution');
 };
 let controller=core.create({record,save:r=>journal.write(r),executeNode,stopNode:async()=>{}});
 let done=controller.execute();
 await until(()=>record.status==='waiting');assert.deepEqual(calls,['discover']);
 await assert.rejects(controller.action('approve',record.revision,'accept_release'));
 const saved=journal.read();
 await controller.cancel();await done;
 record=saved;controller=core.create({record,save:r=>journal.write(r),executeNode,stopNode:async()=>{}});
 done=controller.execute();await tick();assert.deepEqual(calls,['discover']);
 await controller.action('approve',record.revision,'confirm_scope');
 await until(()=>record.status==='failed');
 assert.equal(calls.at(-1),'review');assert.ok(!calls.includes('prepare_release'));
 failReview=false;await controller.action('retry',record.revision,'review');
 await until(()=>record.status==='waiting');
 assert.ok(!calls.includes('deliver'));
 await controller.action('approve',record.revision,'accept_release');
 await until(()=>record.status==='waiting'&&record.nodes.find(x=>x.key==='accept_delivery').status==='waiting');
 const delivery=record.nodes.find(x=>x.key==='deliver').outputsFound.find(x=>x.key==='delivery');
 assert.ok(fs.existsSync(path.join(f.root,delivery.path)));
 await controller.action('approve',record.revision,'accept_delivery');
 assert.equal((await done).ok,true);assert.equal(record.status,'completed');
 assert.equal(calls.filter(x=>x==='discover').length,1);assert.equal(calls.filter(x=>x==='review').length,2);
 assert.equal(journal.read().status,'completed');
});
