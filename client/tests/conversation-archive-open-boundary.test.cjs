'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../components/panels/chat-session-controller.js'),'utf8');
const deferred=()=>{let resolve,reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail;});return{promise,resolve,reject};};
const tick=()=>new Promise(setImmediate);
const opened=id=>({ok:true,ref:'ref-'+id,sessionId:id,adapterId:'qwen',model:{id:'review-model'},
  snapshot:{status:'idle',messages:[{role:'assistant',text:id+' saved history',done:true}],tools:[]}});
function fixture(open,options={}){
  let owner='account-a';const opens=[],sends=[],released=[],failures=[],input={value:'Retained review draft',style:{}};
  const native={open:async value=>{opens.push({...value});return open(value,opens.length);},
    release:async ref=>{released.push(ref);return{ok:true};},send:async(...args)=>{sends.push(args);return{ok:true};},
    onEvent:()=>()=>{},bindTask:async()=>({ok:true})};
  const window={SoduWorkAPI:{taskStorageKey:()=>owner}};
  const ctx={_viewEpoch:1,_draftScopeEpoch:0,_sessionId:'',_ref:'',_draftKey:'new',_sessionOptions:{},_snap:null,
    _openingTask:null,_openingEpoch:-1,_busy:false,OPEN_TIMEOUT_MS:options.timeout||1000,
    _collabTasks:new Map(),_collabStarts:new Set(),_collabPicker:{},_collabPollTimer:1,_taskOpenSeq:0,
    _activeCollabTaskId:'',_collaborationTaskId:'',_draftOwnerScope:()=>owner,_api:()=>native,
    _mount:()=>({querySelector:()=>input}),_render(){},_paintBar(){},_pullOuts(){},refreshHistory(){},
    _rememberConversationSnapshot(){},_restoreCollaboration(){},_bindCollaborationTask(){},_selectCollabTask(){},
    _isEmptyStalledSnapshot:()=>options.stalled===true,
    _fail(title,reason){failures.push({title,reason});ctx._snap={...ctx._snap,status:'unreachable',statusText:[title,reason].filter(Boolean).join(': ')};},
  };
  vm.runInNewContext(source,{window,setTimeout,clearTimeout});
  const controller=window.ChatSessionController.create(ctx);Object.assign(ctx,controller);
  return{ctx,controller,window,native,opens,sends,released,failures,input,owner:value=>{owner=value;}};
}

for(const code of ['ACCOUNT_HISTORY_UNAVAILABLE','SESSION_FORBIDDEN','OWNER_MISMATCH','TASK_BINDING_MISMATCH']){
  test(`archive failure ${code} retains its identity and blocks composer sends until explicit retry`,async()=>{
    const f=fixture(async()=>({ok:false,notFound:false,code,reason:'Original archive unreadable'}));
    assert.equal(await f.controller._ensure('original'),false);
    assert.equal(f.ctx._sessionId,'original');assert.equal(f.ctx._ref,'');assert.equal(f.ctx._snap.openBlocked,true);
    assert.equal(f.ctx._draftKey,'original','Edits after an unsuccessful archive open belong to that archive, not a new-chat draft');
    assert.equal(f.ctx._snap.sessionNotFound,false);assert.equal(f.ctx._snap.sessionOpenCode,code);
    assert.match(f.ctx._snap.statusText,/Original archive unreadable/);
    assert.equal(await f.controller._sendCore(),false);assert.equal(await f.controller._sendCore('Explicit draft'),false);
    assert.equal(f.opens.length,1);assert.equal(f.sends.length,0);assert.equal(f.input.value,'Retained review draft');
  });
}

