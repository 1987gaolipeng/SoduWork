'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { identity } = require('./helpers/platform-session-fixture.cjs');
const { create: createStore } = require('../main/conversation/replica-store.cjs');
const { create } = require('../main/conversation/shared-history.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'device-history-'));
  const app = { getPath: () => root }, file = path.join(root, 'pi-agent', 'sessions', 'one.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let current = identity(), denied = false, history, store;
  const row = { id: 'one', adapterId: 'pi', path: file, cwd: root, title: 'Synthetic history', count: 300,
    workOwner: require('../main/platform-connections/runtime.cjs').scope(current),
    taskId: '', creator: { account: 'one', hub: current.hub } };
  const session = {
    historyEntry: async (_app, id, options) => {
      assert.equal(options?.strict, true);
      if (denied) return { ok: false, reason: 'EACCES: synthetic access denied' };
      return id === row.id && fs.existsSync(file) ? { ok: true, entry: row } : { ok: false, notFound: true };
    },
    archivedConversation: async () => null, findBySessionId: () => null,
  };
  function open() { store = createStore(path.join(root, 'history.sqlite')); history = create({ app, session, store, identityOf: () => current }); }
  open();
  t.after(async () => { await history.close(); fs.rmSync(root, { recursive: true, force: true }); });
  function write(count = 300) {
    const entries = [{ type: 'session', id: 'one' }];
    for (let i = 0; i < count; i++) entries.push({ type: 'message', id: 'entry-' + i,
      message: { role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: 'Message ' + i }] } });
    entries.push({ type: 'message', id: 'tool-call', message: { role: 'assistant', content: [
      { type: 'toolCall', id: 'tool-one', name: 'read', arguments: { path: 'synthetic.txt' } }] } },
    { type: 'message', id: 'tool-result', message: { role: 'toolResult', toolCallId: 'tool-one', toolName: 'read', content: [{ type: 'text', text: 'Full synthetic receipt' }] } });
    fs.writeFileSync(file, entries.map(value => JSON.stringify(value)).join('\n') + '\n');
  }
  return { root, app, row, file, session, write, get history() { return history; }, get store() { return store; },
    identity: () => current, setIdentity: value => { current = value; }, deny: () => { denied = true; },
    async restart() { await history.close(); open(); } };
}
test('native backfill retains the full transcript and tools independently of native archives', async t => {
  const f = fixture(t); f.write(); await f.history.projectRows([f.row]);
  await f.history.backfill('one');
  const bundle = await f.history.exportPortable('one');
  assert.equal(bundle.coverage.complete, true);
  assert.equal(bundle.snapshot.messages[0].text, 'Message 0');
  assert.ok(bundle.snapshot.messages.length >= 300);
  assert.equal(bundle.snapshot.tools[0].result, 'Full synthetic receipt');
  fs.unlinkSync(f.file); await f.restart();
  const page = await f.history.read('one', { limit: 200 });
  assert.equal(page.items[0].text, 'Message 0');
  assert.equal(page.nextCursor, 200);
  const view = await f.history.open('one');
  assert.ok(view.snapshot().tools.some(tool => tool.result === 'Full synthetic receipt'));
  const continuation = await require('../main/conversation/native-history-opening.cjs').resolve({ ...f, history: f.history });
  assert.equal(continuation.resume.id, 'one');
  assert.equal(continuation.recovery.prefix.messages[0].text, 'Message 0');
  assert.equal(continuation.recovery.historyRecovery.nativeArchiveMissing, true);
});
function piArchive(texts, ending = '\n') {
  return [{ type: 'session', id: 'one' }, ...texts.map((text, index) => ({
    type: 'message', id: 'entry-' + index, message: { role: index % 2 ? 'assistant' : 'user', content: text },
  }))].map(row => JSON.stringify(row)).join('\n') + ending;
}

test('a verified unstarted Runner segment preserves the Pi body; uncertain or admitted segments stay read-only', async t => {
  const f = fixture(t), segments = require('../main/conversation/runtime-segments');
  const runnerRef = require('../main/agent-runtime/runner-adapter').runnerRefForDispatch;
  const dormant = name => ({ adapterId: 'codex', started: false, sessionId: runnerRef(name), nativeDispatchId: name });
  const middle = dormant('dormant-middle'), tail = dormant('dormant-tail');
  let cold = false, offline = false, admitted = false, busy = false;
  t.mock.method(require('../main/runner-runtime'), 'rpc', async (op, p) => {
    if (op === 'job.session') {
      if (p.ref === tail.sessionId && busy) return { ok: false, code: 'RUNNER_RPC_BUSY', retryable: true, uncertain: false };
      if (p.ref === tail.sessionId && offline) throw Error('offline');
      if (p.ref === tail.sessionId && admitted)
        return { ok: true, data: { ref: p.ref, seq: 1, items: [{ seq: 1, kind: 'say', text: 'New turn' }] } };
      return { ok: true, data: { ok: false, ref: p.ref, code: 'NATIVE_HISTORY_MISSING', items: [] } };
    }
    assert.equal(op, 'job.has');
    assert.equal(p.checkPendingWork, true);
    const persisted = cold && p.ref === tail.sessionId && p.admissionKey === 'dispatch:' + tail.sessionId;
    return { ok: true, data: { has: persisted, inflight: false, persisted, admissionDurable: true, localWorkPending: false,
      bootId: 'boot', admissionKey: p.admissionKey || '' } };
  });
  f.write(3);
  await segments.save(f.app, { version: 1, id: f.row.id, owner: f.row.workOwner, cwd: f.row.cwd,
    originAdapter: 'pi', segments: [{ sessionId: f.row.id, adapterId: 'pi' }, middle], active: tail });
  await f.history.projectRows([f.row]);
  const saved = await f.history.backfill(f.row.id);
  assert.equal(saved.coverage.complete, true);
  assert.deepEqual(saved.coverage.sources.filter(s => s.dormant).map(s => s.id), [middle.sessionId, tail.sessionId]);
  assert.equal(saved.snapshot.messages[0].text, 'Message 0');
  assert.equal((await f.history.exportPortable(f.row.id)).coverage.complete, true);

  cold = true;
  const view = await f.history.open(f.row.id, { historyPreview: true, allowContinuation: true });
  assert.equal(view.snapshot().messages[0].text, 'Message 0');
  assert.equal(view.snapshot().historyRecovery.incomplete, true);
  assert.match(view.snapshot().historyRecovery.reason, /codex/);
  assert.equal(view.snapshot().execution.canContinueOnDevice, false);
  await assert.rejects(f.history.prepareContinuation(f.row.id, { refresh: true }), /不完整/);
  await assert.rejects(f.history.prepareContinuation(f.row.id), /不完整/);
  await assert.rejects(f.history.exportPortable(f.row.id), /完整/);
  assert.equal((await f.store.deviceHistory(f.row.id)).digest, saved.digest);

  cold = false;
  const local = await require('../main/conversation/task-output-journal').create(f.app, tail.sessionId);
  local.append(0, { kind: 'message', role: 'assistant', text: 'Controlled task output before dispatch' });
  local.close();
  await assert.rejects(f.history.prepareContinuation(f.row.id, { refresh: true }), /不完整/);
  offline = true;
  assert.equal((await f.history.open(f.row.id)).snapshot().historyRecovery.incomplete, true);
  offline = false; admitted = true;
  const next = await f.history.backfill(f.row.id);
  assert.equal(next.coverage.sources.at(-1).revision, '1');
  assert.equal(next.coverage.sources.at(-1).dormant, undefined);
  const replica = f.store.deviceHistory(f.row.id);
  const { digest, savedAt, ...body } = replica;
  const legacy = await f.store.saveDeviceHistory(f.row.id, { ...body,
    localArtifactHistory: { root: fs.realpathSync(f.row.cwd), items: [{ relative: 'report.txt' }] },
  }, { expectedRevision: f.store.get(f.row.id).replicaRevision, expectedHistoryDigest: digest });
  assert.equal(legacy.ok, true);
  const backup = t.mock.method(require('../main/conversation/device-artifact-archive.cjs'), 'preserve',
    async (_profile, _id, prior) => prior);
  busy = true;
  await assert.rejects(f.history.prepareContinuation(f.row.id, { refresh: true }), { code: 'RUNNER_HISTORY_BUSY' });
  assert.equal(backup.mock.callCount(), 0);
  assert.equal(f.store.deviceHistory(f.row.id).digest, legacy.digest);
  assert.equal(f.store.deviceHistory(f.row.id).coverage.complete, true);
});

