'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { create } = require('../main/workspace-state.cjs');

test('a full restart ignores the former disk page without overwriting it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-workspace-state-'));
  const file = path.join(root, 'workspace-state.json');
  const old = JSON.stringify({ lastWorkspaceView: 'schedules' });
  try {
    fs.writeFileSync(file, old);
    const state = create({ app: { getPath: () => root } });
    assert.equal(state.get(), '');
    state.set('settings');
    assert.equal(fs.readFileSync(file, 'utf8'), old);
    assert.deepEqual(fs.readdirSync(root), ['workspace-state.json']);
  } finally {
    fs.unlinkSync(file); fs.rmdirSync(root);
  }
});

function setup() {
  let owner = 'account-a';
  const state = create({ ownerOf: () => owner });
  return { state, switchOwner: next => { owner = next; } };
}

test('only closing a renderer preserves its last page; a new process starts at home', () => {
  const { state } = setup();
  assert.equal(state.set('skills'), true);
  assert.equal(state.get(), 'skills');
  assert.equal(state.set('not-a-page'), false);
  assert.equal(state.get(), 'skills');
  assert.equal(create().get(), '');
});

test('a tray reopen carries the selected conversation and its reading position', () => {
  const { state } = setup();
  state.set({ view: 'create', chatId: 'chat-live', reading: { top: 720, follow: false }, ...state.context() });
  const destination = state.resolve({ panel: 'workspace' });
  assert.equal(destination.view, 'create');
  assert.equal(destination.chatId, 'chat-live');
  const restored = JSON.parse(destination.workspaceRestore);
  assert.deepEqual(restored.reading, { top: 720, follow: false });
  assert.equal(restored.owner, 'account-a');
  assert.equal(destination.newSession, undefined);
});

test('explicit plugin, new-chat, task and conversation destinations never inherit an old chat', () => {
  const { state } = setup();
  state.set({ view: 'create', chatId: 'chat-old', ...state.context() });
  for (const payload of [
    { panel: 'workspace', view: 'skills' },
    { panel: 'workspace', view: 'create', newSession: true },
    { panel: 'workspace', taskId: 'task-new' },
    { panel: 'workspace', chatId: 'chat-new' },
  ]) {
    const got = state.resolve(payload);
    assert.equal(got.workspaceRestore, undefined);
    assert.equal(got.chatId, payload.chatId);
    assert.equal(got.view, payload.view || 'create');
  }
});

test('account changes discard navigation and reject late snapshots from the previous account', () => {
  const { state, switchOwner } = setup();
  const previous = state.context();
  state.set({ view: 'create', chatId: 'private-chat', ...previous });
  switchOwner('account-b');
  assert.equal(state.resolve({ panel: 'workspace' }).view, 'create');
  assert.equal(state.set({ view: 'create', chatId: 'private-chat', ...previous }), false);
  assert.equal(state.resolve({ panel: 'workspace' }).chatId, undefined);
  switchOwner('account-a');
  assert.equal(state.set({ view: 'create', chatId: 'private-chat', ...previous }), false);
});

test('anonymous contexts cannot restore a private conversation; malformed records are rejected', () => {
  const { state, switchOwner } = setup();
  state.set('settings');
  assert.equal(state.set({ view: 'create', chatId: '../private', ...state.context() }), false);
  assert.equal(state.get(), 'settings');
  switchOwner('');
  assert.equal(state.set({ view: 'create', chatId: 'private-chat', ...state.context() }), false);
  assert.equal(state.resolve({ panel: 'workspace' }).view, 'create');
});

test('workspace IPC rejects an old renderer after a replacement window is registered', () => {
  const { state } = setup();
  const ipcMain = new EventEmitter();
  ipcMain.handle = (name, fn) => { ipcMain[name] = fn; };
  const first = { isDestroyed: () => false }, next = { isDestroyed: () => false };
  let current = first;
  state.install({ ipcMain, BrowserWindow: { fromWebContents: sender => sender }, getWorkspace: () => current });
  ipcMain.emit('workspace-view', { sender: first }, 'skills');
  current = next;
  ipcMain.emit('workspace-view', { sender: next }, 'settings');
  ipcMain.emit('workspace-view', { sender: first }, 'schedules');
  assert.equal(state.get(), 'settings');
  assert.equal(ipcMain['workspace-state-context']({ sender: first }), null);
});

test('a cold desk boot ignores renderer-local page caches and defaults to home', () => {
  const source = fs.readFileSync(path.join(__dirname, '../desk.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
  const context = { URLSearchParams, location: { search: '?panel=workspace' },
    localStorage: { getItem: () => 'skills' }, window: {},
    document: { documentElement: { setAttribute() {} }, addEventListener() {} } };
  vm.runInNewContext(source, context);
  assert.equal(context.window.__deskArgs.view, 'create');
  assert.equal(context.window.__deskArgs.chatId, '');
});
