'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { makeGlobals, stubGlobals, El } = require('./fixture/chat-draft-harness.cjs');
const ROOT = path.join(__dirname, '..');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function until(check) { for (let i = 0; i < 40 && !check(); i++) await tick(); assert.ok(check()); }

function fixture(t, { modelReady = Promise.resolve(true), openReady, send, firstSendApi } = {}) {
  const calls = [], releases = [], opens = [];
  let owner = 'account-a', compose, picked = [], modelRequests = 0, receive;
  let runtime = 'pi', location = 'local', executionRevision = 0;
  const api = {
    ...firstSendApi,
    open: async options => { opens.push(options); if (openReady) await openReady;
      return { ok: true, ref: 'ref-first', sessionId: 'first-chat', snapshot: { messages: [] } }; },
    snapshot: async () => ({ ok: true, snapshot: { messages: [] } }),
    send: async (...args) => { calls.push(args); return send ? send(...args) : { ok: true }; },
    onEvent(fn) { receive = fn; return () => {}; }, release: async ref => { releases.push(ref); return { ok: true }; },
    history: async () => ({ ok: true, chats: [] }),
  };
  const f = makeGlobals(); stubGlobals(f.g, { piSession: api });
  if (firstSendApi) f.g.crypto = { randomUUID: require('node:crypto').randomUUID };
  f.g.SessionMemoryEntry.options = () => ({});
  f.g.SoduWorkAPI.taskStorageKey = () => owner;
  f.g.window = f.g;
  function publish() {
    for (const key of Object.keys(f.g)) {
      if (['require', 'setTimeout', 'clearTimeout'].includes(key)) continue;
      Object.defineProperty(globalThis, key, { value: f.g[key], configurable: true, writable: true });
    }
  }
  function load(name) {
    new Function('window', fs.readFileSync(path.join(ROOT, 'components/panels', name + '.js'), 'utf8'))(f.g);
    publish();
  }
  publish();
  // Use the production composer, NativeChat, draft store and session controller.
  // Only DOM rendering and the native runtime boundary use the existing fixture.
  for (const name of ['chat-draft-recovery', 'chat-composer-bindings', 'chat-session-controller',
    'panels-chat', 'compose-surface', 'panels-compose-work-actions', 'panels-plugin-builder-entry']) load(name);
  const panel = f.document.getElementById('composePanel'), input = new El('textarea', 'cpInput');
  panel.appendChild(input);
  const create = f.g.ComposeSurface.create;
  f.g.ComposeSurface.create = context => {
    compose = context;
    return { ...create(context), _panel: () => panel, _paintSetup() {}, refreshComposeRecommendations() {} };
  };
  f.g.ComposeRuntime = { value: () => runtime, ready: async () => true, accessSupported: () => false };
  f.g.ComposeExecution = { value: () => location, revision: () => executionRevision,
    reset() { location = 'local'; executionRevision++; }, bind() {}, paint() {} };
  f.g.ComposeModelPicker = { ready: () => { modelRequests++; return modelReady; },
    value: () => ({ modelName: 'fixture-model' }), refresh() {} };
  publish(); load('panels-compose');
  compose._pluginMention = { selected: () => picked.slice(), draft: () => picked.slice(), action: () => null,
    clear: () => { picked = []; }, restore: rows => { picked = rows.slice(); },
    resolve: async (_chat, _project, text) => ({ text, items: picked.slice() }) };
  input.addEventListener('input', () => compose._rememberComposeDraft());
  f.g.openComposePanel({ newSession: true });
  t.after(() => f.g.NativeChat.reset());
  return { ...f, input, panel, calls, releases, opens, compose, receive: event => receive(event),
    readyCalls: () => modelRequests,
    owner: value => { owner = value; },
    runtime: value => { runtime = value; },
    location: value => { if (value !== location) executionRevision++; location = value; },
    type(text, plugins = []) { picked = plugins.slice(); input.value = text; input.dispatchEvent(new Event('input')); },
    plugins: () => picked.slice(),
    draft: key => f.g.NativeChat.getDraft(key || 'new'),
    submit: () => compose.makeDraft(),
    newSession: () => f.g.openComposePanel({ newSession: true }),
  };
}
const oldPlugin = { pluginId: 'local:app-developer', name: '即用开发' };
const newPlugin = { pluginId: 'local:new-plugin', name: 'New draft plugin' };

