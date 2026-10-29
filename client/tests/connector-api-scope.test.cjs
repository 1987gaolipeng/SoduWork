'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('./renderer-source.cjs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../api.js'),'utf8');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const stale=e=>e.code==='STALE_TASK_SCOPE';
const file=()=>new File(['{"token":"private-fixture-secret"}'],'connection.json');
function harness(){
 let user='alice',now=Date.now();const values=new Map([['soduwork_work_hub_url','http://hub-a:8989']]),calls=[];
 const h={calls,fetch:async()=>new Response('{"ok":true}')};
 const bridge={deviceAuthBootstrap:async()=>({ok:true,stored:true,clientId:'device-1',user:{id:user},session:'session-'+user,expiresIn:1800})};
 const window={__SODUWORK_TEST_HUB_CONFIG__:{allowSwitch:true},soduWorkAPI:bridge,dispatchEvent(){}};
 vm.runInNewContext(source,{window,User:{id:'device-1',name:'Fixture'},navigator:{platform:'test'},
  localStorage:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)},
  fetch:async(url,options)=>{calls.push({url,options});return h.fetch(url,options)},
  Date:class extends Date{static now(){return now}},URL,URLSearchParams,FormData,Blob,File,Response,AbortController,CustomEvent:class{},console:{log(){},error(){}},
  setTimeout:()=>0,clearTimeout(){},setInterval:()=>0});
 h.api=window.SoduWorkAPI;h.bridge=bridge;h.advanceClock=ms=>{now+=ms};
 h.signIn=async next=>{user=next;await h.api.registerClient()};
 h.switch=async kind=>kind==='account'?h.signIn('bob'):h.api.setHubEnvironment('development','http://hub-b:8989');
 return h;
}
for(const kind of ['account','hub'])for(const operation of ['previewMyMcpImport','importMyMcp']){
 test(operation+' discards old '+kind+' response before retry or UI disclosure',async()=>{
  const h=harness(),wait=deferred();await h.signIn('alice');
  h.fetch=()=>wait.promise;const pending=h.api[operation](file());await tick();await h.switch(kind);
  wait.resolve(new Response('{"detail":"expired"}',{status:401}));await assert.rejects(pending,stale);
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].options.headers.Authorization,'Device session-alice');
 });
}
test('connector upload cannot retry original file with an account changed during authentication refresh',async()=>{
 const h=harness();await h.signIn('alice');
 h.fetch=async()=>new Response('{"detail":"expired"}',{status:401});
 h.bridge.deviceAuthBootstrap=async()=>({ok:true,stored:true,clientId:'device-1',user:{id:'bob'},session:'session-bob',expiresIn:1800});
 await assert.rejects(h.api.importMyMcp(file()),stale);assert.equal(h.calls.length,1);
});
test('unchanged connector upload may refresh authentication and retries exact original bytes',async()=>{
 const h=harness();await h.signIn('alice');
 h.fetch=async()=>h.calls.length===1?new Response('{"detail":"expired"}',{status:401}):new Response('{"ok":true}');
 assert.equal((await h.api.importMyMcp(file())).ok,true);assert.equal(h.calls.length,2);
 assert.equal(await h.calls[1].options.body.get('file').text(),await file().text());
});
test('connector credential mutations and probes refuse a different account discovered during bootstrap',async()=>{
 const operations=[a=>a.importMyMcp(file()),a=>a.previewMyMcpImport(file()),a=>a.saveMyMcpServer({id:'one'}),
  a=>a.shareMyMcp('one','company'),a=>a.probeMyMcpServer({headers:{Authorization:'private'}}),a=>a.preflightMyMcpServer({}),a=>a.probeCompanyMcp('one')];
 for(const operation of operations){const h=harness();await assert.rejects(operation(h.api),stale);assert.equal(h.calls.length,0);}
});

for(const next of ['alice','bob'])test('schedule creation fixes its account before authentication refresh: '+next,async()=>{
 const h=harness(),wait=deferred();await h.signIn('alice');h.advanceClock(31*60*1000);
 h.bridge.deviceAuthBootstrap=()=>wait.promise;
 const pending=h.api.createSchedule({title:'Synthetic schedule'});await tick();
 assert.equal(h.calls.length,0,'no write may precede completion of authentication');
 wait.resolve({ok:true,stored:true,clientId:'device-1',user:{id:next},session:'renewed-'+next,expiresIn:1800});
 if(next==='bob'){
  await assert.rejects(pending,stale);assert.equal(h.calls.length,0,'old input must never create a schedule in the new account');
 }else{
  assert.equal((await pending).ok,true);assert.equal(h.calls.length,1);
  assert.equal(h.calls[0].options.headers.Authorization,'Device renewed-alice');
  assert.deepEqual(JSON.parse(h.calls[0].options.body),{title:'Synthetic schedule'});
 }
});
