const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const TaskSync = require('../core/task-sync.js');

const source = fs.readFileSync(path.join(__dirname, '../core/store-lifecycle.js'), 'utf8') + '\n' +
  fs.readFileSync(path.join(__dirname, '..', 'core', 'store.js'), 'utf8');

function fixture(api, failOutbox) {
  const values = new Map();
  const events = [], said = [];
  const localStorage = {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => {
      if (failOutbox && String(key).includes('task_ops')) throw new Error('quota');
      values.set(key, String(value));
    },
    removeItem: (key) => values.delete(key),
  };
  const context = {
    SoduWorkAPI: api,
    soduWorkAPI: null,
    localStorage,
    TaskSync,
    CustomEvent: class {
      constructor(type, init) { this.type = type; this.detail = init && init.detail; }
    },
    document: {
      activeElement: null,
      getElementById: () => null,
      querySelectorAll: () => [],
      documentElement: { setAttribute() {} },
    },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    location: { reload() {} },
    console: { log() {}, error() {} },
    petSay: (text) => said.push(String(text)),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  context.window = context;
  context.dispatchEvent = (event) => events.push(event);
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'store.js' });
  const store = vm.runInContext('Store', context);
  store.__events = events; store.__said = said; store.__context = context;
  return store;
}

function localTask(id) {
  return {
    id,
    title: id,
    note: 'must persist',
    status: 'todo',
    handler: 'me',
    priority: 'normal',
    tags: [],
    progress: [],
    deps: [],
    origin: 'local',
  };
}

test('single save receipt updates only its task without hydration or a detail reload', () => {
  const store = fixture({online:true, getTasks(){assert.fail('no full fetch on save');}});
  let detailReloads = 0;
  store.__context.refreshOpenDetail = () => {detailReloads++;};
  const old = {...localTask('saved'), ownerClientId:'device', assigneeUserId:'u',
    canViewExecution:true, ai:{state:'running'}};
  const other = localTask('unrelated');
  store._tasks.push(old, other);
  store._setShadow([old, other]);
  const receipt = {...old, title:'Confirmed', ai:undefined, projectionPending:true,
    statusTransition:{applied:false, message:'Keep actual state'}};
  store.acceptTaskSave(receipt);
  assert.equal(store._tasks[0].title, 'Confirmed');
  assert.equal(store._tasks[1], other);
  assert.equal(store._shadow.saved.title, 'Confirmed');
  assert.equal(store._shadow.saved.statusTransition, undefined);
  assert.equal(receipt.statusTransition.applied, false, 'the caller can still display the rejected transition');
  assert.equal(store._tasks[0].ai.state, 'running');
  assert.equal(detailReloads, 0);
  assert.equal(store._readTaskOps().length, 0, 'acknowledgement must not enqueue a save echo');
});

test('board save events also merge pending projections without reloading an open detail', () => {
  const store = fixture({online:true}); let reloads = 0;
  store.__context.refreshOpenDetail = () => {reloads++;};
  const old = {...localTask('board-save'), status:'doing', triageStage:'ready', reviewedAt:null,
    requirementStage:'reviewing', requirementVersion:1, ownerClientId:'device',
    canViewExecution:true, ai:{state:'running'}};
  store._tasks.push(old); store._setShadow([old]);
  store.applyServerEvent({type:'task.updated',task:{...old, title:'Confirmed board change',
    requirementStage:'delivering', requirementVersion:2, ai:undefined, projectionPending:true}});
  assert.equal(store._tasks[0].title, 'Confirmed board change');
  assert.equal(store._tasks[0].requirementVersion, 2);
  assert.equal(store._tasks[0].requirementStage, 'reviewing');
  assert.equal(store._tasks[0].ai.state, 'running');
  assert.equal(store._tasks[0].projectionPending, undefined);
  assert.equal(reloads, 0);
});

