'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { randomUUID } = require('node:crypto');
const { create } = require('../main/conversation/first-send.cjs');
const tick = () => new Promise(done => setImmediate(done));
function gate() { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; }
function sendEditedDraft(service, request, expected = request.intentId) {
  return service.start(null, { ...request, retryAttempt: { expected, next: 'first-' + randomUUID() } });
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-first-send-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = 'a'.repeat(32), b = 'b'.repeat(32);
  let current = a;
  const sends = [], opens = [];
  const config = {
    root, actor: async () => ({ owner: current }),
    assertCurrent: async context => { if (context.owner !== current) throw Error('scope changed'); },
    async open(_actor, options) {
      opens.push(options);
      return { ok: true, ref: 'ref-' + opens.length, sessionId: options.chatId || 'chat-' + opens.length };
    },
    async send(_actor, ref, text, files, options) {
      sends.push({ ref, text, files, options }); return { ok: true };
    },
    received: async () => true, notify() {},
  };
  const request = (text = '制作插件') => ({ intentId: 'first-' + randomUUID(), text,
    open: { modelName: 'glm', adapterId: 'opencode', accessConsentId: 'private-grant' },
    attachments: [], turn: { skills: ['review'], plugins: [{ pluginId: 'selected' }] } });
  return { root, a, b, opens, sends, config, request, use: owner => { current = owner; } };
}

test('only refused plain text can be reconstructed from a cold journal', async t => {
  const f = fixture(t), service = create({ ...f.config, send: async () => ({ ok: false, notSent: true }) });
  async function refusal(turn, attachments = []) {
    const request = { ...f.request('original'), turn, attachments };
    await service.start(null, request);
    return (await service.act(null, request.intentId, 'wait')).row;
  }
  assert.equal((await refusal({ inputPreparation: { userText: 'original' } })).canRestoreText, true);
  assert.equal((await refusal({ inputPreparation: { userText: 'visible only' } })).canRestoreText, false);
  assert.equal((await refusal({ skills: ['review'] })).canRestoreText, false);
  assert.equal((await refusal({ plugins: [{ pluginId: 'selected', inputValues: { path: 'private' } }] })).canRestoreText, false);
});
test('unallocated plain text retains ordinary model and project settings across restart without replaying access grants', async t => {
  const f = fixture(t), config = { ...f.config, open: async () => ({ ok: false, reason: 'unavailable' }) };
  const req = { ...f.request('first text'), turn: {}, sidebarProjectId: 'S' };
  Object.assign(req.open, { cwd: 'D:/project', projectId: 'P', accessMode: 'standard' });
  const service = create(config); await service.start(null, req); await service.act(null, req.intentId, 'wait');
  const cold = create(config), row = (await cold.list(null)).rows[0];
  assert.equal(row.sessionId, ''); assert.equal(row.status, 'failed'); assert.equal(row.canRestoreText, true);
  assert.deepEqual(row.draftOptions, { adapterId: 'opencode', modelName: 'glm', cwd: 'D:/project',
    projectId: 'P', accessMode: 'standard', sidebarProjectId: 'S' });
  req.intentId = 'first-' + randomUUID(); req.open.accessMode = 'full';
  await cold.start(null, req); const restricted = (await cold.act(null, req.intentId, 'wait')).row;
  assert.equal(restricted.canRestoreText, false); assert.equal(restricted.draftOptions, undefined);
  req.intentId = 'first-' + randomUUID(); req.open.accessMode = ''; req.open.mode = 'full';
  await cold.start(null, req);
  assert.equal((await cold.act(null, req.intentId, 'wait')).row.draftOptions, undefined, 'the current default could grant more access');
  req.intentId = 'first-' + randomUUID(); req.open.mode = 'readonly';
  await cold.start(null, req);
  assert.equal((await cold.act(null, req.intentId, 'wait')).row.draftOptions.mode, 'readonly');
  assert.equal(f.sends.length, 0);
});

