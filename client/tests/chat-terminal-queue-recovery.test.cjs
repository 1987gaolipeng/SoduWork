'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const { createTurnQueue } = require('../main/pi-session/turn-queue');
const source = fs.readFileSync(require.resolve('../components/panels/panels-chat.js'), 'utf8');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };

async function failedSnapshot(recoveryRequired = false) {
  const queue = createTurnQueue();
  const item = queue.add({text:'你好', options:{submissionId:'first-attempt'}});
  queue.take();
  await queue.run(item, async () => ({ok:false, reason:'Runner RPC timed out: job.dispatch'}));
  return {status:'unreachable', statusText:'发送尚未确认，请核实执行状态', messages:[], tools:[],
    execution:{running:false, queue:queue.view(), turnQueue:queue.state(), recoveryRequired}};
}

function busyFixture(snapshot) {
  const ctx = {global:{}, _snap:snapshot, _pending:'你好', _pendingPlugins:[], _pendingAttachmentNames:[],
    _render() {}, _restoreFailedDraft(draft) { ctx.input = draft?.text || ''; }};
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('  function _runtimeBusy()'), source.indexOf('  let _queueEdit')), ctx);
  vm.runInContext(source.slice(source.indexOf('  function _fail('), source.indexOf('  async function refreshHistory')), ctx);
  ctx._fail('这一轮没跑成', 'Runner RPC timed out: job.dispatch');
  return ctx;
}

function queueFixture(snapshot, update = async () => ({ok:true})) {
  const host = {dataset:{}, classList:{add() {}, toggle() {}}}, calls = [], notices = [];
  const globals = {document:{activeElement:null}, petSay:message => notices.push(message)};
  globals.window = globals;
  vm.runInNewContext(fs.readFileSync(require.resolve('../components/panels/chat-send-queue.js'), 'utf8'), globals);
  const ctx = {_ref:'chat-a', _sessionId:'archive-a', _viewEpoch:1, _snap:snapshot, _localQueue:[],
    _collabTasks:new Map(), _collabEntries:() => [], esc:String, _mount:() => ({querySelector:() => host}),
    _api:() => ({updateQueue:async (...args) => { calls.push(args); return update(...args); }})};
  const queue = globals.ChatSendQueue.create(ctx);
  ctx._render = () => queue._renderQueue(ctx._mount());
  return {ctx, queue, calls, notices, render:() => { ctx._render(); return host.innerHTML; }};
}

test('a confirmed terminal first-send failure restores the text without treating its empty automatic pause as execution', async () => {
  const ctx = busyFixture(await failedSnapshot(false));
  assert.equal(ctx.input, '你好');
  assert.equal(ctx._pending, '');
  assert.equal(ctx._snap.execution.turnQueue.paused, true, 'rendering never clears the runtime pause');
  assert.equal(ctx._runtimeBusy(), false);
});

test('unknown execution, pending messages and manual pauses remain protected', async () => {
  const snapshot = await failedSnapshot(true), ctx = busyFixture(snapshot);
  assert.equal(ctx._runtimeBusy(), true);
  snapshot.execution.recoveryRequired = false;
  snapshot.execution.queue = [{id:'next', text:'next'}];
  assert.equal(ctx._runtimeBusy(), true);
  snapshot.execution.queue = [];
  snapshot.execution.turnQueue.activeQueueId = 'active';
  assert.equal(ctx._runtimeBusy(), true);
  snapshot.execution.turnQueue.activeQueueId = '';
  snapshot.execution.turnQueue.failure = null;
  assert.equal(ctx._runtimeBusy(), true, 'a manual pause is not an automatic failed-turn pause');
  delete snapshot.execution.recoveryRequired;
  assert.equal(ctx._runtimeBusy(), true, 'legacy snapshots cannot prove the old dispatch ended');
});

test('an idle preflight failure snapshot also releases only the confirmed empty automatic pause', async () => {
  const snapshot = await failedSnapshot(false), ctx = busyFixture(snapshot);
  ctx._snap = {...ctx._snap, status:'idle'};
  assert.equal(ctx._runtimeBusy(), false);
  assert.equal(ctx._snap.execution.turnQueue.paused, true);
});

test('an unknown first send exposes verification even with no queued messages, without replaying text', async () => {
  const gate = deferred(), f = queueFixture(await failedSnapshot(true), () => gate.promise);
  assert.match(f.render(), /data-queue-action="resume"[^>]*>核实执行状态/);
  assert.match(f.render(), /发送尚未确认/);
  assert.doesNotMatch(f.render(), /继续队列/);
  const pending = f.queue._queueAction('resume', '');
  assert.match(f.render(), /核实中/);
  await f.queue._queueAction('resume', '');
  assert.deepEqual(f.calls, [['chat-a', '', 'resume', '']]);
  const terminal = await failedSnapshot(false);
  gate.resolve({ok:true, snapshot:terminal});
  await pending;
  assert.equal(f.ctx._snap, terminal);
  assert.doesNotMatch(f.render(), /nqueue-paused|核实中|继续队列/);
});