test('explicit requirement creation finishes after its receipt while an unrelated background save is pending', async t => {
  let releaseBackground;
  const background = new Promise(resolve => { releaseBackground = resolve; });
  const requests = [];
  const store = fixture({ online: true,
    parseTaskText: async () => { assert.fail('clicking Create must not call the model parser'); },
    putTask: async (id, data) => {
      requests.push(id);
      if(id==='background-task')await background;
      return {...data,id,origin:'local',canEditRequirement:true};
    },
  });
  t.after(async () => { releaseBackground(); await store._taskFlushPromise; clearTimeout(store._syncT); });
  store._scheduleTaskFlush=()=>{}; store.initLocal();
  store.tasks.push(localTask('background-task'));
  store._captureTaskChanges();
  const ctx=store.__context;
  ctx.Requirements={dateTimestamp:()=>null};
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../components/panels/panels-compose-submit.js'),'utf8'),ctx);
  const state={id:'explicit-create'},record=ctx.ComposeDraftSubmit.card({},null);
  record.submission=state;
  const pending=ctx.ComposeDraftSubmit.createRequirement({
    draft:{title:'Explicit requirement',check:[],who:{kind:'me'}},options:{},
    state,card:record,btn:{},current:()=>true,done(){},note:'Complete input',
  });
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(requests,['explicit-create','background-task'],'explicit creation takes priority over queued background writes');
  assert.equal(record.phase,'succeeded','confirmed creation must not wait for the rest of the outbox');
  assert.equal(record.receipt.id,'explicit-create');
  assert.equal(store._readTaskOps().length,1);
  assert.equal(store._readTaskOps()[0].id,'background-task');
  assert.equal(store._taskPersistWaiters.size,0);
  await pending;
});

test('a create bypasses an already in-flight unrelated background save without waiting for its timeout', async t => {
  let releaseBackground;
  const background = new Promise(resolve => { releaseBackground = resolve; });
  const requests = [];
  const store = fixture({online: true, putTask: async (id, data) => {
    requests.push(id);
    if (id === 'slow-background') await background;
    return {...data, id, origin: 'local'};
  }});
  store._scheduleTaskFlush = () => {};
  store.tasks.push(localTask('slow-background')); store._captureTaskChanges();
  const draining = store._flushTaskOps();
  t.after(async () => {releaseBackground(); await draining; await store._taskPriorityFlushPromise;});
  store.tasks.push(localTask('interactive-create'));
  let saved = false;
  const submission = store.persistTask('interactive-create').then(result => {saved = result;});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests, ['slow-background', 'interactive-create']);
  assert.equal(saved, true, 'the exact Hub receipt completes creation while the background request is still pending');
  assert.equal(store._readTaskOps().length, 1);
  await submission;
});

test('same-task explicit saves share the existing in-flight write and both receive its receipt', async t => {
  let accept;
  const receipt=new Promise(resolve=>{accept=resolve;});
  const requests=[];
  const store=fixture({online:true,putTask:async(id,data)=>{
    requests.push(id);await receipt;return {...data,id,origin:'local'};
  }});
  store.tasks.push(localTask('same-create'));
  const first=store.persistTask('same-create'),second=store.persistTask('same-create');
  t.after(()=>accept());
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(requests,['same-create']);
  accept();
  assert.deepEqual(await Promise.all([first,second]),[true,true]);
  assert.equal(store._readTaskOps().length,0);
  assert.equal(store._taskPersistWaiters.size,0);
});

test('an unrelated background write failure cannot turn an already confirmed explicit create into a failure', async t => {
  const store=fixture({online:true,putTask:async(id,data)=>{
    if(id==='failing-background')throw Error('unrelated connection failure');
    return {...data,id,origin:'local'};
  }});
  t.after(()=>{clearTimeout(store._taskRetryT);clearTimeout(store._syncT);});
  store._scheduleTaskFlush=()=>{};
  store.tasks.push(localTask('failing-background'),localTask('confirmed-create'));
  assert.equal(await store.persistTask('confirmed-create'),true);
  await store._taskFlushPromise;
  assert.equal(store._readTaskOps().length,1);
  assert.equal(store._readTaskOps()[0].id,'failing-background');
  assert.equal(store.taskPersistError('confirmed-create'),'');
  assert.equal(store._taskPersistWaiters.size,0);
});

