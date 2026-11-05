'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { create } = require('../main/conversation/personal-relay');

const flush = () => new Promise(resolve => setImmediate(resolve));
function clock() {
  let now = 0, sequence = 0;
  const timers = new Map();
  const next = () => [...timers.values()].sort((a, b) => a.at - b.at)[0];
  return {
    now: () => now, pending: () => timers.size, delay: () => next()?.at - now,
    setTimeout(fn, ms) { const timer = { id: ++sequence, at: now + ms, fn, unref() {} }; timers.set(timer.id, timer); return timer; },
    clearTimeout(timer) { timers.delete(timer.id); },
    async advance(ms) {
      const end = now + ms;
      await flush();
      while (next()?.at <= end) {
        const timer = next(); now = timer.at; timers.delete(timer.id); timer.fn(); await flush();
      }
      now = end; await flush();
    },
  };
}

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-relay-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const session = Buffer.from(JSON.stringify({ typ: 'device', cid: 'pc', uid: 'u1' })).toString('base64url') + '.sig';
  let identity = { hub: 'http://hub', clientId: 'pc', session };
  const job = { id: '12345678-1234-1234-1234-123456789012', targetClientId: 'pc', conversationId: 'account-1',
    sourceSessionId: 'native-1', instruction: 'read my local file', phase: 'prepared' };
  const state = { status: 'idle', messages: [{ role: 'user', text: 'earlier' }] };
  const handle = { sessionId: 'native-1', ref: 'native-ref', snapshot: () => state, inFlight: () => false };
  const calls = [], acks = [];
  let available = true, sends = 0;
  const dependencies = { app: { getPath: () => directory }, identityOf: async () => identity,
    find: () => available ? handle : null,
    open: async (opts) => { calls.push(['open', opts]); available = true; return { ok: true }; },
    sync: async () => ({ ok: true }), autoStart: false,
    send: async (ref, text, files, opts) => { await opts.nativeRelayGuard(); sends++; calls.push(['send', ref, text]); return { ok: true, accepted: true }; },
    fetch: async (_identity, url, opts) => {
      const route = url.split('/personal-conversation-relay/')[1];
      calls.push([route]);
      if (route === 'poll') return { ok: true, json: async () => ({ requests: ['accepted', 'rejected', 'uncertain'].includes(job.phase) ? [] : [structuredClone(job)] }) };
      if (route.startsWith('claims/')) { if (job.phase !== 'prepared') throw Error('already claimed'); job.phase = 'claimed'; }
      if (route.startsWith('acks/')) { const body = JSON.parse(opts.body); acks.push(body); if (options.failAck?.()) throw Error('offline'); job.phase = body.phase; }
      return { ok: true, json: async () => ({ ok: true }) };
    },
  };
  Object.assign(dependencies, options.override || {});
  const service = create(dependencies);
  t.after(() => service.close());
  return { service, job, state, handle, calls, acks, dependencies,
    setAvailable: value => { available = value; }, setIdentity: value => { identity = value; }, sends: () => sends };
}

function pollingFixture(t, { confirmed = true, poll }) {
  const f = fixture(t), time = clock(), starts = [];
  f.service.close();
  let wake, active = 0, maxActive = 0;
  const service = create({ ...f.dependencies, autoStart: true,
    pollingOptions: { ...time, random: () => 1 },
    discovery: { confirmed: () => confirmed, register(topic, callback) {
      assert.equal(topic, 'personal-relay'); wake = callback; return () => {};
    } },
    fetch: async (...args) => {
      const read = () => f.dependencies.fetch(...args);
      if (!args[1].endsWith('/poll')) return read();
      starts.push(time.now()); maxActive = Math.max(maxActive, ++active);
      try { return await poll({ time, read }); }
      finally { active--; }
    },
  });
  t.after(() => service.close());
  return { ...f, service, time, starts, wake: () => wake(), maxActive: () => maxActive };
}