test('two edits to the same refused turn can dispatch only once and late settlement cannot change the winner', async t => {
  const f = fixture(t), request = f.request('original text'), attempts = [], completions = new Map();
  const service = create({ ...f.config, received: async () => false,
    async send(_context, ref, text, files, options, settled) {
      attempts.push({ ref, text, id: options.submissionId }); completions.set(options.submissionId, settled);
      return { ok: true };
    } });
  await service.start(null, request); const first = (await service.act(null, request.intentId, 'wait')).row;
  completions.get(first.attemptId)({ ok: false, notSent: true, reason: 'refused before write' });
  let failure = (await service.act(null, request.intentId, 'wait')).row;
  assert.equal(failure.canAttachFailed, true);
  const edit = (text, attemptId) => service.start(null, { ...request, text }, {
    expected: first.attemptId, attemptId, ref: 'ref-1', sessionId: first.sessionId });
  const [firstEdit, laterEdit] = await Promise.all([edit('edited in original composer', 'ui-next'), edit('second edit', 'ui-other')]);
  assert.equal(firstEdit.ok, true); assert.equal(laterEdit.code, 'FIRST_SEND_RETRY_STALE');
  const latest = (await service.act(null, request.intentId, 'wait')).row;
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[1], { id: 'ui-next', ref: 'ref-1', text: 'edited in original composer' });
  completions.get(first.attemptId)({ ok: false, notSent: true, reason: 'late previous refusal' });
  assert.equal((await service.act(null, request.intentId, 'wait')).row.status, 'accepted');
  completions.get(latest.attemptId)({ ok: false, notSent: true, reason: 'new refusal' });
  failure = (await service.act(null, request.intentId, 'wait')).row;
  assert.equal(failure.status, 'failed'); assert.equal(failure.reason, 'new refusal');
  assert.equal((await edit('old attempt', 'ui-stale')).code, 'FIRST_SEND_RETRY_STALE');
  assert.equal(attempts.length, 2);
});

test('an edited draft retries a refused open on the same intent with its current model and consent', async t => {
  const f = fixture(t), original = f.request(), attempts = [], open = f.config.open;
  const service = create({ ...f.config, received: async () => false, async open(context, options) {
    attempts.push(options); return attempts.length === 1 ? { ok: false, reason: 'Runtime unavailable' } : open(context, options);
  } });
  await service.start(null, original);
  const failure = (await service.act(null, original.intentId, 'wait')).row;
  assert.equal(failure.status, 'failed'); assert.equal(failure.sessionId, '');
  const next = 'first-' + randomUUID();
  const edited = { ...original, text: 'edited',
    retryAttempt: { expected: failure.attemptId, next }, turn: { inputPreparation: { userText: 'edited' } },
    open: { ...original.open, modelName: 'replacement', accessConsentId: 'new-interactive-grant' } };
  const [admitted, stale] = await Promise.all([service.start(null, edited),
    sendEditedDraft(service, { ...original, text: 'different edit' }, failure.attemptId)]);
  assert.equal(admitted.ok, true); assert.equal(stale.code, 'FIRST_SEND_RETRY_STALE');
  const result = (await service.act(null, original.intentId, 'wait')).row;
  assert.equal(result.text, 'edited'); assert.equal(result.attemptId, next); assert.equal(result.status, 'accepted');
  assert.equal(attempts[1].modelName, 'replacement'); assert.equal(attempts[1].accessConsentId, 'new-interactive-grant');
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0].options.submissionId, next);
  assert.equal((await service.act(null, original.intentId, 'attach', next)).row.sessionId, result.sessionId);
  await assert.rejects(service.act(null, original.intentId, 'attach', failure.attemptId));
});

test('pre-admission refusal retains the allocated handle and recognizes only the edited retry receipt after restart', async t => {
  const f = fixture(t), req = f.request(), sends = [], received = [];
  const config = { ...f.config, async received(_ctx, row) { return received.includes(row.attemptId || row.intentId); },
    async send(_ctx, ref, text, files, options) {
      sends.push({ ref, text, id: options.submissionId });
      return sends.length === 1 ? { ok: false, notSent: true, reason: 'preflight refused' } : { ok: true };
    } };
  const service = create(config); await service.start(null, req);
  const first = (await service.act(null, req.intentId, 'wait')).row;
  assert.equal(first.acceptedAt, undefined); assert.equal(first.canAttachFailed, true);
  assert.equal((await service.act(null, req.intentId, 'attach')).row.sessionId, 'chat-1');
  req.text = 'corrected request'; req.turn.plugins = [];
  const expected = { expected: first.attemptId, ref: 'ref-1', sessionId: 'chat-1', attemptId: 'ui-corrected' };
  assert.equal((await service.start(null, req, { ...expected, sessionId: 'other' })).code, 'FIRST_SEND_RETRY_STALE');
  assert.equal((await service.start(null, req, expected)).ok, true);
  received.push(first.intentId);
  const cold = create(config);
  assert.equal((await cold.list(null)).rows[0].status, 'uncertain'); await tick();
  assert.equal((await cold.act(null, req.intentId, 'wait')).row.status, 'uncertain');
  assert.equal((await cold.start(null, req, expected)).code, 'FIRST_SEND_RETRY_STALE');
  assert.equal((await cold.start(null, req, { ...expected, expected: 'ui-corrected', attemptId: 'ui-again' })).code,
    'FIRST_SEND_RETRY_STALE', 'An unconfirmed turn must not be replayed even with its current attempt id');
  received.push('ui-corrected');
  const restarted = create(config); await restarted.list(null); await tick();
  assert.equal((await restarted.act(null, req.intentId, 'wait')).row.status, 'accepted');
  assert.equal(f.opens.length, 1); assert.deepEqual(sends.map(row => row.ref), ['ref-1', 'ref-1']);
});

