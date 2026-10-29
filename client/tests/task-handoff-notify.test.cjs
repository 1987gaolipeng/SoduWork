const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const TaskSync = require('../core/task-sync.js');

const source = fs.readFileSync(path.join(__dirname, '../core/store-lifecycle.js'), 'utf8') + '\n' +
  fs.readFileSync(path.join(__dirname, '..', 'core', 'store.js'), 'utf8');

function fixture(api, seed) {
  const values = seed instanceof Map ? seed : new Map(Object.entries(seed || {}));
  const events = [];
  const timers = [];
  const localStorage = {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  const petSays = [];
  const context = {
    SoduWorkAPI: api,
    soduWorkAPI: null,
    localStorage,
    TaskSync,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    document: {
      activeElement: null,
      getElementById: () => null,
      querySelectorAll: () => [],
      documentElement: { setAttribute() {} },
    },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    location: { reload() {} },
    console: { log() {}, error() {} },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    setInterval: (fn, ms) => { timers.push({ fn, ms, interval: true }); return timers.length; },
    clearInterval() {},
    petSay: (text) => petSays.push(text),
  };
  context.window = context;
  context.dispatchEvent = (event) => events.push(event);
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'store.js' });
  return {
    context, values, events, timers, petSays,
    Store: vm.runInContext('Store', context),
    initData: vm.runInContext('initData', context),
  };
}

/*
 * Read persisted notification records rather than depending on Store's private closure.
 */
function savedNotices(f) {
  const raw = [...f.values.entries()].find(([k]) => /notices/.test(k));
  if (!raw) return [];
  try { const v = JSON.parse(raw[1]); return Array.isArray(v) ? v : (v.items || []); } catch { return []; }
}

function seedOne(status, readOnly) {
  const task = { id: 'h-1', title: '狂野飙车基础版', status, origin: 'local', myRoles: ['creator'] };
  if (readOnly) task.readOnly = true;
  return task;
}

function updated(task) {
  return { type: 'task.updated', task: Object.assign({ myRoles: ['creator'] }, task) };
}

test('转出的需求被完成时，转交人收到通知与气泡提醒', () => {
  const f = fixture({ online: true, connectWS: () => () => {} }, {});
  f.Store.tasks.push(seedOne('doing', true));
  f.Store._setShadow([seedOne('doing', true)]);
  f.Store.save();
  f.Store.applyServerEvent(updated({ id: 'h-1', title: '狂野飙车基础版', status: 'done', readOnly: true }));
  assert.deepEqual(f.petSays, ['你转出的「狂野飙车基础版」已完成，点击查看结果']);
  const rows = savedNotices(f);
  assert.equal(rows.length, 1);
  assert.match(rows[0].text, /已完成/);
  assert.equal(rows[0].kind, 'handoff.done');
  assert.equal(rows[0].taskId, 'h-1');
});

test('同一任务同一状态只提醒一次，不随重复事件刷屏', () => {
  const f = fixture({ online: true, connectWS: () => () => {} }, {});
  f.Store.tasks.push(seedOne('doing', true));
  f.Store._setShadow([seedOne('doing', true)]);
  f.Store.save();
  const ev = updated({ id: 'h-1', title: '狂野飙车基础版', status: 'done', readOnly: true });
  f.Store.applyServerEvent(ev);
  f.Store.applyServerEvent(ev);
  f.Store.applyServerEvent(ev);
  assert.deepEqual(f.petSays, ['你转出的「狂野飙车基础版」已完成，点击查看结果']);
  assert.equal(savedNotices(f).length, 1);
});

test('双窗口收到同一次完成事件，只保存一条并仅首次提醒', () => {
  const shared = new Map(), api = { online: true, connectWS: () => () => {} };
  const first = fixture(api, shared), second = fixture(api, shared);
  for (const f of [first, second]) {
    f.Store.tasks.push(seedOne('doing', true));
    f.Store._setShadow([seedOne('doing', true)]);
  }
  const event = updated({ ...seedOne('done', true), updatedAt: 900, actualEnd: 900 });
  first.Store.applyServerEvent(event);
  // Simulate notification synchronization while another window retains an active-task snapshot.
  vm.runInContext('notices.splice(0, notices.length, ..._readNotices())', second.context);
  second.Store.applyServerEvent(event);
  assert.equal(savedNotices(first).length, 1);
  assert.equal(first.petSays.length + second.petSays.length, 1);
});

