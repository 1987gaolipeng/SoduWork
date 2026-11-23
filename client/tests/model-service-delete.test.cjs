'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const store = require('../main/local-model-store.cjs');

function fixture() {
  const local = store.publicCatalog(store.normalize({providers:[
    {id:'local-first',name:'First service',baseUrl:'http://127.0.0.1:1/v1',authMode:'key'},
    {id:'local-second',name:'Second service',baseUrl:'http://127.0.0.1:2/v1',authMode:'none'}],
  models:[{providerId:'local-first',name:'first-model'},{providerId:'local-second',name:'second-model'}],keys:{'local-first':'synthetic-key'}}));
  local.revision=3;
  const managed={revision:'hub-1',providers:[{id:'custom-hub',name:'Hub service',personal:true,
    baseUrl:'https://fixture.invalid/v1',myKeySet:true,modelNames:[]}],myModels:[],usable:[]};
  const state={writes:[],fail:false,gate:null,scope:'account-one',renders:0,refreshFails:false};
  const button={}, body={querySelectorAll:()=>[],querySelector:()=>null};
  const context={URL,structuredClone,setTimeout,clearTimeout,addEventListener(){},
    esc:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),
    document:{getElementById:id=>id==='mdBody'?body:id==='mdSave'?button:null},petSay(){},
    SoduWorkAPI:{taskStorageKey:()=>state.scope,
      localModels:async()=>structuredClone(local),
      myModels:async()=>{if(state.refreshFails)throw Error('Synthetic refresh failure');return structuredClone(managed);},
      saveMyModels:async input=>{
        state.writes.push(structuredClone(input)); if(state.gate)await state.gate;
        if(state.fail)throw Error('Synthetic persistence failure');
        if(input.localProviders){
          assert.equal(input.localRevision,local.revision);
          local.providers=input.localProviders;local.myModels=input.localModels;local.revision++;
          local.usable=local.usable.filter(row=>row.providerId!=='local-first');
          return structuredClone(local);
        }
        assert.equal(input.expectedRevision,managed.revision);
        managed.providers=input.providers;managed.myModels=input.models;managed.revision='hub-2';
        state.afterHubCommit?.();
        return {ok:true};
      }},state};
  context.window=context;vm.createContext(context);
  for(const name of ['model-capabilities.js','model-catalog-editor.js','panels-models.js','model-service-delete.js']){
    const file=path.join(__dirname,'../components/panels',name);
    if(fs.existsSync(file))vm.runInContext(fs.readFileSync(file,'utf8'),context,{filename:name});
  }
  context.catalog={...structuredClone(managed),localRevision:3,
    providers:structuredClone(local.providers).concat(managed.providers),
    myModels:structuredClone(local.myModels),usable:structuredClone(local.usable)};
  const evaluate=source=>vm.runInContext(source,context);
  evaluate('_mdData=catalog;_mdMyModels=catalog.myModels.slice();_mdOpen="local-first";_mdLoadState="ready";_mdRender=()=>{state.renders++};_mdRefreshSavedModels=async()=>{};');
  return {state,context,evaluate,local,managed,button};
}

test('service delete confirmation describes the stored models and personal key without mutating drafts',async()=>{
  const f=fixture();f.evaluate('_mdTouchProvider("local-second",{name:"Unsaved second"});');
  const before=f.evaluate('JSON.stringify(_mdData)');
  const plan=await f.evaluate('_mdPrepareServiceDelete("local-first")');
  assert.equal(plan.count,1);assert.equal(plan.hasKey,true);assert.equal(plan.name,'First service');
  assert.equal(f.state.writes.length,0);assert.equal(f.evaluate('JSON.stringify(_mdData)'),before);
  const noKey=await f.evaluate('_mdPrepareServiceDelete("local-second")');assert.equal(noKey.hasKey,false);
});

