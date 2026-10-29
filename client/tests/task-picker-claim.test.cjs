'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const fs = require('./renderer-source.cjs');
const source = fs.readFileSync(path.join(__dirname, '../components/panels/chat-task-controller.js'), 'utf8');

const assigned = changes => ({id:'assigned', title:'Assigned work', note:'Saved requirements', status:'todo',
  triageStage:'ready', ownerClientId:'sender-device', assigneeUserId:'receiver', readOnly:true,
  canViewExecution:true, canClaimExecution:true, myRoles:['assignee'], ...changes});
const owned = changes => assigned({readOnly:false, canClaimExecution:false, ownerClientId:'receiver-device', ...changes});
function deferred() {
  let resolve;
  return {promise:new Promise(done => {resolve = done;}), resolve:value => resolve(value)};
}
function harness(rows = [assigned()], overrides = {}) {
  const events = [], sent = [], bindings = [];
  let owner = 'receiver-scope', authoritative = rows[0];
  const window = {RequirementSessionContext:require('../core/requirement-session-context'),
    SoduWorkAPI:{taskStorageKey:() => owner, getTasksSnapshot:async () => ({online:true, items:rows}),
      getTask:async id => {events.push(['read', id]); return authoritative;},
      prepareRequirementExecution:async id => {
        events.push(['claim', id]); authoritative = owned(); return authoritative;
      }, ...overrides}};
  vm.runInNewContext(source, {window, SoduWorkAPI:window.SoduWorkAPI,
    document:{getElementById:() => null}, setTimeout:() => 1});
  const ctx = {_collabTasks:new Map(), _collabStarts:new Set(), _collabPicker:{open:false,tasks:[]},
    _sessionId:'chat-a', _ref:'ref-a', _viewEpoch:1, _taskOpenSeq:0, _sessionOptions:{adapterId:'pi'},
    _snap:{status:'idle',messages:[]}, _collabPollTimer:1, _render:() => {}, _ensure:async () => true,
    _api:() => ({bindTask:async (ref,id) => {events.push(['bind',id]); bindings.push({ref,id}); return {ok:true};}}),
    _send:async (text,options) => {events.push(['send',options.taskId]); sent.push({text,options}); return true;},
    refreshHistory:() => {}};
  const controller = window.ChatTaskController.create(ctx);
  return {window,ctx,controller,events,sent,bindings, setTask:value => {authoritative = value;},
    changeOwner:() => {owner = 'other-scope';}, submit:() => controller._collabAction('select-task',{taskId:'assigned'})};
}
function noExecution(f) {
  assert.equal(f.sent.length,0);
  assert.equal(f.bindings.length,0);
  assert.equal(f.ctx._collabTasks.size,0);
}

test('opening the picker includes claimable assigned work without taking ownership or starting work', async () => {
  const task = assigned(), f = harness([task, assigned({id:'observer',canClaimExecution:false}),
    assigned({id:'string-capability',canClaimExecution:'true'}), assigned({id:'hidden',canViewExecution:false}),
    assigned({id:'active',workRouting:{conversationTurn:{state:'running'}}})]);
  await f.controller._openTaskPicker();
  assert.deepEqual(Array.from(f.ctx._collabPicker.tasks, row => row.id), ['assigned']);
  assert.deepEqual(f.events,[]);
  assert.equal(task.readOnly,true);
  assert.equal(f.window.ChatTaskController.isPickableTask(task),false);
  noExecution(f);
  f.controller._collabAction('picker-close');
  assert.deepEqual(f.events,[]);
});

test('explicit confirmation claims assigned work before any binding or execution', async () => {
  const f = harness();
  await f.controller._openTaskPicker();
  assert.equal(await f.submit(),true);
  const actions = f.events.filter(row => row[0] !== 'read').map(row => row[0]);
  assert.equal(actions[0],'claim');
  assert.equal(actions.at(-1),'send');
  assert.equal(actions.filter(action => action === 'claim').length,1);
  assert.equal(f.sent.length,1);
  assert.equal(f.sent[0].options.taskId,'assigned');
  assert.equal(f.ctx._collabTasks.get('assigned').task.readOnly,false);
  assert.equal(f.ctx._collabPicker.open,false);
});

test('owned tasks do not invoke the ownership endpoint', async () => {
  const f = harness([owned()]);
  await f.controller._openTaskPicker();
  assert.equal(await f.submit(),true);
  assert.equal(f.events.some(row => row[0] === 'claim'),false);
  assert.equal(f.sent.length,1);
});

test('freshly revoked claim capability cannot transfer ownership or bind a task', async () => {
  for (const task of [assigned({canClaimExecution:false}), assigned({canViewExecution:false}),
    assigned({status:'doing'}), assigned({id:'another'})]) {
    const f = harness();
    await f.controller._openTaskPicker();
    assert.equal(f.ctx._collabPicker.tasks.length,1);
    f.setTask(task);
    assert.equal(await f.submit(),false);
    assert.equal(f.events.some(row => row[0] === 'claim'),false);
    noExecution(f);
    assert.ok(f.ctx._collabPicker.error);
  }
});

