const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = name => fs.readFileSync(path.join(__dirname, '../components/panels', name), 'utf8');

test('requirement progress uses the authoritative Task state and never completion guesses', () => {
  const requirements = require('../core/requirements');
  for (const [status, expected] of [['todo', 'ready'], ['doing', 'delivering'], ['done', 'reviewing'], ['paused', 'delivering']]) {
    assert.equal(requirements.stage({ status, triageStage: 'ready' }), expected);
  }
  assert.equal(requirements.stage({ status: 'done', triageStage: 'ready', reviewedAt: 1 }), 'delivered', 'acceptance moves the requirement to delivered');
  assert.equal(requirements.stage({ status: 'doing', ai: { executionState: 'completed' } }), 'delivering');
  assert.equal(requirements.stage({ status: 'done', archivedAt: 123 }), 'closed');
});

function notices() {
  let scope = 'one', request;
  const values = new Map(), listeners = [];
  const context = vm.createContext({ SoduWorkAPI: { taskStorageKey: () => scope, mateMessages: () => request() }, _renderNoticePanel() {},
    _taskStorageKey: () => scope, document:{getElementById:()=>null},
    addEventListener: (_type, handler) => listeners.push(handler),
    localStorage:{getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)} });
  context.window=context;
  const store=fs.readFileSync(path.join(__dirname,'../core/store.js'),'utf8');
  vm.runInContext(store.slice(store.indexOf('const LS_NOTICES='),store.indexOf('function _nextRecurAt(')),context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../core/mate-notice-sync.js'),'utf8'),context);
  const source = read('panels-desk.js');
  vm.runInContext(source.slice(source.indexOf("let _noticeFolder ="), source.indexOf('function openNoticePanel()')), context);
  return { context, scope: value => {scope=value;listeners.forEach(fn=>fn());vm.runInContext('notices=_readNotices()',context);}, request: value => request = value,
    snapshot: () => vm.runInContext('JSON.stringify({remote:{received:MateNoticeSync.rows("received"),sent:MateNoticeSync.rows("sent")},load:_noticeLoad})', context) };
}

test('notification failure preserves received rows and exposes an error; retry recovers', async () => {
  const n = notices();
  n.request(async () => ({ ok: true, items: [{ id: 'saved' }] }));
  await n.context._loadMateNoticeFolder('received');
  n.request(async () => ({ ok: false, items: [] }));
  await n.context._loadMateNoticeFolder('received');
  let state = JSON.parse(n.snapshot());
  assert.equal(state.remote.received[0].serverMessageId, 'saved');
  assert.equal(state.load.received.error, '通知暂时无法加载，请重试');
  assert.equal(state.load.received.pending, false);
  n.request(async () => ({ ok: true, items: [{ id: 'fresh' }] }));
  await n.context._loadMateNoticeFolder('received');
  state = JSON.parse(n.snapshot());
  assert.ok(state.remote.received.some(row => row.serverMessageId === 'fresh'));
  assert.equal(state.load.received.error, '');
});

test('late notification responses cannot cross scope and overlapping folder refreshes share one request', async () => {
  const n = notices(); let release;
  n.request(() => new Promise(resolve => { release = resolve; }));
  const pending = n.context._loadMateNoticeFolder('received');
  n.scope('two'); n.request(async () => ({ ok: true, items: [{ id: 'new-scope' }] }));
  await n.context._loadMateNoticeFolder('received');
  release({ ok: true, items: [{ id: 'old-scope' }] }); await pending;
  assert.equal(JSON.parse(n.snapshot()).remote.received[0].serverMessageId, 'new-scope');
  let calls=0;
  n.request(() => {calls++;return new Promise(resolve => { release = resolve; });});
  const slow = n.context._loadMateNoticeFolder('sent');
  const overlap=n.context._loadMateNoticeFolder('sent');
  release({ ok: true, items: [{ id: 'latest' }] }); await Promise.all([slow,overlap]);
  assert.equal(calls,1);
  assert.equal(JSON.parse(n.snapshot()).remote.sent[0].serverMessageId, 'latest');
});

test('mate read receipts clear the local notification badge for either server or client id', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../core/store.js'), 'utf8');
  const start = source.indexOf('function markMateNoticeRead(');
  const end = source.indexOf('function markNoticeRead(', start);
  const ctx = {
    notices: [
      { id: 'mate-client-1', messageId: 'client-1', serverMessageId: 'server-1', read: false },
      { id: 'mate_client_2', messageId: 'client-2', serverMessageId: 'server-2', read: false },
      { id: 'other', messageId: 'other', read: false },
    ],
    _saveNotices() {},
    updateNoticeBadge() {},
    Date,
  };
  vm.createContext(ctx);
  vm.runInContext(source.slice(start, end), ctx);
  assert.equal(ctx.markMateNoticeRead('server-1', 123), true);
  assert.equal(ctx.notices[0].read, true);
  assert.equal(ctx.notices[0].readAt, 123);
  assert.equal(ctx.markMateNoticeRead('client-2', 456), true);
  assert.equal(ctx.notices[1].read, true);
  assert.equal(ctx.notices[1].readAt, 456);
  assert.equal(ctx.notices[2].read, false);
});


test('notification cache follows the active hub and account scope', () => {
  const store = fs.readFileSync(path.join(__dirname, '../core/store.js'), 'utf8');
  const bridge = fs.readFileSync(path.join(__dirname, '../core/win-bridge.js'), 'utf8');
  assert.match(store, /const LS_NOTICES=\(\)=>_taskStorageKey\('notices','soduwork_work_notices_v1'\)/);
  assert.match(bridge, /taskStorageKey\('notices'\)/);
});
