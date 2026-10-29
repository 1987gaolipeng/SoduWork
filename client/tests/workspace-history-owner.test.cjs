'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture(user = 'user-a') {
  const events = new Map(), pending = [], subscriptions = [], renders = [];
  let hub = 'https://hub.example.invalid', device = 'device-a';
  const window = { URL,
    addEventListener(name, fn) { (events.get(name) || events.set(name, []).get(name)).push(fn); },
    SoduWorkAPI: { hubBase: () => hub, clientAuthSnapshot: () => ({ user: user ? { id: user } : null, clientId: device }),
      taskStorageKey: () => ['cache', hub, device, user || 'unbound'].join('@') },
    soduWorkAPI: { conversationSession: {
      history: () => new Promise((resolve, reject) => pending.push({ user, resolve, reject })),
      onEvent() {},
      onEventBatch(fn) { const sub = { fn, closed: false }; subscriptions.push(sub); return () => { sub.closed = true; }; },
    } },
  };
  const sandbox = vm.createContext({ window, URL });
  for (const name of ['workspace-sidebar-state', 'workspace-chat-list'])
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/workspace', name + '.js'), 'utf8'), sandbox);
  const ctx = { root: {}, historyLoad: null, chatItems: [], chatNames: new Map(), incomingOpened: new Map(),
    activeChatId: '', chatsLoading: false, sessionOff: null, openChatMenu: null,
    renderChats() { renders.push(ctx.chatItems.map(row => row.id)); },
    setChats(rows) { ctx.chatItems = rows; ctx.chatsLoading = false; },
    updateChatState(event) { ctx.chatItems.push(event.presence); } };
  const api = window.WorkspaceChatList.create(ctx);
  return { ctx, api, pending, subscriptions, renders,
    async switch(nextUser, name = 'soduwork-data-scope-changed', nextHub = hub, nextDevice = device) {
      user = nextUser; hub = nextHub; device = nextDevice;
      for (const fn of events.get(name) || []) fn(); await tick();
    },
  };
}
const row = (id = 'private-a') => ({ id, title: 'Private A', usedHarnesses: ['pi', 'qwen'] });

test('account changes clear private rows and reject a late history response without blocking the next account', async () => {
  const f = fixture(); f.ctx.chatItems = [row()]; f.ctx.activeChatId = 'private-a'; f.ctx.chatNames.set('private-a', { title: 'A override' });
  const old = f.api.refreshConversationHistory(); await tick();
  await f.switch('user-b');
  assert.equal(f.ctx.chatItems.length, 0); assert.equal(f.ctx.chatNames.size, 0); assert.equal(f.ctx.activeChatId, '');
  assert.ok(f.renders.some(rows => rows.length === 0), 'old rows disappear synchronously');
  assert.equal(f.pending.length, 2, 'B history starts without waiting for A');
  const next = f.ctx.historyLoad; f.pending[0].resolve({ ok: true, chats: [row()] }); await old;
  assert.equal(f.ctx.chatItems.length, 0); assert.equal(f.ctx.historyLoad, next, 'old finally cannot clear B in-flight request');
  f.pending[1].resolve({ ok: true, chats: [{ id: 'private-b', title: 'B', usedHarnesses: ['claude'] }] }); await next;
  assert.deepEqual(f.ctx.chatItems.map(item => item.id), ['private-b']);
});

test('startup authentication, token renewal and same-account device replacement preserve current history and selection', async () => {
  const f = fixture(''); f.ctx.chatItems = [row()]; f.ctx.activeChatId = 'private-a';
  const request = f.api.refreshConversationHistory(); await tick();
  await f.switch('user-a', 'soduwork-device-auth');
  await f.switch('user-a', 'soduwork-device-auth');
  await f.switch('user-a', 'soduwork-data-scope-changed', 'https://hub.example.invalid/', 'replacement');
  assert.equal(f.ctx.chatItems[0].id, 'private-a'); assert.equal(f.ctx.activeChatId, 'private-a'); assert.equal(f.pending.length, 1);
  f.pending[0].resolve({ ok: true, chats: [row('fresh-a')] }); assert.equal(await request, true);
  assert.equal(f.ctx.chatItems[0].id, 'fresh-a');
});

test('logout and a different Hub clear history while queued callbacks from the prior presence subscription stay invalid', async () => {
  const f = fixture(); f.api.subscribeConversationPresence(); const old = f.subscriptions[0];
  f.ctx.chatItems = [row()]; await f.switch('');
  assert.equal(f.ctx.chatItems.length, 0); assert.equal(old.closed, true);
  old.fn({ presence: row() }); assert.equal(f.ctx.chatItems.length, 0);
  await f.switch('user-a', 'soduwork-device-auth');
  f.ctx.chatItems = [row()]; await f.switch('user-a', 'soduwork-data-scope-changed', 'https://other.example.test');
  assert.equal(f.ctx.chatItems.length, 0);
});

test('ordinary requests coalesce and failed history loads release the slot for retry', async () => {
  const f = fixture(); const first = f.api.refreshConversationHistory(), second = f.api.refreshConversationHistory();
  await tick(); assert.equal(f.pending.length, 1); f.pending[0].reject(Error('offline'));
  assert.equal(await first, false); assert.equal(await second, false); assert.equal(f.ctx.historyLoad, null);
  const retry = f.api.refreshConversationHistory(); await tick(); assert.equal(f.pending.length, 2);
  f.pending[1].resolve({ ok: true, chats: [row()] }); assert.equal(await retry, true); assert.equal(f.ctx.chatItems[0].id, 'private-a');
});

test('after logout a shell remount cannot reload or resubscribe to private history before authentication', async () => {
  const f = fixture(); f.api.subscribeConversationPresence(); await f.switch('');
  const requests = f.pending.length, subscriptions = f.subscriptions.length;
  f.api.subscribeConversationPresence(); void f.api.refreshConversationHistory(); await tick();
  assert.equal(f.pending.length, requests, 'logout must block another history IPC');
  assert.equal(f.subscriptions.length, subscriptions, 'logout must block another presence subscription');
  await f.switch('user-b', 'soduwork-device-auth');
  assert.equal(f.pending.length, requests + 1); assert.equal(f.subscriptions.length, subscriptions + 1);
});