test('a pre-allocation draft opens an ordinary composer without allocating and consumes its original intent only on send', async t => {
  const calls = [];
  const row = { intentId: 'first-original', attemptId: 'first-attempt', status: 'failed', text: 'original text',
    canRestoreText: true, draftOptions: { adapterId: 'pi', modelName: 'glm-model', cwd: 'X:/project',
      projectId: 'P', sidebarProjectId: 'S', mode: 'full', accessMode: 'standard' } };
  const f = fixture(t, { firstSendApi: {
    async startFirstSend(request) { calls.push(request); return { ok: true, row: { title: request.text } }; },
    async waitFirstSend() { return { ok: true, row: { status: 'accepted', sessionId: 'native-fixed' } }; },
    async attachFirstSend() { return { ok: true, ref: 'ref-fixed', sessionId: 'native-fixed', snapshot: { messages: [] } }; },
  } });
  f.g.ChatWorkbenchAnnotations.submit = submit => submit({ notes: [] });
  f.type('unrelated new chat draft', [newPlugin]);
  f.g.NativeChat.rememberDraft(row.intentId, 'next turn from earlier');
  assert.equal(f.g.openComposePanel({ firstSendDraft: row }), true);
  assert.equal(f.opens.length, 0); assert.equal(calls.length, 0);
  const input = f.document.getElementById('nchatInput');
  assert.equal(input.value, 'original text');
  input.value = ''; input.dispatchEvent(new Event('input'));
  input.value = 'revised after clearing'; input.dispatchEvent(new Event('input'));
  assert.equal(await f.g.NativeChat.send(), true);
  assert.equal(calls.length, 1); assert.equal(calls[0].intentId, row.intentId);
  assert.equal(calls[0].retryAttempt.expected, row.attemptId); assert.equal(calls[0].text, 'revised after clearing');
  for (const [key, value] of Object.entries(row.draftOptions)) assert.equal(calls[0].open[key], value);
  assert.equal(f.draft('native-fixed'), 'next turn from earlier');
  assert.equal(f.draft('new'), 'unrelated new chat draft');
});

test('a refusal before allocation after navigating away keeps the complete plugin draft and the next-turn input separate', async t => {
  const finished = deferred(); let row;
  const f = fixture(t, { firstSendApi: {
    async startFirstSend(request) {
      row = { status: 'failed', intentId: request.intentId, attemptId: request.intentId, canRestoreText: false,
        text: request.text, draftOptions: { adapterId: 'pi', modelName: 'fixture-model' } };
      return { ok: true, row: { title: request.text } };
    },
    async waitFirstSend() { await finished.promise; return { ok: true, row }; },
  } });
  f.type('requires plugin options', [{ ...oldPlugin, inputValues: { name: 'sample' } }]);
  const pending = f.submit(); await until(() => Boolean(row));
  const next = f.document.getElementById('nchatInput'); next.value = 'next turn'; next.dispatchEvent(new Event('input'));
  f.newSession(); f.type('other chat'); finished.resolve(); await pending;
  assert.equal(f.g.NativeChat.firstSendEditState(row, false), 'starter');
  assert.equal(f.g.openComposePanel({ firstSendDraft: row }), true);
  assert.equal(f.document.getElementById('nchatInput').value, 'requires plugin options');
  assert.equal(f.draft(row.intentId), 'next turn'); assert.equal(f.draft('new'), 'other chat');
  assert.equal(f.opens.length, 0); assert.equal(f.calls.length, 0);
});

