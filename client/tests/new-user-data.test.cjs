const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');
const TaskSync = require('../core/task-sync');
const apiSource = fs.readFileSync(path.join(__dirname, '../api.js'), 'utf8');
const storeSource = fs.readFileSync(path.join(__dirname, '../core/store-lifecycle.js'), 'utf8') + '\n' +
  fs.readFileSync(path.join(__dirname, '../core/store.js'), 'utf8');
const hub = 'http://127.0.0.1:18989';
const oldKey = kind => ({tasks:'soduwork_work_tasks_v5',ops:'soduwork_work_task_ops_v1',shadow:'soduwork_work_task_shadow_v1'}[kind]) + '@' + encodeURIComponent(hub);
const op = {id:'old-pending-task',kind:'put',token:'old-operation',data:{title:'旧演示任务',status:'todo',origin:'local'}};

function fixture(seed = {}, initial = {clientId:'new-install',user:{id:'new-user'}}) {
  const values = seed instanceof Map ? seed : new Map(Object.entries(seed));
  const calls = [], timers = [], listeners = new Map();
  let identity = initial, tasks = [], pendingFetch = null;
  const ctx = {TaskSync, URL, URLSearchParams, console,
    localStorage:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)},
    User:{id:'legacy-browser-id'},navigator:{platform:'test'},
    CustomEvent:class{constructor(type,init){this.type=type;this.detail=init?.detail}},
    document:{getElementById:()=>null,querySelectorAll:()=>[],documentElement:{setAttribute(){}}},
    getComputedStyle:()=>({getPropertyValue:()=>''}),
    AbortController, FormData, WebSocket:class{},
    setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length},clearTimeout(){},setInterval(){},clearInterval(){},
    location:{reload(){}}, addEventListener:(name,fn)=>{const rows=listeners.get(name)||[];rows.push(fn);listeners.set(name,rows)},
    dispatchEvent:event=>{for(const fn of listeners.get(event.type)||[])fn(event)},
    soduWorkAPI:{deviceAuthBootstrap:async()=>({ok:true,stored:true,session:'test-session',expiresIn:1800,...identity})},
    fetch:async(url,options={})=>{
      const method=options.method||'GET'; calls.push({url,method,body:options.body});
      if(pendingFetch && url.endsWith('/tasks')) return pendingFetch;
      let result={};
      if(url.endsWith('/tasks')) result=tasks;
      if(method==='PUT') {result={id:url.split('/').pop(),...JSON.parse(options.body)};tasks.push(result);}
      return {ok:true,status:200,text:async()=>JSON.stringify(result)};
    }
  };
  ctx.window=ctx; vm.createContext(ctx);vm.runInContext(apiSource,ctx);vm.runInContext(storeSource,ctx);
  const api=ctx.SoduWorkAPI,store=vm.runInContext('Store',ctx);
  return {api,store,ctx,values,calls,timers,
    setIdentity:row=>{identity=row},setTasks:rows=>{tasks=rows},
    deferTasks:()=>new Promise(resolve=>{pendingFetch=new Promise(r=>resolve(rows=>r({ok:true,status:200,text:async()=>JSON.stringify(rows)})))}),
    start:async()=>{await api.registerClient();await store.init();await store._flushTaskOps();}
  };
}

test('全新设备启动不生成任务、不发送任何创建操作',async()=>{
  const f=fixture();await f.start();
  assert.equal(f.store.tasks.length,0);
  assert.equal(f.calls.filter(x=>x.method!=='GET').length,0);
});
test('新身份不重放旧版无归属创建队列，旧数据原样保留',async()=>{
  const saved=JSON.stringify([op]);
  const f=fixture({soduwork_work_task_ops_v1:saved,soduwork_work_tasks_v5:JSON.stringify([op.data])});
  await f.start();
  assert.equal(f.calls.filter(x=>x.method==='PUT').length,0);
  assert.equal(f.store.tasks.length,0);
  assert.equal(f.values.get('soduwork_work_task_ops_v1'),saved);
});
test('新设备不继承同 Hub 旧设备的待提交操作',async()=>{
  const saved=JSON.stringify([op]);
  const f=fixture({soduwork_work_hub_url:hub,[oldKey('ops')]:saved,[oldKey('shadow')]:JSON.stringify([{id:op.id,ownerClientId:'old-device',createdBy:'old-user'}])});
  await f.start();
  assert.equal(f.calls.filter(x=>x.method==='PUT').length,0);
  assert.equal(f.values.get(oldKey('ops')),saved);
});
test('缓存键包含服务器、设备和账号；切换身份后 Store 使用新键',async()=>{
  const f=fixture();await f.start();
  const key=f.api.taskStorageKey('ops');
  f.store._writeTaskOps([op]);
  f.setIdentity({clientId:'new-install',user:{id:'another-user'}});
  await f.api.registerClient();
  assert.notEqual(f.api.taskStorageKey('ops'),key);
  assert.equal(f.store._readTaskOps().length,0);
  assert.equal(JSON.parse(f.values.get(key)).length,1);
});
test('同一身份重开保留自己的待提交操作且只提交一次',async()=>{
  const f=fixture();await f.start();f.store._writeTaskOps([op]);
  const reopened=fixture(f.values);await reopened.start();await reopened.store._flushTaskOps();
  assert.equal(reopened.calls.filter(x=>x.method==='PUT').length,1);
});
test('服务端真实转办任务正常显示，不靠标题过滤用户数据',async()=>{
  const f=fixture();f.setTasks([{id:'assigned',title:'写周报',status:'todo',ownerClientId:'new-install'}]);await f.start();
  assert.equal(f.store.tasks.length,1);assert.equal(f.store.tasks[0].id,'assigned');
  assert.equal(f.calls.filter(x=>x.method==='PUT').length,0);
});
test('正式应用入口不再携带可调用的演示任务生成器',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../app/app.js'),'utf8');
  assert.doesNotMatch(source,/function sampleTasks\s*\(/);
});

