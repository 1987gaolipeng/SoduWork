const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorker, keyOf, pluginSelection, diskJournal } = require('../main/automation-conversations');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');

function fixture() {
  const identity = { hub: 'http://example.invalid', clientId: 'device' }, store = new Map(), calls = [], acks = [];
  let finish, status = 'streaming', ackOffline = false;
  const completion = new Promise(resolve => { finish = resolve; });
  const input = { runId: 'run-1', title: '测试', text: '完整说明\n验收要求\n参数：中文', adapterId: 'pi',
    attachments: [{ name: 'input.txt', data: 'materials' }], projectId: 'project' };
  const journal = { read: key => store.get(key), write: (key, record) => store.set(key, { ...record }) };
  const request = async (_identity, route, body) => {
    if (route.endsWith('/inbox')) return { items: [{ id: input.runId }] };
    if (route.endsWith('/claim')) return { ok: true, input };
    if (ackOffline) throw Error('offline');
    acks.push(body); return { ok: true };
  };
  const conversation = {
    open: async (options, owner) => { calls.push(['open', options, owner]); return { ok: true, sessionId: 'chat-1', ref: 'ref-1' }; },
    send: async (...args) => { calls.push(['send', ...args]); return { ok: true, completion }; },
    find: () => ({ status: () => status }),
  };
  const deps = { identityOf: async () => identity, request, journal, conversation, catalog: async () => [], instanceId: 'worker' };
  return { identity, store, calls, acks, input, deps, journal, finish,
    setStatus: value => { status = value; }, setOffline: value => { ackOffline = value; },
    get record() { return journal.read(keyOf(identity, input.runId)); } };
}

test('automation opens and sends an ordinary chat, with complete materials and no Task or goal', async () => {
  const f = fixture(), worker = createWorker(f.deps);
  await worker.tick();
  const open = f.calls[0][1], send = f.calls[1];
  assert.equal(open.intent, 'chat'); assert.equal(open.taskRef, undefined);
  assert.equal(send[2], f.input.text); assert.deepEqual(send[3], f.input.attachments);
  assert.equal(send[4].taskId, undefined); assert.equal(send[4].projectId, 'project');
  assert.equal(send[4].submissionId, 'automation-run-1');
  assert.equal(f.record.conversationId, 'chat-1');
  assert.equal(f.record.phase, 'sending');
  await worker.tick(); assert.equal(f.calls.length, 2);
  f.finish({ ok: true }); await Promise.resolve(); await worker.tick();
  assert.equal(f.acks.at(-1).state, 'succeeded');
  await worker.tick(); assert.equal(f.calls.length, 2);
});

test('manual runs freeze the device access choice before opening the ordinary conversation', async () => {
  for (const mode of ['standard', 'readonly']) {
    const f = fixture();
    f.deps.request = async (_identity, route, body) => {
      if (route.endsWith('/inbox')) return { items: [{ id: f.input.runId }] };
      if (route.endsWith('/claim')) return { ok: true, trigger: 'manual', input: f.input };
      f.acks.push(body); return { ok: true };
    };
    f.deps.conversation.captureAutomationAccess = () => ({ mode });
    f.deps.conversation.openAutomation = async (options, identity, choice) => {
      assert.equal(f.record.accessChoice.mode, mode, 'the selection must be durable before opening');
      return f.deps.conversation.open({ ...options, accessMode: choice.mode }, identity);
    };
    await createWorker(f.deps).tick();
    assert.equal(f.calls[0][1].accessMode, mode);
  }
});

test('automation opening does not forward policy or consent objects from its envelope', async () => {
  const f = fixture();
  Object.assign(f.input, { accessPolicy: { mode: 'full' }, accessConsentId: 'forged', accessDraftId: 'forged' });
  await createWorker(f.deps).tick();
  assert.equal(f.calls[0][1].accessPolicy, undefined);
  assert.equal(f.calls[0][1].accessConsentId, undefined);
  assert.equal(f.calls[0][1].accessDraftId, undefined);
});

