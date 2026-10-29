'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createRunnerRuntimeAdapter, getRunnerSessionDetails, _uuidV5 } = require('../main/agent-runtime/runner-adapter');
const catalog = require('../main/agent-runtime/runtime-catalog');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
async function until(check) { for (let n = 0; n < 500; n++) { if (check()) return; await delay(5); } throw Error('Runner admission fixture timed out'); }

async function fixture(t, spec, { delayedDispatch = false, delayedPlugin = false, staleReply = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-steering-admission-'));
  const app = { getPath: () => root }, calls = [], events = [], comments = [];
  const initialPoll = deferred(), secondPoll = deferred(), stop = deferred(), dispatch = deferred(), plugin = deferred();
  const file = path.join(root, 'queued.txt'); fs.writeFileSync(file, 'retained queued attachment');
  let pollCount = 0, status = 'running', rows = [], round = 1;
  const data = () => ({ ok: true, status, round, items: rows,
    error: status === 'stopped' ? '你把它叫停了' : '' });
  const runtime = { async rpc(op, value) {
    calls.push({ op, value });
    if (op === 'runtime.detect') return { ok: true, data: {} };
    if (op === 'job.dispatch') {
      const receipt = { ok: true, data: { ok: true,
        ref: _uuidV5('9af442c8-cd1d-4b91-a668-22da2b2635bf', value.dispatchId) } };
      if (delayedDispatch && calls.filter(row => row.op === 'job.dispatch').length === 1) { const reply = await dispatch.promise; return reply || receipt; }
      return receipt;
    }
    if (op === 'job.comment') {
      const pending = deferred(); comments.push({ value, ...pending }); return pending.promise;
    }
    if (op === 'job.stop') return stop.promise;
    if (op === 'job.session') {
      pollCount++;
      if (pollCount === 1) return initialPoll.promise;
      if (pollCount === 2 && staleReply) return secondPoll.promise;
      return { ok: true, data: data() };
    }
    throw Error(op);
  } };
  const model = { ok: true, model: { id: 'fixture', input: ['text'], key: 'synthetic', baseUrl: 'http://synthetic.invalid/v1' } };
  const adapter = createRunnerRuntimeAdapter({ app, runtimeSpec: spec, runnerRuntime: runtime,
    modelConfig: { fetchModel: async () => model, fetchSelection: async () => model } });
  const session = await adapter.createSession({ identity: {}, native: { runner: { openOptions: {
    app, cwd: root, ref: 'admission-' + spec.id,
    resolvePlugins: async ids => {
      if (delayedPlugin) await plugin.promise;
      return { items: ids.map(pluginId => ({ pluginId, name: 'Fixture', version: '1', context: 'Selected plugin context', capabilities: {} })), grant: { cleanup() {} } };
    },
  } } } });
  const handle = getRunnerSessionDetails(session).handle;
  handle.on((event, snapshot) => events.push({ kind: event.kind, status: snapshot.status, reconnecting: event.reconnecting }));
  t.after(async () => {
    stop.resolve({ ok: true, data: { ok: true } }); plugin.resolve(); dispatch.resolve();
    initialPoll.resolve({ ok: true, data: { ok: true, status: 'stopped', items: [] } });
    secondPoll.resolve({ ok: true, data: { ok: true, status: 'stopped', items: [] } });
    comments.forEach(row => row.resolve({ ok: true, data: { ok: true, state: 'done' } }));
    await session.dispose(); await delay(10); fs.rmSync(root, { recursive: true, force: true });
  });
  return { handle, calls, comments, events, file, dispatch, plugin, secondPoll, initialPoll,
    get polls() { return pollCount; },
    async cancelOriginal() {
      const first = handle.submit('original request', []);
      await until(() => pollCount === 1);
      stop.resolve({ ok: true, data: { ok: true } });
      handle.cancel(); await first.completion;
      await delay(10);
    },
    async beginSteering(options = {}) {
      const first = handle.submit('original request', []);
      await until(() => pollCount === 1 && handle.snapshot().execution.queueImmediate.available);
      const later = handle.submit('later request', [{ path: file, name: 'queued.txt' }], { submissionId: 'later' });
      const guide = handle.submit('old guidance', [], { submissionId: 'guide', ...options });
      assert.equal(handle.updateQueue(guide.queueId, 'edit', 'edited guidance').ok, true);
      const steering = handle.updateQueue(guide.queueId, 'send-now');
      await until(() => calls.some(row => row.op === 'job.stop'));
      stop.resolve({ ok: true, data: { ok: true } });
      // Queue-immediate's stop ACK leaves a zero-delay refresh outstanding.
      for (let n = 0; n < 12; n++) await Promise.resolve();
      status = 'stopped'; initialPoll.resolve({ ok: true, data: data() });
      assert.equal((await steering).ok, true);
      assert.equal((await first.completion).cancelled, true);
      return { first, later, guide };
    },
    admit(index = 0) {
      status = 'running'; round++;
      comments[index].resolve({ ok: true, data: { ok: true, state: 'running' } });
    },
    complete(index = 0) {
      status = 'done';
      rows = [{ seq: 1, kind: 'user', text: comments[index].value.text }, { seq: 2, kind: 'say', text: 'Guided response' }];
    },
  };
}

for (const spec of catalog.runnerRuntimes()) {
  test(spec.id + ': stale stop timer cannot settle guidance while its admission reply is pending', async t => {
    const f = await fixture(t, spec), { guide, later } = await f.beginSteering();
    let settled = false; guide.completion.then(() => { settled = true; });
    await until(() => f.comments.length === 1); await delay(35);
    assert.equal(settled, false);
    assert.equal(f.handle.snapshot().status, 'streaming');
    assert.equal(f.comments[0].value.text, 'edited guidance');
    assert.match(f.comments[0].value.promptText, /edited guidance/);
    assert.equal(f.polls, 1, 'old timer is cleared before native admission');
    assert.deepEqual(f.handle.snapshot().execution.queue.map(row => row.id), [later.queueId]);
    f.admit(); f.complete();
    assert.equal((await guide.completion).ok, true);
    await until(() => f.comments.length === 2);
    assert.equal(f.comments[1].value.text, 'later request');
    assert.equal(f.comments[1].value.localFiles[0].path, f.file);
    assert.equal(f.comments.filter(row => row.value.text === 'edited guidance').length, 1);
  });
}

for (const stale of ['stopped', 'transport-error']) test('an in-flight ' + stale + ' observation from before manual stop cannot complete the next turn', async t => {
  const f = await fixture(t, catalog.runtime('opencode'), { delayedPlugin: true });
  await f.cancelOriginal();
  const guide = f.handle.submit('edited guidance', [], { pluginIds: ['fixture-plugin'] });
  let settled = false; guide.completion.then(() => { settled = true; });
  f.plugin.resolve(); await until(() => f.comments.length === 1);
  f.admit(); await delay(35); // The new poll cannot run while the old RPC is held.
  if (stale === 'stopped') f.initialPoll.resolve({ ok: true, data: { ok: true, status: 'stopped', round: 1, items: [], error: '你把它叫停了' } });
  else f.initialPoll.reject(Error('old observation transport failed'));
  await until(() => f.polls >= 2);
  assert.equal(settled, false);
  assert.equal(f.handle.snapshot().status, 'streaming');
  assert.equal(f.events.some(row => row.reconnecting), false);
  assert.match(f.comments[0].value.promptText, /edited guidance/);
  assert.match(f.comments[0].value.promptText, /Selected plugin context/);
  f.complete(); assert.equal((await guide.completion).ok, true);
});

test('plugin preparation does not publish the old native stop as a fresh settled turn', async t => {
  const f = await fixture(t, catalog.runtime('opencode'), { delayedPlugin: true });
  const { guide } = await f.beginSteering({ pluginIds: ['fixture-plugin'] });
  const start = f.events.length;
  await delay(40);
  assert.equal(f.polls, 1);
  assert.equal(f.handle.snapshot().status, 'streaming');
  assert.equal(f.events.slice(start).some(row => row.kind === 'settled'), false);
  f.plugin.resolve(); await until(() => f.comments.length === 1);
  f.admit(); f.complete(); assert.equal((await guide.completion).ok, true);
});

for (const operation of ['dispatch', 'comment']) for (const outcome of ['rejected', 'ambiguous']) {
  test(operation + ' ' + outcome + ' admission preserves remaining text/files, pauses, and never resends automatically', async t => {
    const f = await fixture(t, catalog.runtime('opencode'), { delayedDispatch: operation === 'dispatch' });
    let active, later, reply;
    if (operation === 'dispatch') {
      active = f.handle.submit('initial request', []);
      later = f.handle.submit('later request', [{ path: f.file, name: 'queued.txt' }], { submissionId: 'later' });
      reply = f.dispatch;
    } else {
      await f.cancelOriginal();
      active = f.handle.submit('edited guidance', []);
      later = f.handle.submit('later request', [{ path: f.file, name: 'queued.txt' }], { submissionId: 'later' });
      await until(() => f.comments.length === 1); reply = f.comments[0];
    }
    const reason = outcome === 'rejected' ? 'Runner rejected this admission' : 'Runner receipt timed out; delivery is unknown';
    if (outcome === 'rejected') reply.resolve({ ok: false, error: reason });
    else reply.reject(Error(reason));
    const result = await active.completion;
    assert.equal(result.ok, false); assert.equal(result.reason, reason);
    if (operation === 'comment') f.initialPoll.resolve({ ok: true, data: { ok: true, status: 'done', items: [] } });
    await delay(50);
    const snap = f.handle.snapshot();
    assert.equal(snap.status, 'unreachable');
    assert.equal(snap.execution.turnQueue.paused, true);
    assert.deepEqual(snap.execution.queue.map(row => ({ id: row.id, text: row.text, attachments: row.attachments })),
      [{ id: later.queueId, text: 'later request', attachments: ['queued.txt'] }]);
    assert.equal(fs.readFileSync(f.file, 'utf8'), 'retained queued attachment');
    assert.equal(f.calls.filter(row => row.op === 'job.' + operation).length, 1);
    assert.equal(f.events.some(row => row.kind === 'settled' && row.status === 'idle'), false);
    if (operation === 'dispatch') {
      const resumed = f.handle.updateQueue('', 'resume');
      if (outcome === 'ambiguous') {
        assert.equal(resumed.ok, false); assert.match(resumed.reason, /尚未确认/);
        assert.equal(f.calls.filter(row => row.op === 'job.dispatch').length, 1);
      } else {
        assert.equal(resumed.ok, true);
        await until(() => f.calls.filter(row => row.op === 'job.dispatch').length === 2);
        const sent = f.calls.filter(row => row.op === 'job.dispatch')[1].value;
        assert.equal(sent.ctx.conversationUserText, 'later request');
        assert.equal(sent.localFiles[0].path, f.file);
        f.initialPoll.resolve({ ok: true, data: { ok: true, status: 'done', items: [] } });
        assert.equal((await later.completion).ok, true);
      }
    }
  });
}
