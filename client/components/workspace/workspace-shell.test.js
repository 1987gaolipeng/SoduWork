'use strict';

const assert = require('assert');
global.window = global;
require('./workspace-chat-history');
require('./workspace-chat-list');
require('./workspace-shell');
const shell = global.WorkspaceShell;
delete global.window;

const current = [
  { id: 'a', title: '第一条', at: 300, state: 'completed' },
  { id: 'b', title: '第二条', at: 200, state: 'running' },
  { id: 'c', title: '第三条', at: 100, state: 'completed' },
];
const reorderedPoll = [
  { id: 'c', title: '第三条', at: 900, state: 'completed' },
  { id: 'a', title: '第一条', at: 800, state: 'running' },
  { id: 'b', title: '第二条', at: 700, state: 'completed' },
];
assert.deepEqual(shell._reconcileChats(current, reorderedPoll, 1000).map((row) => row.id),
  ['a', 'b', 'c'], '轮询和状态更新时间不能改变既有会话顺序');

const withFresh = shell._reconcileChats(current, [
  { id: 'new', title: '真正新会话', at: 1000, state: 'starting' },
  ...reorderedPoll,
], 1100);
assert.deepEqual(withFresh.map((row) => row.id), ['new', 'a', 'b', 'c'],
  '只有真正新建的会话可以进入列表首位');

const draft = { localId: 'draft-1', title: '准备官网', at: 2000, pending: true, state: 'starting' };
const settled = shell._reconcileChats([current[0], draft, current[1]], [
  { id: 'real-1', title: '准备官网', at: 2010, state: 'running', adapterId: 'pi' },
  current[0], current[1],
], 2200);
assert.deepEqual(settled.map((row) => row.id), ['a', 'real-1', 'b'],
  '临时会话应在原位置原子替换为正式 ID');
assert.equal(settled[1].pending, false);
assert.equal(settled[1].localId, undefined);

const updated = shell._upsertChatItems(current, { id: 'b', state: 'waiting', title: '第二条' });
assert.deepEqual(updated.map((row) => row.id), ['a', 'b', 'c'],
  '实时状态更新不能把会话移到第一位');
assert.equal(updated[1].state, 'waiting');
assert.equal(shell._chatState({ state: 'streaming' }), 'running');
assert.equal(shell._chatState({ state: 'waiting-user' }), 'waiting');
assert.equal(shell._chatState({ state: 'cancelled' }), 'stopped');
assert.equal(shell._chatState({ state: 'archived' }), 'completed');
assert.equal(shell._chatState({ state: 'unreachable' }), 'failed');
assert.equal(shell._chatState({ state: 'compacting' }), 'running');
assert.equal(shell._chatState({ status: 'running' }), 'running');
assert.equal(shell._chatState({ status: 'streaming' }), 'running');
assert.equal(shell._chatState({ state: 'future-unknown-state' }), 'completed');

console.log('workspace recent chats: 14 assertions passed');
