'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../components/panels/platform-connection-directory.js'),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
 let resolve,actions,changed=0,renders=0;const states=new Map(['wecom','dingtalk','feishu'].map(key=>[key,{label:{},button:{}}]));
 const pending=new Promise(done=>resolve=done);
 const window={soduWorkAPI:{platformConnections:{status:key=>key==='wecom'?pending:Promise.resolve({ok:true,provider:key,state:'needs_auth'})}},
  SoduWorkPlatformConnections:{openProvider(_key,_ctx,options){actions=options;}}};
 vm.runInNewContext(source,{window});
 const root={isConnected:true,set innerHTML(_html){renders++;},querySelector(selector){
  const key=selector.match(/="([^"]+)"/)?.[1],row=states.get(key);
  return selector.includes('manage')?row.button:{querySelector:selector=>selector==='button'?row.button:row.label};}};
 window.SoduWorkPlatformDirectory.render(root,{h:String,query:'',onConnectionChanged(){changed++;}});
 return {root,states,api:window.SoduWorkPlatformDirectory,resolve,open(){states.get('wecom').button.onclick();return actions;},get changed(){return changed;},get renders(){return renders;}};
}
test('a late initial status cannot revive a disconnected row or replace its DOM',async()=>{
 const f=fixture();await tick();const row=f.states.get('wecom');const actions=f.open();
 actions.onState({ok:true,provider:'wecom',state:'disconnected',connected:false,disconnected:true});
 f.resolve({ok:true,provider:'wecom',state:'connected',connected:true});await tick();
 assert.equal(row.label.textContent,'已断开');assert.equal(row.button.textContent,'重新连接');
 assert.equal(f.renders,1);assert.equal(f.changed,1);assert.equal(f.api.connectedCount({}),0);
});
test('retry completion and reconnect refresh the existing selection once per transition',async()=>{
 const f=fixture();const actions=f.open();const state={provider:'wecom',disconnected:true,connected:false};
 actions.onState({...state,state:'error'});actions.onState({...state,state:'error'});
 actions.onState({...state,state:'disconnected'});actions.onState({provider:'wecom',state:'connected',connected:true,disconnected:false});
 assert.equal(f.changed,3);assert.equal(f.api.connectedCount({}),1);assert.equal(f.renders,1);
 f.resolve({ok:true,provider:'wecom',state:'needs_auth'});await tick();assert.equal(f.api.connectedCount({}),1);
});
test('account reset rejects late dialog and directory status from the previous owner',async()=>{
 const f=fixture();const actions=f.open();f.api.reset();
 actions.onState({provider:'wecom',state:'connected',connected:true});
 f.resolve({ok:true,provider:'wecom',state:'connected',connected:true});await tick();
 assert.equal(f.api.connectedCount({}),0);assert.equal(f.changed,0);
});

test('initial authorization refreshes MCP rows when a connecting account becomes connected',async()=>{
 const f=fixture();const actions=f.open();
 actions.onState({provider:'wecom',state:'connecting',connected:false,disconnected:false});
 assert.equal(f.changed,0);
 actions.onState({provider:'wecom',state:'connected',connected:true,disconnected:false});
 actions.onState({provider:'wecom',state:'connected',connected:true,disconnected:false});
 assert.equal(f.changed,1);assert.equal(f.renders,1);
 f.resolve({ok:true,provider:'wecom',state:'needs_auth'});await tick();
 assert.equal(f.api.connectedCount({}),1);
});

test('restart keeps a disconnected cleanup error truthful and reconnectable',async()=>{
 const f=fixture();f.resolve({ok:false,provider:'wecom',state:'error',connected:false,disconnected:true});await tick();
 assert.equal(f.states.get('wecom').label.textContent,'需检查连接');
 assert.equal(f.states.get('wecom').button.textContent,'重新连接');
 assert.equal(f.api.connectedCount({}),0);
});