test('desktop preview keeps its transcript, draft and handle across failed activation and only releases it after a writable reply', async () => {
  const preview = { ...opened('original'), ref: 'preview-original', localReplica: true,
    snapshot: { messages: [{ role: 'assistant', text: 'Retained reply' }], localReplica: true,
      modelSelection: {name: 'glm', model: {id: 'glm', label: 'GLM'}},
      execution: { readOnly: true, canContinueOnDevice: true } } };
  const f = fixture((options, index) => index === 1 ? preview : index === 2 ? { ok: false, reason: 'Model unavailable' } : opened('original'));
  assert.equal(await f.controller._ensure('original'), true);
  assert.equal(f.opens[0].historyIntent, 'view');
  f.ctx._sessionOptions.taskRef = 'old-draft-task';
  assert.equal(await f.controller._ensure('original', preview.ref), false);
  assert.equal(f.opens[1].historyIntent, 'continue');
  assert.equal(f.opens[1].adapterId, 'qwen');
  assert.equal(f.opens[1].modelName, 'glm');
  assert.equal(Object.hasOwn(f.opens[1], 'accessDraftId'), false, 'An absent consent must not reserve a new-chat grant');
  assert.equal(Object.hasOwn(f.opens[1], 'accessConsentId'), false);
  assert.equal(f.opens[1].taskRef, undefined);
  delete f.ctx._sessionOptions.taskRef;
  assert.equal(f.ctx._ref, preview.ref);
  assert.equal(f.ctx._snap.messages[0].text, 'Retained reply');
  assert.equal(f.input.value, 'Retained review draft');
  assert.deepEqual(f.released, []);
  assert.equal(await f.controller._ensure('original', preview.ref), true);
  assert.equal(f.ctx._ref, 'ref-original');
  assert.deepEqual(f.released, [preview.ref]);
  assert.equal(f.sends.length, 0);
});

test('an account change during preview activation releases only the late writable handle', async () => {
  const pending = deferred(), f = fixture(() => pending.promise);
  f.ctx._ref = 'preview-original'; f.ctx._sessionId = 'original';
  f.ctx._snap = { localReplica: true, execution: { canContinueOnDevice: true } };
  const changing = f.controller._ensure('original', 'preview-original');
  await tick();
  f.owner('account-b'); f.ctx._viewEpoch++; f.ctx._ref = 'unrelated-live'; f.ctx._sessionId = 'other';
  pending.resolve(opened('original'));
  assert.equal(await changing, false);
  assert.equal(f.ctx._ref, 'unrelated-live');
  assert.deepEqual(f.released, ['ref-original']);
  assert.equal(f.sends.length, 0);
});

test('continuing a recovered draft rechecks its receipt and keeps edits when the preview is stale', async () => {
  const reason = '最后一条消息的发送状态已变化，请重新打开会话后确认。';
  const f = fixture(async options => options.historyIntent === 'continue'
    ? { ok: false, code: 'HISTORY_PENDING_USER_TAIL_CHANGED', reason } : opened('original'));
  f.ctx._ref = 'preview-a'; f.ctx._sessionId = 'original';
  f.ctx._snap = { localReplica: true, messages: [], historyRecovery: { reasonCode: 'HISTORY_UNDISPATCHED_USER_TAIL',
    pendingUserDigest: 'receipt-a', pendingUserText: 'original text' }, execution: { canContinueOnDevice: true } };
  f.input.value = 'user edits';
  assert.equal(await f.controller._ensure('original', 'preview-a'), false);
  await tick();
  assert.equal(f.opens[0].expectedPendingUserDigest, 'receipt-a');
  assert.equal(f.input.value, 'user edits'); assert.equal(f.sends.length, 0);
  assert.equal(f.ctx._snap.sessionOpenCode, 'HISTORY_PENDING_USER_TAIL_CHANGED');
  assert.equal(f.ctx._snap.execution.canContinueOnDevice, false);
  assert.equal(f.ctx._snap.historyRecovery.pendingUserText, undefined);
  assert.equal(f.ctx._ref, ''); assert.deepEqual(f.released, ['preview-a']);
  assert.equal(await f.controller._retryOpenChat(), true);
  assert.equal(f.opens[1].historyIntent, 'view'); assert.equal(f.opens[1].expectedPendingUserDigest, undefined);
  assert.equal(f.input.value, 'user edits'); assert.equal(f.sends.length, 0);
});

test('a view-only history rejects typed and programmatic sends before composer or runtime work', async () => {
  const f = fixture(() => { throw Error('must not execute'); });
  f.ctx._ref = 'preview-original';
  f.ctx._sessionId = 'original';
  f.ctx._snap = { localReplica: true, execution: { readOnly: true, canContinueOnDevice: false },
    historyRecovery: { incomplete: true, reason: 'A tool outcome is unknown' } };
  f.ctx._mount = () => { throw Error('must not consume draft'); };
  assert.equal(await f.controller._sendCore(), false);
  assert.equal(await f.controller._sendCore('Retry tool'), false);
  assert.equal(f.input.value, 'Retained review draft');
  assert.equal(f.sends.length, 0);
});

