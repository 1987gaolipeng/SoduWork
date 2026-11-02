'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { create } = require('../main/conversation/personal-relay');

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