test('an edited retry on a different runtime records its native segment and keeps its original conversation', async t => {
  const f = fixture(t), req = f.request(), completions = [], captures = [];
  const service = create({ ...f.config, received: async () => false,
    async send(_ctx, ref, text, files, options, settled, sessionId, rememberTarget) {
      completions.push(settled);
      if (completions.length > 1) rememberTarget('pi', 'switched-native-segment', () => 'replacement');
      else rememberTarget('opencode', sessionId);
      captures.push(JSON.parse(fs.readFileSync(path.join(f.root, f.a, req.intentId + '.json'), 'utf8')));
      return { ok: true };
    } });
  await service.start(null, req); const initial = (await service.act(null, req.intentId, 'wait')).row;
  completions[0]({ ok: false, notSent: true, reason: 'runtime offline' });
  const retry = { expected: initial.attemptId, attemptId: 'ui-switched', sessionId: initial.sessionId, ref: 'ref-1' };
  assert.equal((await service.start(null, req, retry)).ok, true);
  assert.equal(captures[1].sessionId, initial.sessionId);
  assert.deepEqual(captures[1].receiptTarget, { adapterId: 'pi', sessionId: 'switched-native-segment' });
  completions[1]({ ok: false, notSent: true, reason: 'new runtime offline' });
  assert.equal((await service.start(null, { ...req, text: 'corrected again' }, {
    ...retry, expected: retry.attemptId, attemptId: 'ui-corrected-again' })).ok, true);
  assert.equal((await service.act(null, req.intentId, 'wait')).row.status, 'accepted');
  assert.equal(f.opens.length, 1); assert.equal(captures[2].adapterId, 'pi'); assert.equal(captures[2].modelName, 'replacement');
  assert.deepEqual(captures[2].receiptTarget, captures[1].receiptTarget); assert.equal(captures[2].sessionId, initial.sessionId);
});

test('two simultaneous first sends finish independently and identical IPC retries do not duplicate work', async t => {
  const f = fixture(t), delayed = gate(), opened = gate(), original = f.config.open;
  f.config.open = async (actor, options) => {
    const result = await original(actor, options);
    if (options.modelName === 'glm') { opened.resolve(); await delayed.promise; }
    return result;
  };
  const service = create(f.config), a = f.request(), b = f.request();
  b.open.modelName = 'deepseek';
  const saved = await service.start(null, a); await opened.promise;
  assert.equal(saved.row.status, 'opening');
  await service.start(null, b);
  assert.equal((await service.act(null, b.intentId, 'wait')).row.sessionId, 'chat-2');
  let rows = (await service.list(null)).rows;
  assert.equal(rows.length, 2); assert.deepEqual(new Set(rows.map(row => row.intentId)), new Set([a.intentId, b.intentId]));
  await service.start(null, a);
  await assert.rejects(service.start(null, { ...a, text: 'different' }), /标识/);
  delayed.resolve();
  assert.equal((await service.act(null, a.intentId, 'wait')).row.sessionId, 'chat-1');
  assert.deepEqual(f.sends.map(send => [send.ref, send.options.submissionId]), [['ref-2', b.intentId], ['ref-1', a.intentId]]);
  assert.deepEqual(f.sends[1].options.skills, ['review']);
  assert.equal(f.sends[1].options.plugins[0].pluginId, 'selected');
  assert.equal(f.opens[0].accessConsentId, 'private-grant');
  await tick();
  const accepted = fs.readFileSync(path.join(f.root, f.a, a.intentId + '.json'), 'utf8');
  assert.doesNotMatch(accepted, /private-grant|accessConsentId|"text"/);
  assert.equal((await sendEditedDraft(service, a)).code, 'FIRST_SEND_RETRY_STALE');
  await service.start(null, a);
  assert.equal(f.sends.length, 2);
});