test('an explicit save waits for a newer same-task edit instead of accepting the older PUT receipt', async t => {
  let acceptCreate,acceptEdit;
  const created=new Promise(resolve=>{acceptCreate=resolve;}),edited=new Promise(resolve=>{acceptEdit=resolve;});
  const requests=[];
  const store=fixture({online:true,
    putTask:async(id,data)=>{
      requests.push({...data});await (requests.length===1?created:edited);return {...data,id,origin:'local'};
    },
  });
  t.after(async()=>{acceptCreate();acceptEdit();await store._taskFlushPromise;});
  store._scheduleTaskFlush=()=>{};
  store.tasks.push(localTask('edited-create'));
  let finished=false;
  const pending=store.persistTask('edited-create').then(result=>{finished=true;return result;});
  store.tasks[0].note='edited while saving';store._captureTaskChanges();
  acceptCreate();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(requests.map(row=>row.note),['must persist','edited while saving']);
  assert.equal(finished,false);
  acceptEdit();assert.equal(await pending,true);
  assert.equal(store.tasks[0].note,'edited while saving');
  assert.equal(store._taskPersistWaiters.size,0);
});

test('a create queued during an older flush is drained before persistTask returns', async () => {
  const created = [];
  const store = fixture({
    online: true,
    putTask: async (id, data) => {
      created.push(id);
      return Object.assign({ id, origin: 'local' }, data);
    },
  });
  let release;
  const base = new Promise((resolve) => { release = resolve; });
  const active = base.finally(() => {
    if (store._taskFlushPromise === active) store._taskFlushPromise = null;
  });
  store._taskFlushPromise = active;
  store.tasks.push(localTask('late-create'));

  const persisted = store.persistTask('late-create');
  release(true);

  assert.equal(await persisted, true);
  assert.deepEqual(created, ['late-create']);
  assert.equal(store._readTaskOps().length, 0);
  assert.equal(store.tasks.some((task) => task.id === 'late-create'), true);
});

test('an explicit create falls back to idempotent PUT when the persistent outbox is full', async () => {
  const created = [];
  const store = fixture({
    online: true,
    putTask: async (id, data) => {
      created.push(id);
      return Object.assign({ id, origin: 'local' }, data);
    },
  }, true);
  store.tasks.push(localTask('quota-create'));

  assert.equal(await store.persistTask('quota-create'), true);
  assert.deepEqual(created, ['quota-create']);
  assert.equal(store.tasks.some((task) => task.id === 'quota-create'), true);
});

test('a stale local PUT reconciles to the creator read-only tracking task', async () => {
  const serverTask = Object.assign(localTask('assigned-race'), {
    note: 'server assignment',
    origin: 'dispatch',
    readOnly: true,
    myRoles: ['creator', 'requester'],
  });
  const store = fixture({
    online: true,
    putTask: async () => {
      const error = new Error('HTTP 409: task belongs to another device');
      error.status = 409;
      throw error;
    },
    getTask: async () => serverTask,
  });
  store.tasks.push(Object.assign(localTask('assigned-race'), { note: 'stale local create' }));

  assert.equal(await store.persistTask('assigned-race'), true);
  assert.equal(store._readTaskOps().length, 0);
  assert.equal(store.tasks.find((task) => task.id === 'assigned-race').readOnly, true);
  assert.equal(store.tasks.find((task) => task.id === 'assigned-race').note, 'server assignment');
  assert.equal(store.taskPersistError('assigned-race'), '');
});

test('a read-only assignment event clears a queued local write before overlay', () => {
  const store = fixture({ online: true });
  store.tasks.push(Object.assign(localTask('event-race'), { note: 'stale local create' }));
  store._writeTaskOps([{
    id: 'event-race',
    kind: 'put',
    token: 'old-window',
    data: Object.assign(localTask('event-race'), { note: 'stale local create' }),
  }]);

  store.applyServerEvent({
    type: 'task.updated',
    task: Object.assign(localTask('event-race'), {
      note: 'assigned on server',
      origin: 'dispatch',
      readOnly: true,
      myRoles: ['creator'],
    }),
  });

  const visible = store.tasks.find((task) => task.id === 'event-race');
  assert.equal(store._readTaskOps().length, 0);
  assert.equal(visible.readOnly, true);
  assert.equal(visible.note, 'assigned on server');
});


