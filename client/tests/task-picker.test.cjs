'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../components/panels/chat-task-controller.js'), 'utf8');
function harness(rows = [], api = {}) {
  const sent = [], bindings = [];
  const window = { SoduWorkAPI: { getTasksSnapshot: async () => ({online:true,items:rows}),
    getTask: async id => rows.find(t => t.id === id), ...api } };
  window.RequirementSessionContext = require('../core/requirement-session-context');
  vm.runInNewContext(source, {window, SoduWorkAPI:window.SoduWorkAPI, get ChatChrome(){return window.ChatChrome},
    get WorkspaceShell(){return window.WorkspaceShell}, document:{getElementById:()=>null}, setTimeout:()=>1});
  const ctx = {_collabTasks:new Map(),_collabStarts:new Set(),_collabPicker:{open:false,tasks:[]},
    _sessionId:'conversation-a',_ref:'session-a',_viewEpoch:1,_taskOpenSeq:0,_sessionOptions:{adapterId:'pi'},
    _snap:{status:'idle',messages:[]},_collabPollTimer:1,_render:()=>{},_ensure:async()=>true,
    _api:()=>({bindTask:async(ref,id)=>{bindings.push({ref,id});return{ok:true}}}),
    _send:async(text,options)=>{sent.push({text,options});return true},refreshHistory:()=>{}};
  return {ctx, window, controller:window.ChatTaskController.create(ctx), eligible:window.ChatTaskController.isPickableTask,sent,bindings};
}
test('picker only accepts explicit todo, never unknown, active, held or completed tasks',()=>{
  const {eligible}=harness();
  assert.equal(eligible({id:'t',status:'todo'}),true);
  for(const status of ['',null,undefined,'pending','doing','running','done','cancel','waiting','failed','blocked']){
    assert.equal(eligible({id:'t',status}),false,String(status));
  }
});
test('queued, waiting and delivered receipts override stale todo status',()=>{
  const {eligible}=harness();
  for(const state of ['queued','running','waiting','completed','unknown'])
    assert.equal(eligible({id:'t',status:'todo',workRouting:{conversationTurn:{state}}}),false,state);
  for(const state of ['running','dispatching','done','waiting_human'])
    assert.equal(eligible({id:'t',status:'todo',ai:{state}}),false,state);
  assert.equal(eligible({id:'t',status:'todo',ai:{state:'failed'}}),true);
});
test('picker filters duplicate/bound tasks and keeps more than twenty pending tasks',async()=>{
  const rows=Array.from({length:31},(_,i)=>({id:String(i),status:'todo',title:'Task '+i}));
  rows.push({...rows[0]},{id:'run',status:'doing'});
  const {ctx,controller}=harness(rows);
  ctx._collabTasks.set('0',{taskId:'0',task:rows[0],queueState:'queued'});
  await controller._openTaskPicker();
  assert.equal(ctx._collabPicker.tasks.length,30);
  assert.equal(ctx._collabPicker.tasks.some(t=>t.id==='0'||t.id==='run'),false);
  assert.equal(ctx._collabPicker.tasks.at(-1).id,'30');
});
test('offline list is a recoverable error, not a false empty state',async()=>{
  const {ctx,controller}=harness([],{getTasksSnapshot:async()=>({online:false,items:[]})});
  await controller._openTaskPicker();
  assert.match(ctx._collabPicker.error,/重试/);
  assert.equal(ctx._collabPicker.loading,false);
});

test('starter close returns only once and a task-list retry retains its return callback', async () => {
  let closes = 0, reads = 0;
  const { controller } = harness([], { getTasksSnapshot: async () => {
    if (++reads === 1) throw Error('offline');
    return { online: true, items: [] };
  } });
  await controller._openTaskPicker({ onClose: () => closes++ });
  await controller._openTaskPicker();
  controller._collabAction('picker-close');
  controller._collabAction('picker-close');
  assert.equal(closes, 1);
});

