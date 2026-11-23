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
 assert.equal(outputLimit({maxOutputTokens:Infinity}),16384);
 assert.equal(outputLimit({maxOutputTokens:40000,contextWindow:8192}),8192);
});

test('real Pi wire budgets preserve explicit limits and default below a 32768-token provider cap', async () => {
 const { pathToFileURL } = require('node:url');
 const { streamSimple } = await import(pathToFileURL(path.resolve(__dirname,
  '../node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js')).href);
 const caps = require('../main/model-capability-contract.cjs');
 const errors = require('../main/pi-session/model-errors');
 for (const field of ['max_tokens', 'max_completion_tokens']) {
  for (const [saved, budget, stop] of [[{}, 16384, 'stop'], [{maxOutputTokens:32768}, 32768, 'stop'],
   [{maxOutputTokens:65536}, 65536, 'error']]) {
   const provider = piProvider({id:'fixture',baseUrl:'https://fixture.invalid/v1',contextWindow:131072,
    thinkingMode:'none',...caps.runtimeFields(saved),compatibility:{maxTokensField:field}});
   const model = {...provider.models[0],api:provider.api,provider:'soduwork',baseUrl:provider.baseUrl};
   let calls = 0;
   const result = await streamSimple(model, {messages:[{role:'user',content:'OK',timestamp:1}]}, {
    apiKey:'synthetic-fixture',maxRetries:0,timeoutMs:2000,env:{},
    fetch:async (_url, options) => {
     calls++;
     const body = JSON.parse(options.body);
     assert.equal(body[field], budget);
     assert.equal(body[field === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens'], undefined);
     if (budget > 32768) return new Response(JSON.stringify({error:{message:
      field + '=' + budget + ' cannot be greater than max_model_len=32768'}}),
      {status:400,headers:{'content-type':'application/json'}});
     const frame = {id:'fixture',object:'chat.completion.chunk',choices:[{
      index:0,delta:{role:'assistant',content:'OK'},finish_reason:'stop'}]};
     return new Response('data: ' + JSON.stringify(frame) + '\n\ndata: [DONE]\n\n',
      {headers:{'content-type':'text/event-stream'}});
    }
   }).result();
   assert.equal(model.contextWindow, 131072);
   assert.equal(result.stopReason, stop);
   assert.equal(calls, 1);
   if (stop === 'error') {
    assert.equal(errors.describe(result.errorMessage).code, 'output_token_limit_exceeded');
    assert.equal(errors.describe(result.errorMessage).retryable, false);
   }
  }
 }
 assert.equal(outputLimit({contextWindow:8192}),8192);
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

test('saved local native-image and thinking declarations reach Pi and Runner configuration', async t => {
 const store=require('../main/local-model-store.cjs');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-local-cap-runtime-'));
 const deps={app:{getPath:()=>root},safeStorage:{isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from(value),decryptString:value=>value.toString()}};
 store.configure(deps);t.after(()=>{store.configure(null);fs.rmSync(root,{recursive:true,force:true});});
 const saved=store.save({providers:[{id:'fixture',baseUrl:'http://127.0.0.1:1/v1',authMode:'none'}],models:[{
  providerId:'fixture',name:'gateway-alias',config:{thinkingMode:'always',thinkingFormat:'qwen',
   capabilities:{imageInput:'supported'},imageRouting:'auto'}}]});
 const got=await config.fetchModel(null,saved.usable[0].id,1000,()=>{throw Error('No network expected')},false,'pi',{allowLocal:true});
 assert.deepEqual(got.model.input,['text','image']);assert.equal(got.model.imageRouting,'native');
 assert.equal(got.model.reasoning,true);assert.equal(got.model.thinkingMode,'always');assert.equal(got.model.thinkingFormat,'qwen');
 const llm=require('../main/agent-runtime/runner-config.cjs').create(got.model,'qwen').llm;
 assert.deepEqual(llm.input,['text','image']);assert.equal(llm.thinkingMode,'always');
});

test('explicit local thinking disable is preserved despite a reasoning-family model name', async t => {
 const store=require('../main/local-model-store.cjs');
 t.mock.method(store,'resolve',()=>({id:'local:model-'+'1'.repeat(32),modelRef:'local:model-'+'1'.repeat(32),
  name:'qwen-local',baseUrl:'http://127.0.0.1:1/v1',key:'',localOnly:true,config:{thinkingMode:'none',thinkingFormat:'qwen'}}));
 const got=await config.fetchModel(null,'local:model-'+'1'.repeat(32),1000,()=>{throw Error('No network expected')},false,'pi',{allowLocal:true});
 assert.equal(got.model.reasoning,false);assert.equal(got.model.thinkingMode,'none');
});

test('verified stream compatibility is emitted in the registered Pi transport and Runner contract',()=>{
 const model={id:'alias',baseUrl:'http://127.0.0.1:1/v1',key:'fixture',compatibility:{maxTokensField:'max_tokens',streamOptions:false,toolChoice:'auto'}};
 assert.equal(piProvider(model).compat.supportsUsageInStreaming,false);
 assert.equal(piProvider(model).compat.maxTokensField,'max_tokens');
 assert.equal(require('../main/agent-runtime/runner-config.cjs').create(model,'qwen').llm.compatibility.streamOptions,false);
});

test('required unsupported combinations fail clearly while unknown capabilities and text-only chat remain usable',()=>{
 const base={id:'alias',baseUrl:'http://127.0.0.1:1/v1',key:'fixture'};
 assert.throws(()=>piProvider({...base,capabilityProfile:{streaming:{state:'unsupported'}}}),/流式/);
 assert.doesNotThrow(()=>piProvider({...base,capabilityProfile:{imageInput:{state:'unsupported'},streaming:{state:'unknown'}}}));
 const model={...base,capabilityProfile:{toolCalling:{state:'unsupported'}}};
 const runner=require('../main/agent-runtime/runner-config.cjs');
 assert.throws(()=>runner.create(model,'qwen',['browser']),/工具/);
 assert.doesNotThrow(()=>runner.create(model,'qwen',[]));
});

test('streaming Runner runtimes reject known unsupported streaming before launch',()=>{
 const runner=require('../main/agent-runtime/runner-config.cjs');
 const base={id:'alias',baseUrl:'http://127.0.0.1:1/v1',key:'fixture'};
 for(const runtime of ['pi']){
  assert.throws(()=>runner.create({...base,capabilityProfile:{streaming:{state:'unsupported'}}},runtime),/流式/);
  assert.doesNotThrow(()=>runner.create({...base,capabilityProfile:{streaming:{state:'unknown'}}},runtime));
 }
});

test('Pi preparation refuses a locally declared unsupported streaming route before requesting inference',async t=>{
 const store=require('../main/local-model-store.cjs');
 t.mock.method(store,'resolve',()=>({id:'local:model-'+'1'.repeat(32),modelRef:'local:model-'+'1'.repeat(32),
  name:'alias',baseUrl:'http://127.0.0.1:1/v1',key:'',localOnly:true,config:{capabilities:{streaming:'unsupported'}}}));
 const got=await config.fetchModel(null,'local:model-'+'1'.repeat(32),1000,()=>{throw Error('No network expected')},false,'pi',{allowLocal:true});
 assert.equal(got.ok,false);assert.match(got.reason,/流式/);
});