test('a stale edit and a second send cannot overwrite a turn awaiting its native receipt after restart', async t => {
  const f = fixture(t), request = f.request(), id = request.intentId;
  let sends = 0;
  const config = { ...f.config, received: async () => false, async send() {
    return ++sends === 1 ? { ok: false, notSent: true, reason: 'refused' } : { ok: true };
  } };
  const service = create(config);
  await service.start(null, request);
  const failed = (await service.act(null, id, 'wait')).row;
  assert.equal(failed.status, 'failed');
  const attemptId = 'ui-edited';
  const retry = { ref: 'ref-1', sessionId: failed.sessionId, expected: failed.attemptId, attemptId };
  await service.start(null, { ...request, text: 'edited draft' }, retry);
  assert.equal((await service.act(null, id, 'wait')).row.status, 'accepted');
  assert.equal((await service.start(null, request, retry)).code, 'FIRST_SEND_RETRY_STALE');

  const cold = create(config);
  const [pending] = (await cold.list(null)).rows;
  assert.equal(pending.status, 'uncertain'); assert.equal(pending.text, 'edited draft');
  assert.equal((await cold.start(null, request, retry)).code, 'FIRST_SEND_RETRY_STALE');
  assert.equal((await cold.start(null, request, { ...retry, expected: attemptId, attemptId: 'ui-other' })).code,
    'FIRST_SEND_RETRY_STALE');
  assert.equal((await cold.act(null, id, 'wait')).row.text, 'edited draft');
  assert.equal(sends, 2);
});

test('a refused open preserves the staged attachment and sends the newly selected input and consent after restart', async t => {
  const f = fixture(t), req = f.request('original first turn'), denied = create({ ...f.config,
    open: async () => ({ ok: false, reason: 'modelo unavailable' }) });
  req.attachments = [{ name: 'clip.txt', type: 'text/plain', data: Buffer.from('original clipboard') }];
  await denied.start(null, req);
  const failed = (await denied.act(null, req.intentId, 'wait')).row;
  assert.equal(failed.canRestoreText, false); assert.equal(failed.modelName, 'glm');
  assert.deepEqual(failed.attachmentNames, ['clip.txt']);
  const saved = fs.readFileSync(path.join(f.root, f.a, req.intentId + '.json'), 'utf8');
  assert.doesNotMatch(saved, /private-grant/);
  assert.equal(fs.readFileSync(JSON.parse(saved).files[0].path, 'utf8'), 'original clipboard');
  const send = f.config.send;
  const afterRestart = create({ ...f.config, send: async (...args) => {
    assert.equal(fs.readFileSync(args[3][0].path, 'utf8'), 'new clipboard'); return send(...args);
  } });
  assert.equal((await afterRestart.list(null)).rows[0].text, req.text);
  assert.equal(f.opens.length, 0);
  const edited = { ...req, open: { ...req.open, accessConsentId: 'new-grant' },
    attachments: [{ name: 'replacement.txt', data: Buffer.from('new clipboard') }] };
  assert.equal((await sendEditedDraft(afterRestart, edited)).ok, true);
  const accepted = (await afterRestart.act(null, req.intentId, 'wait')).row;
  assert.equal(accepted.status, 'accepted'); assert.notEqual(accepted.attemptId, req.intentId);
  assert.equal(f.opens[0].modelName, 'glm'); assert.equal(f.opens[0].accessConsentId, 'new-grant');
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0].options.submissionId, accepted.attemptId);
  assert.deepEqual(f.sends[0].files.map(file => file.name), ['replacement.txt']);
  await tick();
  assert.equal(fs.existsSync(path.join(f.root, f.a, req.intentId + '.inputs')), false);
});