test('service deletion writes only its stored ownership domain and preserves unrelated unsaved edits',async()=>{
  const f=fixture();f.evaluate('_mdTouchProvider("local-second",{name:"Unsaved second"});_mdTouchProvider("custom-hub",{name:"Unsaved Hub"});_mdDrafts.set("local-second",{fields:{label:"Retain"}});');
  const plan=await f.evaluate('_mdPrepareServiceDelete("local-first")');f.context.plan=plan;
  assert.equal(await f.evaluate('_mdDeleteService(plan)'),true);
  assert.equal(f.state.writes.length,1);
  const input=f.state.writes[0];assert.deepEqual(Object.keys(input).sort(),['localKeys','localModels','localProviders','localRevision']);
  assert.equal(input.localProviders[0].name,'Second service','do not submit an unrelated draft');
  assert.equal(input.localKeys['local-first'],null);
  assert.equal(f.evaluate('_mdProvider("local-second").name'),'Unsaved second');
  assert.equal(f.evaluate('_mdProvider("custom-hub").name'),'Unsaved Hub');
  assert.equal(f.evaluate('_mdDrafts.has("local-second")'),true);
  assert.equal(f.evaluate('_mdProvider("local-first")'),undefined);
  assert.equal(f.evaluate('_mdData.localRevision'),4);
  assert.equal(f.evaluate('_mdLocalDirty'),true);assert.equal(f.evaluate('_mdManagedDirty'),true);
});

test('a failed or pending service deletion leaves the service, key edit and model editor in place',async()=>{
  const f=fixture();let release;f.state.gate=new Promise(resolve=>{release=resolve});f.state.fail=true;
  f.evaluate('_mdKeyEdits["local-first"]="unsaved-key";_mdMarkOwnedDirty("local-first");_mdDrafts.set("local-first",{original:"first-model"});');
  f.context.plan=await f.evaluate('_mdPrepareServiceDelete("local-first")');
  const before=f.evaluate('JSON.stringify([_mdData,_mdMyModels,_mdKeyEdits])');
  const pending=f.evaluate('_mdDeleteService(plan)');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.state.writes.length,1);assert.equal(f.button.disabled,true);
  assert.equal(f.evaluate('JSON.stringify([_mdData,_mdMyModels,_mdKeyEdits])'),before);
  release();await assert.rejects(pending,/Synthetic persistence failure/);
  assert.equal(f.evaluate('JSON.stringify([_mdData,_mdMyModels,_mdKeyEdits])'),before);
  assert.equal(f.evaluate('_mdDrafts.has("local-first")'),true);assert.equal(f.button.disabled,false);
  f.state.fail=false;assert.equal(await f.evaluate('_mdDeleteService(plan)'),true);
  assert.equal(f.evaluate('_mdDrafts.has("local-first")'),false);
  assert.equal(f.evaluate('Object.hasOwn(_mdKeyEdits,"local-first")'),false);
});

test('unsaved service drafts can be discarded without validating an empty URL or writing storage',async()=>{
  const f=fixture();f.evaluate('_mdAddService();_mdTouchProvider(_mdNew.id,{name:"Draft only"});');
  f.context.draftId=f.evaluate('_mdNew.id');f.context.plan=await f.evaluate('_mdPrepareServiceDelete(draftId)');
  assert.equal(f.context.plan.draftOnly,true);assert.equal(await f.evaluate('_mdDeleteService(plan)'),true);
  assert.equal(f.state.writes.length,0);assert.equal(f.evaluate('_mdNew'),null);assert.equal(f.evaluate('_mdDirty'),false);
});

test('Hub service deletion excludes local rows and keeps a committed deletion successful if reloading fails',async()=>{
  const f=fixture();f.context.plan=await f.evaluate('_mdPrepareServiceDelete("custom-hub")');
  f.state.refreshFails=true;assert.equal(await f.evaluate('_mdDeleteService(plan)'),true);
  const input=f.state.writes[0];assert.deepEqual(Object.keys(input).sort(),['expectedRevision','keys','models','providers']);
  assert.equal(input.providers.length,0);assert.equal(JSON.stringify(input).includes('local-first'),false);
  assert.equal(f.evaluate('_mdProvider("custom-hub")'),undefined);
  assert.equal(f.evaluate('_mdManagedNeedsReload'),true);
});

for(const boundary of ['scope','panel'])test(`service deletion ignores stale UI results after a ${boundary} change`,async()=>{
  const f=fixture();let release;f.state.gate=new Promise(resolve=>{release=resolve});
  f.context.plan=await f.evaluate('_mdPrepareServiceDelete("local-first")');
  const pending=f.evaluate('_mdDeleteService(plan)');await new Promise(resolve=>setImmediate(resolve));
  if(boundary==='scope')f.state.scope='account-two';else f.evaluate('closeModelsPanel()');
  release();assert.equal(await pending,true);
  assert.equal(f.local.providers.some(row=>row.id==='local-first'),false);
  assert.equal(f.evaluate('_mdData.providers.some(row=>row.id==="local-first")'),true,'old result cannot mutate another view');
});

