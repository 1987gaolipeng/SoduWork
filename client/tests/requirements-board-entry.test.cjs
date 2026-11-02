'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Requirements = require('../core/requirements.js');

function fixture(saved) {
  class Node {
    constructor() {
      this.children = new Map(); this.classes = new Set(); this.scrollTop = 0; this.dataset = {};
      this.classList = { contains: name => this.classes.has(name), add: name => this.classes.add(name), remove: name => this.classes.delete(name),
        toggle: (name, value) => value ? this.classes.add(name) : this.classes.delete(name) };
    }
    querySelector(selector) {
      if (!this.children.has(selector)) this.children.set(selector, new Node());
      return this.children.get(selector);
    }
    querySelectorAll() { return []; }
    matches() { return false; }
    contains() { return false; }
    setAttribute() {}
  }
  const root = new Node(), rendered = [], stored = new Map([['account:requirement-view', JSON.stringify(saved)]]);
  const context = { Requirements,
    RequirementsView: { labels: {phase: '', kind: '', priority: '', project: '', owner: '', tag: '', due: '', attention: ''},
      icon: () => '', chips: () => '', options: () => '', board: (rows, state) => { rendered.push({ids: rows.map(row => row.id), state: {...state}}); return ''; } },
    document: { getElementById: id => id === 'historyBoard' ? root : null, activeElement: null },
    localStorage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) },
    SoduWorkAPI: { taskStorageKey: () => 'account' }, Store: {taskState: 'ready'},
    tasks: [
      {id: 'review', status: 'done', title: '待验收需求', kind: 'requirement', myRoles: ['creator']},
      {id: 'running', status: 'doing', title: '进行中的需求', myRoles: ['creator', 'executor']},
      {id: 'archived', status: 'done', archivedAt: 1, title: '归档需求', myRoles: ['creator']},
    ],
    addEventListener() {},
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/requirements/requirements-board.js'), 'utf8'), context);
  return {api: context.RequirementsBoard, root, rendered, stored, context};
}

test('explicit acceptance entry clears unrelated filters and opens the current review stage', () => {
  const f = fixture({scope: 'created', archive: 'archived', kind: 'bug', owner: 'another', project: 'old', due: 'overdue'});
  f.api.open({phase: 'reviewing'});
  assert.ok(f.rendered.length, 'pending review remains visible after entering from unrelated saved filters');
  const {ids, state} = f.rendered.at(-1);
  assert.deepEqual(ids, ['review']);
  assert.equal(state.phase, 'reviewing');
  assert.equal(state.archive, 'active');
  for (const key of ['q', 'kind', 'priority', 'project', 'owner', 'tag', 'due', 'attention']) assert.equal(state[key], '');
  assert.equal(state.onlyOverdue, false);
});

test('ordinary entry defaults to actionable while preserving other saved filters', () => {
  const f = fixture({scope: 'created', archive: 'active', phase: 'delivering'});
  f.api.open();
  assert.deepEqual(f.rendered.at(-1).ids, ['running']);
  assert.equal(f.rendered.at(-1).state.phase, 'delivering');
  assert.equal(f.rendered.at(-1).state.scope, 'actionable');
});

test('entering the pool reconciles a stale failure without rerunning the requirement', async () => {
  const f = fixture({}), row = f.context.tasks.find(task => task.id === 'running');
  row.ai = {state: 'failed', error: 'Old routing failure'};
  let refreshes = 0;
  f.context.Store.refreshTasks = async () => {
    refreshes++;
    await Promise.resolve();
    row.ai = {state: 'done', executionState: 'done'};
  };
  assert.equal(Requirements.blocked(row), true);
  f.api.open();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshes, 1);
  assert.equal(Requirements.blocked(row), false);
  f.api.open(); f.api.render();
  assert.equal(refreshes, 1, 'rendering an already open pool does not poll');
  f.api.close(); f.api.open();
  assert.equal(refreshes, 2, 'a new navigation reconciles missed updates');
});

test('a failed pool refresh preserves the last known execution state and view', async () => {
  const f = fixture({phase: 'delivering'}), row = f.context.tasks.find(task => task.id === 'running');
  row.ai = {state: 'failed', error: 'Current failure'};
  f.context.Store.refreshTasks = async () => { throw Error('offline'); };
  f.api.open();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(Requirements.blocked(row), true);
  assert.equal(f.rendered.at(-1).state.phase, 'delivering');
  assert.deepEqual(f.rendered.at(-1).ids, ['running']);
});