function manualFixture(t, mode = 'full') {
  const f = fixture(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-worker-access-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root }, rules = require('../main/access-control/automation-access');
  const identity = uid => {
    const now = Math.floor(Date.now() / 1000);
    return { ...f.identity, session: Buffer.from(JSON.stringify({ typ: 'device', uid, cid: 'device', iat: now - 60, exp: now + 3600 })).toString('base64url') + '.' + 'a'.repeat(64) };
  };
  Object.assign(f.identity, identity('owner'));
  const preference = next => fs.writeFileSync(path.join(root, 'access-preferences.json'), JSON.stringify({ schema: 1, mode: next, revision: 1, fullConsentVersion: 1 }));
  preference(mode);
  let trigger = 'manual', current = f.identity, ackOffline = false;
  f.deps.identityOf = async () => current;
  f.deps.request = async (_owner, route, body) => {
    if (route.endsWith('/inbox')) return { items: [{ id: f.input.runId }] };
    if (route.endsWith('/claim')) return { ok: true, trigger, input: f.input };
    if (ackOffline) throw Error('offline');
    f.acks.push(body); return { ok: true };
  };
  Object.assign(f.deps.conversation, rules.service(app, async (_event, options, owner, context) => {
    rules.assertCurrent(context, current);
    return f.deps.conversation.open(rules.apply(options, context), owner);
  }));
  return { ...f, get record() { return f.record; }, preference, setTrigger: next => { trigger = next; },
    setAccount: uid => { current = identity(uid); }, setOffline: next => { ackOffline = next; } };
}
test('a manually created conversation retries its receipt with the same frozen choice and sends once', async t => {
  const f = manualFixture(t), worker = createWorker(f.deps); f.setOffline(true);
  await worker.tick(); assert.equal(f.record.phase, 'created');
  assert.equal(f.record.accessChoice.mode, 'full');
  f.preference('readonly'); f.setOffline(false); await worker.tick();
  assert.equal(f.calls[1][1].chatId, 'chat-1'); assert.equal(f.calls[1][1].accessMode, undefined,
    'the saved chat owns its policy when reattaching');
  assert.equal(f.calls.filter(call => call[0] === 'send').length, 1);
  f.finish({ ok: true }); await Promise.resolve(); await worker.tick(); await worker.tick();
  assert.equal(f.record.accessChoice.mode, 'full');
  assert.equal(f.calls.filter(call => call[0] === 'send').length, 1);
});
test('timer and missing-trigger runs ignore full access fields in the Hub input', async t => {
  for (const trigger of ['timer', undefined]) {
    const f = manualFixture(t); f.setTrigger(trigger);
    Object.assign(f.input, { accessMode: 'full', trigger: 'manual', accessPolicy: { mode: 'full' } });
    await createWorker(f.deps).tick();
    assert.equal(f.record.accessChoice, null);
    assert.equal(f.calls[0][1].accessMode, undefined);
    assert.equal(f.calls.filter(call => call[0] === 'send').length, 1);
  }
});
test('a legacy journal with no recorded choice cannot inherit a later full default', async t => {
  const f = manualFixture(t);
  f.journal.write(keyOf(f.identity, f.input.runId), { phase: 'created', state: 'running', conversationId: 'chat-1' });
  await createWorker(f.deps).tick();
  assert.equal(f.calls[0][1].chatId, 'chat-1'); assert.equal(f.calls[0][1].accessMode, undefined);
  assert.equal(f.record.accessChoice, undefined);
});
test('switching accounts after manual creation cannot resend from the original choice', async t => {
  const f = manualFixture(t), worker = createWorker(f.deps); f.setOffline(true);
  await worker.tick(); assert.equal(f.record.phase, 'created');
  f.setAccount('other'); f.setOffline(false); await worker.tick();
  assert.equal(f.record.state, 'failed'); assert.equal(f.calls.filter(call => call[0] === 'send').length, 0);
});

test('waiting for ordinary in-chat input is not success or a task acceptance gate', async () => {
  const f = fixture(), worker = createWorker(f.deps);
  await worker.tick(); f.setStatus('waiting-user'); await worker.tick();
  assert.equal(f.acks.at(-1).state, 'waiting');
  f.setStatus('streaming'); await worker.tick(); assert.equal(f.acks.at(-1).state, 'running');
  f.finish({ ok: true }); await Promise.resolve(); await worker.tick();
  assert.equal(f.acks.at(-1).state, 'succeeded');
});

test('lost completion receipt retries only the receipt, including after worker restart', async () => {
  const f = fixture(), worker = createWorker(f.deps);
  await worker.tick(); f.setOffline(true); f.finish({ ok: true }); await Promise.resolve();
  await worker.tick(); assert.equal(f.record.state, 'succeeded');
  f.setOffline(false); await createWorker(f.deps).tick();
  assert.equal(f.acks.at(-1).state, 'succeeded'); assert.equal(f.calls.length, 2);
});

test('connection failure before send preserves created chat and resumes it once', async () => {
  const f = fixture(), worker = createWorker(f.deps); f.setOffline(true);
  await worker.tick(); assert.equal(f.record.phase, 'created'); assert.equal(f.calls.length, 1);
  f.setOffline(false); await worker.tick();
  assert.equal(f.calls[1][1].chatId, 'chat-1'); assert.equal(f.calls.filter(c => c[0] === 'send').length, 1);
});

