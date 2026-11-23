'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

function fixture() {
  const text = {}, button = { dataset: {}, addEventListener(_name, handler) { this.click = handler; } };
  const notice = { querySelector: tag => tag === 'span' ? text : button };
  const state = { runtime: { ok: true }, model: 'empty', owner: 'first', location: 'local', now: 1000 };
  const reports = [], opened = [], timers = [];
  const context = {
    Date: { now: () => state.now },
    setTimeout(callback) { timers.push(callback); return 1; },
    ComposeRuntime: { availability: () => state.runtime, location: () => state.location },
    ComposeModelPicker: { modelReadiness: () => state.model },
    WorkspaceHost: { open: name => opened.push(name) },
    SoduWorkAPI: { clientAuthSnapshot: () => ({ state: 'active', user: { id: state.owner } }),
      taskStorageKey: () => state.owner,
      reportFirstChatReadiness: async (...args) => { reports.push(args); return state.wait || true; } },
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/first-chat-readiness.js'), 'utf8'), context);
  const api = context.FirstChatReadiness;
  api.bind({ querySelector: () => notice });
  return { state, api, button, reports, opened, notice, async flush() {
    while (timers.length) { timers.shift()(); await new Promise(resolve => setImmediate(resolve)); }
  } };
}

test('known missing selections expose settings and uncertain runtime checks do not block native defaults', async () => {
  const { api, state, reports, flush, notice, button, opened } = fixture();
  assert.equal(api.canStart(), false);
  button.click({ currentTarget: button });
  assert.deepEqual(opened, ['models']);
  await flush();
  assert.deepEqual(reports, [['first', true, false]]);
  state.runtime = { ok: false }; state.model = 'ready'; api.checked();
  assert.equal(button.dataset.action, 'agents');
  assert.equal(api.canStart(), false);
  state.runtime = { ok: false, unverified: true }; state.model = 'native'; api.checked();
  assert.equal(button.dataset.action, 'retry');
  assert.equal(api.canStart(), true);
  await flush();
  assert.deepEqual(reports.at(-1), ['first', null, null]);
  state.runtime = { ok: true }; state.model = 'ready'; api.checked();
  assert.equal(notice.hidden, true);
});

test('a pending report is followed by the new owner, unchanged observations refresh only after a new check', async () => {
  const { api, state, reports, flush } = fixture();
  let finish;
  state.wait = new Promise(resolve => { finish = resolve; });
  await flush();
  state.owner = 'second'; state.model = 'checking'; api.checked(); await flush();
  assert.equal(reports.length, 1);
  state.wait = null; finish(true);
  await new Promise(resolve => setImmediate(resolve)); await flush();
  assert.deepEqual(reports[1], ['second', true, null]);
  state.now += 120000; api.paint(); await flush();
  assert.equal(reports.length, 2);
  api.checked(); await flush(); api.paint(); await flush();
  assert.deepEqual(reports[2], ['second', true, null]);
  assert.equal(reports.length, 3);
});