test('a rejected completion restores server truth and explains why', async () => {
  const serverTask = Object.assign(localTask('gated-done'), { status: 'doing', progress: [] });
  const store = fixture({
    online: true,
    patchTask: async () => Object.assign({}, serverTask, {
      statusTransition: {
        applied: false,
        code: 'delivery_incomplete',
        message: '任务还不能完成：缺少验收证据',
      },
    }),
  });
  store._rememberServerTask(serverTask);
  store.tasks.push(Object.assign({}, serverTask, {
    status: 'done',
    progress: [{ text: '已完成', at: Date.now() }],
  }));

  assert.equal(await store.persistTask('gated-done'), true);
  const visible = store.tasks.find((task) => task.id === 'gated-done');
  assert.equal(visible.status, 'doing');
  assert.deepEqual(visible.progress, []);
  assert.equal(Object.hasOwn(visible, 'statusTransition'), false);
  assert.equal(store._readTaskOps().length, 0);
  assert.equal(store.__events.some((event) =>
    event.type === 'soduwork-task-sync-error' &&
    event.detail.error === 'delivery_incomplete'), true);
  assert.equal(store.__said.some((text) => text.includes('缺少验收证据')), true);
});

test('a Hub refresh preserves a confirmed task priority edit until its PATCH is acknowledged', async () => {
  const original = Object.assign(localTask('priority-refresh'), { priority: 'low' });
  let releaseSnapshot;
  const snapshot = new Promise(resolve => { releaseSnapshot = resolve; });
  const patches = [];
  const store = fixture({
    online: true,
    getTasksSnapshot: () => snapshot,
    getConfig: async () => ({}),
    patchTask: async (id, data) => { patches.push(data); return { ...original, ...data }; },
  });
  store._scheduleTaskFlush = () => {};
  store.initLocal();
  store._rememberServerTask(original);
  store.tasks.push({ ...original });
  const refresh = store.hydrate(true);
  store.tasks[0].priority = 'normal';
  store.save();
  releaseSnapshot({ online: true, items: [{ ...original }] });
  await refresh;
  assert.equal(store._shadow[original.id].priority, 'low');
  assert.equal(store.tasks[0].priority, 'normal');
  store.save(); // A later field blur must not cancel the still-pending edit.
  assert.equal(store._readTaskOps()[0].data.priority, 'normal');
  assert.equal(await store._flushTaskOps(), true);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].priority, 'normal');
  assert.equal(store.tasks[0].priority, 'normal');
  assert.equal(store._readTaskOps().length, 0);
});

test('pending edits cannot revive tasks missing from the current Hub or alter read-only tasks', async () => {
  const readOnly = { ...localTask('readonly'), readOnly: true, priority: 'low' };
  const store = fixture({
    online: true,
    getTasksSnapshot: async () => ({ online: true, items: [readOnly] }),
    getConfig: async () => ({}),
  });
  store._scheduleTaskFlush = () => {};
  store._writeTaskOps([
    { id: 'missing', kind: 'patch', data: { priority: 'critical' } },
    { id: 'unconfirmed', kind: 'put', data: localTask('unconfirmed') },
    { id: 'readonly', kind: 'patch', data: { priority: 'critical' } },
  ]);
  await store.hydrate(true);
  assert.equal(store.tasks.length, 1);
  assert.equal(store.tasks[0].id, 'readonly');
  assert.equal(store.tasks[0].priority, 'low');
  assert.equal(store._readTaskOps().some(op => op.id === 'missing' || op.id === 'readonly'), false);
});

test('a create confirmed after a concurrent empty Hub snapshot becomes visible again', async () => {
  let accept;
  const receipt = new Promise(resolve => { accept = resolve; });
  const store = fixture({
    online: true,
    getTasksSnapshot: async () => ({ online: true, items: [] }),
    putTask: () => receipt,
  });
  store._scheduleTaskFlush = () => {};
  store.initLocal();
  const task = localTask('snapshot-create');
  store.tasks.push(task);
  const submission = store.persistTask(task.id);
  await store.hydrate(true);
  assert.equal(store.tasks.length, 0, 'the unconfirmed local draft is not Hub truth');
  accept({ ...task, canEditRequirement: true });
  assert.equal(await submission, true);
  assert.equal(store.tasks.length, 1, 'the successful receipt restores the confirmed requirement');
  assert.equal(store.tasks[0].id, 'snapshot-create');
  assert.equal(store.tasks[0].canEditRequirement, true);
  assert.equal(store._readTaskOps().length, 0);
});