test('重开窗口重放相同完成事件不重复，真正重跑完成仍新增通知', () => {
  const values = new Map(), api = { online: true, connectWS: () => () => {} };
  for (const actualEnd of [900, 900, 1900]) {
    const f = fixture(api, values);
    f.Store.tasks.push(seedOne('doing', true));
    f.Store._setShadow([seedOne('doing', true)]);
    f.Store.applyServerEvent(updated({ ...seedOne('done', true), actualEnd, updatedAt: actualEnd }));
  }
  assert.equal(JSON.parse(values.get('soduwork_work_notices_v1')).length, 2);
});

test('同次执行按服务端结束时间去重，后续updatedAt变化不产生第二条', () => {
  const values = new Map(), api = { online: true, connectWS: () => () => {} };
  for (const updatedAt of [900, 1900]) {
    const f = fixture(api, values);
    f.Store.tasks.push(seedOne('doing', true));
    f.Store._setShadow([seedOne('doing', true)]);
    f.Store.applyServerEvent(updated({ ...seedOne('done', true), actualEnd: 800, updatedAt }));
  }
  assert.equal(JSON.parse(values.get('soduwork_work_notices_v1')).length, 1);
});

test('旧事件没有服务端时间时仍按任务与状态在重开窗口后去重', () => {
  const values = new Map(), api = { online: true, connectWS: () => () => {} };
  for (let index = 0; index < 2; index++) {
    const f = fixture(api, values);
    f.Store.tasks.push(seedOne('doing', true));f.Store._setShadow([seedOne('doing', true)]);
    f.Store.applyServerEvent(updated(seedOne('done', true)));
  }
  assert.equal(JSON.parse(values.get('soduwork_work_notices_v1')).length, 1);
});

test('执行失败也会提醒；已完结后再变化不重复提醒', () => {
  const f = fixture({ online: true, connectWS: () => () => {} }, {});
  f.Store.tasks.push(seedOne('doing', true));
  f.Store._setShadow([seedOne('doing', true)]);
  f.Store.save();
  f.Store.applyServerEvent(updated({ id: 'h-1', title: 'X', status: 'failed', readOnly: true }));
  assert.equal(f.petSays.length, 1);
  assert.match(f.petSays[0], /执行失败/);
  f.Store.applyServerEvent(updated({ id: 'h-1', title: 'X', status: 'doing', readOnly: true }));
  assert.equal(f.petSays.length, 1, '已完结后状态抖动不再提醒');
});

test('对方开始执行（进入 doing/running）提醒一次，进度事件不重复', () => {
  const f = fixture({ online: true, connectWS: () => () => {} }, {});
  f.Store.tasks.push(seedOne('todo', true));
  f.Store._setShadow([seedOne('todo', true)]);
  f.Store.save();
  f.Store.applyServerEvent(updated({ id: 'h-1', title: 'X', status: 'doing', readOnly: true }));
  assert.equal(f.petSays.length, 1);
  assert.equal(f.petSays[0], '「X」已开始执行');
  f.Store.applyServerEvent(updated({ id: 'h-1', title: 'X', status: 'doing', readOnly: true }));
  assert.equal(f.petSays.length, 1);
});

test('自己承办的任务（非转出）与首条快照事件都不触发提醒', () => {
  const f = fixture({ online: true, connectWS: () => () => {} }, {});
  f.Store.tasks.push(seedOne('doing', false));
  f.Store._setShadow([seedOne('doing', false)]);
  f.Store.save();
  f.Store.applyServerEvent(updated({ id: 'h-1', title: 'X', status: 'done' }));
  assert.equal(f.petSays.length, 0, '自己的任务不走转交提醒');
  const g = fixture({ online: true, connectWS: () => () => {} }, {});
  g.Store.applyServerEvent(updated({ id: 'h-2', title: 'Y', status: 'done', readOnly: true }));
  assert.equal(g.petSays.length, 0, '无本地基线（hydrate 场景）不提醒');
});

for (const [before, after] of [['todo', 'doing'], ['doing', 'done'], ['doing', 'failed']]) {
  test('团队可见需求变为 ' + after + ' 时不向无关同事生成个人通知', () => {
    const f = fixture({ online: true, connectWS: () => () => {} }, {});
    const task = { ...seedOne(before, true), myRoles: [] };
    f.Store.tasks.push(task);
    f.Store._setShadow([task]);
    f.Store.applyServerEvent(updated({ ...task, status: after }));
    assert.equal(f.Store.tasks[0].status, after, '团队需求状态仍正常刷新');
    assert.equal(savedNotices(f).length, 0, '可见需求不等于应接收个人通知');
    assert.deepEqual(f.petSays, [], '无关同事不出现气泡提醒');
  });
}