test('repeated opens retain one pending list request and the loaded picker',async()=>{
  let resolveTasks,calls=0,renders=0;
  const {ctx,controller}=harness([],{getTasksSnapshot:()=>{
    calls++;return new Promise(resolve=>{resolveTasks=resolve});
  }});
  ctx._render=()=>renders++;
  const pending=controller._openTaskPicker(),request=ctx._collabPicker;
  await controller._openTaskPicker();await controller._openTaskPicker();
  assert.equal(calls,1);assert.equal(renders,1);assert.equal(ctx._collabPicker,request);
  assert.equal(request.loading,true);
  resolveTasks({online:true,items:[{id:'a',status:'todo'}]});await pending;
  await controller._openTaskPicker();
  assert.equal(calls,1);assert.equal(renders,2);assert.equal(ctx._collabPicker,request);
  assert.equal(request.loading,false);assert.equal(request.tasks[0].id,'a');
});

test('late list results cannot reopen a closed picker or replace a newer request',async()=>{
  for(const reopen of [false,true]){
    const requests=[];let renders=0;
    const {ctx,controller}=harness([],{getTasksSnapshot:()=>new Promise(resolve=>requests.push(resolve))});
    ctx._render=()=>renders++;
    const oldPending=controller._openTaskPicker();
    controller._collabAction('picker-close');
    const newPending=reopen?controller._openTaskPicker():null;
    const current=ctx._collabPicker,beforeLateResult=renders;
    requests[0]({online:true,items:[{id:'old',status:'todo'}]});await oldPending;
    assert.equal(ctx._collabPicker,current);assert.equal(renders,beforeLateResult);
    assert.equal(current.open,reopen);assert.equal(current.tasks.length,0);
    if(reopen){
      assert.equal(current.loading,true);
      requests[1]({online:true,items:[{id:'new',status:'todo'}]});await newPending;
      assert.equal(current.loading,false);assert.equal(current.tasks[0].id,'new');
    }
  }
});

