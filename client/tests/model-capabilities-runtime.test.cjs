'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const config=require('../main/pi-session/model-config');
const {create,piProvider,outputLimit}=require('../main/conversation/model-selection');

test('saved output budget and native capability metadata reach both Pi configuration forms',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-cap-config-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const profile={imageInput:{state:'supported',source:'verified'}};
 const response={ok:true,key:'fixture-key',model:'custom-alias',maxOutputTokens:32768,contextWindow:128000,
  imageRouting:'native',input:['text','image'],capabilityProfile:profile,configRevision:'saved-v1',runtimeRevision:'runtime-v2'};
 const got=await config.fetchModel({hub:'http://fixture',clientId:'fixture',secret:'fixture'},'',1000,async()=>({ok:true,json:async()=>response}));
 assert.deepEqual(got.model.capabilityProfile,profile);
 assert.equal(got.model.runtimeRevision,'runtime-v2');
 assert.equal(piProvider(got.model).models[0].maxTokens,32768);
 const written=JSON.parse(fs.readFileSync(config.writeModels(root,got.model),'utf8'));
 assert.equal(written.providers.soduwork.models[0].maxTokens,32768);
 assert.deepEqual(written.providers.soduwork.models[0].input,['text','image']);
 assert.ok(!JSON.stringify(written).includes('fixture-key'));
 assert.equal(outputLimit({maxOutputTokens:Infinity}),32768);
 assert.equal(outputLimit({maxOutputTokens:40000,contextWindow:8192}),8192);
});

test('same-name model capability revisions apply only at a turn boundary',async()=>{
 let current={id:'alias',runtimeRevision:'runtime-v1'},epoch=0,calls=0;
 const applied=[];
 const selection=create({name:'alias',model:current,generation:()=>epoch,
  resolve:async()=>{calls++;return {ok:true,model:current};},apply:model=>applied.push(model.runtimeRevision)});
 await selection.applyForTurn();assert.equal(calls,0);
 current={id:'alias',runtimeRevision:'runtime-v2'};epoch++;
 assert.equal(selection.needsApply(),true);assert.deepEqual(applied,[]);
 await selection.applyForTurn();assert.deepEqual(applied,['runtime-v2']);
 await selection.applyForTurn();assert.equal(calls,1);
 current={id:'alias',runtimeRevision:'runtime-v3'};
 await selection.select('alias');assert.deepEqual(applied,['runtime-v2']);
 assert.equal(selection.view().pending,true);
 await selection.applyForTurn();assert.deepEqual(applied,['runtime-v2','runtime-v3']);
});

test('settings broadcasts invalidate cached model metadata without changing active requests',()=>{
 const before=config.generation();config._modelCache.set('fixture',{value:{id:'old'}});
 config.invalidate();assert.equal(config._modelCache.size,0);assert.equal(config.generation(),before+1);
});