test('a failed verification retains its recovery action and original queue', async () => {
  const snapshot = await failedSnapshot(true), f = queueFixture(snapshot, async () => { throw Error('Runner remains offline'); });
  await f.queue._queueAction('resume', '');
  assert.equal(f.ctx._snap, snapshot);
  assert.deepEqual(f.notices, ['Runner remains offline']);
  assert.match(f.render(), /核实执行状态/);
  assert.doesNotMatch(f.render(), /核实中/);
});

test('verification replies cannot replace another chat or newer runtime events', async () => {
  for (const navigate of [false, true]) {
    const gate = deferred(), f = queueFixture(await failedSnapshot(true), () => gate.promise);
    const pending = f.queue._queueAction('resume', '');
    if (navigate) { f.ctx._ref = 'chat-b'; f.ctx._viewEpoch++; }
    const fresh = {status:'streaming', execution:{running:true, queue:[]}};
    f.ctx._snap = fresh;
    gate.resolve({ok:true, snapshot:await failedSnapshot(false)});
    await pending;
    assert.equal(f.ctx._snap, fresh);
  }
});

test('known terminal empty failures do not invent a continue-queue action', async () => {
  const f = queueFixture(await failedSnapshot(false));
  assert.doesNotMatch(f.render(), /nqueue-paused|核实执行状态|data-queue-action="resume"/);
  f.ctx._snap.execution.queue = [{id:'next', text:'later'}];
  assert.match(f.render(), /继续队列/);
});

test('the Agent picker explains unknown execution instead of asking users to wait for a failed turn', () => {
  const handlers = new Map(), notices = [];
  const pop = {hidden:true, style:{}, setAttribute() {}, addEventListener() {}, remove() {}};
  const button = {setAttribute() {}, addEventListener:(name, fn) => handlers.set(name, fn), after() {}};
  const globals = {AbortController, document:{createElement:() => pop, addEventListener() {}}, addEventListener() {}};
  globals.window = globals;
  vm.runInNewContext(fs.readFileSync(require.resolve('../components/panels/chat-runtime-picker.js'), 'utf8'), globals);
  const state = {ref:'chat-a', adapterId:'harness2', busy:true, recoveryRequired:true,
    recoveryReason:'执行机无法连接，请先核实执行状态'};
  globals.ChatRuntimePicker.create({querySelector:() => button}, {state:() => state, say:value => notices.push(value)});
  handlers.get('click')({stopPropagation() {}});
  assert.match(notices[0], /无法连接.*核实执行状态/);
  assert.doesNotMatch(notices[0], /等待本轮/);
});

test('the production NativeChat send button submits the retained first message after a confirmed failure', async t => {
  const {makeGlobals, stubGlobals} = require('./fixture/chat-draft-harness.cjs');
  const f = makeGlobals(), sent = []; let onEvent;
  const initial = {status:'idle', messages:[], tools:[], execution:{running:false, recoveryRequired:false}};
  const api = {open:async () => ({ok:true, ref:'ref-a', sessionId:'archive-a', adapterId:'harness2', snapshot:initial}),
    onEvent:handler => { onEvent = handler; return () => {}; },
    history:async () => ({ok:true, chats:[]}), outputs:async () => ({ok:true, items:[]}), release:async () => ({ok:true}),
    send:async (...args) => { sent.push(args); return {ok:true}; }};
  stubGlobals(f.g, {piSession:api});
  f.g.ChatWorkbenchAnnotations = null;
  f.g.window = f.g;
  vm.createContext(f.g);
  for (const file of ['chat-draft-recovery', 'chat-composer-bindings', 'chat-session-controller', 'panels-chat'])
    vm.runInContext(fs.readFileSync(require.resolve('../components/panels/' + file + '.js'), 'utf8'), f.g);
  const chat = f.g.NativeChat;
  t.after(() => chat.reset());
  chat.prepare({adapterId:'harness2'});
  const input = f.document.getElementById('nchatInput'); input.focus = () => {};
  assert.equal(await chat.enter('你好', '', {adapterId:'harness2'}), true);
  assert.equal(sent.length, 1);
  onEvent({ref:'ref-a', kind:'error', reason:'Runner refused this submission', snapshot:await failedSnapshot(false)});
  assert.equal(input.value, '你好');
  assert.equal(chat.isBusy(), false);
  f.document.getElementById('nchatSend').dispatchEvent({type:'click'});
  for (let n = 0; n < 30; n++) await Promise.resolve();
  assert.equal(sent.length, 2, 'the real send-button handler accepts an explicit fresh submission');
  assert.equal(sent[1][0], 'ref-a');
  assert.equal(sent[1][1], '你好');
  assert.notEqual(sent[1][3].submissionId, sent[0][3].submissionId);
});