function dataFixture() {
 let clock=1000, handler=key=>Promise.resolve({ok:true,provider:key,state:'needs_setup',installed:false}),actions;
 const calls=[];
 const bridge={status(key){calls.push(key);return handler(key);},refresh(){throw Error('目录不能刷新授权');},connect(){throw Error('目录不能发起授权');}};
 const window={soduWorkAPI:{platformConnections:bridge},SoduWorkPlatformConnections:{openProvider(key,ctx,options){actions={key,ctx,...options};return actions;}}};
 vm.runInNewContext(source,{window,Date:{now:()=>clock}});
 return {api:window.SoduWorkPlatformDirectory,calls,setHandler(fn){handler=fn;},advance(n){clock+=n;},get actions(){return actions;}};
}
test('数据目录只读查询并缓存，连续加载单飞且显式重查可用',async()=>{
 const f=dataFixture();let done;const waiting=new Promise(resolve=>done=resolve);
 f.setHandler(async key=>{await waiting;return{ok:true,provider:key,state:'needs_setup'};});
 const a=f.api.load(),b=f.api.load();await tick();assert.equal(f.calls.length,3);
 done();await Promise.all([a,b]);await f.api.load();assert.equal(f.calls.length,3);
 await f.api.load({force:true});assert.equal(f.calls.length,6);
 f.advance(10001);await f.api.load();assert.equal(f.calls.length,9);
});
test('未配置平台留在添加目录，连接断开过期或未知不会丢失已有条目',async()=>{
 const f=dataFixture();assert.equal(f.api.entries().length,3);
 assert.equal(f.api.entries().every(row=>!row.added&&row.state==='unknown'),true);
 await f.api.load();assert.equal(f.api.entries().every(row=>!row.added),true);
 f.api.open('wecom',{});f.actions.onState({provider:'wecom',state:'connected',connected:true,account:'fixture-account'});
 for(const state of ['needs_auth','offline','unknown','needs_setup']){
  f.setHandler(key=>Promise.resolve({ok:true,provider:key,state:key==='wecom'?state:'needs_setup'}));
  await f.api.load({force:true});const row=f.api.entries().find(row=>row.key==='wecom');
  assert.equal(row.added,true);assert.equal(row.connected,false);assert.equal(row.state,state);
 }
 f.actions.onState({provider:'wecom',state:'disconnected',disconnected:true});
 const row=f.api.entries().find(row=>row.key==='wecom');assert.equal(row.added,true);assert.equal(row.account,'');
});
test('已有授权历史和断开记录首次加载仍保留，失败状态不伪装已连接',async()=>{
 const f=dataFixture();f.setHandler(key=>Promise.resolve(key==='wecom'?{ok:true,provider:key,state:'needs_auth',added:true}:
  key==='dingtalk'?{ok:false,provider:key,state:'error',disconnected:true}:{ok:false,provider:key,state:'connected',connected:true}));
 await f.api.load();const rows=f.api.entries();assert.equal(rows[0].added,true);assert.equal(rows[1].added,true);
 assert.equal(rows[2].connected,false);assert.equal(rows[2].state,'error');assert.equal(f.api.connectedCount({}),0);
});
test('订阅只通知变化，取消订阅生效，返回的行副本不可修改内部状态',async()=>{
 const f=dataFixture(),events=[];const stop=f.api.subscribe((rows,meta)=>events.push({rows,meta}));
 await f.api.load();assert.equal(events.length,3);
 await f.api.load({force:true});assert.equal(events.length,3);
 f.api.entries()[0].state='connected';assert.equal(f.api.entries()[0].state,'needs_setup');
 stop();f.api.open('wecom',{});f.actions.onState({provider:'wecom',state:'connected',connected:true});
 assert.equal(events.length,3);assert.equal(f.api.connectedCount({}),1);
});
test('账号重置后旧状态请求和授权弹窗都不能污染新的目录',async()=>{
 const f=dataFixture();let done;const waiting=new Promise(resolve=>done=resolve);
 f.setHandler(async key=>{await waiting;return{ok:true,provider:key,state:'connected',connected:true,account:'old-owner'};});
 const pending=f.api.load();await tick();f.api.open('wecom',{});const old=f.actions;
 f.api.reset();old.onState({provider:'wecom',state:'connected',connected:true});done();await pending;
 assert.equal(f.api.entries().every(row=>!row.added&&!row.connected&&!row.account),true);
 f.setHandler(key=>Promise.resolve({ok:true,provider:key,state:'needs_setup'}));await f.api.load();
 assert.equal(f.calls.length,6);assert.equal(f.api.entries().every(row=>row.state==='needs_setup'),true);
});
test('失效弹窗上下文不发布状态，飞书计数继续对个人注册去重',async()=>{
 const f=dataFixture();let active=true;f.api.open('feishu',{isCurrent:()=>active});
 f.actions.onState({provider:'feishu',state:'connected',connected:true});
 assert.equal(f.api.connectedCount({}),1);
 assert.equal(f.api.connectedCount({personal:[{id:'soduwork-feishu-fixture',enabled:true}]}),0);
 active=false;f.actions.onState({provider:'feishu',state:'disconnected',disconnected:true});
 assert.equal(f.api.entries().find(row=>row.key==='feishu').connected,true);
});

test('仅安装运行环境而从未授权的平台不计入我的连接',async()=>{
 const f=dataFixture();f.setHandler(key=>Promise.resolve({ok:true,provider:key,state:'needs_auth',installed:true,added:false}));
 await f.api.load();assert.equal(f.api.entries().every(row=>row.installed&&!row.added&&!row.connected),true);
 f.api.open('wecom',{});f.actions.onState({ok:true,provider:'wecom',state:'needs_auth',installed:true,added:false});
 assert.equal(f.api.entries().find(row=>row.key==='wecom').added,false);
 f.actions.onState({ok:true,provider:'wecom',state:'connecting',installed:true,added:true});
 assert.equal(f.api.entries().find(row=>row.key==='wecom').added,true);
});
