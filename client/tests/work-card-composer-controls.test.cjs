'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const tick = () => new Promise(resolve => setImmediate(resolve));
test('ordinary send waits for work selection persistence and rejects failed or stale saves', async()=>{
  const f=fixture(); let done;
  f.ctx._workCards={ensureDraftSelectionSaved:()=>new Promise(resolve=>{done=resolve;})};
  let finished=false;const pending=f.controls.ready().then(value=>{finished=true;return value;});
  await tick();assert.equal(finished,false);done(false);assert.equal(await pending,false);
  const stale=f.controls.ready();await tick();f.ctx._viewEpoch++;f.ctx._sessionId='other';done(true);
  assert.equal(await stale,false);
});
function fixture() {
  const calls = [], support = {schema:'soduwork.access-policy/v1', supported:true, modes:['standard','readonly','full']};let changed;
  const ctx = {_ref:'', _sessionId:'work-a', _viewEpoch:1, _snap:{workOnly:true}, _sessionOptions:{}, _paintBar(){}, _render(){}};
  const api = {runtimes:async()=>({ok:true,runtimes:[{id:'pi',displayName:'Pi',accessControl:support}, {id:'qwen',displayName:'Qwen',accessControl:support}]}),
    confirmNewChatAccess:async input=>{calls.push(['consent',input]);return {ok:true,consentId:'confirmed'};},
    revokeNewChatAccess:async input=>{calls.push(['revoke',input]);return {ok:true};}};
  ctx._api = () => api;
  const g = {window:null, crypto:require('node:crypto').webcrypto, console, setTimeout, clearTimeout,
    soduWorkAPI:{conversationSession:api,accessPreferences:{get:async()=>({ok:true,mode:'readonly'}),onChange:fn=>{changed=fn;return ()=>{};}}}, petSay:x=>calls.push(['say',x])};
  g.window=g;vm.createContext(g);
  for(const name of ['compose-surface','chat-composer-bindings']) vm.runInContext(fs.readFileSync(path.join(__dirname,'../components/panels/'+name+'.js'),'utf8'),g);
  return {ctx,api,calls,g,support,change:value=>changed(value),controls:g.ChatComposerBindings.createDraftControls(ctx)};
}
test('仅表单会话的控件继承系统权限，无需打开执行底座', async()=>{
  const f=fixture();assert.equal(f.controls.state().draftOnly,true);await tick();
  assert.equal(f.controls.state().accessPolicy.mode,'readonly');
  assert.equal(f.controls.state().accessControl.supported,true);
  assert.equal(f.controls.state().draftId,'work-a');
  assert.equal(f.calls.length,0);
});
test('草稿 Agent/模型选择只返回同一会话的选项，完全访问沿用一次性确认', async()=>{
  const f=fixture();await f.controls.runtimes();f.controls.state();await tick();
  const agent=f.controls.selectRuntime('pi');assert.equal(agent.ok,true);assert.equal(agent.snapshot.workOnly,true);
  assert.equal(agent.adapterId,'pi');assert.equal(f.ctx._sessionId,'work-a');
  const model=f.controls.selectModel('chosen','所选模型');assert.equal(model.selection.name,'chosen');
  assert.equal(await f.controls.chooseAccess('full','pi',{}),true);
  assert.equal(f.ctx._sessionOptions.accessMode,'full');assert.equal(f.ctx._sessionOptions.accessConsentId,'confirmed');
  assert.equal(f.calls.filter(x=>x[0]==='consent').length,1);
  await f.controls.chooseAccess('standard','pi',{});await tick();
  assert.equal(f.ctx._sessionOptions.accessMode,'standard');assert.equal(f.ctx._sessionOptions.accessConsentId,undefined);
});
test('已运行会话不提供草稿选择，切走时迟到确认不能改新页面', async()=>{
  const f=fixture();f.controls.state();await tick();let done;
  f.api.confirmNewChatAccess=()=>new Promise(resolve=>{done=resolve;});
  const choice=f.controls.chooseAccess('full','pi',{});await tick();
  f.ctx._viewEpoch++;f.controls.destroy();f.ctx._sessionOptions={};
  done({ok:true,consentId:'stale'});assert.equal(await choice,false);
  assert.deepEqual(f.ctx._sessionOptions,{});
  f.ctx._ref='running';assert.equal(f.controls.active(),false);assert.deepEqual({...f.controls.state()},{});
});

test('空白页已绑定控件后进入表单历史，复用 DOM 仍能选择执行选项', async()=>{
  const f=fixture();f.ctx._sessionId='';f.ctx._snap=null;
  assert.equal(f.controls.active(),true);
  const initialDraftId = f.controls.state().draftId;
  await f.controls.runtimes(); await tick();
  assert.equal(f.controls.selectModel('preselected','预选模型').selection.name,'preselected');
  f.ctx._viewEpoch++;
  assert.notEqual(f.controls.state().draftId,initialDraftId,'new blank views cannot reuse an old picker identity');
  f.ctx._viewEpoch++;f.ctx._sessionId='history-work';f.ctx._snap={workOnly:true};
  assert.equal(f.controls.state().draftOnly,true);await tick();
  assert.equal(f.controls.selectRuntime('pi').ok,true);
  assert.equal(f.controls.state().accessPolicy.mode,'readonly');
});

test('已有存档但尚未恢复运行状态时不能当作空白草稿接管选择',()=>{
  const f=fixture();f.ctx._snap=null;
  assert.equal(f.controls.active(),false);
  assert.equal(f.controls.selectModel('wrong','错误选择').ok,false);
  f.ctx._snap={workOnly:false};assert.equal(f.controls.active(),false);
  f.ctx._snap={workOnly:true};assert.equal(f.controls.active(),true);
  f.ctx._ref='live';assert.equal(f.controls.active(),false);
});

test('复用控件切到另一表单时，旧权限确认不能污染新表单或阻塞发送', async()=>{
  const f=fixture();f.controls.state();await tick();let done;
  f.api.confirmNewChatAccess=()=>new Promise(resolve=>{done=resolve;});
  const choice=f.controls.chooseAccess('full','pi',{});await tick();
  f.ctx._viewEpoch++;f.ctx._sessionId='work-b';f.ctx._sessionOptions={};f.controls.state();
  assert.equal(await Promise.race([f.controls.ready(),tick().then(()=>false)]),true);
  done({ok:true,consentId:'stale'});assert.equal(await choice,false);
  assert.deepEqual(f.ctx._sessionOptions,{});
});

test('系统默认权限超出 Agent 能力时不显示未实际生效的权限', async()=>{
  const f=fixture();f.support.modes=['standard'];f.controls.state();await tick();
  assert.equal(f.controls.state().accessPolicy,null);
});

test('迟到偏好读取不能覆盖更新，显式权限始终优先', async()=>{
  const f=fixture();let done;f.g.soduWorkAPI.accessPreferences.get=()=>new Promise(resolve=>{done=resolve;});
  f.controls.state();await tick();f.change({mode:'full'});done({ok:true,mode:'readonly'});await tick();
  assert.equal(f.controls.state().accessPolicy.mode,'full');
  await f.controls.chooseAccess('standard','pi',{});f.change({mode:'readonly'});
  assert.equal(f.controls.state().accessPolicy.mode,'standard');
});