test('a thrown native open is a blocked archive failure rather than permission to start a new chat',async()=>{
  const f=fixture(async()=>{throw Error('Synthetic IPC failure');});
  assert.equal(await f.controller._ensure('original'),false);
  assert.equal(f.ctx._sessionId,'original');assert.equal(f.ctx._snap.openBlocked,true);assert.equal(f.ctx._snap.sessionNotFound,false);
  assert.match(f.ctx._snap.statusText,/Synthetic IPC failure/);assert.equal(await f.controller._sendCore(),false);
  assert.equal(f.opens.length,1);assert.equal(f.sends.length,0);
});

test('a native archive timeout stays blocked and releases its own late successful handle',async()=>{
  const reply=deferred(),f=fixture(()=>reply.promise,{timeout:8});
  const pending=f.controller._ensure('original');assert.equal(f.ctx._sessionId,'original');
  assert.equal(await pending,false);assert.equal(f.ctx._snap.openBlocked,true);
  assert.equal(f.ctx._snap.sessionOpenCode,'SODUWORK_OPEN_TIMEOUT');assert.equal(f.ctx._snap.sessionNotFound,false);
  assert.equal(await f.controller._sendCore(),false);assert.equal(f.opens.length,1);
  reply.resolve(opened('original'));await tick();assert.deepEqual(f.released,['ref-original']);
  assert.equal(f.ctx._ref,'');assert.equal(f.ctx._snap.openBlocked,true);
});

test('an invalid native handle cannot make the original archive appear open',async()=>{
  const f=fixture(async()=>({...opened('original'),ref:''}));
  assert.equal(await f.controller._ensure('original'),false);assert.equal(f.ctx._sessionId,'original');
  assert.equal(f.ctx._ref,'');assert.equal(f.ctx._snap.openBlocked,true);assert.equal(f.ctx._snap.sessionOpenCode,'INVALID_SESSION_REPLY');
  assert.equal(await f.controller._sendCore(),false);assert.equal(f.opens.length,1);
});

for(const failure of ['task-binding','stalled','ui-hook']){
  test(`a ${failure} failure after native open releases its handle and retains a retryable archive`,async()=>{
    const f=fixture(async()=>opened('original'),{stalled:failure==='stalled'});
    if(failure==='task-binding')f.ctx._sessionOptions={taskRef:'task',requireTaskBinding:true};
    if(failure==='ui-hook')f.ctx._paintBar=()=>{throw Error('Synthetic UI preparation failure');};
    assert.equal(await f.controller._ensure('original'),false);await tick();
    assert.equal(f.ctx._sessionId,'original');assert.equal(f.ctx._ref,'');assert.equal(f.ctx._snap.openBlocked,true);
    assert.equal(f.ctx._snap.sessionNotFound,false);assert.deepEqual(f.released,['ref-original']);
    assert.equal(await f.controller._sendCore(),false);assert.equal(f.opens.length,1);
  });
}

test('explicit retry reopens the same archive as an ordinary conversation and clears the blocked state only on success',async()=>{
  const f=fixture(async(_value,count)=>count===1?{ok:false,code:'SESSION_FORBIDDEN',reason:'Access temporarily denied'}:opened('original'));
  f.ctx._sessionOptions={taskRef:'review-task',taskTitle:'Review task',taskSession:true,requireTaskBinding:true};
  f.ctx._activeCollabTaskId=f.ctx._collaborationTaskId='review-task';
  assert.equal(await f.controller._ensure('original'),false);assert.equal(await f.controller._sendCore(),false);
  assert.equal(await f.controller._retryOpenChat(),true);
  assert.deepEqual(f.opens.map(row=>row.chatId),['original','original']);assert.equal(f.ctx._sessionId,'original');
  assert.equal(f.ctx._ref,'ref-original');assert.notEqual(f.ctx._snap.openBlocked,true);
  assert.equal(f.opens[1].resumeAsOrdinary,true);assert.equal(f.opens[1].taskRef,undefined);
  assert.equal(f.ctx._activeCollabTaskId,'');assert.equal(f.sends.length,0);assert.equal(f.input.value,'Retained review draft');
});

