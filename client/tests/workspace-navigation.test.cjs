'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { create } = require('../main/workspace-state.cjs');

function setup() {
  let owner = 'account-a', scope = 'scope-a';
  const state = create({ ownerOf: () => owner });
  const shell = { active: 'create', activeChatId: 'chat-one' };
  const scroll = { scrollTop: 330, scrollHeight: 1200, clientHeight: 400,
    __soduworkScrollFollow: { follow: false } };
  const events = new Map(), frames = [];
  const global = { window: null, __deskPanel: 'workspace', setTimeout, clearTimeout,
    addEventListener: (name, fn) => events.set(name, fn), requestAnimationFrame: fn => frames.push(fn),
    SoduWorkAPI: { taskStorageKey: () => scope }, WorkspaceShell: shell,
    NativeChat: { hasSession: () => true, sessionInfo: () => ({ sessionId: shell.activeChatId }) },
    document: { getElementById: id => id === 'composePanel' ? { dataset: { stage: 'chat' } } :
      id === 'nchatScroll' ? scroll : null, addEventListener() {} },
    soduWorkAPI: { workspaceContext: async () => state.context(),
      resetWorkspaceState: async () => { state.reset(); return state.context(); },
      reportWorkspaceView: row => state.set(row) },
  };
  global.window = global;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/workspace/workspace-navigation.js'), 'utf8'), global);
  const navigation = global.WorkspaceNavigation;
  return { global, state, navigation, shell, scroll, frames,
    bindRenderer: () => { scope = 'scope-bound'; events.get('soduwork-device-auth')?.(); },
    switchOwner: value => { owner = value; scope = 'scope-' + value; } };
}

test('conversation snapshots contain identity, chat id and reading position, never messages', async () => {
  const { state, navigation } = setup();
  await navigation.record('create');
  const route = JSON.parse(state.resolve({ panel: 'workspace' }).workspaceRestore);
  assert.equal(route.chatId, 'chat-one');
  assert.deepEqual(route.reading, { top: 330, follow: false });
  assert.equal(route.owner, 'account-a');
  assert.equal(route.messages, undefined);
});

test('initial renderer identity binding does not strand restoration or later page snapshots', async () => {
  const { state, navigation, shell, scroll, frames, bindRenderer } = setup();
  await navigation.record('create');
  const saved = state.resolve({ panel: 'workspace' });
  scroll.scrollTop = 0;
  const opened = await navigation.open('create', saved, () => { bindRenderer(); return true; });
  while (frames.length) frames.shift()();
  assert.equal(opened, true);
  assert.equal(scroll.scrollTop, 330);
  shell.active = 'skills';
  assert.equal(await navigation.record('skills'), true);
  assert.equal(state.resolve({ panel: 'workspace' }).view, 'skills');
});

test('changing a selected chat updates the restore target; utility pages have no chat target', async () => {
  const { state, navigation, shell } = setup();
  await navigation.record('create');
  shell.activeChatId = 'chat-two';
  await navigation.chatChanged('chat-two');
  assert.equal(state.resolve({ panel: 'workspace' }).chatId, 'chat-two');
  shell.active = 'schedules';
  await navigation.record('schedules');
  assert.equal(state.resolve({ panel: 'workspace' }).view, 'schedules');
  assert.equal(state.resolve({ panel: 'workspace' }).chatId, undefined);
});

test('restoration reopens the same chat with no first message and restores scroll following', async () => {
  const { state, navigation, shell, scroll, frames } = setup();
  await navigation.record('create');
  const saved = state.resolve({ panel: 'workspace' });
  scroll.scrollTop = 0; scroll.__soduworkScrollFollow.follow = true;
  let input;
  await navigation.open('create', saved, (view, payload) => {
    input = { view, payload }; shell.active = view; shell.activeChatId = payload.chatId;
    return true;
  });
  while (frames.length) frames.shift()();
  assert.equal(input.payload.chatId, 'chat-one');
  assert.equal(input.payload.newSession, undefined);
  assert.equal(input.payload.prefill, undefined);
  assert.equal(input.payload.workspaceRestore, undefined);
  assert.equal(scroll.scrollTop, 330);
  assert.equal(scroll.__soduworkScrollFollow.follow, false);
});

test('switching pages while restoration is opening prevents a late scroll or navigation overwrite', async () => {
  const { state, navigation, shell, scroll, frames } = setup();
  await navigation.record('create');
  const saved = state.resolve({ panel: 'workspace' });
  let finish;
  const pending = navigation.open('create', saved, () => new Promise(resolve => { finish = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  await navigation.open('skills', {}, view => { shell.active = view; return true; });
  finish(true); await pending;
  while (frames.length) frames.shift()();
  assert.equal(state.resolve({ panel: 'workspace' }).view, 'skills');
  assert.equal(scroll.scrollTop, 330);
});

test('a saved private conversation is not opened after the account changes', async () => {
  const { state, navigation, shell, switchOwner } = setup();
  await navigation.record('create');
  const saved = state.resolve({ panel: 'workspace' });
  switchOwner('account-b');
  let input;
  await navigation.open('create', saved, (view, payload) => {
    input = { view, payload }; shell.active = view; shell.activeChatId = ''; return true;
  });
  assert.equal(input.view, 'create');
  assert.equal(input.payload.chatId, undefined);
  assert.equal(input.payload.newSession, true);
});

test('a deleted conversation returns to home without creating an execution', async () => {
  const { state, navigation, shell } = setup();
  await navigation.record('create');
  const saved = state.resolve({ panel: 'workspace' });
  const destinations = [];
  await navigation.open('create', saved, (view, payload) => {
    destinations.push(payload.chatId || 'home');
    shell.active = view; shell.activeChatId = payload.chatId || '';
    return !payload.chatId;
  });
  assert.deepEqual(destinations, ['chat-one', 'home']);
  assert.equal(state.resolve({ panel: 'workspace' }).chatId, undefined);
});

test('utility openers without a return value still restore their page', async () => {
  const { state, navigation, shell } = setup();
  shell.active = 'schedules';
  await navigation.record('schedules');
  const saved = state.resolve({ panel: 'workspace' });
  const destinations = [];
  await navigation.open('schedules', saved, view => { shell.active = view; destinations.push(view); });
  assert.deepEqual(destinations, ['schedules']);
});