for (const role of ['observer', 'assignee', 'executor']) {
  test('只有 ' + role + ' 角色不应被视为转交人', () => {
    const f = fixture({ online: true, connectWS: () => () => {} }, {});
    const task = { ...seedOne('doing', true), myRoles: [role] };
    f.Store.tasks.push(task);
    f.Store._setShadow([task]);
    f.Store.applyServerEvent(updated({ ...task, status: 'done' }));
    assert.equal(savedNotices(f).length, 0);
    assert.deepEqual(f.petSays, []);
  });
}

test('已失去参与角色的当前事件不能借用旧缓存中的创建人身份', () => {
  const f = fixture({ online: true, connectWS: () => () => {} }, {});
  f.Store.tasks.push(seedOne('doing', true));
  f.Store._setShadow([seedOne('doing', true)]);
  f.Store.applyServerEvent(updated({ ...seedOne('done', true), myRoles: [] }));
  assert.equal(savedNotices(f).length, 0);
  assert.deepEqual(f.petSays, []);
});

test('缺少参与角色的旧格式事件不凭只读状态推断转交人', () => {
  const f = fixture({ online: true, connectWS: () => () => {} }, {});
  f.Store.tasks.push(seedOne('doing', true));
  f.Store._setShadow([seedOne('doing', true)]);
  const task = seedOne('done', true);
  delete task.myRoles;
  f.Store.applyServerEvent({ type: 'task.updated', task });
  assert.equal(savedNotices(f).length, 0);
  assert.deepEqual(f.petSays, []);
});

test('提出人仍可收到转出需求的状态通知', () => {
  const f = fixture({ online: true, connectWS: () => () => {} }, {});
  const task = { ...seedOne('doing', true), myRoles: ['requester'] };
  f.Store.tasks.push(task);
  f.Store._setShadow([task]);
  f.Store.applyServerEvent(updated({ ...task, status: 'done' }));
  assert.equal(savedNotices(f).length, 1);
  assert.match(f.petSays[0], /已完成/);
});

test('团队可见、提出人跟进与管理身份不能触发他人的定时提醒或循环任务修改', () => {
  const f = fixture({}, {});
  for (const roles of [[], ['observer'], ['creator'], ['requester']]) {
    const suffix = roles[0] || 'team';
    f.Store.tasks.push(
      { id: 'remind-' + suffix, status: 'todo', remindAt: 1, readOnly: true, myRoles: roles },
      { id: 'recur-' + suffix, status: 'done', recur: 'daily', recurAt: 1, readOnly: true, myRoles: roles });
  }
  f.Store.tasks.push({ id: 'admin-visible', status: 'todo', remindAt: 1, readOnly: false, myRoles: [] });
  vm.runInContext('_tickRecur()', f.context);
  assert.equal(savedNotices(f).length, 0);
  assert.deepEqual(f.petSays, []);
  assert.ok(f.Store.tasks.every(task => !task.reminded && (!task.recur || task.status === 'done')));
});

test('本人可执行任务仍提醒一次，归档任务不重新激活', () => {
  const f = fixture({}, {});
  f.Store.tasks.push(
    { id: 'own-reminder', title: 'My work', status: 'todo', remindAt: 1, myRoles: ['executor'] },
    { id: 'archived', status: 'done', archivedAt: 1, recur: 'daily', recurAt: 1, myRoles: ['executor'] });
  vm.runInContext('_tickRecur(); _tickRecur()', f.context);
  assert.equal(savedNotices(f).length, 1);
  assert.equal(f.Store.tasks[0].reminded, true);
  assert.equal(f.Store.tasks[1].status, 'done');
});

test('执行者本机循环任务仍能回到待办并记录下一次时间', () => {
  const f = fixture({}, {});
  f.Store.tasks.push({ id: 'own-cycle', title: 'My cycle', status: 'done', recur: 'daily',
    recurAt: 1, readOnly: false, myRoles: ['executor'] });
  vm.runInContext('_tickRecur(); _tickRecur()', f.context);
  assert.equal(f.Store.tasks[0].status, 'todo');
  assert.ok(f.Store.tasks[0].recurAt > Date.now());
  assert.equal(savedNotices(f).length, 1);
});
