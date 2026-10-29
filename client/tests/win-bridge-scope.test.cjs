'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../core/win-bridge.js'), 'utf8');

function fixture() {
  const sent = [], applied = [], timers = new Map();
  let receive, nextTimer = 0, refreshes = 0;
  const owner = { hub: 'hub-a', device: 'device-a', user: 'alice', state: 'active' };
  const scope = () => [owner.hub, owner.device, owner.user].join(':');
  const context = {
    SoduWorkAPI: { taskStorageKey: scope,
      clientAuthSnapshot: () => ({ state: owner.state, user: owner.user ? { id: owner.user } : null }) },
    soduWorkAPI: { broadcast: (kind, payload) => sent.push({ kind, payload }), onBroadcast: fn => { receive = fn; } },
    Store: { _tasks: [], applyServerEvent(event) { applied.push(event); this._tasks.push(event.task); },
      async refreshTasks() { refreshes++; this._tasks = [{ id: owner.user + '-authorized' }]; } },
    localStorage: { getItem: () => null }, location: { pathname: '/desk.html' },
    document: { getElementById: () => null }, addEventListener() {}, dispatchEvent() {},
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  context.window = context;
  vm.runInNewContext(source, context, { filename: 'win-bridge.js' });
  return { owner, scope, sent, applied, context, receive: (...args) => receive(...args),
    refreshes: () => refreshes, async flush() {
      for (const [id, fn] of [...timers]) { timers.delete(id); await fn(); }
    } };
}
const event = () => ({ type: 'task.created', task: { id: 'alice-private', title: 'Private requirement' },
  arrival: 'assign', by: 'Alice', autoOpen: true, notificationId: 'notice-1' });

test('same authenticated scope relays assignment semantics without trusting event-supplied provenance', () => {
  const from = fixture(), to = fixture();
  from.context.WinSync.pushTaskEvent({ ...event(), taskScope: 'spoofed' });
  const message = from.sent[0];
  assert.equal(message.kind, 'task-event'); assert.equal(message.payload.taskScope, from.scope());
  to.receive(message.kind, message.payload);
  assert.equal(to.context.Store._tasks[0].id, 'alice-private');
  assert.equal(to.applied[0].__fromWindow, true);
  for (const key of ['arrival', 'by', 'autoOpen', 'notificationId']) assert.equal(to.applied[0][key], event()[key]);
  assert.equal(to.sent.length, 0, 'receiving never broadcasts the event back');
});

for (const [boundary, value] of [['user', 'bob'], ['hub', 'hub-b'], ['device', 'device-b'], ['state', 'pending']]) {
  test('late task relay cannot fill a renderer after its ' + boundary + ' changes', () => {
    const f = fixture(); f.context.WinSync.pushTaskEvent(event());
    const pending = f.sent[0]; f.owner[boundary] = value;
    f.context.Store._tasks = [{ id: 'current-account-task' }];
    f.receive(pending.kind, pending.payload);
    assert.equal(f.applied.length, 0);
    assert.deepEqual(f.context.Store._tasks, [{ id: 'current-account-task' }]);
  });
}

test('legacy task broadcasts only refresh current authorized data and never insert the payload', async () => {
  const f = fixture(); f.owner.user = 'bob';
  f.receive('task-event', event());
  assert.equal(f.applied.length, 0); assert.equal(f.context.Store._tasks.length, 0);
  await f.flush();
  assert.equal(f.refreshes(), 1); assert.equal(f.context.Store._tasks[0].id, 'bob-authorized');
});

test('unbound and logged-out renderers send invalidations without task contents', () => {
  for (const identity of [{ user: '', state: 'active' }, { user: 'alice', state: 'pending' }]) {
    const f = fixture(); Object.assign(f.owner, identity);
    f.context.WinSync.pushTaskEvent(event());
    assert.equal(f.sent[0].kind, 'tasks'); assert.equal(f.sent[0].payload, null);
  }
});