test('new-session navigation during model preparation cannot send old text or clear the newer draft and plugin', async t => {
  const ready = deferred(), f = fixture(t, { modelReady: ready.promise });
  f.type('original submitted text', [oldPlugin]);
  const pending = f.submit(); await until(() => f.readyCalls());
  f.newSession(); f.type('new unsent text', [newPlugin]);
  ready.resolve(true); await pending;
  assert.equal(f.calls.length, 0);
  assert.equal(f.panel.dataset.stage, 'compose');
  assert.equal(f.input.value, 'new unsent text');
  assert.equal(f.draft(), 'new unsent text');
  assert.deepEqual(f.plugins(), [newPlugin]);
});

test('account changes during model preparation reject the old request even before the scope event arrives', async t => {
  const ready = deferred(), f = fixture(t, { modelReady: ready.promise });
  f.type('account A request'); const pending = f.submit(); await until(() => f.readyCalls());
  f.owner('account-b'); ready.resolve(true); await pending;
  assert.equal(f.calls.length, 0);
  assert.equal(f.input.value, 'account A request');
  assert.equal(f.panel.dataset.stage, 'compose');
});

for (const selection of ['runtime', 'execution']) test(selection + ' changes during model preparation cannot dispatch the earlier draft', async t => {
  const ready = deferred(), f = fixture(t, { modelReady: ready.promise });
  f.type('request under original selection', [oldPlugin]);
  const pending = f.submit(); await until(() => f.readyCalls());
  if (selection === 'runtime') f.runtime('codex');
  else { f.location('cloud'); f.location('local'); }
  ready.resolve(true); await pending;
  assert.equal(f.opens.length, 0, 'changed selection must be rejected before opening a runtime');
  assert.equal(f.calls.length, 0);
  assert.equal(f.panel.dataset.stage, 'compose');
  assert.equal(f.input.value, 'request under original selection');
  assert.equal(f.draft(), 'request under original selection');
  assert.deepEqual(f.plugins(), [oldPlugin]);
});

test('ordinary attachment preparation cannot start a stale first send after new-session navigation', async t => {
  const analysis = deferred(), f = fixture(t); let analysing = false;
  f.compose._attachments = { files: () => [], has: () => true, clear() {},
    analysis: () => { analysing = true; return analysis.promise; }, refs: async () => [],
    names: () => [], libraryItems: () => [], submissionText: text => text };
  f.type('old attachment request'); const pending = f.submit(); await until(() => analysing);
  f.newSession(); f.type('new attachment draft'); analysis.resolve([]); await pending;
  assert.equal(f.calls.length, 0);
  assert.equal(f.input.value, 'new attachment draft');
  assert.equal(f.draft(), 'new attachment draft');
});

for (const change of ['none', 'edit', 'navigate']) test('unreadable starter attachments cannot dispatch or overwrite another draft: ' + change, async t => {
  const reading = deferred(), notices = [];
  let checking = false, requests = 0;
  const f = fixture(t, { firstSendApi: { startFirstSend: async () => { requests++; } } });
  f.g.petSay = message => notices.push(message);
  const file = { name: 'moved.txt' };
  f.compose._attachments = { files: () => [file], has: () => true, clear() {}, add() {}, names: () => [file.name],
    analysis: async () => [], libraryItems: () => [],
    async refs(_api, { unreadable }) { checking = true; await reading.promise; unreadable.push(file.name); return []; } };
  f.type('read the file');
  const pending = f.submit(); await until(() => checking);
  if (change === 'navigate') f.newSession();
  if (change !== 'none') f.type('my new text');
  reading.resolve(); await pending;
  assert.equal(requests, 0); assert.equal(f.opens.length, 0); assert.equal(f.calls.length, 0);
  assert.equal(f.panel.dataset.stage, 'compose');
  assert.equal(f.input.value, change === 'none' ? 'read the file' : 'my new text');
  assert.equal(f.compose._attachments.files()[0], file);
  if (change === 'none') assert.match(notices.join(' '), /moved.txt/);
  else assert.deepEqual(notices, []);
});