for(const stale of ['owner','view'])for(const outcome of ['success','throw']){
  test(`a late ${outcome} after a ${stale} change cannot overwrite the newly active view`,async()=>{
    const reply=deferred(),f=fixture(()=>reply.promise);const pending=f.controller._ensure('original');await tick();
    if(stale==='owner')f.owner('account-b');else f.ctx._viewEpoch++;
    const snapshot={status:'idle',messages:[{role:'user',text:'New owner view'}]};
    f.ctx._sessionId='other';f.ctx._ref='other-ref';f.ctx._snap=snapshot;
    if(outcome==='success')reply.resolve(opened('original'));else reply.reject(Error('Obsolete open failure'));
    assert.equal(await pending,false);assert.equal(f.ctx._snap,snapshot);assert.equal(f.ctx._sessionId,'other');
    assert.equal(f.ctx._ref,'other-ref');assert.equal(f.failures.length,0);
    assert.deepEqual(f.released,outcome==='success'?['ref-original']:[]);
  });
}

test('two pending exact archive targets do not share an opening and a late first ACK cannot replace the second',async()=>{
  const first=deferred(),second=deferred(),f=fixture(options=>options.chatId==='first'?first.promise:second.promise);
  const a=f.controller._ensure('first');await tick();const b=f.controller._ensure('second');await tick();
  assert.deepEqual(f.opens.map(row=>row.chatId),['first','second']);assert.equal(f.ctx._sessionId,'second');
  second.resolve(opened('second'));assert.equal(await b,true);const snapshot=f.ctx._snap;
  first.resolve(opened('first'));assert.equal(await a,false);
  assert.equal(f.ctx._sessionId,'second');assert.equal(f.ctx._ref,'ref-second');assert.equal(f.ctx._snap,snapshot);
  assert.deepEqual(f.released,['ref-first']);assert.equal(f.failures.length,0);
});

for(const timedOut of [false,true])test(`a late same-archive ACK cannot release the public ref reattached by a newer ${timedOut?'timeout retry':'view epoch'}`,async()=>{
  const first=deferred(),f=fixture((_options,count)=>count===1?first.promise:opened('original'),{timeout:timedOut?8:1000});
  const previous=f.controller._ensure('original');await tick();
  if(timedOut)assert.equal(await previous,false);
  else {f.ctx._viewEpoch++;f.ctx._ref='';f.ctx._sessionId='';f.ctx._snap=null;}
  assert.equal(await f.controller._ensure('original'),true);const snapshot=f.ctx._snap;
  first.resolve(opened('original'));assert.equal(await previous,false);await tick();
  assert.equal(f.ctx._sessionId,'original');assert.equal(f.ctx._ref,'ref-original');assert.equal(f.ctx._snap,snapshot);
  assert.deepEqual(f.released,[],'A reused public ref already owned by the active view must not be detached');
});

test('a repeated request for the same pending archive shares one native open',async()=>{
  const reply=deferred(),f=fixture(()=>reply.promise);
  const first=f.controller._ensure('original'),second=f.controller._ensure('original');await tick();
  assert.equal(f.opens.length,1);reply.resolve(opened('original'));
  assert.equal(await first,true);assert.equal(await second,true);assert.equal(f.ctx._sessionId,'original');
});

for(const stale of [false,true])test(`the initial native snapshot refresh observes the active archive after its opening reservation settles (stale owner: ${stale})`,async()=>{
  const reply=deferred(),f=fixture(async()=>opened('original'));f.native.snapshot=()=>reply.promise;
  assert.equal(await f.controller._ensure('original'),true);assert.equal(f.ctx._openingTask,null);
  const initial=f.ctx._snap;if(stale)f.owner('different-owner');
  reply.resolve({ok:true,snapshot:{status:'idle',messages:[{role:'assistant',text:'Refreshed native history'}]}});await tick();
  if(stale)assert.equal(f.ctx._snap,initial);else assert.equal(f.ctx._snap.messages[0].text,'Refreshed native history');
  assert.equal(f.ctx._sessionId,'original');assert.equal(f.ctx._ref,'ref-original');
});

for(const initial of ['','new','file-input','another-view'])test(`an archive target scopes draft key ${JSON.stringify(initial)} without replacing another view's saved key`,async()=>{
  const f=fixture(async()=>({ok:false,code:'HISTORY_UNAVAILABLE',reason:'Archive unreadable'}));f.ctx._draftKey=initial;
  assert.equal(await f.controller._ensure('original'),false);
  assert.equal(f.ctx._draftKey,initial==='another-view'?initial:'original');
});