test('a list error allows one retry and clears the error when the retry succeeds',async()=>{
  let calls=0,resolveRetry;
  const {ctx,controller}=harness([],{getTasksSnapshot:()=>{
    if(++calls===1)throw Error('offline');
    return new Promise(resolve=>{resolveRetry=resolve});
  }});
  await controller._openTaskPicker();
  const failed=ctx._collabPicker;
  assert.match(failed.error,/重试/);assert.equal(failed.loading,false);
  const pending=controller._openTaskPicker(),retry=ctx._collabPicker;
  assert.notEqual(retry,failed);assert.equal(retry.loading,true);assert.ok(!retry.error);
  await controller._openTaskPicker();assert.equal(calls,2);assert.equal(ctx._collabPicker,retry);
  resolveRetry({online:true,items:[{id:'recovered',status:'todo'}]});await pending;
  assert.equal(retry.loading,false);assert.ok(!retry.error);assert.equal(retry.tasks[0].id,'recovered');
});
test('status change after opening blocks attachment and submission',async()=>{
  const {ctx,controller,sent,bindings}=harness([{id:'t',status:'todo'}],{getTask:async()=>({id:'t',status:'doing'})});
  await controller._openTaskPicker();
  assert.equal(await controller._collabAction('select-task',{taskId:'t'}),false);
  assert.equal(sent.length,0);assert.equal(bindings.length,0);
  assert.equal(ctx._collabPicker.tasks.length,0);assert.match(ctx._collabPicker.error,/不再是/);
});
test('unknown task id cannot bypass the picker',async()=>{
  const {controller,sent}=harness([{id:'t',status:'todo'}]);
  await controller._openTaskPicker();
  assert.equal(await controller._collabAction('select-task',{taskId:'injected'}),false);
  assert.equal(sent.length,0);
});
test('double confirmation sends once and retains fresh materials in this conversation',async()=>{
  let resolve;
  const original={id:'t',title:'Task',status:'todo',note:'old'};
  const {ctx,controller,sent}=harness([original],{getTask:()=>new Promise(r=>resolve=r)});
  await controller._openTaskPicker();
  const first=controller._collabAction('select-task',{taskId:'t'});
  assert.equal(await controller._collabAction('select-task',{taskId:'t'}),false);
  const fresh={...original,note:'complete updated requirements',attachments:[{id:'image-1',name:'截图.png'}]};
  resolve(fresh);
  assert.equal(await first,true);
  assert.equal(sent.length,1);assert.equal(sent[0].text,fresh.note);
  assert.equal(sent[0].options.taskId,'t');assert.equal(ctx._sessionId,'conversation-a');
  assert.equal(ctx._collabTasks.get('t').task.attachments[0].id,'image-1');
});
test('closing during validation cancels the send',async()=>{
  let resolve;const {ctx,controller,sent}=harness([{id:'t',status:'todo'}],{getTask:()=>new Promise(r=>resolve=r)});
  await controller._openTaskPicker();const pending=controller._collabAction('select-task',{taskId:'t'});
  controller._collabAction('picker-close');
  await controller._openTaskPicker();assert.equal(ctx._collabPicker.open,true);
  resolve({id:'t',status:'todo'});
  assert.equal(await pending,false);assert.equal(sent.length,0);assert.equal(ctx._collabTasks.size,0);
});
test('switching conversations discards late validation',async()=>{
  let resolve;const {ctx,controller,sent}=harness([{id:'t',status:'todo'}],{getTask:()=>new Promise(r=>resolve=r)});
  await controller._openTaskPicker();const pending=controller._collabAction('select-task',{taskId:'t'});
  ctx._sessionId='conversation-b';ctx._viewEpoch++;resolve({id:'t',status:'todo'});
  assert.equal(await pending,false);assert.equal(sent.length,0);
});
test('validation error preserves selection and allows retry',async()=>{
  let fail=true;const task={id:'t',title:'Task',status:'todo'};
  const {ctx,controller,sent}=harness([task],{getTask:async()=>{if(fail)throw Error('offline');return task}});
  await controller._openTaskPicker();await controller._collabAction('select-task',{taskId:'t'});
  assert.equal(ctx._collabPicker.submitting,false);assert.equal(ctx._collabPicker.tasks[0].id,'t');
  assert.match(ctx._collabPicker.error,/最新状态/);assert.equal(sent.length,0);
  fail=false;assert.equal(await controller._collabAction('select-task',{taskId:'t'}),true);assert.equal(sent.length,1);
});
test('viewing an already bound running task remains available',()=>{
  const {ctx,controller}=harness();
  ctx._collabTasks.set('r',{taskId:'r',task:{id:'r',title:'Running',status:'doing'},queueState:'running'});
  controller._selectCollabTask('r');
  assert.equal(ctx._activeCollabTaskId,'r');
});

test('a removed pending task can be requeued with the existing retry contract',async()=>{
  const task={id:'t',title:'Requeue',status:'todo',workRouting:{conversationTurn:{state:'cancelled'}}};
  const {ctx,controller,sent}=harness([task]);
  ctx._collabTasks.set('t',{taskId:'t',task,queueRemoved:true,nativeTurn:true,queueState:'cancelled'});
  await controller._openTaskPicker();
  assert.equal(ctx._collabPicker.tasks.length,1);
  assert.equal(await controller._collabAction('select-task',{taskId:'t'}),true);
  assert.equal(sent.length,1);assert.equal(sent[0].options.retry,true);
  assert.equal(ctx._collabTasks.get('t').queueRemoved,false);
});

