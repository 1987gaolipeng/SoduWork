'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { create } = require('../main/conversation/device-history.cjs');
const segments = require('../main/conversation/runtime-segments');
const replicas = require('../main/conversation/replica-store.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-transcript-'));
  const app = { getPath: () => root };
  const id = 'first-run', logs = new Map([[id, [
    { seq: 1, kind: 'user', text: 'Keep my request' },
    { seq: 2, kind: 'say', text: 'Original', streamId: 'output', done: false },
    { seq: 3, kind: 'do', tool: 'write', callId: 'one', arguments: { body: 'old' } },
  ]]]);
  const runtime = { async rpc(method, { ref, since }) {
    assert.equal(method, 'job.session');
    const items = logs.get(ref);
    if (!items) return { ok: true, data: { ref, ok: false, code: 'NATIVE_HISTORY_MISSING', items: [] } };
    return { ok: true, data: { ref, seq: items.length, items: items.filter(event => event.seq > since).slice(0, 2) } };
  } };
  let store, history;
  function open() {
    store = replicas.create(path.join(root, 'history.sqlite'));
    history = create({ app, runtime, store, session: {}, resolve: key => store.get(key),
      register: rows => store.register(rows), guard: () => () => {}, authorize() {}, identityOf: () => ({}) });
  }
  open();
  store.register([{ id, adapterId: 'opencode', title: 'Fixture' }]);
  t.after(async () => { await history.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { app, id, logs, runtime, get store() { return store; }, get history() { return history; },
    async restart() { await history.close(); store.close(); open(); } };
}
for (const legacy of [false, true]) test('Runner history preserves durable evidence on ' +
  (legacy ? 'upgrade from a cursor-only snapshot' : 'subsequent reads'), async t => {
  for (const change of ['truncation', 'replacement', 'longer rewrite', 'tool rewrite']) await t.test(change, async t => {
    const f = fixture(t), original = f.logs.get(f.id);
    const { snapshot, coverage } = await f.history.refresh(f.id);
    if (legacy) {
      const sources = coverage.sources.map(({ id, adapterId, revision }) => ({ id, adapterId, revision }));
      assert.ok(f.store.saveDeviceHistory(f.id, { snapshot, coverage: { ...coverage, sources } },
        { expectedRevision: f.store.get(f.id).replicaRevision }).ok);
    }
    await f.restart();
    const rewritten = structuredClone(original);
    if (change === 'truncation') rewritten.pop();
    else if (change === 'tool rewrite') rewritten[2].arguments.body = 'replacement';
    else {
      rewritten[0].text = 'Different request';
      if (change === 'longer rewrite') rewritten.push({ seq: 4, kind: 'say', text: 'Later answer' });
    }
    f.logs.set(f.id, rewritten);
    await assert.rejects(f.history.refresh(f.id), { code: 'NATIVE_HISTORY_DIVERGED' });
    f.logs.delete(f.id);
    await f.restart();
    const saved = await f.history.saved(f.id, { refresh: true });
    assert.equal(saved.nativeReadError.code, 'NATIVE_HISTORY_DIVERGED');
    assert.deepEqual(saved.snapshot, JSON.parse(JSON.stringify(snapshot)));
    await assert.rejects(f.history.prepareContinuation(f.id, { refresh: true }), { code: 'NATIVE_HISTORY_DIVERGED' });
    f.logs.set(f.id, [...original, { seq: 4, kind: 'say', streamId: 'output', text: ' ending', delta: true },
      { seq: 5, kind: 'out', callId: 'one', text: 'Verified output' }]);
    const continued = await f.history.prepareContinuation(f.id, { refresh: true });
    assert.equal(continued.prefix.messages[1].text, 'Original ending');
    assert.equal(continued.prefix.tools[0].result, 'Verified output');
    assert.match(f.store.deviceHistory(f.id).coverage.sources[0].journalDigest, /^[a-f0-9]{64}$/);
  });
});
test('loss of a runtime-switch manifest preserves all previously verified Runner segments', async t => {
  const f = fixture(t);
  f.logs.set('next-run', [{ seq: 1, kind: 'user', text: 'Second segment' }]);
  const manifest = { id: f.id, version: 1, segments: [{ sessionId: f.id, adapterId: 'opencode' }],
    active: { sessionId: 'next-run', adapterId: 'kimi' } };
  await segments.save(f.app, manifest);
  const before = await f.history.refresh(f.id);
  await segments.remove(f.app, f.id);
  await assert.rejects(f.history.refresh(f.id), { code: 'NATIVE_HISTORY_DIVERGED' });
  assert.deepEqual(f.store.deviceHistory(f.id).snapshot, JSON.parse(JSON.stringify(before.snapshot)));
  await segments.save(f.app, manifest);
  assert.equal((await f.history.refresh(f.id)).snapshot.messages.at(-1).text, 'Second segment');
});
test('a changing page boundary, queue placeholder or unrelated ref cannot replace a stable Runner transcript', async t => {
  const f = fixture(t), original = f.logs.get(f.id);
  const before = await f.history.refresh(f.id), rpc = f.runtime.rpc;
  f.logs.set(f.id, [{ ...original[0], text: 'Inconsistent page' }, ...original.slice(1),
    ...[4, 5, 6].map(seq => ({ seq, kind: 'say', text: 'Append' }))]);
  f.runtime.rpc = async (method, args) => {
    const result = await rpc(method, args);
    if (args.since === 4) result.data.seq++;
    return result;
  };
  await assert.rejects(f.history.refresh(f.id), { code: 'NATIVE_HISTORY_CHANGED' });
  for (const data of [{ ref: f.id, seq: 0, items: [], admissionKey: 'waiting' },
    { ref: 'other', seq: 3, items: original }]) {
    f.runtime.rpc = async () => ({ ok: true, data });
    await assert.rejects(f.history.refresh(f.id), { code: 'NATIVE_HISTORY_UNAVAILABLE' });
  }
  assert.equal(f.store.deviceHistory(f.id).digest, before.digest);
  f.runtime.rpc = rpc;
  f.logs.set(f.id, original.map(event => Object.fromEntries(Object.entries(event).reverse())));
  assert.equal((await f.history.refresh(f.id)).coverage.sources[0].journalDigest, before.coverage.sources[0].journalDigest);
});
