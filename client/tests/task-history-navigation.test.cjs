const test=require('node:test');
const assert=require('node:assert/strict');
const {createPiSessionBridge}=require('../main/agent-runtime/pi-session-bridge');
test('opening an archived conversation does not use the sidebar 50-item limit',async()=>{
 const module={probe:async()=>({ok:true}),open:async()=>({ok:false}),history:async()=>({ok:true,chats:[]}),historyEntry:async(_app,id)=>({ok:true,entry:{id,path:'verified.jsonl',cwd:'safe',title:'old chat'}})};
 const bridge=createPiSessionBridge({sessionModule:module,runnerAdapters:[]});
 const row=await bridge.archivedConversation({},'old-task-chat');
 assert.equal(row.id,'old-task-chat');assert.equal(row.adapterId,'pi');assert.equal(row.path,'verified.jsonl');
 await bridge.dispose();
});
test('missing archive stays missing rather than inventing a new conversation',async()=>{
 const bridge=createPiSessionBridge({sessionModule:{probe:async()=>({ok:true}),open:async()=>({ok:false}),historyEntry:async()=>({ok:false,notFound:true})},runnerAdapters:[]});
 assert.equal(await bridge.archivedConversation({},'missing'),null);await bridge.dispose();
});

test('an unreadable archive is a retriable error, never a missing task draft',async()=>{
 const bridge=createPiSessionBridge({sessionModule:{probe:async()=>({ok:true}),open:async()=>({ok:false}),historyEntry:async()=>({ok:false,reason:'archive permission denied'})},runnerAdapters:[]});
 try { await assert.rejects(bridge.archivedConversation({},'unreadable'),/archive permission denied/); }
 finally { await bridge.dispose(); }
});

test('Runner archive discovery is concurrent and one failing adapter does not block another',async()=>{
 const calls=[];let release;
 const blocked=new Promise(resolve=>release=resolve);
 const make=(id,history)=>({id,displayName:id,capabilities:[],detect:async()=>({ok:true}),createSession:async()=>{},history});
 const adapters=[
  make('runner-a',async()=>{calls.push('a');await blocked;throw Error('offline')}),
  make('runner-b',async()=>{calls.push('b');return{ok:true,chats:[{id:'runner-chat',adapterId:'runner-b',path:'verified-runner-ref'}]}}),
 ];
 const bridge=createPiSessionBridge({sessionModule:{open:async()=>({ok:false}),probe:async()=>({ok:true}),historyEntry:async()=>({ok:false,notFound:true})},runnerAdapters:adapters});
 try{
  const opening=bridge.archivedConversation({},'runner-chat');
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,['a','b']);
  release();
  const result=await opening;
  assert.equal(result.adapterId,'runner-b');assert.equal(result.path,'verified-runner-ref');
 }finally{release();await bridge.dispose()}
});
