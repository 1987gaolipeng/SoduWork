'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../components/panels/panels-chat.js'), 'utf8');

function section(start, end) {
  if (start.includes('function _ensure(')) return require('./renderer-source.cjs')
    .factoryFunction('chat-session-controller.js', 'ChatSessionController', '_ensure');
  const from = source.indexOf(start);
  assert.ok(from >= 0, `missing ${start}`);
  const to = source.indexOf(end, from);
  assert.ok(to >= 0, `missing ${end}`);
  return source.slice(from, to);
}

test('a rejected history open leaves the loading skeleton and returns a retryable failure', async () => {
  const body = section('  async function _ensure(chatId)', '  async function _ensureOnce');
  const failures = [], failure = new Error('IPC channel closed');
  const ctx = {
    _ref: '', _openingTask: null, _openingEpoch: -1, _viewEpoch: 4, _busy: false,
    _ensureOnce: async () => { throw failure; },
    _fail: (...args) => failures.push(args),
  };
  const vm = require('node:vm');
  ctx.ctx = ctx;
  vm.createContext(ctx);
  vm.runInContext(body, ctx);

  assert.equal(await ctx._ensure('history-a'), false);
  assert.deepEqual(failures, [['打不开对话', 'IPC channel closed', null, failure]]);
  assert.equal(ctx._openingTask, null);
  assert.equal(ctx._busy, false);
  assert.equal(ctx._openingEpoch, -1);
});

test('a stale rejected open does not overwrite the conversation opened after navigation', async () => {
  const body = section('  async function _ensure(chatId)', '  async function _ensureOnce');
  const failures = [];
  const ctx = {
    _ref: '', _openingTask: null, _openingEpoch: -1, _viewEpoch: 4, _busy: false,
    _ensureOnce: async () => { throw new Error('old archive failed'); },
    _fail: (...args) => failures.push(args),
  };
  const vm = require('node:vm');
  ctx.ctx = ctx;
  vm.createContext(ctx);
  vm.runInContext(body, ctx);

  const pending = ctx._ensure('history-a');
  ctx._viewEpoch = 5;
  assert.equal(await pending, false);
  assert.deepEqual(failures, []);
});