test('a partial native read retains the verified tools and artifact binding at a matching turn', async t => {
  const f = fixture(t), messages = [{ role: 'user', text: 'Draw' }];
  const saved = { digest: 'stored', snapshot: { messages, tools: [{ id: 'tool', state: 'done' }] },
    coverage: { complete: true, sources: [] }, localArtifactHistory: { items: [{ relative: 'drawing.png' }] } };
  const history = require('../main/conversation/device-history.cjs').create({ app: f.app, session: f.session,
    store: { deviceHistory: () => saved }, resolve: async () => f.row, guard: () => () => {}, authorize() {} });
  let prefix = messages;
  t.mock.method(require('../main/conversation/device-history-native.cjs'), 'read', async () => {
    throw Object.assign(Error('busy'), { code: 'RUNNER_HISTORY_BUSY', history: {
      snapshot: { messages: prefix, tools: [] }, coverage: { complete: false, sources: [] } } });
  });
  const read = () => history.saved(f.row.id, { refresh: true });
  const equal = await read();
  assert.equal(equal.coverage.complete, false);
  assert.deepEqual(equal.snapshot.tools, saved.snapshot.tools);
  assert.equal(equal.localArtifactHistory, saved.localArtifactHistory);
  prefix = [...messages, { role: 'assistant', blocks: [] }];
  const longer = await read();
  assert.equal(longer.snapshot.messages.length, 2);
  assert.equal(longer.digest, saved.digest);
  assert.equal(longer.localArtifactHistory, saved.localArtifactHistory);
  prefix = [{ role: 'user', text: 'Different work' }, prefix[1]];
  assert.equal((await read()).localArtifactHistory, undefined);
});

test('retired Runner descriptors without a started flag need both dispatch absence and the full frozen prefix', async t => {
  const f = fixture(t), segments = require('../main/conversation/runtime-segments');
  const sessionId = require('../main/agent-runtime/runner-adapter').runnerRefForDispatch('legacy-codex');
  const old = { sessionId, adapterId: 'codex', nativeDispatchId: 'legacy-codex', usedHarnesses: [] };
  const user = { role: 'user', text: 'Original', sentAt: 1700000000000 };
  const prefix = { messages: [user], tools: [] };
  const used = { sessionId: 'used', adapterId: 'qwen' }, active = { sessionId: 'current', adapterId: 'dsh' };
  let pending = false, receipt = false, permitted = true;
  const busy = new Map([['job.session', 1], ['keyed', 1], ['live', 1]]);
  const runtime = { async rpc(op, p) {
    const key = op === 'job.has' ? p.admissionKey ? 'keyed' : 'live' : op;
    if (p.ref === sessionId && busy.get(key) > 0) {
      busy.set(key, busy.get(key) - 1);
      return { ok: false, code: 'RUNNER_RPC_BUSY', retryable: true, uncertain: false };
    }
    if (op === 'job.session') {
      if (p.ref === sessionId) return { ok: true, data: { ok: false, ref: p.ref, code: 'NATIVE_HISTORY_MISSING', items: [] } };
      const event = { seq: 1, kind: 'user', text: p.ref === 'used' ? user.text : 'Later', sentAt: user.sentAt };
      return { ok: true, data: { ref: p.ref, seq: 1, items: [event] } };
    }
    assert.equal(op, 'job.has');
    return { ok: true, data: { has: receipt, persisted: receipt, inflight: false, localWorkPending: pending,
      admissionDurable: true, bootId: 'boot', admissionKey: p.admissionKey || '' } };
  } };
  const manifest = { version: 1, id: 'used', segments: [used, old], active, prefix };
  const save = overrides => segments.save(f.app, { ...manifest, ...overrides });
  const read = extra => require('../main/conversation/device-history-native.cjs').read({ app: f.app, row: { id: 'used' },
    session: f.session, runtime, guard() {}, mayVerifyLegacyRetired: () => permitted, ...extra });
  const blocked = async () => assert.rejects(read(), { code: 'NATIVE_SEGMENT_UNAVAILABLE' });
  await save({});
  const saved = await read();
  assert.equal(saved.coverage.complete, true);
  assert.deepEqual([...busy.values()], [0, 0, 0]);
  assert.equal(saved.coverage.sources[1].dormant, true);
  assert.deepEqual(saved.snapshot.messages.map(m => m.text), ['Original', 'Later']);
  busy.set('live', Infinity);
  await assert.rejects(read(), error => error.code === 'RUNNER_HISTORY_BUSY' &&
    error.history.coverage.complete === false && /暂忙/.test(error.message));
  busy.set('live', 1); pending = true; await blocked(); pending = false;
  busy.set('keyed', 1); receipt = true; await blocked(); receipt = false;
  permitted = false; await blocked(); permitted = true;
  await assert.rejects(read({ previousSources: [saved.coverage.sources[0],
    { id: sessionId, adapterId: 'codex', revision: '2' }] }), { code: 'NATIVE_SEGMENT_UNAVAILABLE' });
  for (const change of [
    { prefix: { ...prefix, messages: [user, { ...user, text: 'Lost dispatch' }] } },
    { prefix: { ...prefix, messages: [{ ...user, sentAt: user.sentAt + 1 }] } },
    { prefix: { ...prefix, tools: [{ id: sessionId + ':tool', callId: 'unrecorded' }] } },
    { deviceShared: true }, { deviceTransferId: 'other-device' },
    { segments: [used, { ...old, usedHarnesses: ['codex'] }] },
    { segments: [used, { ...old, started: true }] }, { segments: [used], active: old },
  ]) { await save(change); await blocked(); }
});

