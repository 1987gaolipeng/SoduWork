'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));

test('resource preload overlaps tool settling; abort and replacement wait for the recorded result', async () => {
  const tool = deferred(), resources = deferred(), loaded = deferred(), log = [];
  const live = { session: { abort: async () => { log.push('abort'); } }, access: {
    suspend() { log.push('suspend'); return tool.promise.then(() => { log.push('tool-recorded'); }); },
  } };
  const control = require('../main/access-control/pi-live-change').create({ current: () => live, transition: {
    schedule() {}, preload() { log.push('preload'); loaded.resolve(); return resources.promise; },
    async apply() { log.push('replace'); },
  } });
  const change = control.change({ mode: 'full' }, 1);
  await loaded.promise;
  assert.deepEqual(log, ['suspend', 'preload']);
  resources.resolve(); await turn();
  assert.deepEqual(log, ['suspend', 'preload'], 'ready resources must not interrupt an executing effect');
  tool.resolve(); assert.equal((await change).ok, true);
  assert.deepEqual(log, ['suspend', 'preload', 'tool-recorded', 'abort', 'replace']);
});

test('internal empty-output gap is neutral, genuine model failure and final empty result stay visible', async () => {
  const finish = deferred(), replacement = deferred(), continuation = deferred(), entered = deferred();
  const session = { abort: async () => finish.resolve(), sendCustomMessage: async () => { entered.resolve(); await continuation.promise; } };
  const control = require('../main/access-control/pi-live-change').create({
    current: () => ({ session, access: { suspend: async () => {} } }),
    transition: { schedule() {}, apply: () => replacement.promise },
  });
  const running = control.run(() => finish.promise), changing = control.change({ mode: 'full' }, 1);
  await turn();
  const empty = { status: 'no-output', statusText: 'no model output' };
  assert.equal(control.view(empty).status, 'streaming');
  assert.deepEqual(control.view({ status: 'unreachable', statusText: 'upstream 500' }), { status: 'unreachable', statusText: 'upstream 500' });
  replacement.resolve(); await changing; await entered.promise;
  assert.equal(control.view(empty).status, 'streaming', 'continues across change promise/next model-start gap');
  continuation.resolve(); await running;
  assert.deepEqual(control.view(empty), empty, 'an actually empty completed continuation is not hidden');
});

test('neutral access cancellation is neither successful execution nor a failed batch', () => {
  global.window = global;
  const tools = require('../components/panels/panels-chat-tools'); delete global.window;
  const cancelled = { name: 'bash', args: { command: 'build' }, state: 'cancelled', cancelReason: 'access-change', isError: false };
  assert.equal(tools.batchSummary([cancelled]).state, 'cancelled');
  assert.equal(tools.batchSummary([cancelled]).errors, 0);
  assert.doesNotMatch(tools.render(cancelled).title, /异常|完成/);
  assert.equal(tools.batchSummary([cancelled, { ...cancelled, state: 'error', isError: true }]).state, 'error');
  assert.equal(tools.batchSummary([{ ...cancelled, cancelReason: undefined }]).state, 'error');
});

test('closing during preload releases the abandoned extension runtime without creating a session', async () => {
  const resources = deferred(), rules = require('../main/access-control/policy');
  const cwd = require('node:os').tmpdir(), policy = rules.create('standard', cwd);
  const resource = {}, released = []; let prepared = 0;
  const changes = require('../main/access-control/pi-transition').create({ cwd,
    current: () => ({ policy, session: { sessionManager: { appendCustomEntry() {} } } }),
    preload: () => resources.promise, release: value => released.push(value),
    prepare() { prepared++; }, commit() { assert.fail('closed session must not commit'); },
  });
  changes.schedule(rules.next('full', cwd, policy, policy.revision), policy.revision);
  const loading = changes.preload(), applying = changes.apply();
  const failure = assert.rejects(applying, /关闭/);
  changes.close(); resources.resolve(resource);
  await loading; await failure; await turn();
  assert.deepEqual(released, [resource]); assert.equal(prepared, 0);
});