test('a normal accepted first send consumes only its original draft and plugin selection', async t => {
  const f = fixture(t); f.type('normal request', [oldPlugin]); await f.submit();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][1], 'normal request');
  assert.equal(f.calls[0][3].plugins[0].pluginId, oldPlugin.pluginId);
  assert.equal(f.input.value, ''); assert.equal(f.draft(), ''); assert.deepEqual(f.plugins(), []);
});

for (const accepted of [true, false]) test('navigation after actual send preserves the new draft when its late receipt is ' + accepted, async t => {
  const ack = deferred(), f = fixture(t, { send: () => ack.promise });
  f.type('already dispatched request', [oldPlugin]); const pending = f.submit();
  await until(() => f.calls.length === 1);
  f.newSession();
  assert.equal(f.input.value, ''); assert.deepEqual(f.plugins(), []);
  f.type('independent new draft', [newPlugin]);
  ack.resolve({ ok: accepted, reason: accepted ? '' : 'Synthetic refusal' }); await pending;
  assert.equal(f.calls.length, 1, 'no duplicate send');
  assert.deepEqual(f.releases, ['ref-first'], 'navigation releases the renderer handle only');
  assert.equal(f.panel.dataset.stage, 'compose');
  assert.equal(f.input.value, 'independent new draft'); assert.equal(f.draft(), 'independent new draft');
  assert.deepEqual(f.plugins(), [newPlugin]);
  if (!accepted) assert.equal(f.draft('first-chat'), 'already dispatched request');
});

test('a refused first send retains the unsent input in its original conversation', async t => {
  const f = fixture(t, { send: async () => ({ ok: false, reason: 'Synthetic refusal' }) });
  f.type('unsent original request'); await f.submit();
  assert.equal(f.calls.length, 1);
  assert.equal(f.document.getElementById('nchatInput').value, 'unsent original request');
  assert.equal(f.draft('first-chat'), 'unsent original request');
});


test('capture failures without a snapshot notify only the active conversation and never resend the turn', async t => {
  const f = fixture(t);
  f.type('complete a report'); await f.submit();
  await until(() => f.calls.length === 1);
  const notices = [];
  f.g.petSay = text => notices.push(text);
  const reason = 'The archived original can still be exported.';
  f.receive({ kind: 'artifact-capture-error', ref: 'another-chat', reason });
  f.receive({ kind: 'artifact-capture-error', ref: 'ref-first', reason });
  assert.deepEqual(notices, [reason]);
  assert.equal(f.calls.length, 1);
});

test('a new app generation request can finish after switching to another new conversation without clearing its input', async t => {
  const admitted = [], gate = deferred();
  const f = fixture(t, { firstSendApi: {
    async startFirstSend(request) { admitted.push(request); return { ok: true, row: { title: request.text } }; },
    async waitFirstSend() { await gate.promise; return { ok: true, row: { status: 'accepted', sessionId: 'original' } }; },
    async attachFirstSend() { assert.fail('a departed view cannot attach the original session'); },
  } });
  f.g.PluginBuilderEntry.openApp('make app A');
  f.type('make app A', [oldPlugin]); const sending = f.submit(); await until(() => admitted.length === 1);
  f.newSession(); f.type('independent draft B', [newPlugin]); gate.resolve(); await sending;
  assert.equal(f.input.value, 'independent draft B'); assert.deepEqual(f.plugins(), [newPlugin]);
  assert.equal(admitted[0].text, 'make app A'); assert.equal(admitted[0].turn.plugins[0].pluginId, oldPlugin.pluginId);
  assert.equal(admitted[0].open.pluginEditId, '');
  assert.equal(admitted[0].open.modelName, 'fixture-model'); assert.equal(f.calls.length, 0);
});