test('ambiguous process crash never resends tool side effects', async () => {
  const f = fixture(); await createWorker(f.deps).tick();
  await createWorker(f.deps).tick();
  assert.equal(f.calls.length, 2); assert.equal(f.record.state, 'failed');
  assert.equal(f.acks.at(-1).conversationId, 'chat-1'); assert.match(f.record.error, /避免重复/);
});

test('failed or cancelled turns are not reported as completed', async () => {
  for (const [result, expected] of [[{ ok: false }, 'failed'], [{ ok: true, cancelled: true }, 'cancelled']]) {
    const f = fixture(), worker = createWorker(f.deps); await worker.tick();
    f.finish(result); await Promise.resolve(); await worker.tick();
    assert.equal(f.acks.at(-1).state, expected);
  }
});

test('authentication failure backs off inbox polling and resumes after identity changes', async () => {
  const f = fixture();
  let calls = 0, notices = 0, current = f.identity;
  f.deps.request = async () => {
    calls++;
    throw Object.assign(new Error('expired'), { status: 401, authRequired: true });
  };
  f.deps.identityOf = async () => current;
  const worker = createWorker({ ...f.deps, onError: () => { notices++; } });
  await worker.tick(); await worker.tick();
  assert.equal(calls, 1);
  assert.equal(notices, 1);
  current = { ...f.identity, clientId: 'new-device' };
  await worker.tick();
  assert.equal(calls, 2);
  assert.equal(notices, 2);
});

test('same occurrence on another owner or Hub uses a separate idempotency key', () => {
  const id = { hub: 'http://a', clientId: 'one' };
  assert.equal(keyOf(id, 'r'), keyOf({ ...id, hub: 'http://a/' }, 'r'));
  assert.notEqual(keyOf(id, 'r'), keyOf({ ...id, hub: 'http://b' }, 'r'));
  assert.notEqual(keyOf(id, 'r'), keyOf({ ...id, clientId: 'two' }, 'r'));
});

test('oversized prompts are rejected without truncation or execution', async () => {
  const f = fixture(); f.input.text = 'x'.repeat(50001);
  await createWorker(f.deps).tick(); assert.equal(f.calls.length, 0); assert.match(f.record.error, /未被截断/);
});

test('plugin metadata is resolved locally; missing, disabled and changed pinned versions fail closed', () => {
  const plugin = { key: 'report', pluginId: 'local:one', version: '1.0.0', checksum: 'hash', enabled: true,
    entrypoints: { automation: true } };
  const spec = { key: 'report', versionPolicy: 'pinned', version: '1.0.0', checksum: 'hash' };
  assert.equal(pluginSelection(spec, [plugin]).pluginId, 'local:one');
  assert.throws(() => pluginSelection(spec, []));
  assert.throws(() => pluginSelection(spec, [{ ...plugin, enabled: false }]));
  assert.throws(() => pluginSelection(spec, [{ ...plugin, checksum: 'changed' }]));
  assert.throws(() => pluginSelection(spec, [{ ...plugin, entrypoints: { automation: false } }]));
  assert.equal(pluginSelection({ key: 'report', versionPolicy: 'latest' }, [plugin]).version, '1.0.0');
});

test('durable journal is owner-scoped, contains no prompt and does not ignore corrupt records', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-automation-journal-test-'));
  try {
    const key = 'a'.repeat(64), journal = diskJournal(directory);
    assert.equal(journal.read(key), null);
    journal.write(key, { conversationId: 'chat', phase: 'sending' });
    assert.equal(diskJournal(directory).read(key).phase, 'sending');
    assert.throws(() => journal.write('../outside', {}));
    fs.writeFileSync(path.join(directory, key + '.json'), '{');
    assert.throws(() => journal.read(key));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('run history renders ordinary chat link, preserves legacy task links, escapes titles', () => {
  const context = { _schRunRows: { s: [
    { state: 'succeeded', conversationId: 'chat', conversationTitle: '<ordinary>', receipt: { executionMode: 'soduwork.automation-conversation/v1' } },
    { state: 'waiting', taskId: 'legacy-task', taskTitle: 'Legacy' },
  ] }, _schRunLoading: {}, _schRunErrors: {}, SCH_RUN_STATE: { succeeded: ['完成', 'done'] }, SCH_RUN_TRIGGER: {},
  _schRunDuration: () => '', _schLocal: () => '', _schmRunProofHtml: () => '',
  esc: value => String(value).replace(/</g, '&lt;').replace(/>/g, '&gt;') };
  vm.createContext(context); vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/panels/panels-schedules-runs.js'), 'utf8'), context);
  const html = context._schRunRowsHtml('s');
  assert.match(html, /data-run-chat="chat"/); assert.match(html, /打开对话/);
  assert.match(html, /data-run-task="legacy-task"/); assert.match(html, /&lt;ordinary&gt;/);
});