test('a lost create receipt is confirmed by a single-task Hub read before reporting failure', async t => {
  let server;
  const store = fixture({
    online: true,
    putTask: async (id, data) => {
      server = { ...data, id, origin: 'local', canEditRequirement: true };
      throw new Error('connection lost after commit');
    },
    getTask: async id => server?.id === id ? { ...server } : null,
  });
  t.after(() => clearTimeout(store._taskRetryT));
  store._scheduleTaskFlush = () => {};
  store.tasks.push(localTask('ack-lost-create'));
  assert.equal(await store.persistTask('ack-lost-create'), true);
  assert.equal(store._readTaskOps().length, 0);
  assert.equal(store.tasks[0].canEditRequirement, true);
  assert.equal(store.taskPersistError('ack-lost-create'), '');
});

for (const entry of ['conversation', 'board']) {
  test(`${entry} retains an uncertain create for the same-id retry without deleting a committed Hub row`, async t => {
    let connected = false;
    const server = new Map(), writes = [], deleted = [];
    const store = fixture({
      online: true,
      putTask: async (id, data) => {
        writes.push(id);
        const task = { ...data, id, origin: 'local', canEditRequirement: true };
        server.set(id, task);
        if (!connected) throw new Error('connection lost after commit');
        return { ...task };
      },
      getTask: async id => {
        if (!connected) throw new Error('network unavailable');
        return server.get(id);
      },
      deleteTask: async id => { deleted.push(id); server.delete(id); },
    });
    t.after(() => { clearTimeout(store._taskRetryT); clearTimeout(store._syncT); });
    store._scheduleTaskFlush = () => {};
    store.initLocal();
    const ctx = store.__context;
    ctx.Requirements = { dateTimestamp: () => null };
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/panels/panels-compose-submit.js'), 'utf8'), ctx);
    const state = { id: `${entry}-uncertain` }, record = ctx.ComposeDraftSubmit.card({}, null);
    record.submission = state;
    const input = { draft: { title: 'Preserve the requirement', check: [], who: { kind: 'me' } },
      options: { saveOnly: entry === 'board' }, state, card: record, btn: {},
      current: () => true, done() {}, note: 'Original request' };

    await ctx.ComposeDraftSubmit.createRequirement(input);
    await store._flushTaskOps();
    assert.equal(record.phase, 'error');
    assert.equal(store.tasks.length, 0, 'the uncertain local draft is not a requirement card');
    assert.equal(server.size, 1, 'a transport failure must not delete a committed requirement');
    assert.equal(deleted.length, 0);
    assert.equal(store._readTaskOps().length, 1);
    assert.equal(store._readTaskOps()[0].kind, 'put');
    assert.ok(store._readTaskOps()[0].blocked, 'background refresh must not silently resubmit an uncertain draft');

    connected = true;
    await ctx.ComposeDraftSubmit.createRequirement(input);
    assert.equal(record.phase, 'succeeded');
    assert.equal(record.receipt.id, `${entry}-uncertain`);
    assert.equal(server.size, 1);
    assert.equal(store.tasks.length, 1);
    assert.equal(store._readTaskOps().length, 0);
    assert.ok(writes.every(id => id === `${entry}-uncertain`));
    assert.equal(deleted.length, 0);
  });
}

test('the standalone requirement form retries an uncertain save with its original task id', async t => {
  let connected = false;
  const server = new Map(), written = [], deleted = [];
  const store = fixture({
    online: true,
    putTask: async (id, data) => {
      written.push(id); server.set(id, { ...data, id, origin: 'local' });
      if (!connected) throw new Error('connection lost after commit');
      return server.get(id);
    },
    getTask: async id => { if (!connected) throw new Error('offline'); return server.get(id); },
    deleteTask: async id => { deleted.push(id); server.delete(id); },
  });
  t.after(() => { clearTimeout(store._taskRetryT); clearTimeout(store._syncT); });
  store._scheduleTaskFlush = () => {};
  const ctx = store.__context;
  const fields = new Map(['inTitle', 'inSource', 'inNote', 'inStatus'].map(id =>
    [id, { value: id === 'inTitle' ? 'Standalone requirement' : '' }]));
  ctx.document.getElementById = id => fields.get(id) || null;
  ctx.document.querySelector = () => null;
  ctx.render = () => {};
  ctx._todayInputValue = () => '2026-10-20';
  ctx._openCreatedTaskInChat = () => {};
  ctx._addAssignLoading = false;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/panels/panels-add.js'), 'utf8'), ctx);
  vm.runInContext('_addExecutionContext = () => ({repo:null}); _addGoPayload = () => null;', ctx);
  await ctx._submitAdd();
  const originalId = written[0];
  assert.equal(store.tasks.length, 0);
  assert.equal(server.size, 1);
  assert.equal(deleted.length, 0);
  connected = true;
  await ctx._submitAdd();
  assert.equal(server.size, 1, 'retry must not create a second requirement');
  assert.ok(written.every(id => id === originalId));
  assert.equal(store.tasks.length, 1);
  assert.equal(store._readTaskOps().length, 0);
});