test('opening a truncated or rewritten Pi archive preserves the full replica and blocks execution and transfer', async t => {
  const original = ['first', 'reply', 'second', 'final'];
  const variants = {
    truncated: original.slice(0, 2),
    rewritten: ['other', ...original.slice(1)],
    extendedRewrite: [...original.slice(0, 3), 'different reply', 'new request'],
  };
  for (const [name, rewritten] of Object.entries(variants)) await t.test(name, async t => {
    const f = fixture(t);
    fs.writeFileSync(f.file, piArchive(original));
    await f.history.register([f.row]);
    await f.history.backfill(f.row.id);
    const saved = f.store.deviceHistory(f.row.id);
    await f.restart();
    fs.writeFileSync(f.file, piArchive(rewritten));
    const view = await f.history.open(f.row.id, { historyPreview: true, allowContinuation: true });
    assert.equal(view.snapshot().messages.length, original.length);
    assert.equal(view.snapshot().execution.canContinueOnDevice, false);
    assert.deepEqual(f.store.deviceHistory(f.row.id).snapshot, saved.snapshot);
    await assert.rejects(f.history.prepareContinuation(f.row.id));
    await assert.rejects(f.history.prepareContinuation(f.row.id, { refresh: true }));
    await assert.rejects(f.history.exportPortable(f.row.id));
    await view.close();

    fs.writeFileSync(f.file, piArchive([...original, 'next request']));
    const recovery = await f.history.prepareContinuation(f.row.id, { refresh: true });
    assert.equal(recovery.prefix.messages.length, original.length + 1);
    assert.equal(recovery.prefix.messages.at(-1).text, 'next request');
  });
});

test('a legacy Pi digest accepts genuine appends with or without a final line ending', async t => {
  for (const ending of ['\n', '']) await t.test(ending ? 'with newline' : 'without newline', async t => {
    const f = fixture(t);
    const original = ['问题', '回答'];
    const bytes = piArchive(original, ending);
    fs.writeFileSync(f.file, bytes);
    await f.history.register([f.row]);
    const { snapshot } = await f.history.backfill(f.row.id);
    const revision = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    const coverage = { complete: true, sources: [{ id: f.row.id, adapterId: 'pi', revision }], unresolvedTools: [] };
    assert.equal(f.store.saveDeviceHistory(f.row.id, { snapshot, coverage }, {
      expectedRevision: f.store.get(f.row.id).replicaRevision }).ok, true);
    await f.restart();
    fs.writeFileSync(f.file, piArchive(['他人', '替换', 'new']));
    await f.history.open(f.row.id, { historyPreview: true, allowContinuation: true }).then(view => view.close());
    assert.deepEqual(f.store.deviceHistory(f.row.id).snapshot, snapshot);
    fs.writeFileSync(f.file, piArchive([...original, '新消息']));
    assert.equal((await f.history.prepareContinuation(f.row.id, { refresh: true })).prefix.messages.at(-1).text, '新消息');
  });
});

test('Pi history conflicts retain newly discovered account restrictions after the native archive disappears', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, piArchive(['first', 'reply', 'second', 'final']));
  await f.history.register([f.row]);
  const before = await f.history.backfill(f.row.id);
  const binding = { type: 'custom', customType: 'soduwork.task.binding', data: { taskId: 'private-task', taskTitle: 'Private task' } };
  fs.writeFileSync(f.file, piArchive(['first', 'reply']) + JSON.stringify(binding) + '\n');
  const view = await f.history.open(f.row.id, { historyPreview: true, allowContinuation: true });
  assert.equal(view.snapshot().messages.length, before.snapshot.messages.length);
  await view.close();
  fs.unlinkSync(f.file);
  await f.restart();
  f.setIdentity(identity('two'));
  await assert.rejects(f.history.open(f.row.id, { historyPreview: true }));
  await assert.rejects(f.history.prepareContinuation(f.row.id));
});

test('a slower Pi reader cannot replace a newer complete snapshot committed by another writer', async t => {
  const f = fixture(t);
  const messages = ['initial', 'reply', 'follow-up', 'latest'];
  fs.writeFileSync(f.file, piArchive(messages.slice(0, 2)));
  await f.history.register([f.row]);
  await f.history.backfill(f.row.id);
  const other = create({ app: f.app, session: f.session, identityOf: f.identity,
    store: createStore(path.join(f.root, 'history.sqlite')) });
  const pending = Promise.withResolvers(), resume = Promise.withResolvers();
  const save = f.store.saveDeviceHistory.bind(f.store);
  t.mock.method(f.store, 'saveDeviceHistory', async (...args) => {
    pending.resolve();
    await resume.promise;
    return save(...args);
  });
  fs.writeFileSync(f.file, piArchive(messages.slice(0, 3)));
  const slower = f.history.backfill(f.row.id);
  try {
    await pending.promise;
    fs.writeFileSync(f.file, piArchive(messages));
    await other.backfill(f.row.id);
  } finally {
    resume.resolve();
    await Promise.allSettled([slower]);
    await other.close();
  }
  assert.equal(f.store.deviceHistory(f.row.id).snapshot.messages.at(-1).blocks[0].text, 'latest');
});

