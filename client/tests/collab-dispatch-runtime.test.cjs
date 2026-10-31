'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');
const chat = fs.readFileSync(path.join(__dirname, '../components/panels/panels-chat.js'), 'utf8');
const taskMethods = fs.factoryMethods('chat-task-controller.js', 'ChatTaskController');
function section(start, end) {
  const name = start.match(/function (\w+)/)[1];
  const names = name === '_startTask' ? ['_taskExecutionConfig', name, '_startTaskCommand'] : [name];
  const guard = fs.readFileSync(path.join(__dirname, '../components/panels/chat-task-controller.js'), 'utf8')
    .match(/function _viewGuard\([\s\S]*?(?=  function _sessionContext)/)[0];
  return 'var ctx = globalThis;\n' + guard + names.map(key => taskMethods[key].toString()).join('\n');
}

const predicateWindow = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/chat-task-controller.js'), 'utf8'), {window: predicateWindow});
const predicate = predicateWindow.ChatTaskController.isPickableTask;
function startHarness(api, entries = []) {
  const context = {
    global: { SoduWorkAPI: api }, _api: () => ({}), isPickableTask: predicate,
    _sessionOptions: { adapterId: 'pi' }, _collabPicker:{}, _ensure: async () => true,
    _persistTaskBinding: async () => true,
    _send: (...args) => api.send ? api.send(...args) : Promise.resolve(true),
    _collabTasks: new Map(entries.map(e => [e.taskId, e])), _collabStarts: new Set(),
    _collabQueueMode: () => 'serial', _collabEntries: () => entries,
    _collabTerminal: new Set(['done', 'completed', 'failed']),
    _collabRunning: new Set(['running', 'queued', 'dispatching']),
    _collabEntryStatus: e => e.queueState || e.task.status,
    _selectCollabTask: () => {}, _setCollabEntryStatus: (e, s) => { if(e)e.queueState = s; },
    _bindCollaborationTask: (id, title, opts) => {
      if (!context._collabTasks.has(id)) context._collabTasks.set(id, { taskId: id, task: opts.taskMeta });
    }, _collaborationTask: {}, _taskSession: null,
    _render: () => {}, _loadCollabRun: () => {}, refreshHistory: () => {}, _taskStartPrompt: null,
    _renderTaskStartPrompt: () => {}, _dismissProposal: () => {},
    _collaborationTaskId: '',
  };
  const pickerWindow = {SoduWorkAPI:api};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../components/panels/chat-task-controller.js'),'utf8'),{window:pickerWindow});
  context._openTaskPicker = pickerWindow.ChatTaskController.create(context)._openTaskPicker;
  vm.createContext(context);
  vm.runInContext(section('  async function _startTask(task, options)', '  async function _send('), context);
  return context;
}

test('direct task start sends into this conversation without a second dispatch', async () => {
  let calls = 0;
  const ctx = startHarness({
    listAIAgents: async () => ({ agents: [{ id: 'local:pi', cliName: 'pi', available: true }] }),
    dispatchToAI: async () => { throw new Error('must not create another execution'); },
    send: async (_, options) => { calls++; assert.equal(options.taskId, 't1'); return true; },
  });
  assert.equal(await ctx._startTask({ id: 't1', workRouting: { selectedStrategy: 'direct' } }), true);
  assert.equal(calls, 1);
});

test('starting an unconfigured requirement preserves the work draft model and reasoning choice', async () => {
  const ctx = startHarness({});
  ctx._sessionOptions = {adapterId:'pi', modelName:'chosen-model', reasoningEffort:'high'};
  ctx._sessionId = 'work-draft';
  ctx._snap = {workOnly:true, status:'idle'};
  ctx._workModel = () => ctx._sessionOptions.modelName;
  assert.equal(await ctx._startTask({id:'t1', status:'todo'}), true);
  assert.equal(ctx._sessionOptions.modelName, 'chosen-model');
  assert.equal(ctx._sessionOptions.reasoningEffort, 'high');
});

test('dispatch navigation never inherits a different conversation draft model', () => {
  const ctx = startHarness({});
  ctx._sessionId = 'old-draft'; ctx._snap = {workOnly:true, status:'idle'};
  ctx._sessionOptions = {adapterId:'pi', modelName:'private-old-model', reasoningEffort:'high'};
  for (const options of [{forceNew:true}, {chatId:'other-chat'}, {source:'task-dispatch'}]) {
    const chosen = ctx._taskExecutionConfig({id:'t1'}, options);
    assert.equal(chosen.config.model, '');
    assert.equal(chosen.config.reasoningEffort, '');
  }
});

test('an explicit default or saved task model still overrides the work draft choice', async () => {
  for (const [task, options, expected] of [
    [{id:'t1'}, {taskExecution:{model:''}}, ''],
    [{id:'t1', model:'task-model'}, {}, 'task-model'],
    [{id:'t1'}, {taskExecution:{model:'explicit-model'}}, 'explicit-model'],
  ]) {
    const ctx = startHarness({});
    ctx._sessionOptions = {adapterId:'pi', modelName:'chosen-model'};
    ctx._workModel = () => ctx._sessionOptions.modelName;
    assert.equal(await ctx._startTask(task, options), true);
    assert.equal(ctx._sessionOptions.modelName, expected);
  }
});

test('repeated clicks during dispatch send a single request', async () => {
  let resolve;
  let calls = 0;
  const ctx = startHarness({
    listAIAgents: async () => ({ agents: [{ id: 'local:pi' }] }),
    send: async () => { calls++; return new Promise(r => { resolve = r; }); },
  });
  const first = ctx._startTask({ id: 't1' });
  await new Promise(r => setImmediate(r));
  assert.equal(await ctx._startTask({ id: 't1' }), false);
  resolve({ ok: true });
  assert.equal(await first, true);
  assert.equal(calls, 1);
});

test('workflow launch uses node routing without requesting an Agent', async () => {
  let calls = 0;
  const ctx = startHarness({
    listAIAgents: () => { throw new Error('workflow must not ask for Agent'); },
    startTaskPlugin: async () => { throw Error('renderer must not launch a workflow'); },
    send: async (_, options) => { calls++; assert.equal(options.taskExecution.bindingId, 'flow1'); return true; },
  });
  assert.equal(await ctx._startTask({ id: 't1', workflowBindingId: 'flow1' }), true);
  assert.equal(calls, 1);
});

test('serial dispatch queues a second task while the first runs', async () => {
  const first = { taskId: 't1', nativeTurn: true, task: { id: 't1', status: 'running' }, queueState: 'running' };
  const second = { taskId: 't2', task: { id: 't2', status: 'todo' } };
  const ctx = startHarness({
    listAIAgents: async () => ({ agents: [{ id: 'local:pi' }] }),
    dispatchToAI: () => { throw new Error('must not dispatch concurrently'); },
  }, [first, second]);
  assert.equal(await ctx._startTask(second.task), true);
  assert.equal(second.queueState, 'queued');
});

test('start command lists tasks through the Hub API', async () => {
  const ctx = startHarness({ getTasks: async () => [{ id: 'todo', status: 'todo' }, { id: 'done', status: 'done' }] });
  assert.equal(await ctx._startTaskCommand(), true);
  assert.equal(ctx._collabPicker.tasks.length, 1);
  assert.equal(ctx._collabPicker.tasks[0].id, 'todo');
});

test('late task picker response cannot reopen a dismissed picker', async () => {
 let resolve;
 const window={SoduWorkAPI:{getTasks:()=>new Promise(r=>{resolve=r;})}};
 vm.runInNewContext(require('./renderer-source.cjs').readFileSync(path.join(__dirname,'../components/panels/chat-task-controller.js'),'utf8'),{window});
 const context={_collabPicker:{open:false},_collabTasks:new Map(),_collabStarts:new Set(),_render:()=>{}};
 const controller=window.ChatTaskController.create(context);
 const pending=controller._openTaskPicker();
 controller._collabAction('picker-close');
 resolve([{id:'late',status:'todo'}]);await pending;
 assert.equal(context._collabPicker.open,false);
 assert.equal(context._collabPicker.tasks.length,0);
});

test('repository task enters the shared queue with its task identity for controlled checkout', async () => {
 let dispatched=0;
 const ctx=startHarness({
  listAIAgents:async()=>({agents:[{id:'local:pi'}]}),
  send:async(_, options)=>{dispatched++;assert.equal(options.taskId,'t');return true;},
  dispatchToAI:()=>{throw Error('renderer must not dispatch alongside the send queue');},
 });
 assert.equal(await ctx._startTask({id:'t',repoId:'repo-1'}),true);
 assert.equal(dispatched,1);
});

test('workflow and native task use the same queue instead of a renderer barrier', async () => {
 const first={taskId:'w',task:{id:'w'},queueState:'running'};
 const second={taskId:'t',task:{id:'t'},queueState:'todo'};
 const ctx=startHarness({send:async(_,options)=>{assert.equal(options.taskId,'t');return true;}},[first,second]);
 assert.equal(await ctx._startTask(second.task),true);
 assert.equal(second.queueState,'queued');
 assert.equal(second.nativeTurn,true);
});

test('waiting for user input blocks later tasks without restarting the earlier task', async () => {
  const first = { taskId: 't1', task: { id: 't1' }, queueState: 'waiting_human' };
  const second = { taskId: 't2', task: { id: 't2', status: 'todo' } };
  const ctx = startHarness({ dispatchToAI: () => { throw new Error('must not restart the waiting task'); } }, [first, second]);
  await ctx._startTask(second.task, { candidate: { id: 'local:pi' } });
  assert.equal(second.queueState, 'queued');
  assert.equal(second.nativeTurn, true);
  assert.equal(first.queueState, 'waiting_human');
});

test('manual task creation never launches a leftover workflow', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../components/panels/panels-compose-submit.js'), 'utf8');
  const context = { window: { SoduWorkAPI: { startTaskPlugin: () => { throw new Error('unexpected workflow'); } } } };
  vm.runInNewContext(source, context);
  const result = await context.window.ComposeDraftSubmit.handOff({ id: 'manual', who: { kind: 'me' }, flowId: 'previous-flow' });
  assert.equal(result.warn, '');
  assert.equal(result.who, '');
});