test('a late create confirmation cannot discard a newer explicit delete', async t => {
  let confirm, reading;
  const ready = new Promise(resolve => { reading = resolve; });
  const receipt = new Promise(resolve => { confirm = resolve; });
  const task = { ...localTask('confirmation-delete'), canEditRequirement: true };
  const store = fixture({
    online: true,
    putTask: async () => { throw new Error('lost receipt'); },
    getTask: () => { reading(); return receipt; },
  });
  t.after(() => clearTimeout(store._taskRetryT));
  store._scheduleTaskFlush = () => {};
  store.tasks.push(task);
  const submission = store.persistTask(task.id);
  await ready;
  assert.ok(store.removeTask(task.id, 0, task));
  confirm(task);
  await submission;
  assert.equal(store.tasks.length, 0);
  assert.equal(store._readTaskOps().length, 1);
  assert.equal(store._readTaskOps()[0].kind, 'delete');
});

test('switching identity during create confirmation cannot fill the new account', async t => {
  let owner = 'account-a', confirm, reading;
  const ready = new Promise(resolve => { reading = resolve; });
  const receipt = new Promise(resolve => { confirm = resolve; });
  const store = fixture({
    online: true, taskStorageKey: kind => `${owner}-${kind}`,
    putTask: async () => { throw new Error('lost receipt'); },
    getTask: () => { reading(); return receipt; },
  });
  t.after(() => clearTimeout(store._taskRetryT));
  store._scheduleTaskFlush = () => {};
  store.tasks.push(localTask('old-account'));
  const submission = store.persistTask('old-account');
  await ready;
  owner = 'account-b'; store.beginEnvironmentSwitch();
  confirm(localTask('old-account'));
  assert.equal(await submission, false);
  assert.equal(store.tasks.length, 0);
  assert.equal(Object.keys(store._shadow).length, 0);
  assert.equal(store._readTaskOps().length, 0);
});

test('an explicit validation rejection cannot be replaced by a stale server copy', async () => {
  let reads = 0;
  const store = fixture({
    online: true,
    putTask: async () => { const error = new Error('HTTP 422: invalid request'); error.status = 422; throw error; },
    getTask: async () => { reads++; return localTask('rejected-create'); },
  });
  store._scheduleTaskFlush = () => {};
  store.tasks.push(localTask('rejected-create'));
  assert.equal(await store.persistTask('rejected-create'), false);
  store.pauseUnconfirmedTask('rejected-create');
  assert.equal(reads, 0);
  assert.equal(store.tasks.length, 0);
  assert.match(store.taskPersistError('rejected-create'), /422/);
  assert.equal(store._readTaskOps()[0].kind, 'put');
  assert.ok(store._readTaskOps()[0].blocked);
});