test('permission failure cannot authorize a replacement native session even with complete local history', async t => {
  const f = fixture(t); f.write(4); await f.history.projectRows([f.row]); await f.history.backfill('one'); f.deny();
  await assert.rejects(require('../main/conversation/native-history-opening.cjs').resolve({ ...f, history: f.history }), /EACCES/);
  assert.equal((await f.history.read('one')).items[0].text, 'Message 0');
});
test('ordinary device history stays readable across accounts while transfer and deletion retain ownership checks', async t => {
  const f = fixture(t); f.write(4); await f.history.projectRows([f.row]); await f.history.backfill('one');
  f.setIdentity(identity('two'));
  assert.equal((await f.history.read('one')).items[0].text, 'Message 0');
  await assert.rejects(f.history.exportPortable('one'), /账号/);
  f.setIdentity(identity()); await f.history.lifecycle('one', 'delete');
  assert.equal(await f.store.deviceHistory('one'), null);
  await f.history.projectRows([f.row]);
  await assert.rejects(f.history.read('one'), /不存在/);
  assert.equal(f.store.get('one').deleted, true);
});
test('portable history import preserves logical identity, is idempotent, and rejects altered or conflicting transfers', async t => {
  const source = fixture(t); source.write(4); source.row.taskId = 'task-one';
  await source.history.projectRows([source.row]);
  const bundle = await source.history.exportPortable('one');
  const target = fixture(t), options = { identity: target.identity(), cwd: target.root, transferId: 'transfer-one' };
  const first = await target.history.importPortable(bundle, options);
  assert.equal(first.id, 'one');
  assert.equal(target.store.get('one').taskId, 'task-one');
  assert.equal((await target.history.importPortable(bundle, options)).ok, true);
  const changed = structuredClone(bundle); changed.snapshot.messages[0].text = 'tampered';
  await assert.rejects(target.history.importPortable(changed, options), /校验/);
  await assert.rejects(target.history.importPortable(bundle, { ...options, transferId: 'unrelated' }), /不能覆盖/);
  assert.equal((await target.history.read('one')).items[0].text, 'Message 0');
});
test('an independently created target history wins a race with a previously empty transfer destination', async t => {
  const source = fixture(t), target = fixture(t);
  source.write(4); await source.history.projectRows([source.row]);
  const bundle = await source.history.exportPortable('one');
  const register = target.store.register.bind(target.store);
  target.store.register = (rows, options) => {
    if (options?.expectedAbsent) register([{ ...target.row, title: 'Created on the receiver' }]);
    return register(rows, options);
  };
  await assert.rejects(target.history.importPortable(bundle, {
    identity: target.identity(), cwd: target.root, transferId: 'late-incoming'
  }), /接收期间已创建/);
  assert.equal(target.store.get('one').title, 'Created on the receiver');
  assert.equal(target.store.deviceHistory('one'), null);
});
test('imported attachments only receive paths from verified files in the new workspace', async t => {
  const source = fixture(t); source.write(4); await source.history.projectRows([source.row]);
  const original = await source.history.exportPortable('one'), target = fixture(t), crypto = require('node:crypto');
  const { sha256: ignored, ...bundle } = original;
  bundle.snapshot.messages[0].attachments = [
    { name: 'selected', path: '/old-device/selected.txt', previewRef: 'file:///etc/passwd' },
    { name: 'missing', path: '/private/unselected.txt', previewRef: 'file:///private/unselected.txt' } ];
  bundle.attachments = [{ path: '/old-device/selected.txt', relativePath: 'selected.txt' }];
  bundle.snapshot.tools[0].args = { path: '/old-device/selected.txt' };
  bundle.sha256 = crypto.createHash('sha256').update(JSON.stringify(bundle)).digest('hex');
  fs.writeFileSync(path.join(target.root, 'selected.txt'), 'reviewed-file');
  await target.history.importPortable(bundle, { identity: target.identity(), cwd: target.root, transferId: 'files',
    files: [{ path: 'selected.txt', size: 13, sha256: crypto.createHash('sha256').update('reviewed-file').digest('hex') }] });
  const saved = await target.store.deviceHistory('one'), files = saved.snapshot.messages[0].attachments;
  assert.equal(files[0].path, path.join(target.root, 'selected.txt'));
  assert.equal(files[0].previewRef, undefined);
  assert.equal(files[1].path, undefined); assert.equal(files[1].availability, 'missing');
  assert.equal(saved.snapshot.tools[0].args.path, '/old-device/selected.txt', 'Historical arguments are evidence, never a path grant');
});
test('Runner backfill assembles all pages and untruncated stream/tool receipts without starting execution', async t => {
  const f = fixture(t), long = 'synthetic '.repeat(10000), calls = [];
  const events = [ { seq: 1, kind: 'user', text: 'request' }, { seq: 2, kind: 'text', streamId: 'answer', text: long, delta: true },
    { seq: 3, kind: 'text', streamId: 'answer', text: ' tail', delta: true, done: true },
    { seq: 4, kind: 'do', callId: 'call', tool: 'read', arguments: { path: 'file' } },
    { seq: 5, kind: 'out', callId: 'call', text: long, isError: false } ];
  const runtime = { rpc: async (method, args) => { calls.push(method); return { ok: true, data: {
    ok: true, seq: 5, items: events.filter(event => event.seq > args.since).slice(0, 2) } }; } };
  const data = await require('../main/conversation/device-history-native.cjs').read({ app: f.app, session: f.session,
    row: { id: 'runner-one', adapterId: 'qwen' }, runtime, guard() {} });
  assert.equal(data.snapshot.messages[1].blocks[0].text, long + ' tail');
  assert.equal(data.snapshot.tools[0].result, long);
  assert.equal(data.coverage.complete, true);
  assert.deepEqual(calls, ['job.session', 'job.session', 'job.session']);
});
test('Runner backfill rejects nonadvancing or invalid cursors instead of retrying indefinitely', async t => {
  const f = fixture(t);
  for (const second of [[{ seq: 1, kind: 'user' }], [{ seq: '2', kind: 'user' }],
    [{ seq: 3, kind: 'user' }], [null], []]) {
    let calls = 0;
    const runtime = { rpc: async () => {
      if (++calls > 2) throw Error('Unexpected retry after a broken history cursor');
      return { ok: true, data: { ok: true, seq: 2,
        items: calls === 1 ? [{ seq: 1, kind: 'user', text: 'retained request' }] : second } };
    } };
    await assert.rejects(require('../main/conversation/device-history-native.cjs').read({ app: f.app,
      session: f.session, row: { id: 'runner-one', adapterId: 'qwen' }, runtime, guard() {} }),
    { code: 'NATIVE_HISTORY_UNAVAILABLE' });
    assert.equal(calls, 2);
  }
});
test('a remaining title without any transcript opens an explicit missing-content view and cannot continue', async t => {
  const f = fixture(t); await f.history.register([f.row]);
  const view = await f.history.open('one');
  assert.equal(view.historyRow().title, 'Synthetic history');
  assert.deepEqual(view.snapshot().messages, []);
  assert.equal(view.snapshot().historyRecovery.bodyMissing, true);
  assert.match(view.snapshot().historyRecovery.reason, /仅剩会话标题/);
  assert.equal((await f.history.page()).chats[0].historyContentState, 'missing');
  assert.equal(f.store.get('one').deleted, false);
  assert.equal((await require('../main/conversation/native-history-opening.cjs').resolve({ ...f, history: f.history })).readOnly, true);
  assert.equal((await view.send('must not run')).accepted, false);
  f.deny();
  await assert.rejects(f.history.open('one'), /EACCES/);
});
test('replaying an acknowledged import never overwrites later local history', async t => {
  const source = fixture(t); source.write(2); await source.history.projectRows([source.row]);
  const bundle = await source.history.exportPortable('one'), target = fixture(t);
  const options = { identity: target.identity(), cwd: target.root, transferId: 'once' };
  await target.history.importPortable(bundle, options);
  const saved = await target.store.deviceHistory('one'); saved.snapshot.messages.push({ role: 'user', text: 'Later local message' });
  await target.store.saveDeviceHistory('one', saved, { expectedRevision: target.store.get('one').replicaRevision });
  const repeated = await target.history.importPortable(bundle, options);
  assert.equal(repeated.unchanged, true);
  assert.equal((await target.store.deviceHistory('one')).snapshot.messages.at(-1).text, 'Later local message');
});
test('account switching while a transferred file is read prevents any target history registration', async t => {
  const source = fixture(t); source.write(2); await source.history.projectRows([source.row]);
  const bundle = await source.history.exportPortable('one'), target = fixture(t), crypto = require('node:crypto');
  const filename = path.join(target.root, 'selected.txt'); fs.writeFileSync(filename, 'approved');
  const read = fs.promises.readFile;
  t.mock.method(fs.promises, 'readFile', async function (file, ...args) {
    const value = await read.call(this, file, ...args);
    if (file === filename) target.setIdentity(identity('two'));
    return value;
  });
  await assert.rejects(target.history.importPortable(bundle, { identity: target.identity(), cwd: target.root, transferId: 'changed-account',
    files: [{ path: 'selected.txt', size: 8, sha256: crypto.createHash('sha256').update('approved').digest('hex') }] }), /切换|账号/);
  assert.equal(target.store.get('one'), null);
});
test('returned history ignores the old native archive, catalog refresh, and delayed native capture', async t => {
  const target = fixture(t); target.write(2); await target.history.projectRows([target.row]); await target.history.backfill('one');
  const old = target.store.get('one'), original = target.store.deviceHistory('one');
  const predecessor = require('../main/conversation/device-transfer-receipt.cjs').historyStamp(old, original, 'outgoing');
  const source = fixture(t); source.write(4); source.row.title = 'Returned with new messages'; await source.history.projectRows([source.row]);
  const bundle = await source.history.exportPortable('one');
  const cwd = path.join(target.root, 'returned'); fs.mkdirSync(cwd);
  await target.history.importPortable(bundle, { identity: target.identity(), cwd, transferId: 'returned', predecessor });
  await target.history.projectRows([target.row]);
  await target.history.capture({ snapshot: () => original.snapshot, historyRow: () => target.row }, target.identity());
  await target.history.backfill('one');
  const row = target.store.get('one');
  assert.equal(row.title, bundle.conversation.title); assert.equal(row.cwd, cwd);
  assert.deepEqual((await target.history.exportPortable('one')).snapshot.messages, bundle.snapshot.messages);
  const opening = await require('../main/conversation/native-history-opening.cjs').resolve({ ...target, row, history: target.history });
  assert.equal(opening.resume.path, '');
  assert.equal(opening.recovery.prefix.messages.length, bundle.snapshot.messages.length);
  assert.equal(target.store.saveDeviceHistory('one', original, { expectedRevision: row.replicaRevision, expectedTransferId: '' }).stale, true);
  assert.deepEqual((await target.history.prepareContinuation('one')).prefix.messages, bundle.snapshot.messages);
  assert.equal(fs.existsSync(target.file), true, 'The superseded native archive is retained');
});
test('a partially committed import cannot expose an earlier generation as the accepted transcript', async t => {
  const source = fixture(t); source.write(2); await source.history.projectRows([source.row]);
  const bundle = await source.history.exportPortable('one'), target = fixture(t);
  await target.history.importPortable(bundle, { identity: target.identity(), cwd: target.root, transferId: 'first' });
  await target.history.register([{ ...target.store.get('one'), deviceTransferId: 'incomplete-return' }]);
  await assert.rejects(target.history.prepareContinuation('one'), { code: 'HISTORY_IMPORT_PENDING' });
  assert.equal(target.store.deviceHistory('one').imported.transferId, 'first');
});
test('native tool receipts export deterministically using recorded times instead of the replay clock', async t => {
  const f = fixture(t); f.write(2);
  const entries = fs.readFileSync(f.file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const startedAt = 1710000000000, endedAt = startedAt + 3000;
  entries.find(entry => entry.id === 'tool-call').timestamp = new Date(startedAt).toISOString();
  entries.find(entry => entry.id === 'tool-result').timestamp = new Date(endedAt).toISOString();
  fs.writeFileSync(f.file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  await f.history.projectRows([f.row]);
  const first = await f.history.exportPortable('one');
  await new Promise(resolve => setTimeout(resolve, 25));
  const second = await f.history.exportPortable('one');
  assert.equal(first.sha256, second.sha256);
  assert.equal(second.snapshot.tools[0].startedAt, startedAt);
  assert.equal(second.snapshot.tools[0].endedAt, endedAt);
  assert.deepEqual(second.coverage.unresolvedTools, []);
});
test('an unpaired native tool call remains readable but blocks recovery and migration', async t => {
  const f = fixture(t); f.write(2);
  fs.appendFileSync(f.file, JSON.stringify({ type: 'message', id: 'orphan-call', message: {
    role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'unconfirmed', name: 'write', arguments: { path: 'result.txt' } }] } }) + '\n');
  await f.history.projectRows([f.row]); await f.history.backfill('one');
  const saved = f.store.deviceHistory('one');
  assert.equal(saved.coverage.complete, true);
  assert.equal(saved.coverage.unresolvedTools.length, 1);
  assert.equal(saved.snapshot.tools.at(-1).state, 'unknown');
  assert.equal((await f.history.read('one')).items[0].text, 'Message 0');
  await assert.rejects(f.history.exportPortable('one'), { code: 'HISTORY_UNRESOLVED_TOOLS' });
  await assert.rejects(f.history.prepareContinuation('one'), { code: 'HISTORY_UNRESOLVED_TOOLS' });
  fs.unlinkSync(f.file);
  assert.equal((await require('../main/conversation/native-history-opening.cjs').resolve({ ...f, history: f.history })).readOnly, true);
  assert.match((await f.history.open('one')).snapshot().historyRecovery.reason, /缺少终结回执/);
});
test('a retired unknown Runner result can start a new local turn only after all executions and admissions are idle', async t => {
  const f = fixture(t), segments = require('../main/conversation/runtime-segments');
  const retired = { sessionId: 'old-runner', adapterId: 'opencode', started: true };
  const active = { sessionId: 'latest-runner', adapterId: 'kimi', started: true };
  const record = { version: 1, id: f.row.id, owner: f.row.workOwner, cwd: f.root, originAdapter: 'pi',
    segments: [{ sessionId: f.row.id, adapterId: 'pi' }, retired], active };
  let queued = false, quiescent = true, piBusy = false, busyQueries = 0, pendingRef = '';
  f.session.historyExecutionsIdle = ids => ids.includes(f.row.id) && !piBusy;
  t.mock.method(require('../main/runner-runtime'), 'rpc', async (op, p) => {
    const old = p.ref === retired.sessionId, part = old ? retired : active;
    if (op === 'job.has' && old && busyQueries > 0) {
      busyQueries--;
      return { ok: false, code: 'RUNNER_RPC_BUSY', retryable: true, uncertain: false };
    }
    if (op === 'job.has') return { ok: true, data: { bootId: 'runner', inflight: false,
      localWorkPending: false, admissionDurable: true, localAdmissionsPending: queued && old || p.ref === pendingRef } };
    if (op !== 'job.session') return { ok: false };
    const items = old ? [{ seq: 1, kind: 'user', text: 'Old question' },
      { seq: 2, kind: 'do', tool: 'bash', callId: 'missing-result', text: 'Old command' }] :
      [{ seq: 1, kind: 'user', text: 'Next question' }, { seq: 2, kind: 'say', text: 'Next answer' }];
    return { ok: true, data: { ok: true, ref: p.ref, cli: part.adapterId, workDir: f.root,
      deviceTransfer: { schemaVersion: 1, quiescent }, status: 'done', ended: 10,
      seq: items.length, items: items.filter(e => e.seq > p.since) } };
  });
  f.write(2);
  await segments.save(f.app, record);
  await f.history.projectRows([f.row]); await f.history.backfill(f.row.id);
  const preview = async () => (await f.history.open(f.row.id, { historyPreview: true, allowContinuation: true })).snapshot();
  assert.equal((await preview()).execution.canContinueOnDevice, true);
  const options = { refresh: true, allowRetiredTools: true };
  const recovery = await f.history.prepareContinuation(f.row.id, options);
  assert.equal(recovery.prefix.tools.find(tool => tool.callId === 'missing-result').state, 'running');
  const sources = recovery.historyRecovery.retiredRunnerSources;
  await f.history.verifyRetiredToolSend(f.row.id, active.sessionId, sources);
  busyQueries = 1;
  assert.equal((await preview()).execution.canContinueOnDevice, true);
  assert.equal(busyQueries, 0);
  busyQueries = Infinity;
  const busy = await preview();
  assert.equal(busy.execution.canContinueOnDevice, false);
  assert.match(busy.historyRecovery.reason, /暂忙/);
  assert.ok(busy.messages.length > 0);
  await assert.rejects(f.history.verifyRetiredToolSend(f.row.id, active.sessionId, sources), { code: 'RUNNER_HISTORY_BUSY' });
  busyQueries = 0;
  await assert.rejects(f.history.exportPortable(f.row.id), { code: 'HISTORY_UNRESOLVED_TOOLS' });
  await assert.rejects(f.history.prepareContinuation(f.row.id), { code: 'HISTORY_UNRESOLVED_TOOLS' });
  queued = true;
  await assert.rejects(f.history.verifyRetiredToolSend(f.row.id, active.sessionId, sources), { code: 'HISTORY_UNRESOLVED_TOOLS' });
  assert.equal((await preview()).execution.canContinueOnDevice, false);
  queued = false; quiescent = false;
  await assert.rejects(f.history.prepareContinuation(f.row.id, options), { code: 'HISTORY_UNRESOLVED_TOOLS' });
  quiescent = true; piBusy = true;
  assert.equal((await preview()).execution.canContinueOnDevice, false);
  piBusy = false;
  const middle = { sessionId: 'recovered-runner', adapterId: 'kimi', started: true };
  const recovered = { ...record, deviceHistoryComplete: true, prefix: recovery.prefix,
    segments: [...record.segments, active], active: middle, historyRecovery: recovery.historyRecovery };
  await segments.save(f.app, recovered);
  await assert.rejects(f.history.checkpointRetiringRunner(f.row.id, retired.sessionId));
  const extended = await f.history.checkpointRetiringRunner(f.row.id, middle.sessionId);
  assert.deepEqual(extended, [...sources, { id: middle.sessionId, adapterId: 'kimi', revision: '2' }]);
  const replay = await f.store.deviceHistory(f.row.id);
  const last = { sessionId: 'next-runner', adapterId: 'kimi', started: true };
  await segments.save(f.app, { ...recovered, segments: [...recovered.segments, middle], active: last,
    prefix: replay.snapshot, historyRecovery: { ...recovery.historyRecovery, retiredRunnerSources: extended } });
  await f.restart();
  assert.equal((await preview()).execution.canContinueOnDevice, true);
  pendingRef = middle.sessionId;
  await assert.rejects(f.history.verifyRetiredToolSend(f.row.id, last.sessionId, sources), { code: 'HISTORY_UNRESOLVED_TOOLS' });
  assert.equal((await preview()).execution.canContinueOnDevice, false);
  pendingRef = '';
  f.setIdentity(identity('two'));
  const other = await f.history.open(f.row.id, { historyPreview: true, allowContinuation: true });
  assert.notEqual(other?.snapshot().execution.canContinueOnDevice, true);
});
test('nonexecuted tool drafts and a recorded cancellation do not block history continuation', async t => {
  const f = fixture(t); f.write(2);
  const additions = ['error', 'aborted', 'length'].map(stopReason => ({ type: 'message', message: {
    role: 'assistant', stopReason, content: [{ type: 'toolCall', id: 'draft-' + stopReason, name: 'write', arguments: {} }] } }));
  additions.push({ type: 'message', message: { role: 'assistant', stopReason: 'toolUse', content: [
    { type: 'toolCall', id: 'cancelled', name: 'write', arguments: { path: 'cancelled.txt' } }] } },
  { type: 'message', message: { role: 'toolResult', toolCallId: 'cancelled', toolName: 'write', content: [],
    details: { soduWorkAccessChange: { state: 'cancelled', cancelReason: 'access-change' } } } });
  fs.appendFileSync(f.file, additions.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  await f.history.projectRows([f.row]);
  const bundle = await f.history.exportPortable('one');
  assert.deepEqual(bundle.coverage.unresolvedTools, []);
  assert.equal(bundle.snapshot.tools.at(-1).state, 'cancelled');
  assert.equal((await f.history.prepareContinuation('one')).prefix.tools.length, 2);
});
test('an earlier Pi receipt cannot finish a new tool with a reused native call ID', async t => {
  const f = fixture(t); f.write(2);
  const additions = [
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'New turn' }] } },
    { type: 'message', message: { role: 'assistant', content: [
      { type: 'toolCall', id: 'tool-one', name: 'write', arguments: { path: 'different.txt' } }] } },
  ];
  fs.appendFileSync(f.file, additions.map(row => JSON.stringify(row)).join('\n') + '\n');
  await f.history.projectRows([f.row]); await f.history.backfill('one');
  const saved = f.store.deviceHistory('one');
  assert.deepEqual(saved.coverage.unresolvedTools.map(tool => tool.callId), ['tool-one']);
  assert.equal(saved.snapshot.tools[0].result, 'Full synthetic receipt');
  await assert.rejects(f.history.prepareContinuation('one'), { code: 'HISTORY_UNRESOLVED_TOOLS' });
});
test('Runner started tools without terminal receipts retain explicit unresolved coverage', async t => {
  const f = fixture(t);
  const runtime = { rpc: async () => ({ ok: true, data: { ok: true, seq: 1,
    items: [{ seq: 1, kind: 'do', callId: 'unfinished', tool: 'write', arguments: { path: 'result.txt' } }] } }) };
  const saved = await require('../main/conversation/device-history-native.cjs').read({ app: f.app,
    session: f.session, row: { id: 'runner-one', adapterId: 'qwen' }, runtime, guard() {} });
  assert.equal(saved.coverage.unresolvedTools[0].callId, 'unfinished');
});
test('Runner diagnostics and receipts from another segment cannot settle an earlier tool', async t => {
  const f = fixture(t);
  const items = [
    { seq: 1, seg: 1, kind: 'do', callId: 'item_0', tool: 'write' },
    { seq: 2, seg: 1, kind: 'out', tool: 'stderr', text: 'Connection notice' },
    { seq: 3, seg: 2, kind: 'out', callId: 'item_0', tool: 'write', text: 'Another segment' },
  ];
  const runtime = { rpc: async () => ({ ok: true, data: { ok: true, seq: items.length, items } }) };
  const saved = await require('../main/conversation/device-history-native.cjs').read({ app: f.app,
    session: f.session, row: { id: 'runner-one', adapterId: 'codex' }, runtime, guard() {} });
  assert.deepEqual(saved.coverage.unresolvedTools.map(t => t.callId), ['item_0']);
  assert.deepEqual(saved.snapshot.tools.map(t => t.result), ['', 'Connection notice', 'Another segment']);
});
test('a cold Runner journal keeps reading past the page cursor to find the actual terminal receipt', async t => {
  const f = fixture(t);
  const items = Array.from({ length: 199 }, (_, i) => ({ seq: i + 1, kind: 'say', text: 'Historical message ' + i }));
  items.push({ seq: 200, kind: 'do', tool: 'write', callId: 'spans-pages' },
    { seq: 201, kind: 'out', tool: 'write', callId: 'spans-pages', text: 'Recorded execution result' },
    { seq: 202, kind: 'say', text: 'Final answer' });
  const pages = [];
  const runtime = { rpc: async (_op, { since, limit }) => {
    pages.push(since);
    const page = items.filter(i => i.seq > since).slice(0, limit);
    return { ok: true, data: { ok: true, items: page, last: page.at(-1)?.seq || since, status: 'unknown' } };
  } };
  const saved = await require('../main/conversation/device-history-native.cjs').read({ app: f.app,
    session: f.session, row: { id: 'runner-one', adapterId: 'qwen' }, runtime, guard() {} });
  assert.equal(saved.snapshot.messages.at(-1).blocks[0].text, 'Final answer');
  assert.deepEqual(saved.coverage.unresolvedTools, []);
  assert.equal(saved.snapshot.tools[0].result, 'Recorded execution result');
  assert.equal(saved.coverage.sources[0].revision, '202');
  assert.ok(pages.includes(200));
});
test('only a unique unfinished native image read accepts a correlated local receipt', async t => {
  const f = fixture(t);
  const open = (seq, callId, toolKind = 'read') => ({ seq, kind: 'do', callId, toolKind,
    arguments: { path: '/fixture.png' }, _sourceId: 'tool_use:' + callId + ':0' });
  const items = [open(1, 'image'), open(2, 'unclear'), open(3, 'shell', 'execute'), open(4, 'repeat'),
    { seq: 5, kind: 'out', callId: 'repeat' }, open(6, 'repeat'), { seq: 7, kind: 'say', text: 'Completed' }];
  const requests = [];
  const read = async (receipt) => require('../main/conversation/device-history-native.cjs').read({
    app: f.app, session: f.session, row: { id: 'runner-one', adapterId: 'codex-harness' }, guard() {},
    runtime: { rpc: async (op, args) => {
      if (op === 'job.session') return { ok: true, data: { ok: true, seq: items.length, items } };
      assert.equal(op, 'runtime.history.imageReceipts');
      requests.push(args);
      return { ok: true, data: receipt };
    } } });
  const receipt = { ref: 'runner-one', revision: 7, callIds: ['image', 'repeat', 'shell'] };
  const result = await read(receipt);
  assert.deepEqual(result.coverage.unresolvedTools.map(tool => tool.callId), ['unclear', 'shell', 'repeat']);
  assert.deepEqual(result.snapshot.tools.find(tool => tool.callId === 'image').state, 'done');
  assert.deepEqual(requests[0].calls, ['image', 'unclear'].map(callId => ({ callId, path: '/fixture.png' })));
  for (const invalid of [{ ...receipt, ref: 'other' }, { ...receipt, revision: 6 }, {}])
    assert.equal((await read(invalid)).coverage.unresolvedTools.length, 4);
});
test('a Qwen write cancelled before execution never succeeds or blocks a settled continuation', async t => {
  const f = fixture(t), id = 'interrupted-write', binding = 'd'.repeat(64);
  const [row] = await f.store.register([{ ...f.row, id, adapterId: 'qwen' }]);
  const events = [{ seq: 1, kind: 'user', text: 'Create a small example' },
    { seq: 2, kind: 'do', tool: 'WriteFile', toolKind: 'edit', callId: 'x', _sourceId: 'tool_use:x:0', arguments: {} },
    { seq: 3, kind: 'turn-end', state: 'interrupted' }];
  let response = { ref: id, binding, revision: 3, callIds: ['x'] };
  const history = require('../main/conversation/device-history.cjs').create({ app: f.app, session: f.session,
    store: f.store, resolve: key => f.store.get(key), register() {}, guard: () => () => {}, authorize() {}, identityOf: f.identity,
    runtime: { rpc: async (op, request) => {
      if (op === 'job.session') return { ok: true, data: { ref: id, seq: 3, items: events } };
      assert.equal(op, 'runtime.history.qwenCancelledWrites');
      assert.deepEqual(request.calls, ['x']);
      return { ok: true, data: response };
    } },
  });
  async function verify() {
    const { prefix } = await history.prepareContinuation(row.id, { refresh: true });
    assert.equal(prefix.tools.length, 1);
    assert.equal(prefix.tools[0].state, 'cancelled');
    assert.equal(prefix.tools[0].cancelReason, 'access-change');
    assert.equal(prefix.tools[0].isError, false);
  }
  await verify();
  response = { ...response, callIds: [], archiveMissing: true };
  await verify();
  events[0].text = 'Replaced history';
  await assert.rejects(history.prepareContinuation(row.id, { refresh: true }), { code: 'NATIVE_HISTORY_DIVERGED' });
  assert.equal(f.store.deviceHistory(id).snapshot.messages[0].text, 'Create a small example');
  events[0].text = 'Create a small example';
  for (const invalid of [{ ref: 'other', revision: 3, binding }, { ref: id, revision: 2, binding }, { ref: id, revision: 3 }]) {
    response = { ...invalid, callIds: ['x'] };
    await assert.rejects(history.prepareContinuation(row.id, { refresh: true }), { code: 'HISTORY_UNRESOLVED_TOOLS' });
  }
});