test('账号切换清空已显示任务，晚到的旧账号读取不能回填',async()=>{
  const f=fixture();f.setTasks([{id:'previous',title:'旧账号任务'}]);await f.start();
  assert.equal(f.store.tasks.length,1);
  const release=await f.deferTasks();
  const pending=f.api.getTasksSnapshot();
  await new Promise(resolve=>setImmediate(resolve));
  f.setIdentity({clientId:'new-install',user:{id:'another-user'}});await f.api.registerClient();
  assert.equal(f.store.tasks.length,0);
  release([{id:'old-response'}]);
  const snapshot=await pending;
  assert.equal(snapshot.online,false);assert.equal(snapshot.items.length,0);
});
test('需求池迟到响应在切换身份后被丢弃，而不是显示旧需求',async()=>{
  const f=fixture();await f.start();const release=await f.deferTasks();
  const pending=f.store.refreshTasks();
  await new Promise(resolve=>setImmediate(resolve));
  f.setIdentity({clientId:'another-install',user:{id:'another-user'}});await f.api.registerClient();
  release([{id:'old-requirement',visibility:'organization'}]);
  await pending;
  assert.equal(f.store.tasks.length,0);
});
test('可由服务器确认归属的旧队列仍可恢复一次，不会反复执行',async()=>{
  const f=fixture({soduwork_work_hub_url:hub,[oldKey('ops')]:JSON.stringify([op])});
  f.setTasks([{id:op.id,title:'服务器已有任务',ownerClientId:'new-install',createdBy:'new-user'}]);
  await f.start();
  assert.equal(f.calls.filter(x=>x.method==='PUT').length,1);
  await f.store.refreshTasks();await f.store._flushTaskOps();
  assert.equal(f.calls.filter(x=>x.method==='PUT').length,1);
  assert.equal(JSON.parse(f.values.get(oldKey('ops'))).length,1);
});
test('任务写入经过认证刷新时，若账号变化则拒绝把旧操作交给新账号',async()=>{
  const f=fixture();await f.start();
  const oldScope=f.api.taskStorageKey('ops');
  f.setIdentity({clientId:'new-install',user:{id:'another-user'}});await f.api.registerClient();
  await assert.rejects(()=>f.api.putTask(op.id,op.data,oldScope),e=>e.code==='STALE_TASK_SCOPE');
  await assert.rejects(()=>f.api.patchTask(op.id,{title:'wrong'},oldScope),e=>e.code==='STALE_TASK_SCOPE');
  await assert.rejects(()=>f.api.deleteTask(op.id,oldScope),e=>e.code==='STALE_TASK_SCOPE');
  assert.equal(f.calls.filter(x=>x.method!=='GET').length,0);
});

test('设备变为待激活时清空上一位使用人的任务，不能沿用身份',async()=>{
  const f=fixture();f.setTasks([{id:'previous',title:'旧账号任务'}]);await f.start();
  f.setIdentity({clientId:'new-install',user:null,session:'',activationRequired:true});
  await f.api.registerClient();
  assert.equal(f.store.tasks.length,0);
  assert.equal(f.api.clientAuthSnapshot().user,null);
});
test('旧任务写入回包不会污染新账号，也不会再次使用新账号补写',async()=>{
  const f=fixture();await f.start();
  let release;const deferred=new Promise(resolve=>{release=resolve});
  const original=f.api.putTask;
  f.api.putTask=async()=>deferred;
  f.store.tasks.push({id:op.id,...op.data});
  const result=f.store.persistTask(op.id);
  await new Promise(resolve=>setImmediate(resolve));
  const oldKey=f.api.taskStorageKey('ops');
  f.setIdentity({clientId:'new-install',user:{id:'another-user'}});
  await f.api.registerClient();f.api.putTask=original;
  release({id:op.id,...op.data});
  assert.equal(await result,false);
  assert.equal(f.store.tasks.length,0);
  assert.equal(f.calls.filter(x=>x.method==='PUT').length,0);
  assert.equal(JSON.parse(f.values.get(oldKey)).length,1);
});


test('startup preserves queues from another Hub without replay even when IDs match server ownership', async () => {
  const oldHub = 'http://127.0.0.1:9080';
  const legacyOps = 'soduwork_work_task_ops_v1@' + encodeURIComponent(oldHub);
  const scopedOps = legacyOps + '@new-install@new-user';
  const saved = JSON.stringify([op]);
  const f = fixture({soduwork_work_hub_environment_v1:'development', soduwork_work_hub_url:oldHub,
    [legacyOps]:saved, [scopedOps]:saved});
  f.setTasks([{id:op.id,ownerClientId:'new-install',createdBy:'new-user'}]); await f.start();
  assert.equal(f.api.hubBase(), 'http://127.0.0.1:18989');
  assert.equal(f.calls.filter(row => row.method !== 'GET').length, 0);
  assert.equal(f.values.get(legacyOps), saved); assert.equal(f.values.get(scopedOps), saved);
});