for(const workOnly of [false,true])test(`opening another exact task archive resets the retained ${workOnly?'work-only':'failed'} view before native open`,async()=>{
  const staleSnapshot={status:'unreachable',openBlocked:true,workOnly,messages:[{role:'user',text:'Archive A history'}]};
  const f=fixture(async options=>({...opened(options.chatId),taskBindings:[{taskId:'task-b'}]}));
  let resets=0,oldCardReads=0;
  Object.assign(f.ctx,{_sessionId:'archive-a',_draftKey:'archive-a',_snap:staleSnapshot,
    _sessionOptions:{adapterId:'pi'},_taskOpenSeq:0,_collabPollTimer:1,
    _workCards:{ensureDraftSelectionSaved:async()=>{oldCardReads++;return true;}},
    reset(){resets++;f.ctx._viewEpoch++;f.ctx._ref='';f.ctx._sessionId='';f.ctx._draftKey='new';
      f.ctx._snap=null;f.ctx._sessionOptions={};f.ctx._collabTasks.clear();f.ctx._workCards=null;
      f.ctx._openingTask=null;f.ctx._openingEpoch=-1;},
  });
  const task={id:'task-b',title:'Archive B task',status:'reviewing'};
  f.window.SoduWorkAPI.getTask=async()=>task;
  const taskSource=require('./renderer-source.cjs').readFileSync(path.join(__dirname,'../components/panels/chat-task-controller.js'),'utf8');
  vm.runInNewContext(taskSource,{window:f.window,SoduWorkAPI:f.window.SoduWorkAPI,document:{getElementById:()=>null},Event,setTimeout:()=>1});
  const tasks=f.window.ChatTaskController.create(f.ctx);
  assert.equal(await tasks._openTask(task.id,task.title,{task,chatId:'archive-b',navigation:true}),true);
  assert.equal(resets,1);assert.equal(oldCardReads,0);assert.equal(f.ctx._sessionId,'archive-b');
  assert.equal(f.ctx._draftKey,'archive-b');assert.equal(f.opens.length,1);assert.equal(f.opens[0].chatId,'archive-b');
  assert.notEqual(f.ctx._snap,staleSnapshot);assert.equal(f.ctx._snap.messages[0].text,'archive-b saved history');
});

test('task navigation from a pending archive A to exact archive B ignores and releases the late A handle',async()=>{
  const first=deferred(),second=deferred(),f=fixture(options=>options.chatId==='archive-a'?first.promise:second.promise);
  const tasks={a:{id:'task-a',title:'Task A',status:'reviewing'},b:{id:'task-b',title:'Task B',status:'reviewing'}};
  f.window.SoduWorkAPI.getTask=async id=>Object.values(tasks).find(task=>task.id===id);
  f.ctx.reset=()=>{f.ctx._viewEpoch++;f.ctx._ref='';f.ctx._sessionId='';f.ctx._draftKey='new';f.ctx._snap=null;
    f.ctx._sessionOptions={};f.ctx._collabTasks.clear();f.ctx._openingTask=null;f.ctx._openingEpoch=-1;};
  const taskSource=require('./renderer-source.cjs').readFileSync(path.join(__dirname,'../components/panels/chat-task-controller.js'),'utf8');
  vm.runInNewContext(taskSource,{window:f.window,SoduWorkAPI:f.window.SoduWorkAPI,document:{getElementById:()=>null},Event,setTimeout:()=>1});
  const controller=f.window.ChatTaskController.create(f.ctx);
  const a=controller._openTask(tasks.a.id,tasks.a.title,{task:tasks.a,chatId:'archive-a',navigation:true});await tick();
  const b=controller._openTask(tasks.b.id,tasks.b.title,{task:tasks.b,chatId:'archive-b',navigation:true});await tick();
  second.resolve({...opened('archive-b'),taskBindings:[{taskId:tasks.b.id}]});assert.equal(await b,true);
  const snapshot=f.ctx._snap;
  first.resolve({...opened('archive-a'),taskBindings:[{taskId:tasks.a.id}]});assert.equal(await a,false);
  assert.deepEqual(f.opens.map(row=>row.chatId),['archive-a','archive-b']);assert.equal(f.ctx._sessionId,'archive-b');
  assert.equal(f.ctx._draftKey,'archive-b');assert.equal(f.ctx._ref,'ref-archive-b');assert.equal(f.ctx._snap,snapshot);
  assert.deepEqual(f.released,['ref-archive-a']);assert.equal(f.sends.length,0);
});