test('a locally verified image read survives loss of its rollout only for the same complete Runner journal', async t => {
  const f = fixture(t);
  const id = 'legacy-image', binding = 'a'.repeat(64);
  const [row] = await f.store.register([{ ...f.row, id, adapterId: 'codex-harness', count: 1 }]);
  const items = [{ seq: 1, kind: 'user', text: 'Inspect the image' }, { seq: 2, round: 1, seg: 1,
    kind: 'do', toolKind: 'read', callId: 'once', arguments: { path: '/sample.png' }, _sourceId: 'tool_use:once:0' }];
  const confirmed = { ref: id, revision: 2, binding, callIds: ['once'] };
  const missing = { ...confirmed, archiveMissing: true, callIds: [] };
  let receipt = confirmed;
  const runtime = { rpc: async op => ({ ok: true, data: op === 'job.session'
    ? { ok: true, ref: id, seq: 2, items } : receipt }) };
  const history = require('../main/conversation/device-history.cjs').create({
    app: f.app, session: f.session, store: f.store, resolve: key => f.store.get(key), register: () => {},
    guard: () => () => {}, authorize() {}, identityOf: f.identity, runtime,
  });
  const unresolved = async () => (await history.refresh(row.id)).coverage.unresolvedTools.length;
  assert.equal(await unresolved(), 0);
  const bundle = await history.exportPortable(row.id);
  assert.equal(bundle.localToolReceipts, undefined);
  const [proof] = (await f.store.deviceHistory(id)).localToolReceipts;
  assert.match(proof, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(bundle).includes(proof));
  async function rejectRewrittenJournal() {
    const native = await require('../main/conversation/device-history-native.cjs').read({
      app: f.app, session: f.session, row, runtime, guard() {}, previousToolReceipts: [proof] });
    assert.equal(native.coverage.unresolvedTools.length, 1, 'a changed journal cannot inherit a previous receipt');
    await assert.rejects(history.refresh(id), { code: 'NATIVE_HISTORY_DIVERGED' });
  }
  receipt = missing;
  assert.equal(await unresolved(), 0, 'an exact previously verified receipt survives native archive cleanup');
  for (const invalid of [{ ...missing, binding: 'b'.repeat(64) }, { ...missing, archiveMissing: false },
    { ...missing, ref: 'other' }, { ...missing, revision: 1 }, { ...missing, callIds: ['once'] }, {}]) {
    receipt = confirmed; assert.equal(await unresolved(), 0);
    receipt = invalid; assert.equal(await unresolved(), 1);
  }
  for (const field of ['round', 'seg', 'arguments']) {
    receipt = confirmed; assert.equal(await unresolved(), 0);
    const previous = items[1][field];
    items[1][field] = field === 'arguments' ? { path: '/other.png' } : 2;
    receipt = missing; await rejectRewrittenJournal();
    items[1][field] = previous;
  }
  receipt = confirmed; await unresolved();
  receipt = missing; items[0].text = 'Different journal, same cursor and call ID';
  await rejectRewrittenJournal();
  items[0].text = 'Inspect the image';
  receipt = confirmed; await unresolved();
  const saved = await f.store.deviceHistory(id);
  receipt = missing;
  await f.store.saveDeviceHistory(id, { ...saved, imported: { transferId: 'another-device' } },
    { expectedRevision: row.replicaRevision });
  assert.equal(await unresolved(), 1, 'an imported body cannot certify the local native source');
  delete saved.localToolReceipts;
  await f.store.saveDeviceHistory(id, saved, { expectedRevision: row.replicaRevision });
  assert.equal(await unresolved(), 1, 'a legacy done state alone cannot establish native completion');
});
test('archived Codex plan metadata is not mistaken for an unverified tool with a similar name', async t => {
  const f = fixture(t);
  const items = [
    { seq: 1, kind: 'do', tool: 'todo_list', callId: 'plan', _sourceId: 'item.completed:plan:0' },
    { seq: 2, kind: 'step', tool: 'Plan', text: 'Check the output' },
    { seq: 3, kind: 'do', tool: 'todo_list', callId: 'real-call' },
  ];
  const runtime = { rpc: async () => ({ ok: true, data: { ok: true, seq: 3, items } }) };
  const saved = await require('../main/conversation/device-history-native.cjs').read({ app: f.app,
    session: f.session, row: { id: 'runner-one', adapterId: 'codex' }, runtime, guard() {} });
  assert.deepEqual(saved.coverage.unresolvedTools.map(t => t.callId), ['real-call']);
  assert.equal(saved.snapshot.messages[0].blocks[0].text, 'Check the output');
});
test('explicit continuation rechecks native evidence and can still use a complete copy after removal', async t => {
  const f = fixture(t); f.write(2);
  await f.history.projectRows([f.row]); await f.history.backfill('one');
  assert.equal((await f.history.prepareContinuation('one', { refresh: true })).historyRecovery.nativeArchiveMissing, false);
  const bundle = await f.history.exportPortable('one'), target = fixture(t);
  await target.history.importPortable(bundle, { identity: target.identity(), cwd: target.root, transferId: 'only-imported' });
  assert.equal((await target.history.prepareContinuation('one', { refresh: true })).historyRecovery.nativeArchiveMissing, true);
  f.deny();
  await assert.rejects(f.history.prepareContinuation('one', { refresh: true }), { code: 'NATIVE_HISTORY_UNAVAILABLE' });
  const clean = fixture(t); clean.write(2);
  await clean.history.projectRows([clean.row]); await clean.history.backfill('one');
  fs.unlinkSync(clean.file);
  const recovered = await clean.history.prepareContinuation('one', { refresh: true });
  assert.equal(recovered.prefix.tools.length, 1);
  assert.equal(recovered.historyRecovery.nativeArchiveMissing, true);
});
test('only a confirmed first-page Runner archive absence can continue a preserved independent transcript', async t => {
  const f = fixture(t), row = { ...f.row, adapterId: 'qwen', path: '' };
  const event = { seq: 1, kind: 'user', text: 'Retain this request' };
  const answer = { seq: 2, kind: 'say', text: 'Retain this answer' };
  const present = { ok: true, data: { ok: true, seq: 2, items: [event, answer] } };
  const missing = { ok: true, data: { ok: false, ref: row.id, code: 'NATIVE_HISTORY_MISSING', items: [] } };
  let reply = () => present;
  t.mock.method(require('../main/runner-runtime'), 'rpc', async (_op, args) => reply(args));
  await f.history.register([row]); await f.history.backfill(row.id);
  reply = () => missing;
  const recovery = await f.history.prepareContinuation(row.id, { refresh: true });
  assert.equal(recovery.historyRecovery.nativeArchiveMissing, true);
  assert.equal(recovery.prefix.messages[0].text, event.text);
  for (const [unexpected, code] of [
    [{ ok: false, data: missing.data }, 'NATIVE_HISTORY_UNAVAILABLE'],
    [{ ok: true, data: { ...missing.data, ref: 'other' } }, 'NATIVE_HISTORY_UNAVAILABLE'],
    [{ ok: true, data: { ok: false, error: '本地会话不在了', items: [] } }, 'NATIVE_HISTORY_UNAVAILABLE'],
    [{ ok: true, data: { ok: true, seq: 0, items: [] } }, 'NATIVE_HISTORY_DIVERGED'],
    [{ ok: true, data: { ok: true, seq: 1, items: [event] } }, 'NATIVE_HISTORY_DIVERGED'],
  ]) {
    reply = () => unexpected;
    await assert.rejects(f.history.prepareContinuation(row.id, { refresh: true }), { code });
    assert.equal(f.store.deviceHistory(row.id).snapshot.messages[0].text, event.text);
    assert.equal(f.store.deviceHistory(row.id).snapshot.messages.length, 2);
  }
  reply = () => present;
  await f.history.backfill(row.id);
  reply = ({ since }) => since ? missing : { ok: true, data: { ok: true, seq: 2, items: [event] } };
  await assert.rejects(f.history.prepareContinuation(row.id, { refresh: true }), { code: 'NATIVE_HISTORY_UNAVAILABLE' });
});
