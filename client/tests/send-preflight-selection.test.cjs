'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../main/pi-session/session-send');
const pluginContext = require('../main/pi-session/plugin-context');
const processContext = require('../main/agent-runtime/process-context');

function fixture(t, { active = [], ticket = { ok: true }, resolve } = {}) {
  let starts = 0;
  const commits = [], resolutions = [];
  const ctx = {
    ref: 'preflight', handle: {}, activePluginIds: active.slice(), inFlight: false,
    opts: { capabilityIds: [], resolvePlugins: async ids => {
      resolutions.push(ids.slice());
      return resolve ? resolve(ids) : { items: ids.map(pluginId => ({ pluginId, context: 'Work method',
        capabilities: { runtime: ['browser'] } })) };
    } },
    turnQueue: { active: () => null, size: () => 0 },
    persistPluginSelection(ids) { ctx.activePluginIds = ids.slice(); commits.push(ids.slice()); },
    liveAccess: { wait: async () => ({ ok: true }) }, accessChanges: { apply: async () => {} },
    modelSelection: { capture: () => 'fixture-model' }, refreshModelTicketIfNeeded: async () => ticket,
    resourceActivation: { required: () => false }, sdk: {},
    shared: { pluginContext, _pluginIds: rows => [...new Set(rows.filter(Boolean))],
      skillTurn: { prepare: async () => ({ ok: true, items: [] }) } },
  };
  t.mock.method(processContext, 'current', () => ({ synchronize: async () => {
    starts++; throw Error('Reached execution after preflight');
  } }));
  return { ctx, commits, resolutions, send: create(ctx).send, starts: () => starts };
}

test('an unauthorized new plugin does not poison the following ordinary message', async t => {
  const f = fixture(t);
  const blocked = await f.send('Build an application', [], { pluginIds: ['browser-work'] });
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.pluginAuthorization.missing, ['browser']);
  assert.equal(f.starts(), 0);
  assert.deepEqual(f.ctx.activePluginIds, []);
  await assert.rejects(f.send('Hello without a plugin', [], {}), /Reached execution after preflight/);
  assert.equal(f.starts(), 1);
  assert.deepEqual(f.resolutions, [['browser-work']]);
});

test('model or grant preflight failure preserves the prior authorized selection', async t => {
  for (const failure of ['model', 'grant']) {
    const f = fixture(t, { active: ['previous'],
      ticket: failure === 'model' ? { ok: false, reason: 'Temporary model service error' } : { ok: true },
      resolve: async () => { throw Error('Temporary grant service error'); } });
    const result = await f.send('New work', [], { pluginIds: ['replacement'] });
    assert.equal(result.ok, false);
    assert.deepEqual(f.ctx.activePluginIds, ['previous']);
    assert.deepEqual(f.commits, []);
  }
});

test('authorized plugin selections persist for later turns and explicit clearing wins', async t => {
  const f = fixture(t, { resolve: async ids => ({ items: ids.map(pluginId => ({ pluginId, context: 'Work method' })) }) });
  await assert.rejects(f.send('Use the method', [], { pluginIds: ['authorized'] }), /Reached execution after preflight/);
  assert.deepEqual(f.ctx.activePluginIds, ['authorized']);
  await assert.rejects(f.send('Continue', [], {}), /Reached execution after preflight/);
  assert.deepEqual(f.resolutions, [['authorized'], ['authorized']]);
  await assert.rejects(f.send('Only plain conversation', [], {
    clearPluginSelection: true, pluginIds: ['ignored'] }), /Reached execution after preflight/);
  assert.deepEqual(f.ctx.activePluginIds, []);
  assert.equal(f.resolutions.length, 2);
});

test('closing a session during grant resolution cannot persist its pending selection', async t => {
  let resolveGrant, cleanup = 0;
  const f = fixture(t, { active: ['previous'], resolve: () => new Promise(resolve => { resolveGrant = resolve; }) });
  const pending = f.send('Pending work', [], { pluginIds: ['replacement'] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof resolveGrant, 'function');
  f.ctx.closed = true;
  resolveGrant({ items: [{ pluginId: 'replacement', context: 'Method' }], grant: { cleanup: () => cleanup++ } });
  assert.equal((await pending).cancelled, true);
  assert.deepEqual(f.ctx.activePluginIds, ['previous']);
  assert.deepEqual(f.commits, []);
  assert.equal(f.starts(), 0);
  assert.equal(cleanup, 1);
});

test('an ordinary Pi message after a settled preflight failure can send without clicking resume', async () => {
  const { createTurnQueue } = require('../main/pi-session/turn-queue');
  const queue = createTurnQueue(), stream = require('../main/pi-session/event-stream');
  const sent = [];
  const ctx = { ref: 'ordinary-recovery', opts: {}, acc: stream.create(),
    taskBinding: { taskIds: [], taskBindings: [] }, goal: {}, prep: { model: {} },
    shared: { stream, messageTime: require('../main/conversation/message-time'),
      skillTurn: { resumeRetry: () => false } }, turnQueue: queue,
    run: {}, modelRecovery: { view: () => null }, modelSelection: { capture: () => 'model' },
    piSession: { sessionManager: { getSessionId: () => 'ordinary-recovery' } }, handle: {}, _emit() {},
    _enqueueTurn: (text, attachments, options) => queue.add({ text, attachments, options }),
    _drainTurns() {
      if (queue.blocked()) return;
      const item = queue.take();
      if (item) void queue.run(item, async () => {
        sent.push(item.text);
        return sent.length === 1 ? { ok: false, reason: 'Temporary model service failure' } : { ok: true };
      });
    },
  };
  const handle = require('../main/pi-session/session-handle').create(ctx);
  assert.equal((await handle.submit('First plain message', [], {}).completion).ok, false);
  assert.equal(queue.state().paused, true);
  assert.equal((await handle.submit('New plain message', [], {}).completion).ok, true);
  assert.equal(queue.state().paused, false);
  assert.deepEqual(sent, ['First plain message', 'New plain message']);
  queue.pause('Explicit user pause');
  const blocked = handle.submit('Wait for confirmation', [], {});
  assert.equal(blocked.queued, true);
  assert.equal(queue.state().paused, true);
  assert.deepEqual(sent, ['First plain message', 'New plain message']);
  queue.clear();
});
