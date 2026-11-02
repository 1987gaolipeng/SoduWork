'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { accountScopeKey } = require('../device-auth-request');
const { create } = require('./account-sync');
const { create: createStore } = require('./account-sync-store');

const identity = { hub: 'http://hub.test', clientId: 'desktop', session:
  Buffer.from(JSON.stringify({ typ: 'device', uid: 'alice', cid: 'desktop', exp: 9999999999 }))
    .toString('base64url') + '.' + 'a'.repeat(64) };
const allowed = new Set(['idle', 'responding', 'completed', 'interrupted', 'stopped', 'failed']);

function setup(t, fetch, initialJobs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-sync-state-'));
  const file = path.join(root, 'outbox.json');
  if (initialJobs) fs.writeFileSync(file, JSON.stringify({ version: 1, jobs: initialJobs, sessions: {} }));
  const store = createStore(file);
  const sync = create({ app: {}, store, identityOf: async () => identity, fetch });
  t.after(async () => { await sync.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { file, store, sync };
}

function reply(body, accepted = true) {
  return { ok: accepted, status: accepted ? 200 : 422,
    json: async () => accepted
      ? { ok: true, conversationId: 'account-1', sourceRevision: body.sourceRevision }
      : { detail: 'Unsupported conversation state' } };
}

test('native runtime states use the Hub conversation state contract', async t => {
  const sent = [];
  const { sync } = setup(t, async (_identity, _url, request) => {
    const body = JSON.parse(request.body); sent.push(body);
    return reply(body, allowed.has(body.state));
  });
  const cases = [
    ['streaming', 'responding'], ['running', 'responding'], ['queued', 'responding'],
    ['starting', 'responding'], ['dispatching', 'responding'], ['waiting-user', 'responding'],
    ['done', 'completed'], ['aborted', 'interrupted'], ['canceled', 'interrupted'],
    ['cancelled', 'interrupted'], ['unreachable', 'failed'], ['error', 'failed'],
    ...[...allowed].map(state => [state, state]),
  ];
  for (const [index, [native, expected]] of cases.entries()) {
    sync.bind({ sessionId: `native-${index}`, snapshot: () => ({ status: native, messages: [] }) }, identity);
    assert.equal((await sync.flush()).pending, 0, native);
    assert.equal(sent.at(-1).state, expected, native);
  }
});

test('persisted streaming checkpoints drain in order without losing the final reply', async t => {
  const attempts = [];
  let loseAck = true;
  const ownerKey = accountScopeKey(identity);
  const messages = [{ id: 'user-1', position: 0, role: 'user', text: 'First request' },
    { id: 'reply-1', position: 1, role: 'assistant', text: 'Original reply', done: true }];
  // Seed the pre-coalescing disk format to exercise recovery of legacy queues.
  // The current enqueue API intentionally keeps only the latest full snapshot.
  const jobs = [2, 3, 4].map(revision => ({
    id: `legacy-${revision}`, ownerKey, hub: identity.hub, clientId: identity.clientId,
    body: { sourceClientId: identity.clientId, sourceSessionId: 'native-1', sourceEpoch: 'native-1:desktop',
      sourceRevision: revision, title: 'Original conversation', state: revision === 4 ? 'idle' : 'streaming',
      messages: revision === 2 ? messages.slice(0, 1) : messages },
  }));
  const { file, sync } = setup(t, async (_identity, _url, request) => {
    const body = JSON.parse(request.body); attempts.push(request.body);
    if (!allowed.has(body.state)) return reply(body, false);
    if (loseAck) { loseAck = false; throw Error('acknowledgement lost'); }
    return reply(body);
  }, jobs);
  assert.equal(createStore(file).jobs().length, 3, 'legacy checkpoints are durable');
  assert.equal((await sync.flush()).pending, 3);
  assert.equal((await sync.flush()).pending, 0);
  assert.equal(attempts[0], attempts[1], 'a lost acknowledgement retries an identical payload');
  const accepted = attempts.slice(1).map(value => JSON.parse(value));
  assert.deepEqual(accepted.map(body => body.sourceRevision), [2, 3, 4]);
  assert.deepEqual(accepted.map(body => body.state), ['responding', 'responding', 'idle']);
  assert.ok(accepted.every(body => body.sourceSessionId === 'native-1' && body.sourceEpoch === 'native-1:desktop'));
  assert.deepEqual(accepted.at(-1).messages, messages);
  assert.equal(createStore(file).jobs().length, 0);
});

test('restart drains a durable outbox after login without binding or sending a new message', async t => {
  const { file, store, sync: previous } = setup(t, async () => { throw Error('not started'); });
  await previous.close();
  store.enqueue({ id: 'persisted-2', ownerKey: accountScopeKey(identity), hub: identity.hub,
    clientId: identity.clientId, body: { sourceSessionId: 'native-1', sourceEpoch: 'native-1:desktop',
      sourceRevision: 2, state: 'streaming', messages: [{ role: 'assistant', text: 'Saved reply' }] } });
  let loggedIn = false, reads = 0;
  const sent = [];
  const reopened = create({ app: {}, store: createStore(file), retryMs: 5,
    identityOf: async () => { reads++; return loggedIn ? identity : null; },
    fetch: async (_identity, _url, request) => {
      const body = JSON.parse(request.body); sent.push(body);
      return reply(body, allowed.has(body.state));
    } });
  t.after(() => reopened.close());
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.ok(reads > 0, 'startup must try the persisted queue without a new runtime event');
  assert.equal(sent.length, 0, 'do not sync before login');
  loggedIn = true;
  for (let i = 0; i < 100 && !sent.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].state, 'responding');
  assert.equal(sent[0].messages[0].text, 'Saved reply');
  assert.equal(createStore(file).jobs().length, 0);
});

test('opening an idle native transcript schedules its first sync without another event', async t => {
  const { file, sync: previous } = setup(t, async () => { throw Error('not started'); });
  await previous.close();
  const sent = [];
  const sync = create({ app: {}, store: createStore(file), retryMs: 5,
    identityOf: async () => identity,
    fetch: async (_identity, _url, request) => {
      const body = JSON.parse(request.body); sent.push(body); return reply(body);
    } });
  t.after(() => sync.close());
  sync.bind({ sessionId: 'idle-native', snapshot: () => ({ status: 'idle', messages: [
    { role: 'assistant', text: 'Existing reply' },
  ] }) }, identity);
  for (let i = 0; i < 100 && !sent.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].messages[0].text, 'Existing reply');
});
