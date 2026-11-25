'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { create, createWorker } = require('../main/conversation/replica-store.cjs');
const { recoveryTail } = require('../main/conversation/conversation-transcript.cjs');

const user = text => ({ role: 'user', text });
const reply = text => ({ role: 'assistant', text });
const guard = row => ({ expectedRevision: row.replicaRevision, expectedTransferId: row.deviceTransferId || '',
  expectedCatalogRevision: row.revision });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-product-transcript-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'history.sqlite');
}

test('only a newly confirmed native user can replace the exact retained tail, even across different answer splits', t => {
  const file = fixture(t);
  let store = create(file);
  try {
    const [row] = store.register([{ id: 'circle' }]);
    const prefix = [user('circle'), reply('one answer')];
    const retained = [prefix[0], reply('one '), reply('answer'), user('earlier attempt')];
    const marker = recoveryTail(retained, prefix);
    store.saveConversationTranscript(row.id, retained, guard(row));
    const archive = (messages, coverage = {}) => ({ snapshot: { messages, tools: [] }, coverage: { complete: true, ...coverage } });
    const save = (value, options = {}) => store.saveDeviceHistory(row.id, value, {
      ...guard(row), transcriptTail: marker, expectedHistoryDigest: store.deviceHistoryVersion(row.id) ?? null, ...options });
    const different = [...prefix, user('changed question')];
    for (const [value, options] of [
      [archive(prefix)], [archive([...prefix, reply('not a user')])],
      [archive([user('different prefix'), ...different.slice(1)])], [archive(different, { complete: false })],
      [archive(different, { unresolvedTools: ['unfinished'] })], [{ ...archive(different), imported: { transferId: 'x' } }],
      [archive(different), { transcriptTail: { ...marker, digest: 'stale' } }],
      [archive(different), { expectedCatalogRevision: row.revision + 1 }], [archive(different), { expectedTransferId: 'stale' }],
      [archive(different), { expectedHistoryDigest: 'stale' }], [archive(different), { transcriptTail: undefined }],
    ]) {
      save(value, options);
      assert.deepEqual(store.conversationTranscript(row.id), retained);
    }
    assert.equal(store.saveConversationTranscript(row.id, different, guard(row)).diverged, true);
    const optimistic = [...retained, reply('unconfirmed reply')];
    assert.equal(store.saveConversationTranscript(row.id, optimistic, { ...guard(row), pendingTailDigest: marker.digest }).unchanged, true);
    assert.deepEqual(store.conversationTranscript(row.id), retained);
    // Identical user text can occur again at a different position.
    const confirmed = [...different, reply('answer'), user('changed question'), { ...reply('stream'), done: false }];
    assert.equal(save(archive(confirmed)).ok, true);
    store.close();
    store = create(file);
    assert.deepEqual(store.conversationTranscript(row.id, { includeDraftState: true }), confirmed);
    assert.deepEqual(store.deviceHistory(row.id).snapshot.messages, confirmed);
    save(archive([...prefix, user('stale second writer')]));
    assert.deepEqual(store.conversationTranscript(row.id, { includeDraftState: true }), confirmed);
  } finally { store.close(); }
});

test('a damaged independent prefix rolls back the native replacement', t => {
  const file = fixture(t), store = create(file);
  try {
    const [row] = store.register([{ id: 'damaged' }]);
    const prefix = [user('first'), reply('answer')], original = [...prefix, user('pending')];
    store.saveConversationTranscript(row.id, original, guard(row));
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file);
    try { db.prepare('UPDATE conversation_transcript SET data=? WHERE replica=? AND position=0')
      .run(JSON.stringify(user('damaged')), row.id); } finally { db.close(); }
    const archive = { snapshot: { messages: [...prefix, user('edited')], tools: [] }, coverage: { complete: true } };
    assert.throws(() => store.saveDeviceHistory(row.id, archive, { ...guard(row), transcriptTail: recoveryTail(original, prefix) }),
      { code: 'TRANSCRIPT_CHECKSUM_MISMATCH' });
    assert.equal(store.deviceHistoryVersion(row.id) ?? null, null);
  } finally { store.close(); }
});

test('public text survives restart and a runtime change without copying private fields', async t => {
  const file = fixture(t);
  let store = createWorker(file);
  try {
    const [row] = await store.register([{ id: 'ordinary', adapterId: 'pi', creator: { account: 'a' } }]);
    const question = { ...user('question'), submissionId: 'first-id', attachments: [{ path: 'private-path' }] };
    const live = { role: 'assistant', blocks: [{ kind: 'thinking', text: 'private reasoning' },
      { kind: 'text', text: 'part' }, { kind: 'toolcall', text: 'private arguments' }] };
    const thinking = { role: 'assistant', text: 'private fallback', blocks: [{ kind: 'thinking', text: 'private reasoning' }] };
    assert.equal((await store.saveConversationTranscript(row.id, [question, thinking, live], guard(row))).ok, true);
    await store.close();
    store = createWorker(file);
    assert.deepEqual(await store.conversationTranscript(row.id), [user('question'), reply('part')]);
    const [switched] = await store.register([{ id: row.id, adapterId: 'opencode' }]);
    const messages = [user('question'), reply('partial answer'), user('follow-up'), reply('next')];
    assert.equal((await store.saveConversationTranscript(row.id, messages, guard(switched))).ok, true);
    for (const bad of [[], [user('question')], [user('other'), ...messages.slice(1)], [...messages.slice(0, -1), reply('different')]])
      await store.saveConversationTranscript(row.id, bad, guard(switched));
    assert.deepEqual(await store.conversationTranscript(row.id), messages);
  } finally { await store.close(); }
});

