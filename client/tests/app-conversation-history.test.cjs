'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
test('production desk loads the app conversation history runtime exactly once', () => {
  const desk = fs.readFileSync(path.resolve(__dirname, '../desk.html'), 'utf8');
  const resources = [
    '<script src="components/panels/app-conversation-history.js"></script>',
    '<link rel="stylesheet" href="components/panels/chat-crew.css">',
    '<link rel="stylesheet" href="components/panels/plugin-input-sheet.css">',
  ];
  for (const resource of resources) assert.equal(desk.split(resource).length - 1, 1, resource);
});
function fixture() {
  const values = new Map(), listeners = {}, entered = [];
  let owner = 'account-a', device = 'device-a', info = {}, pending = null;
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  const window = { __deskPanel: 'chatbar', addEventListener: (name, fn) => { listeners[name] = fn; },
    SoduWorkAPI: { hubBase: () => 'https://hub.example.invalid', clientAuthSnapshot: () => ({ user: owner ? { id: owner } : null, clientId: device }) },
    NativeChat: { sessionInfo: () => info, reset() { info = {}; }, prepare() {},
      async enter(_text, id, options) { entered.push(id); if (pending) await pending;
        info = { sessionId: id, title: options.chatTitle }; window.SoduWorkAppConversations.identified(id, info.title); return true; } } };
  const sandbox = { window, localStorage: storage, document: { getElementById: () => null }, Promise, Date, URL };
  for (const file of ['workspace/workspace-sidebar-state.js', 'panels/app-conversation-history.js']) {
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../components', file), 'utf8'), sandbox);
  }
  const state = () => window.WorkspaceSidebarState.create({ storage, key: window.WorkspaceSidebarState.storageKey(window.SoduWorkAPI) });
  const app = { id: 'local:ops', name: '运营应用' };
  return { window, listeners, entered, state, app, service: window.SoduWorkAppConversations,
    start: ready => window.SoduWorkAppConversations.start({ ok: true, application: app }, ready || Promise.resolve()),
    owner(value) { owner = value; }, device(value) { device = value; }, pending(value) { pending = value; }, active(value) { info = value; } };
}
test('startup waits for identity hydration then restores the last selected app conversation, not another app or just the latest row', async () => {
  const f = fixture(), s = f.state();
  s.recordAppChat(f.app.id, f.app.name, { id: 'older', title: '较早的对话' });
  s.recordAppChat(f.app.id, f.app.name, { id: 'newer', title: '较新的对话' });
  s.recordAppChat(f.app.id, f.app.name, { id: 'older', title: '较早的对话' });
  s.recordAppChat('local:other', '其他应用', { id: 'other' });
  let hydrate; const opening = f.start(new Promise(resolve => { hydrate = resolve; }));
  await Promise.resolve(); assert.deepEqual(f.entered, []);
  hydrate(); await opening; assert.deepEqual(f.entered, ['older']);
  f.service.newChat(); assert.equal(f.window.NativeChat.sessionInfo().sessionId, undefined);
  f.active({ sessionId: 'third', title: '第三条' }); f.service.identified('third', '第三条');
  assert.equal(f.state().get().projects.find(p => p.appId === f.app.id).lastChatId, 'third');
});
test('a conversation already opened during startup wins over automatic restoration', async () => {
  const f = fixture(); f.state().recordAppChat(f.app.id, f.app.name, { id: 'saved' });
  f.active({ sessionId: 'explicit', title: '主动打开' }); await f.start();
  assert.deepEqual(f.entered, []); assert.equal(f.state().get().projects[0].lastChatId, 'explicit');
});

test('host application identity comes from native hello and survives new chats but clears across account scopes', async () => {
  const f = fixture();
  assert.equal(f.service.applicationId(), '');
  await f.start();
  assert.equal(f.service.applicationId(), f.app.id);
  f.service.newChat();
  assert.equal(f.service.applicationId(), f.app.id);
  f.owner('account-b');
  assert.equal(f.service.applicationId(), '');
  f.listeners['soduwork-data-scope-changed']();
  assert.equal(f.service.applicationId(), '');
});
test('account changes invalidate a late restore and prevent filing old sessions in the new account', async () => {
  const f = fixture(); f.state().recordAppChat(f.app.id, f.app.name, { id: 'private-a' });
  let release; f.pending(new Promise(resolve => { release = resolve; }));
  const opening = f.start(); await new Promise(resolve => setImmediate(resolve));
  f.owner('account-b'); f.listeners['soduwork-data-scope-changed'](); release(); await opening;
  assert.equal(f.state().get().projects.length, 0);
  f.service.identified('private-a', '旧账号'); assert.equal(f.state().get().projects.length, 0);
});

test('app history shares the sidebar account store across device replacement and rejects signed-out writes', async () => {
  const f = fixture();
  const options = f.window.WorkspaceSidebarState.accountOptions({ storage: {
    getItem: () => null
  }, api: f.window.SoduWorkAPI });
  assert.equal(options.key, f.window.WorkspaceSidebarState.storageKey(f.window.SoduWorkAPI));
  f.state().recordAppChat(f.app.id, f.app.name, { id: 'stable', title: 'Saved' });
  f.device('replacement'); await f.start();
  assert.deepEqual(f.entered, ['stable']);
  f.owner(null);
  assert.equal(f.service.applicationId(), '');
  f.service.identified('signed-out', 'Invalid');
  f.owner('account-a');
  assert.deepEqual(Array.from(f.state().get().projects[0].chatIds), ['stable']);
});