for (const preparation of ['load-options', 'pending-options', 'pending-assignee', 'plugin-preflight']) {
test(`the standalone form cannot submit an old account draft after ${preparation}`, async () => {
  let owner = 'account-a', release, preparing;
  const pending = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { preparing = resolve; });
  const written = [];
  const store = fixture({
    online: true, taskStorageKey: kind => `${owner}-${kind}`,
    putTask: async (id, data) => { written.push({ owner, ...data }); return { id, ...data }; },
    createAssignedTask: async data => { written.push({ owner, ...data }); return { task: { id: data.taskId } }; },
  });
  store._scheduleTaskFlush = () => {};
  const ctx = store.__context;
  const fields = new Map(['inTitle', 'inSource', 'inNote', 'inStatus'].map(id =>
    [id, { value: id === 'inTitle' ? 'Account A requirement' : '' }]));
  if (preparation === 'pending-assignee') {
    fields.set('assignField', { style: { display: '' } });
    fields.set('inAssign', { value: 'mate' });
  }
  ctx.document.getElementById = id => fields.get(id) || null;
  ctx.document.querySelector = () => null;
  ctx.render = () => {};
  ctx._todayInputValue = () => '2026-10-20';
  ctx._openCreatedTaskInChat = () => {};
  ctx._addAssignLoading = false;
  ctx._addAssignMembers = [{ id: 'mate' }];
  ctx.prepareRequirement = () => { preparing(); return pending; };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/panels/panels-add.js'), 'utf8'), ctx);
  vm.runInContext('_addExecutionContext = () => ({repo:null}); _addGoPayload = () => null;', ctx);
  const setup = {
    'load-options': '_goStrategyValue = () => "direct"; _fillAddGo = prepareRequirement;',
    'pending-options': '_goStrategyValue = () => "direct"; _addGoQueryKey = JSON.stringify(_goRequestBody()); _addGoPending = prepareRequirement();',
    'pending-assignee': '_addAssignLoading = true; _addAssignPending = prepareRequirement();',
    'plugin-preflight': '_addGoPayload = () => ({plugin:{}}); _verifyAddPlugin = prepareRequirement;',
  };
  vm.runInContext(setup[preparation], ctx);
  const submission = ctx._submitAdd();
  await ready;
  owner = 'account-b'; store.beginEnvironmentSwitch();
  release(); await submission;
  assert.equal(written.length, 0, 'the old draft must never be written as the new account');
  assert.equal(store.tasks.length, 0);
  assert.equal(store._readTaskOps().length, 0);
});
}


test('fallback receipt recovery stays serial while the background lane resumes', async t => {
  let releaseA,releaseB,attempts=0,activeB=0,maxB=0;
  const a=new Promise(resolve=>{releaseA=resolve;}), b=new Promise(resolve=>{releaseB=resolve;});
  const store=fixture({online:true,putTask:async(id,data)=>{
    if(id==='a')await a;
    else {attempts++;activeB++;maxB=Math.max(maxB,activeB);
      try {if(attempts===1)throw Error('lost response');await b;}finally{activeB--;}}
    return {...data,id,origin:'local'};
  }});
  store._scheduleTaskFlush=()=>{};
  t.after(async()=>{releaseA();releaseB();await store._taskFlushPromise;await store._taskPriorityFlushPromise;clearTimeout(store._taskRetryT);});
  store.tasks.push(localTask('a'));store._captureTaskChanges();const background=store._flushTaskOps();
  store.tasks.push(localTask('b'));const first=store.persistTask('b');
  await new Promise(resolve=>setImmediate(resolve));assert.equal(attempts,2);
  const second=store.persistTask('b');releaseA();await background;
  assert.equal(attempts,2);assert.equal(maxB,1);
  releaseB();assert.deepEqual(await Promise.all([first,second]),[true,true]);
  assert.equal(store._readTaskOps().length,0);assert.equal(store._taskPersistJobs.size,0);
});

test('outbox quota fallback shares one same-task confirmation across concurrent submitters', async () => {
  let release,attempts=0;
  const pending=new Promise(resolve=>{release=resolve;});
  const store=fixture({online:true,putTask:async(id,data)=>{attempts++;await pending;return {...data,id};}},true);
  store.tasks.push(localTask('quota'));
  const first=store.persistTask('quota'),second=store.persistTask('quota');
  await new Promise(resolve=>setImmediate(resolve));assert.equal(attempts,1);
  release();assert.deepEqual(await Promise.all([first,second]),[true,true]);
});

for(const readOnly of [true,false])test('409 reconciliation preserves other tasks added while its GET is pending: '+readOnly,async t=>{
  let release,reads=0;
  const pending=new Promise(resolve=>{release=resolve;});const sent=[];
  const store=fixture({online:true,
    putTask:async(id,data)=>{sent.push(id);if(id==='conflict'){const e=Error('HTTP 409');e.status=409;throw e;}return {...data,id};},
    getTask:async()=>{reads++;await pending;return {...localTask('conflict'),readOnly};}
  });
  store._scheduleTaskFlush=()=>{};t.after(()=>clearTimeout(store._taskRetryT));
  store.tasks.push(localTask('conflict'));store._captureTaskChanges();const work=store._flushTaskOps();
  await new Promise(resolve=>setImmediate(resolve));assert.equal(reads,1);
  store.tasks.push(localTask('late'));store._captureTaskChanges();
  release();await work;
  if(!readOnly)await store._flushTaskOps();
  assert.ok(sent.includes('late'));assert.ok(store._shadow.late);
});