test('confirmed relay recovers a lost push before the 60-second prepared deadline', async t => {
  let preparedAt = null, expiresAt = null;
  const f = pollingFixture(t, { poll: async ({ time, read }) => {
    if (preparedAt === null) return { ok: true, json: async () => ({ requests: [] }) };
    // The socket stays confirmed but delivers no hint. HTTP takes another 10s.
    await new Promise(resolve => time.setTimeout(resolve, 10000));
    if (time.now() >= expiresAt) return { ok: true, json: async () => ({ requests: [] }) };
    return read();
  } });
  for (let i = 0; i < 5; i++) await f.time.advance(f.time.delay());
  assert.equal(f.time.delay(), 30000);
  await f.time.advance(1);
  preparedAt = f.time.now(); expiresAt = preparedAt + 60000;
  await f.time.advance(40000);
  assert.equal(f.sends(), 1);
  assert.equal(f.job.phase, 'accepted');
  assert.ok(f.time.now() < expiresAt);
  assert.equal(f.maxActive(), 1);
});

for (const confirmed of [false, true]) test(`relay budgets slow HTTP within its ${confirmed ? 30 : 20}-second start gap`, async t => {
  const f = pollingFixture(t, { confirmed, poll: async ({ time }) => {
    await new Promise(resolve => time.setTimeout(resolve, 11000));
    return { ok: true, json: async () => ({ requests: [] }) };
  } });
  await f.time.advance(5000);
  for (let i = 0; i < 100; i++) f.wake();
  await f.time.advance(10999);
  assert.equal(f.starts.length, 1);
  await f.time.advance(1001);
  assert.equal(f.starts.length, 2);
  await f.time.advance(180000);
  const gaps = f.starts.slice(1).map((start, i) => start - f.starts[i]);
  assert.equal(Math.max(...gaps), confirmed ? 30000 : 20000);
  assert.equal(f.maxActive(), 1);
  f.service.close(); await f.time.advance(12000);
  assert.equal(f.time.pending(), 0);
});

test('confirmed relay retains completion-based error backoff despite push bursts', async t => {
  const f = pollingFixture(t, { poll: async ({ time }) => {
    await new Promise(resolve => time.setTimeout(resolve, 11000));
    throw Error('offline');
  } });
  await f.time.advance(5000);
  for (const delay of [10000, 20000, 40000, 60000]) {
    for (let i = 0; i < 100; i++) f.wake();
    await f.time.advance(11000);
    assert.equal(f.time.delay(), delay);
    const calls = f.starts.length;
    for (let i = 0; i < 100; i++) f.wake();
    await f.time.advance(delay - 1); assert.equal(f.starts.length, calls);
    await f.time.advance(1); assert.equal(f.starts.length, calls + 1);
  }
  assert.equal(f.maxActive(), 1);
  f.service.close(); await f.time.advance(11000);
  assert.equal(f.time.pending(), 0);
});

test('continues the original native session once and keeps its directory/runtime', async t => {
  const f = fixture(t);
  await f.service.tick(); await f.service.tick();
  assert.equal(f.sends(), 1);
  assert.deepEqual(f.calls.find(row => row[0] === 'send'), ['send', 'native-ref', 'read my local file']);
  assert.equal(f.acks[0].phase, 'accepted');
});

test('reopens the exact source archive without creating a new conversation', async t => {
  const f = fixture(t); f.setAvailable(false);
  await f.service.tick();
  assert.deepEqual(f.calls.find(row => row[0] === 'open')[1], { chatId: 'native-1', nativeRelay: true });
  assert.equal(f.sends(), 1);
});

test('ack loss retries only the durable acknowledgment across process restart', async t => {
  let fail = true;
  const f = fixture(t, { failAck: () => fail });
  await f.service.tick();
  assert.equal(f.job.phase, 'claimed'); assert.equal(f.sends(), 1);
  f.service.close(); fail = false;
  const restarted = create(f.dependencies); t.after(() => restarted.close());
  await restarted.tick();
  assert.equal(f.sends(), 1); assert.equal(f.job.phase, 'accepted');
});

test('a lost claim acknowledgment or absent local fence never replays the turn', async t => {
  const f = fixture(t); f.job.phase = 'claimed';
  await f.service.tick();
  assert.equal(f.sends(), 0); assert.equal(f.job.phase, 'uncertain');
});

test('busy native conversations are rejected without queueing a duplicate turn', async t => {
  const f = fixture(t); f.state.status = 'responding';
  await f.service.tick();
  assert.equal(f.sends(), 0); assert.equal(f.job.phase, 'rejected');
});