test('interrupted opens stay recoverable, lost send acknowledgements reconcile only against the exact persisted submission', async t => {
  const f = fixture(t), req = f.request(), service = create({ ...f.config,
    open: async () => ({ ok: false, reason: 'offline' }) });
  await service.start(null, req); await service.act(null, req.intentId, 'wait');
  const file = path.join(f.root, f.a, req.intentId + '.json'), row = JSON.parse(fs.readFileSync(file));
  fs.writeFileSync(file, JSON.stringify({ ...row, status: 'opening' }));
  assert.equal((await create(f.config).list(null)).rows[0].status, 'failed');
  fs.writeFileSync(file, JSON.stringify({ ...row, status: 'sending', sessionId: 'saved-id' }));
  const receipt = gate();
  const cold = create({ ...f.config, received: async (_context, item) => {
    assert.equal(item.sessionId, 'saved-id'); assert.equal(item.intentId, req.intentId); return receipt.promise;
  } });
  assert.equal((await cold.list(null)).rows[0].status, 'uncertain');
  assert.equal((await cold.start(null, req, {
    ref: 'ref-1', sessionId: 'saved-id', expected: req.intentId, attemptId: 'ui-other' })).code, 'FIRST_SEND_RETRY_STALE');
  receipt.resolve(true); await tick();
  assert.equal((await cold.list(null)).rows[0].status, 'accepted'); assert.equal(f.sends.length, 0);
});

test('a different identity cannot read or retry a draft, and switching identity before native open prevents dispatch', async t => {
  const f = fixture(t), req = f.request(), delayed = gate(), opened = gate();
  const service = create({ ...f.config, open: async () => { opened.resolve(); return delayed.promise; } });
  await service.start(null, req); await opened.promise;
  f.use(f.b);
  assert.deepEqual((await service.list(null)).rows, []);
  assert.equal((await sendEditedDraft(service, req)).code, 'FIRST_SEND_RETRY_STALE');
  delayed.resolve({ ok: true, ref: 'wrong-scope', sessionId: 'old' }); await tick();
  assert.equal(f.sends.length, 0); f.use(f.a);
  assert.equal((await service.act(null, req.intentId, 'wait')).row.status, 'failed');
});

test('a queue acknowledgement followed by a crash before the first native event retains the entire request without dispatching again', async t => {
  const f = fixture(t), req = f.request('queued but never archived');
  req.attachments = [{ name: 'notes.txt', data: Buffer.from('my original notes') }];
  const service = create({ ...f.config, received: async () => false });
  await service.start(null, req);
  assert.equal((await service.act(null, req.intentId, 'wait')).row.status, 'accepted');
  const file = path.join(f.root, f.a, req.intentId + '.json'), disk = JSON.parse(fs.readFileSync(file));
  assert.equal(disk.text, req.text); assert.equal(fs.readFileSync(disk.files[0].path, 'utf8'), 'my original notes');
  assert.doesNotMatch(JSON.stringify(disk), /private-grant/);
  const cold = create({ ...f.config, received: async () => false });
  const [row] = (await cold.list(null)).rows;
  assert.equal(row.status, 'uncertain'); assert.equal(row.text, req.text); assert.equal(row.canRestoreText, false);
  assert.equal((await cold.start(null, req, { ref: 'ref-1', sessionId: row.sessionId,
    expected: row.attemptId, attemptId: 'ui-duplicate' })).code, 'FIRST_SEND_RETRY_STALE');
  await cold.start(null, req); assert.equal(f.sends.length, 1);
});

test('missing attachments and ephemeral plugin input are visible and cannot be replayed from incomplete metadata', async t => {
  const f = fixture(t), service = create({ ...f.config, open: async () => ({ ok: false, reason: 'offline' }) });
  const file = f.request(); file.attachments = [{ name: 'missing.txt', path: path.join(f.root, 'missing.txt') }];
  assert.equal((await service.start(null, file)).ok, false);
  assert.equal((await service.act(null, file.intentId, 'wait')).row.canRestoreText, false);
  const plugin = f.request(); plugin.turn.plugins[0].inputValues = { key: 'transient-plugin-value' };
  await service.start(null, plugin); await service.act(null, plugin.intentId, 'wait');
  assert.equal((await service.list(null)).rows.find(row => row.intentId === plugin.intentId).canRestoreText, false);
  assert.doesNotMatch(fs.readFileSync(path.join(f.root, f.a, plugin.intentId + '.json'), 'utf8'), /transient-plugin-value/);
});