test('a second explicit save captures a newer edit while the same task is still being created',async()=>{
  let release;const waiting=new Promise(resolve=>{release=resolve;});const notes=[];
  const store=fixture({online:true,putTask:async(id,data)=>{notes.push(data.note);if(notes.length===1)await waiting;return {...data,id};}});
  store._scheduleTaskFlush=()=>{};store.tasks.push(localTask('changing'));
  const first=store.persistTask('changing');
  store.tasks[0].note='new explicit edit';const second=store.persistTask('changing');
  release();assert.deepEqual(await Promise.all([first,second]),[true,true]);
  assert.deepEqual(notes,['must persist','new explicit edit']);assert.equal(store._shadow.changing.note,'new explicit edit');
});


test('a failed first PUT retries the newer queued payload with its matching token',async t=>{
  let reject;const waiting=new Promise((resolve,no)=>{reject=no;});const notes=[];
  const store=fixture({online:true,putTask:async(id,data)=>{notes.push(data.note);if(notes.length===1)await waiting;return {...data,id};}});
  store._scheduleTaskFlush=()=>{};t.after(()=>clearTimeout(store._taskRetryT));
  store.tasks.push(localTask('changing-failure'));const first=store.persistTask('changing-failure');
  store.tasks[0].note='newer edit';const second=store.persistTask('changing-failure');
  reject(Error('lost receipt'));assert.deepEqual(await Promise.all([first,second]),[true,true]);
  assert.deepEqual(notes,['must persist','newer edit']);assert.equal(store._shadow['changing-failure'].note,'newer edit');
});

test('a delete queued before the first PUT failure is not replaced by a fallback create',async t=>{
  let reject;const waiting=new Promise((resolve,no)=>{reject=no;});let writes=0;const removed=[];
  const store=fixture({online:true,putTask:async()=>{writes++;await waiting;},deleteTask:async id=>removed.push(id)});
  store._scheduleTaskFlush=()=>{};t.after(()=>clearTimeout(store._taskRetryT));
  const task={...localTask('remove-before-failure'),canEditRequirement:true};store.tasks.push(task);
  const first=store.persistTask(task.id);store.removeTask(task.id,0,task);reject(Error('lost receipt'));
  assert.equal(await first,false);assert.equal(writes,1);
  assert.equal(store.tasks.length,0);assert.equal(store._readTaskOps()[0].kind,'delete');
  await store._flushTaskOps();assert.deepEqual(removed,[task.id]);assert.equal(store._readTaskOps().length,0);
});


test('a read-only server event during an in-flight save never spins while awaiting that request',async()=>{
  let release;const waiting=new Promise(resolve=>{release=resolve;});
  const server={...localTask('assigned-in-flight'),origin:'dispatch',readOnly:true,myRoles:['creator']};
  const store=fixture({online:true,putTask:async()=>{await waiting;return server;}});
  store.tasks.push(localTask(server.id));const pending=store.persistTask(server.id);
  // Fail fast if receipt-based polling is accidentally reintroduced.
  const flush=store._flushTaskFor.bind(store);let polls=0;
  store._flushTaskFor=(...args)=>{if(++polls>5)throw Error('receipt polling cannot wait for an active request');return flush(...args);};
  store.applyServerEvent({type:'task.updated',task:server});
  await new Promise(resolve=>setImmediate(resolve));release();
  assert.equal(await pending,true);assert.equal(store._taskInFlight[server.id],undefined);
});


test('an interactive drain does not cancel the pending retry of unrelated background work',async()=>{
  let release,retried=false;const timerFired=new Promise(resolve=>{release=resolve;});
  const store=fixture({online:true});
  store._taskRetryT=setTimeout(()=>{retried=true;release();},10);
  await store._flushTaskOps(true);
  await Promise.race([timerFired,new Promise(resolve=>setTimeout(resolve,50))]);
  assert.equal(retried,true);
});
