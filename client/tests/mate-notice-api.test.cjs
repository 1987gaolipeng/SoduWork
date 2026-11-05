'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs'), path = require('node:path'), vm = require('node:vm');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture({ values = new Map(), seed, received = [] } = {}) {
  const events = {}, calls = [], sockets = [], timers = [];
  let clock = Date.now();
  const auth = user => ({ ok: true, stored: true, clientId: 'install-a', user: { id: user },
    authState: 'active', session: 'test-session', expiresIn: 1800 });
  const ctx = { window: null, console, URL, URLSearchParams, AbortController, FormData,
    Date: class extends Date { static now() { return clock; } },
    TaskSync: require('../core/task-sync.js'), User: { id: 'legacy-device', name: 'Tester' }, navigator: { platform: 'test' },
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {},
    setInterval: (fn, delay) => { timers.push({ fn, delay }); return timers.length; }, clearInterval() {},
    document: { getElementById: () => null, querySelectorAll: () => [], documentElement: { setAttribute() {} } },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    addEventListener: (name, fn) => (events[name] ||= []).push(fn),
    dispatchEvent: event => (events[event.type] || []).forEach(fn => fn(event)),
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) },
    WebSocket: class { constructor(url) { this.url = url; this.sent = []; sockets.push(this); } send(value) { this.sent.push(value); } close() { this.closed = true; } },
    soduWorkAPI: { getAppVersion: async () => 'test', getSysInfo: async () => ({}),
      deviceAuthBootstrap: async () => auth('user-a'), deviceAuthLogin: async payload => auth(payload.account),
      deviceAuthLogout: async () => ({ ok: true }), configureRunner: async () => ({ ok: true }) },
    fetch: async (url, options) => {
      calls.push({ url, options });
      let result = { ok: true };
      if (url.includes('/team/messages?')) result = { ok: true, items: url.includes('folder=received') ? received : [], nextCursor: '' };
      else if (url.endsWith('/delivered')) result = { ok: true, status: 'delivered', deliveredAt: 200 };
      else if (url.endsWith('/read')) result = { ok: true, status: 'read', deliveredAt: 200, readAt: 300 };
      else if (url.endsWith('/tasks')) result = [];
      else if (url.endsWith('/config')) result = {};
      return { ok: true, status: 200, text: async () => JSON.stringify(result) };
    },
  };
  ctx.window = ctx; vm.createContext(ctx);
  const load = file => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), ctx, { filename: file });
  load('api.js'); const api = ctx.SoduWorkAPI; await api.registerClient();
  if (seed) seed(values, api);
  load('core/store-lifecycle.js'); load('core/store.js'); load('core/mate-notice-sync.js');
  return { ctx, api, values, calls, sockets, timers, sync: ctx.MateNoticeSync,
    advance: ms => { clock += ms; },
    run: code => vm.runInContext(code, ctx), unread: () => vm.runInContext('noticeUnread()', ctx) };
}
const message = { id: 'server-1', messageId: 'client-1', senderId: 'user-b', recipientId: 'user-a',
  senderName: '发件人', recipientName: '接收人', text: '需求完整说明', kind: 'task_assignment', taskId: 'task-1', createdAt: 100, status: 'accepted' };
const localNotice = { id: 'ntc_old', at: 100, text: '旧通知', taskId: 'task-1', kind: 'notice', read: false };

test('conditional notification revision is encoded only on the first page', async () => {
  const f = await fixture();
  await f.api.mateMessages('received', 200, '', 'scope/revision');
  assert.match(f.calls.at(-1).url, /ifRevision=scope%2Frevision/);
  await f.api.mateMessages('received', 200, 'page-two', 'scope/revision');
  assert.match(f.calls.at(-1).url, /before=page-two/);
  assert.doesNotMatch(f.calls.at(-1).url, /ifRevision/);
});

test('real API gives notices an independent identity-scoped key and never treats task records as notifications', async () => {
  const task = { id: 'task-1', title: '需求', note: '完整原文', kind: 'requirement', status: 'todo' };
  const f = await fixture({ received: [message], seed(values, api) { values.set(api.taskStorageKey('tasks'), JSON.stringify([task])); } });
  assert.notEqual(f.api.taskStorageKey('notices'), f.api.taskStorageKey('tasks'));
  assert.equal(f.unread(), 0);
  await f.sync.refresh('received'); assert.equal(f.unread(), 1);
  assert.deepEqual(JSON.parse(f.values.get(f.api.taskStorageKey('tasks'))), [task]);
  f.run('Store._tasks.push({id:"task-2",title:"另一需求"}); Store._mirrorTasks(false)');
  assert.equal(JSON.parse(f.values.get(f.api.taskStorageKey('notices')))[0].serverMessageId, 'server-1');
});

