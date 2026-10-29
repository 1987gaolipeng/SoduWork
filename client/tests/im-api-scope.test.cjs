'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('./renderer-source.cjs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../api.js'),'utf8');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
function harness(){
 let user='alice';const values=new Map([['soduwork_work_hub_url','http://hub-a:8989']]),calls=[];
 const h={calls,fetch:async()=>new Response('{"ok":true}')};
 const bridge={deviceAuthBootstrap:async()=>({ok:true,stored:true,clientId:'device-1',user:{id:user},session:'session-'+user,expiresIn:1800})};
 const window={__SODUWORK_TEST_HUB_CONFIG__:{allowSwitch:true},soduWorkAPI:bridge,dispatchEvent(){}};
 vm.runInNewContext(source,{window,User:{id:'device-1',name:'Fixture'},navigator:{platform:'test'},
  localStorage:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)},
  fetch:async(url,options)=>{calls.push({url,options});return h.fetch(url,options);},
  URL,URLSearchParams,FormData,Blob,File,Response,AbortController,CustomEvent:class{},console:{log(){},error(){}},
  setTimeout:()=>0,clearTimeout(){},setInterval:()=>0});
 h.api=window.SoduWorkAPI; h.signIn=async next=>{user=next;await h.api.registerClient();};
 return h;
}
const operations=[(a,o)=>a.im.catalog(o),(a,o)=>a.im.create({credentials:{bot_token:'fixture-secret'}},o),
 (a,o)=>a.im.connect('one',o),(a,o)=>a.im.revoke('one',o),(a,o)=>a.im.targets('one',o),
 (a,o)=>a.im.pair('one',{taskId:'task',runnerId:'desktop',allowStart:false},o),(a,o)=>a.im.bindings('one',o),
 (a,o)=>a.im.unbind('one',o),(a,o)=>a.im.messages('one',o),(a,o)=>a.im.dismiss('one',o)];
test('IM setup and reads reject stale account scope before issuing requests',async()=>{
 for(const operation of operations){const h=harness();await h.signIn('alice');const taskScope=h.api.taskStorageKey('ops');
  await h.signIn('bob');await assert.rejects(operation(h.api,{taskScope}),e=>e.code==='STALE_TASK_SCOPE');assert.equal(h.calls.length,0);}
});
test('an account change cannot disclose a pairing or replay credentials after expired auth',async()=>{
 for(const operation of operations){const h=harness(),wait=deferred();await h.signIn('alice');
  h.fetch=()=>wait.promise;const pending=operation(h.api,{taskScope:h.api.taskStorageKey('ops')});
  await new Promise(r=>setImmediate(r));await h.signIn('bob');wait.resolve(new Response('{"detail":"expired","code":"private-pairing"}',{status:401}));
  await assert.rejects(pending,e=>e.code==='STALE_TASK_SCOPE');assert.equal(h.calls.length,1);}
});
test('ambiguous IM mutations are sent once and cannot follow credential redirects',async()=>{
 for(const operation of [operations[1],operations[2],operations[5],operations[9]]){
  const h=harness();await h.signIn('alice');h.fetch=async()=>{throw new TypeError('network unavailable');};
  await assert.rejects(operation(h.api,{taskScope:h.api.taskStorageKey('ops')}));assert.equal(h.calls.length,1);
  assert.equal(h.calls[0].options.redirect,'error');assert.equal(h.calls[0].options.headers.Authorization,'Device session-alice');
 }
});