test('claim failure preserves the picker and allows a successful explicit retry', async () => {
  let claims = 0;
  const f = harness(undefined,{prepareRequirementExecution:async () => {
    if (++claims === 1) throw Error('负责人已变化，请刷新后重试');
    f.setTask(owned()); return owned();
  }});
  await f.controller._openTaskPicker();
  assert.equal(f.ctx._collabPicker.tasks.length,1);
  assert.equal(await f.submit(),false);
  assert.equal(claims,1);
  noExecution(f);
  assert.equal(f.ctx._collabPicker.open,true);
  assert.equal(f.ctx._collabPicker.submitting,false);
  assert.equal(f.ctx._collabPicker.tasks[0].id,'assigned');
  assert.equal(f.ctx._collabPicker.error,'负责人已变化，请刷新后重试');
  assert.equal(await f.submit(),true);
  assert.equal(claims,2);
  assert.equal(f.sent.length,1);
});

test('task detail failures retain the generic refresh error without exposing transport internals', async () => {
  const f = harness(undefined,{getTask:async () => {throw Error('internal transport failure');}});
  await f.controller._openTaskPicker();
  assert.equal(await f.submit(),false);
  assert.match(f.ctx._collabPicker.error,/最新状态/);
  assert.doesNotMatch(f.ctx._collabPicker.error,/internal transport/);
  assert.equal(f.events.some(row => row[0] === 'claim'),false);
  noExecution(f);
});

test('invalid or newly active claim receipts never bind or execute', async () => {
  for (const result of [null, owned({id:'another'}), assigned(), owned({canViewExecution:false}),
    owned({status:'doing'}), owned({triageStage:'intake'}), owned({archivedAt:1}),
    owned({workRouting:{conversationTurn:{state:'queued'}}}), owned({ai:{executionState:'running'}})]) {
    let claims = 0;
    const f = harness(undefined,{prepareRequirementExecution:async () => {claims++; return result;}});
    await f.controller._openTaskPicker();
    assert.equal(f.ctx._collabPicker.tasks.length,1);
    assert.equal(await f.submit(),false);
    assert.equal(claims,1);
    noExecution(f);
    assert.equal(f.ctx._collabPicker.open,true);
    assert.ok(f.ctx._collabPicker.error);
  }
});

test('incompatible requirements are checked before ownership changes', async () => {
  const f = harness([assigned({projectId:'enterprise-a'})]);
  f.ctx._sessionOptions.projectId = 'enterprise-b';
  await f.controller._openTaskPicker();
  assert.equal(f.ctx._collabPicker.tasks.length,1);
  assert.equal(await f.submit(),false);
  assert.equal(f.events.some(row => row[0] === 'claim'),false);
  noExecution(f);
  assert.match(f.ctx._collabPicker.error,/项目|工程/);
});

test('claim receipts revalidate project and executor compatibility before binding', async () => {
  for (const change of [{projectId:'different'}, {executionContext:{agent:{id:'local:qwen'}}},
    {executionContext:{model:'different'}}]) {
    const f = harness([assigned({projectId:'same'})], {prepareRequirementExecution:async () => owned(change)});
    Object.assign(f.ctx._sessionOptions,{projectId:'same',modelName:'chosen'});
    await f.controller._openTaskPicker();
    assert.equal(f.ctx._collabPicker.tasks.length,1);
    assert.equal(await f.submit(),false);
    noExecution(f);
    assert.ok(f.ctx._collabPicker.error);
  }
});

test('double confirmation shares one ownership request and sends once', async () => {
  const pending = deferred(); let claims = 0;
  const f = harness(undefined,{prepareRequirementExecution:() => {claims++; return pending.promise;}});
  await f.controller._openTaskPicker();
  assert.equal(f.ctx._collabPicker.tasks.length,1);
  const first = f.submit();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(claims,1);
  assert.equal(await f.submit(),false);
  noExecution(f);
  f.setTask(owned()); pending.resolve(owned());
  assert.equal(await first,true);
  assert.equal(claims,1);
  assert.equal(f.sent.length,1);
});

test('closing, reopening, switching chat or switching account during claim discards the response', async () => {
  for (const change of ['close','reopen','chat','account']) {
    const pending = deferred(); let claims = 0;
    const f = harness(undefined,{prepareRequirementExecution:() => {claims++; return pending.promise;}});
    await f.controller._openTaskPicker();
    assert.equal(f.ctx._collabPicker.tasks.length,1);
    const submitting = f.submit();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(claims,1);
    if (change === 'close' || change === 'reopen') f.controller._collabAction('picker-close');
    if (change === 'reopen') await f.controller._openTaskPicker();
    if (change === 'chat') {f.ctx._viewEpoch++; f.ctx._sessionId = 'chat-b'; f.ctx._ref = 'ref-b';}
    if (change === 'account') f.changeOwner();
    const picker = f.ctx._collabPicker, before = JSON.stringify(picker);
    pending.resolve(owned());
    assert.equal(await submitting,false,change);
    noExecution(f);
    assert.equal(f.ctx._collabPicker,picker);
    assert.equal(JSON.stringify(picker),before);
  }
});

test('the starter confirmation receives a live guard after claiming and before binding', async () => {
  const f = harness(); let confirmed = 0;
  await f.controller._openTaskPicker({render:() => {}, context:{adapterId:'pi'}, onConfirm:current => {
    assert.equal(typeof current,'function');
    assert.equal(current(),true);
    assert.equal(f.events.filter(row => row[0] === 'claim').length,1);
    noExecution(f); confirmed++; return true;
  }});
  assert.equal(await f.submit(),true);
  assert.equal(confirmed,1);
  assert.equal(f.sent.length,1);
});