test('partially readable attachments report what was skipped and the next submission uses only reselected files', async t => {
  const f = fixture(t), req = f.request(), missing = path.join(f.root, 'missing.txt');
  req.attachments = [{ name: 'missing.txt', path: missing }, { name: 'notes.txt', data: Buffer.from('original notes') }];
  const offline = create({ ...f.config, open: async () => ({ ok: false, reason: 'offline' }) });
  const saved = await offline.start(null, req);
  assert.equal(saved.ok, true, saved.reason); assert.match(saved.attachmentWarnings[0], /missing\.txt/);
  const failed = (await offline.act(null, req.intentId, 'wait')).row;
  assert.equal(failed.canRestoreText, false); assert.deepEqual(failed.attachmentNames, ['notes.txt']);
  fs.writeFileSync(missing, 'appeared after the original send');
  const cold = create({ ...f.config, received: async () => false });
  assert.equal((await sendEditedDraft(cold, { ...req, attachments: [req.attachments[1]] })).ok, true);
  assert.equal((await cold.act(null, req.intentId, 'wait')).row.status, 'accepted');
  assert.deepEqual(f.sends[0].files.map(file => file.name), ['notes.txt']);
  assert.equal(fs.readFileSync(f.sends[0].files[0].path, 'utf8'), 'original notes');
});

test('ordinary first send applies the native attachment count limit with a warning', async t => {
  const f = fixture(t), req = f.request(), service = create({ ...f.config, received: async () => false });
  const { MAX_FILES } = require('../main/pi-session/attachments');
  req.attachments = Array.from({ length: MAX_FILES + 1 }, (_, index) => ({ name: index + '.txt', data: Buffer.from('file') }));
  const saved = await service.start(null, req);
  assert.equal(saved.ok, true); assert.ok(saved.attachmentWarnings[0].includes(String(MAX_FILES)));
  assert.equal((await service.act(null, req.intentId, 'wait')).row.status, 'accepted');
  assert.deepEqual(f.sends[0].files.map(file => file.name), req.attachments.slice(0, MAX_FILES).map(file => file.name));
});

test('receipt lookup verifies the precise native header and user submission in the Pi archive and Runner journal', async t => {
  const f = fixture(t), saved = f.request(), app = { getPath: () => f.root };
  const directory = path.join(f.root, 'pi-agent', 'workspace');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'session.jsonl');
  const row = { sessionId: 'session', intentId: saved.intentId, adapterId: 'pi' };
  const options = { app, row, owner: f.a, guard() {}, session: {
    historyEntry: async () => ({ ok: true, entry: { id: row.sessionId, path: file } }),
  } };
  const { received } = require('../main/conversation/first-send-receipt.cjs');
  function write(header, ...rows) {
    fs.writeFileSync(file, [JSON.stringify({ type: 'session', id: header }),
      ...rows.map(message => JSON.stringify({ type: 'message', message }))].join('\n') + '\n');
  }
  const real = { role: 'user', submissionId: row.intentId };
  write('wrong-session', real); assert.equal(await received(options), false);
  write(row.sessionId, { role: 'user', text: row.intentId }, { role: 'assistant', submissionId: row.intentId });
  assert.equal(await received(options), false);
  write(row.sessionId, real); assert.equal(await received(options), true);
  let result = { ref: row.sessionId, items: [{ kind: 'say', submissionId: row.intentId }] };
  const runner = { rpc: async () => ({ ok: true, data: result }) };
  row.adapterId = 'opencode'; assert.equal(await received({ ...options, runner }), false);
  result.items = [{ kind: 'user', submissionId: row.intentId }];
  assert.equal(await received({ ...options, runner }), true);
  row.attemptId = 'ui-edited-attempt';
  assert.equal(await received({ ...options, runner }), false, 'The first attempt is not a receipt for the edited retry');
  result.items = [{ kind: 'user', submissionId: row.attemptId }];
  assert.equal(await received({ ...options, runner }), true);
  result.ref = 'wrong'; assert.equal(await received({ ...options, runner }), false);
  const publicId = row.sessionId;
  row.adapterId = 'pi'; row.receiptTarget = { sessionId: 'native-runner', adapterId: 'opencode' };
  result.ref = publicId; assert.equal(await received({ ...options, runner }), false);
  result.ref = row.receiptTarget.sessionId;
  assert.equal(await received({ ...options, runner: { rpc: async (_op, query) => {
    assert.equal(query.ref, 'native-runner'); return { ok: true, data: result };
  } } }), true);
  row.adapterId = 'opencode'; row.receiptTarget = { sessionId: 'native-pi', adapterId: 'pi' };
  options.session.historyEntry = async (_app, id) => {
    assert.equal(id, 'native-pi'); return { ok: true, entry: { id, path: file } };
  };
  write(publicId, { role: 'user', submissionId: row.attemptId }); assert.equal(await received(options), false);
  write('native-pi', { role: 'user', submissionId: row.attemptId }); assert.equal(await received(options), true);
  // A conversation workflow keeps its own public-session receipt across native switches.
  write('native-pi'); row.workflowRun = true;
  const { store } = require('../main/personal-plugin-debug');
  const root = path.join(f.root, 'plugin-debug-runs'), run = 'workflow-after-switch';
  store(path.join(root, 'requests'), [f.a, publicId, row.attemptId].join(':')).write({ runId: run });
  store(path.join(root, 'archive'), run).write({ id: run, owner: f.a, conversationId: publicId,
    requestId: row.attemptId, mode: 'conversation' });
  assert.equal(await received(options), true);
});