function loadHarness(api) {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/chat-task-session.js'), 'utf8'), { window });
  const controller = window.ChatTaskSession.create({ conversationId: 'c1', taskId: 't1' });
  const entry = { taskId: 't1', task: { id: 't1' }, queueState: 'running', controller };
  const context = {
    global: { SoduWorkAPI: api }, _sessionId: 'c1', _collabTasks: new Map([['t1', entry]]),
    _collabStatus: window.ChatTaskSession.normalizeStatus,
    _collabTerminal: new Set(['done', 'completed', 'failed']),
    _setCollabEntryStatus: (e, status) => { e.queueState = status; e.controller.update({ status }); },
    advances: [], _scheduleNextCollabTask: id => context.advances.push(id), _render: () => {},
  };
  vm.createContext(context);
  vm.runInContext(section('  async function _loadCollabRun(taskId)', '  function _scheduleCollabPoll()'), context);
  return { context, entry, controller };
}

test('workflow node completion remains waiting until the entire workflow settles', async () => {
  const { context, entry } = loadHarness({
    aiSession: async () => ({ ok: true, id: 'r1', workflowRunId: 'flow1', status: 'done', items: [{ seq: 1, kind: 'say', text: 'node output' }] }),
    taskTrace: async () => ({ summary: { currentState: 'waiting_human' } }),
  });
  await context._loadCollabRun('t1');
  assert.equal(entry.queueState, 'waiting_human');
  assert.equal(context.advances.length, 0);
  assert.equal(entry.controller.snapshot().events.length, 1);
});