test('service deletion rejects a newer stored snapshot instead of advancing an obsolete page revision',async()=>{
  const f=fixture();f.local.revision=4;f.local.providers[1].name='Changed in another window';
  await assert.rejects(f.evaluate('_mdPrepareServiceDelete("local-first")'),/配置已变化/);
  assert.equal(f.state.writes.length,0);assert.equal(f.evaluate('_mdData.localRevision'),3);
  assert.equal(f.evaluate('_mdProvider("local-second").name'),'Second service');
});

test('a third-party change after Hub deletion cannot grant the old page a newer write revision',async()=>{
  const f=fixture();
  const extra={id:'custom-other',name:'Original',personal:true,baseUrl:'https://other.fixture.invalid/v1',modelNames:[]};
  f.managed.providers.push(structuredClone(extra));f.context.extra=extra;f.evaluate('_mdData.providers.push(structuredClone(extra))');
  f.context.plan=await f.evaluate('_mdPrepareServiceDelete("custom-hub")');
  f.state.afterHubCommit=()=>{f.managed.providers[0].name='Changed externally';f.managed.revision='hub-3'};
  assert.equal(await f.evaluate('_mdDeleteService(plan)'),true);
  assert.equal(f.evaluate('_mdData.revision'),'hub-1');
  assert.equal(f.evaluate('_mdManagedNeedsReload'),true);assert.equal(f.context.plan.refreshWarning,true);
});

test('service deletion remains committed and returns one refresh warning if rendering fails',async()=>{
  const f=fixture();f.context.plan=await f.evaluate('_mdPrepareServiceDelete("local-first")');
  f.evaluate('_mdRender=()=>{throw Error("Synthetic render failure")}');
  assert.equal(await f.evaluate('_mdDeleteService(plan)'),true);
  assert.equal(f.local.providers.some(row=>row.id==='local-first'),false);
  assert.equal(f.context.plan.refreshWarning,true);
});

test('a malformed Hub reload cannot turn a committed service deletion into a failed deletion',async()=>{
  const f=fixture();f.context.plan=await f.evaluate('_mdPrepareServiceDelete("custom-hub")');
  f.context.SoduWorkAPI.myModels=async()=>({revision:'hub-2'});
  assert.equal(await f.evaluate('_mdDeleteService(plan)'),true);
  assert.equal(f.managed.providers.length,0);assert.equal(f.context.plan.refreshWarning,true);
});

for(const edit of ['provider','model','key','editor'])test(`managed deletion preserves an unrelated ${edit} draft before writing`,async()=>{
  const f=fixture();const extra={id:'custom-other',name:'Other',personal:true,baseUrl:'https://other.fixture.invalid/v1',modelNames:[]};
  f.managed.providers.push(structuredClone(extra));f.context.extra=extra;f.evaluate('_mdData.providers.push(structuredClone(extra))');
  const model={providerId:'custom-other',name:'other-model',label:'Other model',modality:'chat'};
  f.managed.myModels.push(structuredClone(model));f.context.model=model;f.evaluate('_mdMyModels.push(structuredClone(model))');
  if(edit==='provider')f.evaluate('_mdTouchProvider("custom-other",{name:"Unsaved service name"})');
  if(edit==='model')f.evaluate('_mdMyModels.find(row=>row.providerId==="custom-other").label="Unsaved model label";_mdMarkOwnedDirty("custom-other")');
  if(edit==='key')f.evaluate('_mdKeyEdits["custom-other"]="pending-user-key";_mdMarkOwnedDirty("custom-other")');
  if(edit==='editor')f.evaluate('_mdDrafts.set("custom-other",{original:"other-model",model:{label:"Unapplied editor"}})');
  const before=f.evaluate('JSON.stringify([_mdData,_mdMyModels,_mdKeyEdits,[..._mdDrafts]])');
  await assert.rejects(f.evaluate('_mdPrepareServiceDelete("custom-hub")'),/请先完成或取消其他服务的编辑/);
  assert.equal(f.state.writes.length,0);assert.equal(f.evaluate('_mdManagedNeedsReload'),false);
  assert.equal(f.evaluate('JSON.stringify([_mdData,_mdMyModels,_mdKeyEdits,[..._mdDrafts]])'),before);
});