test('every pool entry restores current actionable work instead of archived or saved scope', () => {
  for (const scope of ['created', 'actionable', 'related', 'all']) {
    const f = fixture({scope, archive: 'archived', v: 2});
    f.api.open();
    assert.equal(f.rendered.at(-1).state.scope, 'actionable');
    assert.equal(f.rendered.at(-1).state.archive, 'active');
    assert.deepEqual(f.rendered.at(-1).ids, ['running']);
    assert.match(f.root.querySelector('.rq-scopes').innerHTML, /data-rq-scope="actionable"/);
  }
});

test('visible pool refresh and repeated open preserve explicit view; navigation back resets scope', async () => {
  const f = fixture({});
  f.api.open({phase: 'reviewing'});
  f.api.render(true); await f.api.refresh(); f.api.open();
  assert.equal(f.rendered.at(-1).state.scope, 'all');
  assert.equal(f.rendered.at(-1).state.phase, 'reviewing');
  f.api.close(); f.api.open();
  assert.equal(f.root.querySelector('#rqScope').value, 'actionable');
  assert.equal(f.root.querySelector('#rqArchive').value, 'active');
});

function moveFixture() {
  const f = fixture({scope:'all', archive:'active'}), c = f.context;
  c.tasks = [{id:'move',status:'todo',triageStage:'intake',requirementVersion:3,canEditRequirement:true,myRoles:['assignee']}];
  const events = [], notices = [];
  c.Store.applyServerEvent = event => {events.push(event);c.tasks[0]=event.task;};
  c.petSay = text => notices.push(text);
  f.api.open();
  return {...f,c,events,notices};
}
test('preparation move uses one versioned write and renders authoritative reply without list reads', async () => {
  const f=moveFixture();
  f.c.SoduWorkAPI.getTask=async()=>{throw Error('unnecessary detail read');};
  f.c.Store.refreshTasks=async()=>{throw Error('unnecessary list read');};
  const writes=[];
  f.c.SoduWorkAPI.patchTask=async(id,patch)=>{writes.push({id,...patch});return {...f.c.tasks[0],triageStage:'ready',requirementVersion:4};};
  await f.api.move('move','ready');
  assert.equal(writes.length,1);assert.equal(writes[0].requirementVersion,3);
  assert.equal(f.events.length,1);assert.equal(f.c.tasks[0].triageStage,'ready');
  assert.deepEqual(f.notices,[]);
});
test('lost move response checks the saved task and does not report a confirmed write as failed', async () => {
  const f=moveFixture();let writes=0,reads=0;
  f.c.SoduWorkAPI.patchTask=async()=>{writes++;throw Error('request timeout');};
  f.c.SoduWorkAPI.getTask=async()=>{reads++;return {...f.c.tasks[0],triageStage:'ready',requirementVersion:4};};
  await f.api.move('move','ready');
  assert.equal(writes,1);assert.equal(reads,1);assert.equal(f.events.length,1);assert.deepEqual(f.notices,[]);
});
test('rejected version is not retried or presented as a successful move', async () => {
  const f=moveFixture();let writes=0;
  f.c.SoduWorkAPI.patchTask=async()=>{writes++;throw Object.assign(Error('version conflict'),{status:409});};
  await f.api.move('move','ready');
  assert.equal(writes,1);assert.equal(f.events.length,0);assert.deepEqual(f.notices,['version conflict']);
});
test('late move response after identity switch cannot update the current account', async () => {
  const f=moveFixture();let resolve;
  f.c.SoduWorkAPI.patchTask=()=>new Promise(done=>{resolve=done;});
  const moving=f.api.move('move','ready');
  f.c.SoduWorkAPI.taskStorageKey=()=> 'other-account';
  resolve({...f.c.tasks[0],triageStage:'ready',requirementVersion:4});await moving;
  assert.equal(f.events.length,0);
});

test('pending move is visible through refreshes and cleared on success or rejection', async () => {
  for (const failed of [false,true]) {
    const f=moveFixture();let resolve,reject;
    f.c.SoduWorkAPI.patchTask=()=>new Promise((yes,no)=>{resolve=yes;reject=no;});
    const moving=f.api.move('move','ready');
    assert.equal(f.rendered.at(-1).state.movingId,'move');
    f.api.render(true);
    assert.equal(f.rendered.at(-1).state.movingId,'move');
    if (failed) reject(Object.assign(Error('rejected'),{status:409}));
    else resolve({...f.c.tasks[0],triageStage:'ready',requirementVersion:4});
    await moving;
    assert.equal(f.rendered.at(-1).state.movingId,'');
  }
});