test('legacy execution polling remains read-only and renders ordered events exactly once', async () => {
  const { context, controller } = loadHarness({
    aiSession: async () => ({ ok: true, id: 'r1', status: 'done', items: [{ seq: 2 }, { seq: 1 }] }),
  });
  await context._loadCollabRun('t1');
  await context._loadCollabRun('t1');
  assert.equal(JSON.stringify(controller.snapshot().events.map(e => e.seq)), '[1,2]');
  assert.equal(context.advances.length, 0);
});

test('switching chats discards the previous execution response', async () => {
  let resolve;
  const { context, controller } = loadHarness({
    aiSession: () => new Promise(r => { resolve = r; }),
  });
  const load = context._loadCollabRun('t1');
  context._sessionId = 'c2';
  resolve({ ok: true, id: 'r1', status: 'done', items: [{ seq: 1 }] });
  await load;
  assert.equal(controller.snapshot().events.length, 0);
  assert.equal(context.advances.length, 0);
});

test('retry starts a fresh event cursor instead of dropping its early output', async () => {
  const { controller } = loadHarness({});
  controller.setExecution({}, 'run-1');
  controller.applyEvent({ seq: 30, runId: 'run-1' });
  controller.setExecution({}, 'run-2');
  assert.equal(controller.snapshot().eventCursor, 0);
  assert.equal(controller.applyEvent({ seq: 1, runId: 'run-2' }), true);
  assert.equal(controller.snapshot().events.length, 1);
});