test('two project requirements preserve native conversation, model, directory and distinct turn ids',async()=>{
  const rows=['a','b'].map(id=>({id,title:id,status:'todo',projectId:'p',repoId:'repo'}));
  const {ctx,controller,sent,bindings}=harness(rows);
  Object.assign(ctx._sessionOptions,{projectId:'p',repoId:'repo',cwd:'D:/work',modelName:'chosen'});
  ctx._workModel=()=> 'chosen';
  for(const row of rows){
    await controller._openTaskPicker();
    assert.equal(ctx._collabPicker.scope,'related');
    assert.equal(await controller._collabAction('select-task',{taskId:row.id}),true);
  }
  assert.deepEqual(sent.map(row=>row.options.taskId),['a','b']);
  assert.ok(sent.every(row=>row.options.taskExecution.reuseConversation===true));
  assert.equal(ctx._sessionId,'conversation-a');assert.equal(ctx._ref,'session-a');
  assert.equal(ctx._sessionOptions.cwd,'D:/work');assert.equal(ctx._sessionOptions.modelName,'chosen');
  assert.ok(bindings.every(row=>row.ref==='session-a'));
});

test('project/repository or executor changes after loading cannot attach or send',async()=>{
  for(const changed of [{projectId:'other'},{repoId:'other'},{executionContext:{agent:{id:'local:qwen'}}},{executionContext:{model:'different'}}]){
    const task={id:'a',title:'A',status:'todo',projectId:'p',repoId:'repo'};
    const {ctx,controller,sent,bindings}=harness([task],{getTask:async()=>({...task,...changed})});
    Object.assign(ctx._sessionOptions,{projectId:'p',repoId:'repo',modelName:'chosen'});
    await controller._openTaskPicker();
    assert.equal(await controller._collabAction('select-task',{taskId:'a'}),false);
    assert.equal(sent.length,0);assert.equal(bindings.length,0);
    assert.equal(ctx._sessionOptions.projectId,'p');assert.equal(ctx._collabPicker.open,true);
    assert.ok(ctx._collabPicker.error);
  }
});

test('failed delivery remains selected and retryable without a duplicate successful send',async()=>{
  const task={id:'a',title:'A',status:'todo'};
  const {ctx,controller}=harness([task]);let attempts=0;
  ctx._send=async()=>++attempts>1;
  await controller._openTaskPicker();
  assert.equal(await controller._collabAction('select-task',{taskId:'a'}),false);
  assert.equal(ctx._collabPicker.open,true);assert.equal(ctx._collabPicker.submitting,false);
  assert.equal(await controller._collabAction('select-task',{taskId:'a'}),true);
  assert.equal(attempts,2);assert.equal(ctx._collabPicker.open,false);
});

test('selecting the first requirement can establish an empty conversation and send once',async()=>{
  const {ctx,controller,sent}=harness([{id:'first',title:'First request',status:'todo'}]);
  ctx._ref='';ctx._sessionId='';
  ctx._ensure=async()=>{ctx._ref='new-ref';ctx._sessionId='new-chat';return true};
  await controller._openTaskPicker();
  assert.equal(await controller._collabAction('select-task',{taskId:'first'}),true);
  assert.equal(sent.length,1);assert.equal(ctx._sessionId,'new-chat');
});

test('switching chat or account during connection/binding never sends or mutates the new view',async()=>{
  for(const waitAt of ['ensure','bind']) for(const change of ['chat','account']) {
    const task={id:'a',title:'A',status:'todo',projectId:'p',repoId:'repo'};
    let release, waiting, owner='owner-a';
    const entered=new Promise(resolve=>waiting=resolve);
    const delayed=()=>{waiting();return new Promise(resolve=>release=resolve)};
    const {ctx,controller,sent}=harness([task],{taskStorageKey:()=>owner});
    ctx._sessionOptions.projectId='p';
    if(waitAt==='ensure') ctx._ensure=delayed;
    else ctx._api=()=>({bindTask:delayed});
    const pending=controller._startTask(task,{taskExecution:{reuseConversation:true}});
    await entered;
    if(change==='chat') {ctx._viewEpoch++;ctx._ref='other-ref';ctx._sessionId='other-chat';}
    else owner='owner-b';
    ctx._collabTasks.clear();ctx._collabStarts.clear();ctx._taskOpenError='new-view';
    release(waitAt==='ensure'?true:{ok:true});
    assert.equal(await pending,false,waitAt+'/'+change);
    assert.equal(sent.length,0);assert.equal(ctx._collabTasks.size,0);
    assert.equal(ctx._taskOpenError,'new-view');
  }
});