test('managed deletion rechecks unrelated edits before admitting a confirmed write',async()=>{
  const f=fixture();const extra={id:'custom-other',name:'Other',personal:true,baseUrl:'https://other.fixture.invalid/v1',modelNames:[]};
  f.managed.providers.push(structuredClone(extra));f.context.extra=extra;f.evaluate('_mdData.providers.push(structuredClone(extra))');
  f.context.plan=await f.evaluate('_mdPrepareServiceDelete("custom-hub")');
  f.evaluate('_mdKeyEdits["custom-other"]="pending-user-key";_mdMarkOwnedDirty("custom-other")');
  await assert.rejects(f.evaluate('_mdDeleteService(plan)'),/请先完成或取消其他服务的编辑/);
  assert.equal(f.state.writes.length,0);assert.equal(f.evaluate('_mdKeyEdits["custom-other"]'),'pending-user-key');
});

test('a secret-only Hub revision cannot bypass a credential draft introduced after write admission',async()=>{
  const f=fixture();const extra={id:'custom-other',name:'Other',personal:true,baseUrl:'https://other.fixture.invalid/v1',modelNames:[]};
  f.managed.providers.push(structuredClone(extra));f.context.extra=extra;f.evaluate('_mdData.providers.push(structuredClone(extra))');
  f.context.plan=await f.evaluate('_mdPrepareServiceDelete("custom-hub")');
  f.state.afterHubCommit=()=>{f.managed.revision='hub-3';f.evaluate('_mdKeyEdits["custom-other"]="pending-user-key";_mdMarkOwnedDirty("custom-other")')};
  assert.equal(await f.evaluate('_mdDeleteService(plan)'),true);
  assert.equal(f.evaluate('_mdData.revision'),'hub-1');assert.equal(f.evaluate('_mdManagedNeedsReload'),true);
  assert.equal(f.evaluate('_mdKeyEdits["custom-other"]'),'pending-user-key');
});

test('a clean remaining Hub snapshot adopts its credential metadata with its revision',async()=>{
  const f=fixture();const extra={id:'custom-other',name:'Other',personal:true,baseUrl:'https://other.fixture.invalid/v1',modelNames:[],myKeySet:false};
  f.managed.providers.push(structuredClone(extra));f.context.extra=extra;f.evaluate('_mdData.providers.push(structuredClone(extra))');
  f.context.plan=await f.evaluate('_mdPrepareServiceDelete("custom-hub")');
  f.state.afterHubCommit=()=>{f.managed.providers[0].myKeySet=true;f.managed.providers[0].myKeyLen=32;f.managed.revision='hub-3'};
  assert.equal(await f.evaluate('_mdDeleteService(plan)'),true);
  assert.equal(f.evaluate('_mdData.revision'),'hub-3');assert.equal(f.evaluate('_mdProvider("custom-other").myKeySet'),true);
});

test('an unnamed service draft is described with a human label, never its internal ID',async()=>{
  const f=fixture();f.evaluate('_mdAddService()');
  const plan=await f.evaluate('_mdPrepareServiceDelete(_mdNew.id)');assert.equal(plan.name,'未命名服务');
});

test('catalog reload retires removed-service editors and retains current service drafts',async()=>{
  const f=fixture();
  Object.assign(f.context.document.getElementById('mdBody'),{setAttribute(){},removeAttribute(){}});
  f.evaluate(`
    _mdData.providers.push({id:'custom-other',personal:true,name:'Other',baseUrl:'https://other.fixture.invalid/v1'});
    _mdMyModels.push({providerId:'custom-other',name:'old-model'});
    _mdDrafts.set('custom-other',{original:'old-model',model:{name:'old-model'},open:true});
    _mdDrafts.set('custom-hub',{changed:true,fields:{label:'Retain existing editor'}});
    _mdAddService();
    _mdDrafts.set(_mdNew.id,{changed:true,fields:{label:'Retain new editor'}});
  `);
  const draftId=f.evaluate('_mdNew.id');
  f.managed.revision='hub-2';
  assert.equal(await f.evaluate('_mdLoad()'),true);
  assert.equal(f.evaluate('_mdProvider("custom-other")'),undefined);
  assert.equal(f.evaluate('_mdDrafts.has("custom-other")'),false);
  assert.equal(f.evaluate('_mdDrafts.get("custom-hub").fields.label'),'Retain existing editor');
  assert.equal(f.evaluate('_mdDrafts.get(_mdNew.id).fields.label'),'Retain new editor');
  assert.equal(f.evaluate('_mdNew.id'),draftId);
  const plan=await f.evaluate('_mdPrepareServiceDelete("custom-hub")');
  assert.equal(plan.pid,'custom-hub');assert.equal(f.state.writes.length,0);
});