test('a queue-level refusal stays retryable, an ambiguous failure stays visible, and a received turn can fail during execution', async t => {
  const f = fixture(t), settlements = [], durable = new Set();
  const service = create({ ...f.config, send: async (...args) => {
    settlements.push(args[5]); return { ok: true };
  }, received: async (_actor, row) => durable.has(row.intentId) });
  const refused = f.request('quota before dispatch'), ambiguous = f.request('lost execution ack'), model = f.request('model error');
  for (const request of [refused, ambiguous, model]) {
    await service.start(null, request); assert.equal((await service.act(null, request.intentId, 'wait')).row.status, 'accepted');
  }
  durable.add(model.intentId);
  settlements[0]({ ok: false, notSent: true, reason: 'quota' });
  settlements[1]({ ok: false, reason: 'connection lost' });
  settlements[2]({ ok: false, reason: 'provider failed after accepting input' });
  let rows;
  for (let attempt = 0; attempt < 100; attempt++) {
    rows = new Map((await service.list(null)).rows.map(row => [row.intentId, row]));
    if (rows.get(refused.intentId).status === 'failed' && rows.get(ambiguous.intentId).status === 'uncertain') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(rows.get(refused.intentId).canAttachFailed, true);
  assert.equal(rows.get(ambiguous.intentId).canAttachFailed, false);
  assert.equal(rows.get(ambiguous.intentId).text, ambiguous.text);
  assert.equal(rows.get(model.intentId).status, 'accepted');
  assert.equal(rows.get(model.intentId).text, undefined);
  const first = rows.get(refused.intentId);
  assert.equal((await service.start(null, { ...refused, text: 'edited after quota refusal' }, {
    expected: first.attemptId, attemptId: 'ui-quota-resolved', ref: 'ref-1', sessionId: first.sessionId })).ok, true);
  assert.equal((await service.act(null, refused.intentId, 'wait')).row.sessionId, first.sessionId);
  assert.equal(f.opens.length, 3); assert.equal(settlements.length, 4);
});

test('cold project filing requires durable acceptance and the exact session acknowledgement', async t => {
  const f = fixture(t), req = f.request(), ready = gate();
  req.sidebarProjectId = 'sidebar-project';
  const service = create({ ...f.config, received: () => ready.promise });
  await service.start(null, req);
  const result = (await service.act(null, req.intentId, 'wait')).row;
  assert.deepEqual((await service.associations(null)).rows, [], 'in-memory admission alone cannot organize an archive');
  await assert.rejects(service.ackAssociations(null, req.intentId, result.sessionId), /原会话/);
  ready.resolve(true); await tick();
  await assert.rejects(service.ackAssociations(null, req.intentId, 'other'), /原会话/);
  const cold = create(f.config); f.use(f.b);
  assert.deepEqual((await cold.associations(null)).rows, []);
  f.use(f.a);
  const file = path.join(f.root, f.a, req.intentId + '.json');
  const row = JSON.parse(fs.readFileSync(file)); row.acceptedAt -= 120000; fs.writeFileSync(file, JSON.stringify(row));
  assert.deepEqual((await cold.list(null)).rows, [], 'expired sidebar placeholder stays hidden');
  const [pending] = (await cold.associations(null)).rows;
  assert.equal(pending.sessionId, result.sessionId); assert.equal(pending.sidebarProjectId, 'sidebar-project');
  await cold.ackAssociations(null, req.intentId, result.sessionId);
  await cold.ackAssociations(null, req.intentId, result.sessionId);
  assert.deepEqual((await cold.associations(null)).rows, []);
  await cold.list(null); assert.equal(fs.existsSync(file), false);
  const retired = fs.readFileSync(path.join(f.root, f.a, 'receipts', req.intentId + '.json'), 'utf8');
  assert.doesNotMatch(retired, /sidebar-project|制作插件/);
});

test('deletion retires confirmed and unconfirmed first sends without reviving delayed receipts', async t => {
  const f = fixture(t), probe = gate(), delayed = f.request('private pending message');
  delayed.attachments = [{ name: 'pending.txt', data: Buffer.from('private attachment') }];
  const filed = { ...f.request('private project title'), sidebarProjectId: 'private-project' };
  const binding = '1'.repeat(64);
  const config = { ...f.config, actor: async () => ({ owner: f.a, binding }),
    open: async () => ({ ok: true, ref: 'r', sessionId: 'public-target' }),
    received: async (_context, row) => row.intentId === filed.intentId || await probe.promise };
  const service = create(config);
  for (const input of [delayed, filed]) {
    await service.start(null, input); await service.act(null, input.intentId, 'wait');
  }
  await tick();
  assert.equal((await service.associations(null)).rows.length, 1);
  assert.equal(fs.existsSync(path.join(f.root, f.a, delayed.intentId + '.inputs')), true);
  const savedFile = path.join(f.root, f.a, delayed.intentId + '.json');
  const savedRequest = fs.readFileSync(savedFile, 'utf8');
  const other = create({ ...config, actor: async () => ({ owner: f.b, binding: '2'.repeat(64) }),
    assertCurrent: async context => assert.equal(context.owner, f.b) });
  await other.start(null, delayed); await other.act(null, delayed.intentId, 'wait');
  const cold = create(config);
  cold.forgetSession({ binding: '3'.repeat(64) }, 'public-target');
  cold.forgetSession({ owner: f.a }, 'different-target');
  assert.equal((await cold.list(null)).rows.length, 2);
  cold.forgetSession({ binding }, 'public-target'); // Offline, bound during the authenticated send.
  probe.resolve(true); await tick();
  assert.deepEqual((await service.list(null)).rows, []);
  assert.deepEqual((await cold.associations(null)).rows, []);
  assert.equal((await other.list(null)).rows.length, 1);
  for (const input of [delayed, filed]) {
    assert.equal(fs.existsSync(path.join(f.root, f.a, input.intentId + '.json')), false);
    assert.equal(fs.existsSync(path.join(f.root, f.a, input.intentId + '.inputs')), false);
    const receipt = JSON.parse(fs.readFileSync(path.join(f.root, f.a, 'receipts', input.intentId + '.json'), 'utf8'));
    assert.deepEqual(receipt, { intentId: input.intentId, deleted: true });
    assert.equal((await cold.start(null, input)).ok, false);
    const edited = await cold.start(null, { ...input, text: 'stale edit after deletion' }, {
      expected: input.intentId, ref: 'r', sessionId: 'public-target', attemptId: 'ui-deleted' });
    assert.equal(edited.ok, false); assert.match(edited.reason, /已经删除/);
  }
  fs.writeFileSync(savedFile, savedRequest); // Simulate a crash after the tombstone but before cleanup.
  assert.equal((await cold.start(null, delayed)).ok, false); assert.equal(fs.existsSync(savedFile), false);
});

test('deleting during first-send preflight prevents later dispatch and journal recreation', async t => {
  const f = fixture(t), req = f.request(), entered = gate(), resume = gate();
  let submitted = 0;
  const service = create({ ...f.config, async send(_ctx, ref, text, files, options, settled, sessionId, rememberTarget) {
    entered.resolve(); await resume.promise;
    rememberTarget('opencode', sessionId);
    submitted++; return { ok: true };
  } });
  await service.start(null, req); await entered.promise;
  service.forgetSession({ owner: f.a }, 'chat-1'); resume.resolve();
  await tick();
  assert.equal(submitted, 0); assert.deepEqual((await service.list(null)).rows, []);
  assert.equal((await service.start(null, req)).ok, false);
});