test('stale captures, imported copies and retired identities cannot append or expose text', t => {
  const file = fixture(t), store = create(file), other = create(file);
  try {
    const [row] = store.register([{ id: 'chat' }]);
    const messages = [user('public'), reply('answer')];
    store.saveConversationTranscript(row.id, messages, guard(row));
    const [next] = other.register([{ id: row.id, at: 42 }]);
    assert.equal(store.saveConversationTranscript(row.id, [...messages, user('stale')], guard(row)).ok, false);
    assert.deepEqual(other.conversationTranscript(row.id), messages);
    const restricted = [ { id: 'cache', cached: true }, { id: 'cloud', cloud: true },
      { id: 'transferred', deviceTransferId: 'transfer' }, { id: 'task', taskId: 'work' } ];
    for (const r of other.register(restricted)) {
      assert.equal(store.saveConversationTranscript(r.id, messages, guard(r)).ok, false);
      assert.deepEqual(store.conversationTranscript(r.id), []);
    }
    other.lifecycle(row.id, 'delete');
    assert.equal(store.saveConversationTranscript(row.id, messages, guard(next)).ok, false);
    assert.deepEqual(other.conversationTranscript(row.id), []);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file);
    try { assert.equal(db.prepare('SELECT count(*) AS n FROM conversation_transcript').get().n, 0); }
    finally { db.close(); }
  } finally { store.close(); other.close(); }
});

test('a new canonical snapshot survives alias discovery and deleting the conversation removes segment text', t => {
  const file = fixture(t), store = create(file);
  try {
    const [canonical, segment] = store.register([{ id: 'public' }, { id: 'segment' }]);
    const head = [user('first'), reply('first answer')], suffix = [user('second'), reply('second answer')];
    store.saveConversationTranscript(canonical.id, head, guard(canonical));
    store.saveConversationTranscript(segment.id, suffix, guard(segment));
    store.join(canonical.id, [segment.id]);
    assert.deepEqual(store.conversationTranscript(segment.id), []);
    assert.deepEqual(store.conversationTranscript(canonical.id), head);
    const current = store.get(canonical.id);
    assert.equal(store.saveConversationTranscript(current.id, [...head, ...suffix], guard(current)).ok, true);
    assert.deepEqual(store.conversationTranscript(current.id), [...head, ...suffix]);
    store.lifecycle(canonical.id, 'delete');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file);
    try { assert.equal(db.prepare('SELECT count(*) AS n FROM conversation_transcript').get().n, 0); }
    finally { db.close(); }
  } finally { store.close(); }
});

test('an existing device database gains text storage without modifying its verified native snapshot', t => {
  const file = fixture(t);
  let store = create(file);
  const [row] = store.register([{ id: 'old' }]);
  const native = { snapshot: { messages: [user('existing')], tools: [] }, coverage: { complete: true } };
  const saved = store.saveDeviceHistory(row.id, native, { expectedRevision: row.replicaRevision });
  store.close();
  const { DatabaseSync } = require('node:sqlite');
  const old = new DatabaseSync(file);
  try { old.exec('DROP TABLE conversation_transcript'); } finally { old.close(); }
  store = create(file);
  try {
    assert.equal(store.deviceHistoryVersion(row.id), saved.digest);
    assert.deepEqual(store.conversationTranscript(row.id), []);
    assert.equal(store.saveConversationTranscript(row.id, [...native.snapshot.messages, reply('updated')], guard(row)).ok, true);
    assert.equal(store.deviceHistoryVersion(row.id), saved.digest);
  } finally { store.close(); }
});

test('Pi long pasted input keeps the full renderer text despite the shorter block projection', t => {
  const { create: accumulator } = require('../main/pi-session/event-stream');
  const pi = accumulator();
  const input = '中文粘贴段落 '.repeat(5000) + 'uniquely retained tail';
  pi.push({ type: 'message_end', message: { role: 'user', content: input } });
  // Legacy native entries can carry both fields. The user bubble renders text.
  pi.state.messages[0].blocks = [{ index: 0, kind: 'text', text: input, done: true }];
  const message = pi.snapshot().messages[0];
  assert.ok(message.blocks[0].text.length < input.length);
  assert.equal(message.text, input);
  const store = create(fixture(t));
  try {
    const [row] = store.register([{ id: 'paste' }]);
    store.saveConversationTranscript(row.id, [message], guard(row));
    assert.deepEqual(store.conversationTranscript(row.id), [user(input)]);
  } finally { store.close(); }
});

test('only a streaming tail can be corrected by a terminal event or hidden in a later turn', t => {
  const store = create(fixture(t));
  try {
    const [row] = store.register([{ id: 'live' }]);
    const save = messages => store.saveConversationTranscript(row.id, messages, guard(row));
    const question = user('hello'), pending = { ...reply('unfinished visible output'), done: false };
    save([question, pending]);
    assert.equal(save([question, { ...reply('other unfinished'), done: false }]).ok, false);
    const final = { ...reply('corrected'), done: true };
    assert.equal(save([question, final]).ok, true);
    assert.equal(save([question, pending]).ok, false);
    assert.equal(save([question, { ...final, done: false }]).ok, true);
    assert.equal(save([question, { ...reply('rewrite finished text'), done: true }]).ok, false);
    const committed = [question, final, user('second')], next = user('third');
    save([...committed, pending]);
    assert.equal(save([...committed, next, { ...reply('last answer'), done: true }]).ok, true);
    assert.deepEqual(store.conversationTranscript(row.id), [question, reply('corrected'), user('second'), next, reply('last answer')]);
  } finally { store.close(); }
});