test('an unavailable managed catalog preserves unapplied Hub editor drafts',async()=>{
  const f=fixture();
  Object.assign(f.context.document.getElementById('mdBody'),{setAttribute(){},removeAttribute(){}});
  f.evaluate('_mdDrafts.set("custom-hub",{original:"unsaved-model",changed:true,fields:{label:"Keep unapplied input"}});');
  f.context.SoduWorkAPI.myModels=async()=>({...structuredClone(f.local),localRevision:f.local.revision,managedCatalogUnavailable:true});
  assert.equal(await f.evaluate('_mdLoad()'),true);
  assert.equal(f.evaluate('_mdDrafts.get("custom-hub")?.fields.label'),'Keep unapplied input');
  assert.equal(f.state.writes.length,0);
});

test('deleting one personal Hub service excludes company data and keeps the refreshed catalog revision usable', async () => {
  const f = fixture();
  const company = { id: 'company', name: 'Company service', personal: false, baseUrl: 'https://company.invalid/v1',
    myKeySet: true, modelDefs: [{ name: 'company-model' }], modelNames: ['company-model'] };
  const own = { id: 'custom-other', name: 'Other personal service', personal: true,
    baseUrl: 'https://own.invalid/v1', modelNames: [] };
  const models = [{providerId:'company',name:'legacy-company-override'}, {providerId:'custom-other',name:'own-model'}];
  f.managed.providers.push(structuredClone(company), structuredClone(own));
  f.managed.myModels.push(...structuredClone(models));
  f.context.extraProviders = [company, own]; f.context.extraModels = models;
  f.evaluate('_mdData.providers.push(...structuredClone(extraProviders));_mdMyModels.push(...structuredClone(extraModels));_mdKeyEdits.company="old-override-key";_mdDrafts.set("company",{changed:true,original:"legacy-company-override"});');
  f.context.SoduWorkAPI.saveMyModels = async input => {
    f.state.writes.push(structuredClone(input));
    assert.equal(input.expectedRevision, 'hub-1');
    assert.deepEqual(Array.from(input.providers, row => row.id), ['custom-other']);
    assert.deepEqual(Array.from(input.models, row => row.providerId), ['custom-other']);
    assert.deepEqual(Object.keys(input.keys), []);
    f.managed.providers = [{...company, name:'Updated company service'}, ...structuredClone(input.providers)];
    f.managed.myModels = [models[0], ...structuredClone(input.models)];
    f.managed.revision = 'hub-2';
    return {ok:true};
  };
  f.context.plan = await f.evaluate('_mdPrepareServiceDelete("custom-hub")');
  assert.equal(await f.evaluate('_mdDeleteService(plan)'), true);
  assert.equal(f.state.writes.length, 1);
  assert.equal(f.evaluate('_mdProvider("custom-hub")'), undefined);
  assert.equal(f.evaluate('_mdProvider("company").name'), 'Updated company service');
  assert.equal(f.evaluate('_mdProvider("custom-other").name'), 'Other personal service');
  assert.equal(f.evaluate('_mdProvider("local-first").name'), 'First service');
  assert.equal(f.evaluate('_mdData.revision'), 'hub-2');
  assert.equal(f.evaluate('_mdManagedNeedsReload'), false);
  assert.equal(f.evaluate('_mdDirty'), false);
  assert.equal(f.context.plan.refreshWarning, false);
  const next = await f.evaluate('_mdPrepareServiceDelete("custom-other")');
  assert.equal(next.body.expectedRevision, 'hub-2');
  assert.equal(next.body.providers.length, 0);
  assert.equal(next.body.models.length, 0);
});

for (const personal of [false, undefined, 'true', 1]) test('service deletion requires explicit personal ownership: ' + String(personal), async () => {
  const f = fixture(); f.context.ownership = personal;
  f.evaluate('_mdProvider("custom-hub").personal=ownership');
  await assert.rejects(f.evaluate('_mdPrepareServiceDelete("custom-hub")'));
  f.evaluate('_mdConfirmServiceDelete("custom-hub")');
  assert.equal(f.state.writes.length, 0);
  assert.equal(f.evaluate('_mdProvider("custom-hub").name'), 'Hub service');
});

test('a prepared personal deletion rechecks changed ownership before writing', async () => {
  const f = fixture(); f.context.plan = await f.evaluate('_mdPrepareServiceDelete("custom-hub")');
  f.evaluate('_mdProvider("custom-hub").personal=false');
  await assert.rejects(f.evaluate('_mdDeleteService(plan)'));
  assert.equal(f.state.writes.length, 0);
  assert.equal(f.evaluate('_mdProvider("custom-hub").name'), 'Hub service');
});
