const test = require('node:test');
const assert = require('node:assert/strict');
const { create, publicModel, preference } = require('../main/conversation/model-selection');
const { createTurnQueue } = require('../main/pi-session/turn-queue');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const model = name => ({ id: name, label: name, key: 'never-render-this-key', baseUrl: 'private', contextWindow: 128000, contextWindowKnown: true });

test('Runner model switching keeps one native session and sends the selected config on the next turn', async () => {
  const { createRunnerRuntimeAdapter, getRunnerSessionDetails, _uuidV5 } = require('../main/agent-runtime/runner-adapter');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-runner-model-'));
  const alias = 'model-switch-test', ref = _uuidV5('9af442c8-cd1d-4b91-a668-22da2b2635bf', 'chat:' + alias + ':codex-harness');
  const calls = []; let round = 0, session;
  const runtime = { async rpc(op, payload) {
    calls.push({ op, payload });
    if (op === 'job.dispatch') { round++; return { ok: true, data: { ref } }; }
    if (op === 'job.comment') { round++; return { ok: true, data: { ok: true, state: 'running' } }; }
    if (op === 'job.session') return { ok: true, data: { ok: true, status: 'done', round,
      items: [{ seq: round, kind: 'say', text: 'round ' + round }] } };
    if (op === 'job.stop') return { ok: true, data: { ok: true } };
    throw Error('Unexpected RPC ' + op);
  } };
  const adapter = createRunnerRuntimeAdapter({ runnerRuntime: runtime,
    modelConfig: { fetchModel: async (_, name) => ({ ok: true, model: { ...model(name), baseUrl: 'http://model.invalid' } }) } });
  try {
    session = await adapter.createSession({ runtimeId: 'test', identity: { clientId: 'test' },
      native: { runner: { openOptions: { ref: alias, cwd: root, modelName: 'a' } } } });
    const handle = getRunnerSessionDetails(session).handle;
    const first = session.send({ text: 'first' }); assert.equal((await first.completion).ok, true);
    assert.equal((await handle.selectModel('b')).ok, true);
    const second = session.send({ text: 'second' }); assert.equal((await second.completion).ok, true);
    assert.equal(calls.filter(row => row.op === 'job.dispatch').length, 1);
    const next = calls.find(row => row.op === 'job.comment').payload;
    assert.equal(next.ref, ref); assert.equal(next.cfg.llm.model, 'b');
    assert.equal(session.snapshot().modelSelection.activeModel.id, 'b');
    assert.ok(session.snapshot().messages.filter(row => row.role === 'user').length >= 2);
    assert.doesNotMatch(JSON.stringify(session.snapshot()), /never-render-this-key/);
  } finally { if (session) await session.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('real Pi SDK registration produces a complete model, not a models.json partial record', async () => {
  const { ModelRuntime } = await import('../node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js');
  const { piProvider } = require('../main/conversation/model-selection');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-sdk-model-'));
  try {
    const runtime = await ModelRuntime.create({ modelsPath: null, authPath: path.join(root, 'auth.json'), modelsStorePath: path.join(root, 'models.db') });
    runtime.registerProvider('soduwork', piProvider({ ...model('switch-test'), baseUrl: 'http://127.0.0.1:1/v1' }));
    const target = runtime.getModel('soduwork', 'switch-test');
    assert.equal(target.input.includes('text'), true);
    assert.equal(target.cost.input, 0);
    assert.equal(target.reasoning, false);
    assert.equal(target.compat.supportsDeveloperRole, false);
    assert.equal(target.contextWindow, 128000);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
function harness(extra = {}) {
  const applied = [], saved = [];
  const selection = create({ name: 'a', model: model('a'),
    resolve: async name => ({ ok: true, model: model(name) }),
    apply: async (m, name) => applied.push(name), persist: name => saved.push(name), ...extra });
  return { selection, applied, saved };
}
test('model selection is safe metadata and does not mutate a streaming turn', async () => {
  const { selection, applied, saved } = harness();
  assert.equal((await selection.select('b')).ok, true);
  assert.equal(selection.capture(), 'b');
  assert.deepEqual(applied, []);
  assert.deepEqual(saved, ['b']);
  assert.equal(selection.view().activeModel.id, 'a');
  assert.equal(selection.view().pending, true);
  assert.doesNotMatch(JSON.stringify(selection.view()), /never-render|private|baseUrl|key/);
});
test('queued turns capture their model independently of later choices and reorder', async () => {
  const { selection, applied } = harness(), queue = createTurnQueue();
  const first = queue.add({ text: 'first', options: { modelName: selection.capture() } });
  await selection.select('b');
  const second = queue.add({ text: 'second', options: { modelName: selection.capture() } });
  await selection.select('c');
  queue.moveBefore(second.id, first.id);
  const sent = [];
  while (queue.size()) {
    const item = queue.take();
    await queue.run(item, async () => { await selection.applyForTurn(item.options.modelName); sent.push([item.text, selection.view().activeModel.id]); return { ok: true }; });
  }
  assert.deepEqual(sent, [['second', 'b'], ['first', 'a']]);
  assert.equal(selection.capture(), 'c');
  assert.deepEqual(applied, ['b', 'a']);
});
test('invalid, unauthorized and unpersisted choices leave the old model selected', async () => {
  const invalid = harness({ resolve: async () => ({ ok: false, reason: 'secret' }) }).selection;
  assert.equal((await invalid.select('x')).ok, false);
  assert.equal((await invalid.select({ id: 'x' })).ok, false);
  assert.equal((await invalid.select('x\n')).ok, false);
  assert.equal(invalid.capture(), 'a');
  const storage = harness({ persist: () => { throw Error('private disk path'); } }).selection;
  const result = await storage.select('b');
  assert.equal(result.ok, false); assert.doesNotMatch(result.reason, /private/);
  assert.equal(storage.capture(), 'a');
});
test('an apply failure pauses execution and retains pending material', async () => {
  const { selection } = harness({ apply: () => { throw Error('key'); } });
  const queue = createTurnQueue(); await selection.select('b');
  queue.add({ text: 'task', attachments: [{ name: 'brief.pdf' }], options: { modelName: selection.capture() } });
  const waiting = queue.add({ text: 'next', attachments: [{ name: 'design.png' }] });
  const item = queue.take();
  const result = await queue.run(item, () => selection.applyForTurn(item.options.modelName));
  assert.equal(result.ok, false); assert.doesNotMatch(result.reason, /key/);
  assert.equal(queue.state().paused, true);
  assert.equal(queue.view()[0].id, waiting.id);
  assert.deepEqual(queue.view()[0].attachments, ['design.png']);
  assert.equal(selection.view().activeModel.id, 'a');
});
test('simultaneous selection cannot allow a slower response to overwrite the accepted choice', async () => {
  let done;
  const { selection } = harness({ resolve: name => new Promise(resolve => { done = () => resolve({ ok: true, model: model(name) }); }) });
  const first = selection.select('b');
  assert.equal((await selection.select('c')).ok, false);
  done(); await first; assert.equal(selection.capture(), 'b');
});
test('model preference restores only a catalog name, never a credential', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-model-pref-'));
  try {
    const app = { getPath: () => root }, store = preference(app, 'session-a');
    assert.equal(store.read(), undefined); store.write('b');
    assert.equal(preference(app, 'session-a').read(), 'b');
    assert.equal(preference(app, 'session-b').read(), undefined);
    assert.deepEqual(Object.keys(publicModel(model('b'))).sort(), [
      'contextWindow', 'contextWindowEstimated', 'contextWindowKnown',
      'contextWindowSource', 'id', 'label',
    ]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('atomic drag ordering preserves task metadata, attachments and new arrivals', () => {
  const queue = createTurnQueue();
  const a = queue.add({ text: 'a', options: { taskId: 'task-a' }, attachments: [{ name: 'a.png' }] });
  const b = queue.add({ text: 'b' }), c = queue.add({ text: 'c' });
  assert.equal(queue.moveBefore(c.id, a.id), true);
  const d = queue.add({ text: 'arrived during drag' });
  assert.equal(queue.moveBefore(a.id, ''), true);
  assert.deepEqual(queue.view().map(row => row.id), [c.id, b.id, d.id, a.id]);
  assert.deepEqual(queue.view().at(-1).attachments, ['a.png']);
  assert.equal(queue.view().at(-1).taskId, 'task-a');
  assert.equal(queue.moveBefore(a.id, a.id), true);
  assert.equal(queue.moveBefore(a.id, 'stale'), false);
});
test('a turn that started during dragging cannot be reordered or resurrected', async () => {
  const queue = createTurnQueue(), a = queue.add({ text: 'a' }), b = queue.add({ text: 'b' });
  const active = queue.take();
  let finish; const done = queue.run(active, () => new Promise(resolve => { finish = resolve; }));
  assert.equal(queue.moveBefore(a.id, b.id), false);
  assert.equal(queue.moveBefore(b.id, a.id), false);
  assert.deepEqual(queue.view().map(row => row.id), [b.id]);
  finish({ ok: true }); await done;
});