test('an ordinary first send attaches the exact admitted handle when its view remains active', async t => {
  let intentId, attached, admitted;
  const saved = deferred();
  const f = fixture(t, { firstSendApi: {
    async startFirstSend(req) { admitted = req; intentId = req.intentId; await saved.promise; return { ok: true, row: { title: req.text } }; },
    async waitFirstSend(id) { assert.equal(id, intentId); return { ok: true, row: { status: 'accepted', sessionId: 'native' } }; },
    async attachFirstSend(id) { attached = id; return { ok: true, ref: 'native-ref', sessionId: 'native',
      snapshot: { messages: [{ role: 'user', text: 'make skill', submissionId: id }] } }; },
  } });
  const file = { name: 'reference.txt' }, reference = { name: file.name, path: '/fixture/reference.txt' };
  f.compose._attachments = { files: () => [file], has: () => true, clear() {}, analysis: async () => [],
    refs: async () => [reference], names: () => [file.name], libraryItems: () => [], submissionText: text => text };
  f.compose._skillPicker = { selected: () => ['source-audit'], consume() {} };
  f.type('make skill', [oldPlugin]); const pending = f.submit(); await until(() => Boolean(intentId));
  assert.equal(f.draft(), 'make skill', 'keep the original draft until the main process has saved it');
  saved.resolve(); await pending;
  assert.match(intentId, /^first-/); assert.equal(attached, intentId);
  assert.equal(f.opens.length, 0); assert.equal(f.calls.length, 0); assert.equal(f.input.value, '');
  assert.equal(f.document.getElementById('nchatInput').value, '');
  assert.equal(f.draft('native'), '');
  assert.deepEqual(admitted.attachments, [reference]);
  assert.deepEqual(admitted.turn.skills, ['source-audit']);
  assert.equal(admitted.turn.plugins[0].pluginId, oldPlugin.pluginId);
});

for (const switchChat of [false, true]) test('next-turn edits before native admission follow the first chat, switch=' + switchChat, async t => {
  const saved = deferred(), finished = deferred();
  let intentId;
  const f = fixture(t, { firstSendApi: {
    async startFirstSend(req) { intentId = req.intentId; await saved.promise; return { ok: true, row: { title: req.text } }; },
    async waitFirstSend() { await finished.promise; return { ok: true, row: { status: 'accepted', sessionId: 'native-a' } }; },
    async attachFirstSend() { assert.equal(switchChat, false); return { ok: true, ref: 'ref-a', sessionId: 'native-a', snapshot: { messages: [] } }; },
  } });
  f.type('same words'); const pending = f.submit(); await until(() => Boolean(intentId));
  const next = f.document.getElementById('nchatInput');
  assert.equal(next.value, '');
  next.value = 'same words'; next.dispatchEvent(new Event('input'));
  if (switchChat) {
    f.newSession(); assert.equal(f.input.value, '');
    f.type('draft B', [newPlugin]);
  }
  saved.resolve(); finished.resolve(); await pending;
  assert.equal(f.draft('native-a'), 'same words', 'an intentional second draft may be identical');
  assert.equal(f.draft(intentId), '');
  assert.equal(f.draft(), switchChat ? 'draft B' : '');
  if (switchChat) assert.deepEqual(f.plugins(), [newPlugin]);
  else assert.equal(next.value, 'same words');
});

test('editing the starter during model preparation leaves the newer draft unsent', async t => {
  const ready = deferred(), f = fixture(t, { modelReady: ready.promise });
  f.type('submitted before the model check'); const pending = f.submit(); await until(() => f.readyCalls());
  f.type('newer draft'); ready.resolve(true); await pending;
  assert.equal(f.opens.length, 0); assert.equal(f.calls.length, 0);
  assert.equal(f.input.value, 'newer draft'); assert.equal(f.draft(), 'newer draft');
});