test('ordinary chat events do not inherit the selected task identity', () => {
  assert.doesNotMatch(chat, /const eventTaskId = String\(p\.taskId \|\| _activeCollabTaskId/);
});

test('run status never overwrites the business task status', () => {
  const ctx = { global: {}, _sessionId: '', _collabStatus: s => s };
  vm.createContext(ctx);
  vm.runInContext(section('  function _setCollabEntryStatus(', '  function _nextCollabEntry()'), ctx);
  const entry = { taskId: 't1', task: { id: 't1', status: 'doing' } };
  ctx._setCollabEntryStatus(entry, 'done');
  assert.equal(entry.queueState, 'done');
  assert.equal(entry.task.status, 'doing');
});

test('dossier uses real stages and numeric metrics, with no invented release', () => {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/chat-collaboration.js'), 'utf8'), { window });
  const host = { innerHTML: '', querySelectorAll: () => [], querySelector: () => null };
  const view = window.ChatCollaboration.create({ host });
  view.render({ collaboration: true, taskId: 't1', status: 'done', task: { id: 't1', title: 'Smoke test' },
    execution: { tokens: { input: 100, output: 20, total: 0 }, retryCount: 2,
      startedAt: '2026-09-06T00:00:00Z', finishedAt: '2026-09-06T00:00:06Z' } });
  view.setPin('dossier');
  assert.doesNotMatch(host.innerHTML, /\[object Object\]|trial|AI Review|自动合并|健康检查/);
  assert.match(host.innerHTML, /120/);
  assert.match(host.innerHTML, /6 秒/);
});


test('missing or unauthorized task stops repeated polling while preserving history', async () => {
  for (const httpStatus of [403, 404, 410]) {
    let calls = 0;
    const { context, entry, controller } = loadHarness({
      aiSession: async () => { calls++; return { ok: false, httpStatus, items: [] }; },
    });
    controller.setExecution({}, 'old-run');
    controller.applyEvent({ seq: 1, kind: 'say', text: 'saved output', runId: 'old-run' });
    await context._loadCollabRun('t1');
    await context._loadCollabRun('t1');
    assert.equal(calls, 1);
    assert.equal(entry.unavailable, true);
    assert.equal(context._collabTasks.has('t1'), true);
    assert.equal(controller.snapshot().events.length, 1);
    assert.equal(entry.queueState, 'running');
  }
});

test('temporary network errors remain retryable and late failures cannot disable a new chat', async () => {
  let calls = 0;
  const { context, entry } = loadHarness({
    aiSession: async () => { calls++; return { ok: false, httpStatus: 503 }; },
  });
  await context._loadCollabRun('t1');
  await context._loadCollabRun('t1');
  assert.equal(calls, 2);
  assert.equal(entry.unavailable, undefined);
  let resolve;
  const late = loadHarness({ aiSession: () => new Promise(r => { resolve = r; }) });
  const pending = late.context._loadCollabRun('t1');
  late.context._sessionId = 'c2';
  resolve({ ok: false, httpStatus: 404 });
  await pending;
  assert.equal(late.entry.unavailable, undefined);
});