test('projection views and wrong target devices cannot execute', async t => {
  const f = fixture(t); f.handle.passiveCloudView = true;
  await f.service.tick(); assert.equal(f.sends(), 0);
  const other = fixture(t); other.job.targetClientId = 'foreign';
  await other.service.tick(); assert.equal(other.sends(), 0); assert.equal(other.acks.length, 0);
});

test('failed source synchronization blocks execution', async t => {
  const f = fixture(t, { override: { sync: async () => ({ ok: false }) } });
  await f.service.tick(); assert.equal(f.sends(), 0); assert.equal(f.job.phase, 'rejected');
});

test('parallel polls share a single admission operation', async t => {
  const f = fixture(t);
  await Promise.all([f.service.tick(), f.service.tick(), f.service.tick()]);
  assert.equal(f.sends(), 1);
});

test('closing relay aborts discovery and cannot submit a late response', async t => {
  let signal, resolve;
  const f = fixture(t, { override: { fetch: async (_identity, _url, options) => {
    signal = options.signal;
    assert.deepEqual(JSON.parse(options.body), { discoveryProtocol: 1 });
    return new Promise(done => { resolve = done; });
  } } });
  const pending = f.service.tick(); await new Promise(done => setImmediate(done));
  f.service.close(); assert.equal(signal.aborted, true);
  resolve({ ok: true, json: async () => ({ requests: [f.job] }) });
  await assert.rejects(pending, /切换/);
  assert.equal(f.sends(), 0);
});

test('source changes while claiming cannot submit a stale instruction', async t => {
  const f = fixture(t);
  const fetch = f.dependencies.fetch;
  f.service.close();
  const relay = create({ ...f.dependencies, fetch: async (...args) => {
    const result = await fetch(...args);
    if (args[1].includes('/claims/')) f.state.messages.push({ role: 'user', text: 'PC edit' });
    return result;
  } });
  t.after(() => relay.close());
  await relay.tick();
  assert.equal(f.sends(), 0);
});

test('same account on another Hub or device is still a different execution identity', async t => {
  for (const change of [{ hub: 'http://another-hub' }, { clientId: 'another-pc' }]) {
    const f = fixture(t);
    const fetch = f.dependencies.fetch;
    const identity = await f.dependencies.identityOf();
    f.service.close();
    const relay = create({ ...f.dependencies, fetch: async (...args) => {
      const result = await fetch(...args);
      if (args[1].includes('/claims/')) f.setIdentity({ ...identity, ...change });
      return result;
    } });
    t.after(() => relay.close());
    await relay.tick();
    assert.equal(f.sends(), 0);
  }
});

test('logout during the native send preparation is fenced before submit', async t => {
  const f = fixture(t);
  f.service.close();
  let submitted = false;
  const relay = create({ ...f.dependencies, send: async (_ref, _text, _files, opts) => {
    f.setIdentity(null);
    await opts.nativeRelayGuard();
    submitted = true;
  } });
  t.after(() => relay.close());
  await relay.tick();
  assert.equal(submitted, false);
});

test('native skills are revalidated and plugin selection is not cleared', async t => {
  const f = fixture(t); f.handle.ui = { selectedSkills: ['local-reports'] };
  f.service.close();
  let turn;
  const relay = create({ ...f.dependencies, send: async (_ref, _text, files, opts) => {
    await opts.nativeRelayGuard(); turn = opts;
    assert.deepEqual(files, []);
    return { ok: true, accepted: true };
  } });
  t.after(() => relay.close());
  await relay.tick();
  assert.deepEqual(turn.skills, ['local-reports']);
  assert.equal(turn.clearPluginSelection, undefined);
  assert.equal(turn.modelName, undefined);
  assert.equal(turn.cwd, undefined);
});

test('requirement execution cannot bypass its task lifecycle through native relay', async t => {
  const f = fixture(t); f.handle.taskRef = 'requirement-1';
  await f.service.tick();
  assert.equal(f.sends(), 0);
  assert.equal(f.job.phase, 'rejected');
  assert.match(f.acks[0].reason, /需求入口/);
});