for (const field of ['intent', 'mode']) test('a goal selected by ' + field + ' uses its original open and send path', async t => {
  let ordinary = 0;
  const f = fixture(t, { firstSendApi: { startFirstSend() { ordinary++; return { ok: false }; } } });
  const started = await f.g.NativeChat.enter('ship a goal', '', { [field]: 'goal', goal: 'ship', acceptance: 'tested' });
  assert.equal(ordinary, 0); assert.equal(started, true);
  assert.equal(f.opens.length, 1); assert.equal(f.opens[0][field], 'goal');
  assert.equal(f.opens[0].acceptance, 'tested'); assert.equal(f.calls[0][1], 'ship a goal');
});

test('editing an installed app through its compose entry opens the original edit baseline before sending', async t => {
  let ordinary = 0;
  const f = fixture(t, { firstSendApi: { startFirstSend() { ordinary++; return { ok: false }; } } });
  const pluginId = 'local:forecast', localDraft = { id: pluginId };
  f.g.SoduWorkAPI.personalPlugin = async id => {
    assert.equal(id, pluginId);
    return { plugin: { name: 'Forecast', template: 'app', localDraft } };
  };
  f.g.SoduWorkPluginAccess = { async assertEditable(draft) { assert.equal(draft, localDraft); } };
  await f.g.PluginBuilderEntry.editApp(pluginId);
  f.type('edit forecast', [oldPlugin]); await f.submit();
  assert.equal(ordinary, 0); assert.equal(f.opens.length, 1);
  assert.equal(f.opens[0].pluginEditId, pluginId); assert.equal(f.calls[0][1], 'edit forecast');
  assert.equal(f.calls[0][3].plugins[0].pluginId, oldPlugin.pluginId);
});

test('sending while a new file conversation opens reuses that opening', async t => {
  const gate = deferred(); let ordinary = 0;
  const f = fixture(t, { openReady: gate.promise, firstSendApi: { startFirstSend() { ordinary++; return { ok: false }; } } });
  const opened = f.g.NativeChat.enter('', '', { inputTitle: 'notes.txt' });
  await until(() => f.opens.length === 1);
  const send = f.g.NativeChat.send('review the file');
  await tick(); gate.resolve();
  assert.equal(await opened, true); assert.equal(await send, true); assert.equal(ordinary, 0);
  assert.equal(f.opens.length, 1); assert.equal(f.calls[0][0], 'ref-first');
});

test('an existing library item is linked through the original session opening path', async t => {
  let ordinary = 0;
  const linked = [];
  const f = fixture(t, { firstSendApi: { startFirstSend() { ordinary++; return { ok: false }; } } });
  f.g.SoduWorkAPI.associateLibrarySource = async (id, source) => { linked.push([id, source.sessionId]); };
  const started = await f.g.NativeChat.enter('review this document', '', { libraryItemIds: ['document-1'] });
  assert.equal(ordinary, 0); assert.equal(started, true);
  assert.equal(f.opens.length, 1); assert.equal(f.calls[0][1], 'review this document');
  assert.deepEqual(linked, [['document-1', 'first-chat']]);
});

test('a partially staged first send shows the filename warning in its original conversation', async t => {
  const warnings = [], warning = 'missing.txt 无法读取';
  const f = fixture(t, { firstSendApi: {
    async startFirstSend(request) { return { ok: true, row: { title: request.text, attachmentNames: ['good.txt'] }, attachmentWarnings: [warning] }; },
    async waitFirstSend() { return { ok: true, row: { status: 'accepted', sessionId: 'native' } }; },
    async attachFirstSend() { return { ok: true, ref: 'native-ref', sessionId: 'native', snapshot: { messages: [] } }; },
  } });
  f.g.petSay = message => warnings.push(message);
  const started = await f.g.NativeChat.enter('read the attachments', '', { attachments: [{ name: 'missing.txt' }, { name: 'good.txt' }] });
  assert.equal(started, true); assert.deepEqual(warnings, [warning]);
});