test('late assignment lookup and binding cannot pull the user back into the previous chat',async()=>{
  for(const waitAt of ['lookup','binding']) {
    const task={id:'a',title:'A',status:'todo',projectId:'p'};
    let release,waiting;const entered=new Promise(resolve=>waiting=resolve);
    const delay=()=>{waiting();return new Promise(resolve=>release=resolve)};
    const {ctx,controller,sent}=harness([task],waitAt==='lookup'?{getTask:delay}:{});
    ctx.sessionInfo=()=>({adapterId:'pi',projectId:'p'});
    ctx._sessionOptions.projectId='p';
    if(waitAt==='binding')ctx._api=()=>({bindTask:delay});
    const pending=controller.enqueueTask('a',{reuseConversation:true,chatId:'conversation-a'});
    await entered;ctx._viewEpoch++;ctx._sessionId='other-chat';ctx._ref='other-ref';
    ctx._taskOpenPending=false;ctx._taskOpenError='new-view';
    release(waitAt==='lookup'?task:{ok:true});
    assert.equal((await pending).ok,false);assert.equal(sent.length,0);
    assert.equal(ctx._sessionId,'other-chat');assert.equal(ctx._collabTasks.size,0);
    assert.equal(ctx._taskOpenError,'new-view');
  }
});

test('requirement retry retains reuse policy for a project repository',async()=>{
  const task={id:'a',title:'A',status:'todo',projectId:'p',repoId:'repo'};
  const {ctx,controller}=harness([task]);const options=[];
  ctx._send=async(_text,opts)=>{options.push(opts);return options.length>1};
  assert.equal(await controller._startTask(task,{taskExecution:{reuseConversation:true}}),false);
  assert.equal(await controller._startTask(task,{retry:true}),true);
  assert.equal(options[1].retry,true);assert.equal(options[1].taskExecution.reuseConversation,true);
  assert.equal(ctx._ref,'session-a');
});

test('adding the next requirement preserves the existing long chat name',()=>{
  const {window,controller}=harness();const headers=[],history=[];
  window.ChatChrome={sessionTitle:'Project discussion',resume:title=>headers.push(title)};
  window.WorkspaceShell={upsertChat:row=>history.push(row)};
  for(const id of ['first','second'])controller._bindCollaborationTask(id,id,{persist:false,taskMeta:{id,status:'todo'}});
  assert.deepEqual(headers,['Project discussion']);
  assert.ok(history.every(row=>row.title==='Project discussion'));
  assert.deepEqual(Array.from(history.at(-1).taskIds),['first','second']);
});

test('starter configuration validation runs before claiming ownership or mounting a chat',async()=>{
  const task={id:'a',title:'Assigned requirement',status:'todo',readOnly:true,canClaimExecution:true};
  let claims=0,mounts=0,checks=0;
  const {controller,sent}=harness([task],{prepareRequirementExecution:async()=>{claims++;return {...task,readOnly:false};}});
  await controller._openTaskPicker({render:()=>{},canConfirm:current=>{checks++;assert.equal(current(),true);return false;},
    onConfirm:()=>{mounts++;return true;}});
  assert.equal(await controller._collabAction('select-task',{taskId:'a'}),false);
  assert.equal(checks,1);assert.equal(claims,0);assert.equal(mounts,0);assert.equal(sent.length,0);
});