test('migration adopts only exact notice shapes from the same scoped collision key and preserves original tasks', async () => {
  const polluted = [localNotice, { id: 'task-1', title: '需求', text: '任务说明', at: 100, read: false },
    { ...localNotice, id: 'ntc_task', title: '需求', kind: 'requirement', note: '正文' }];
  const f = await fixture({ seed(values, api) { values.set(api.taskStorageKey('tasks'), JSON.stringify(polluted)); } });
  assert.deepEqual(Array.from(f.sync.rows('received'), row => row.id), ['ntc_old']);
  assert.deepEqual(JSON.parse(f.values.get(f.api.taskStorageKey('tasks'))), polluted);
  assert.deepEqual(JSON.parse(f.values.get(f.api.taskStorageKey('notices'))), [localNotice]);
  f.run('clearNotices()'); f.ctx.dispatchEvent(new f.ctx.CustomEvent('soduwork-data-scope-changed'));
  assert.equal(f.unread(), 0, 'a cleared new store must not re-adopt old records');
});

test('migration never adopts unscoped, hub-only or another account notices', async () => {
  const f = await fixture({ seed(values, api) {
    values.set('soduwork_work_notices_v1', JSON.stringify([localNotice]));
    values.set('soduwork_work_tasks_v5', JSON.stringify([localNotice]));
    values.set(api.taskStorageKey('tasks').replace(/@[^@]+$/, '@another-user'), JSON.stringify([localNotice]));
    values.set(api.taskStorageKey('tasks').split('@').slice(0, 2).join('@'), JSON.stringify([localNotice]));
  } });
  assert.equal(f.unread(), 0);
  assert.equal(f.values.get('soduwork_work_notices_v1'), JSON.stringify([localNotice]));
});

test('closed or previous-account websocket callbacks cannot write notices for the current account', async () => {
  const f = await fixture();
  const off = f.api.connectWS(event => { f.ctx.event = event; f.run('Store.applyServerEvent(event)'); });
  const first = f.sockets[0]; first.onopen(); off();
  first.onmessage({ data: JSON.stringify({ type: 'notice', text: '已经关闭的连接' }) });
  assert.equal(f.unread(), 0);
  f.api.connectWS(event => { f.ctx.event = event; f.run('Store.applyServerEvent(event)'); });
  const old = f.sockets[1];
  await f.api.clientLogin({ account: 'user-c' });
  old.onopen(); old.onmessage({ data: JSON.stringify({ type: 'notice', text: '旧账号通知' }) });
  assert.equal(f.unread(), 0); assert.equal(old.sent.length, 0, 'late open cannot authenticate the old socket with the new identity');
});

test('read acknowledgement arriving after account switch cannot mutate the new scope', async () => {
  const f = await fixture({ received: [message] }); await f.sync.refresh('received');
  const pending = deferred(); const fetch = f.ctx.fetch;
  f.ctx.fetch = async (url, options) => url.endsWith('/read') ? pending.promise : fetch(url, options);
  const read = f.sync.markRead('server-1'); await Promise.resolve(); await Promise.resolve();
  await f.api.clientLogin({ account: 'user-c' });
  pending.resolve({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, status: 'read', readAt: 300 }) });
  await assert.rejects(read, /账号|设备|切换/);
  assert.equal(f.unread(), 0); assert.equal(f.values.has(f.api.taskStorageKey('notices')), false);
});

const drain = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
test('startup, reconnect and throttled heartbeat refresh notices without opening the notification center', async () => {
  const received = [message], f = await fixture({ received });
  await f.run('initData()'); await f.run('Store._startupPromise'); await drain();
  assert.equal(f.unread(), 1);
  received.push({ ...message, id: 'server-2', messageId: 'client-2' });
  f.ctx.dispatchEvent(new f.ctx.CustomEvent('soduwork-ws-open')); await drain();
  assert.equal(f.unread(), 2);
  const heartbeat = f.timers.find(timer => timer.delay === 20000);
  assert.ok(heartbeat);
  const before = f.calls.filter(call => call.url.includes('/team/messages?')).length;
  await heartbeat.fn(); await drain();
  assert.equal(f.calls.filter(call => call.url.includes('/team/messages?')).length, before, 'healthy heartbeat must respect the one-minute throttle');
  received.push({ ...message, id: 'server-3', messageId: 'client-3' }); f.advance(61000);
  await heartbeat.fn(); await drain(); assert.equal(f.unread(), 3);
});

test('successful assignment, handoff and direct message each refresh the sender receipt folder', async () => {
  const f = await fixture();
  for (const send of [() => f.api.createAssignedTask({ title: '需求', assigneeUserId: 'user-b' }),
    () => f.api.handoffTask('task-1', 'user-b', '转交'), () => f.api.sendMateMessage('user-b', '消息')]) {
    const before = f.calls.filter(call => call.url.includes('/team/messages?folder=sent')).length;
    await send(); await drain();
    assert.equal(f.calls.filter(call => call.url.includes('/team/messages?folder=sent')).length, before + 1);
  }
});
