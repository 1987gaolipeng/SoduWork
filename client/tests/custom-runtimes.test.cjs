'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { declaration, createStore, startupAgents } = require('../main/agent-runtime/custom-runtime-store.cjs');
const { create } = require('../main/agent-runtime/custom-runtimes.cjs');
const { mutableCatalog, createRuntimeCatalog } = require('../main/agent-runtime/runtime-catalog');
const source = require('../../hub-backend/app/agent_catalog.json');
const input = () => ({ id: 'custom-test', displayName: 'New Agent', command: 'sample-agent', args: ['--acp'], modelMode: 'account', modelEnv: {} });
function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-custom-agent-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root }, store = createStore(app), rows = new Map(), calls = [];
  const session = { addRuntime: spec => rows.set(spec.id, spec) };
  const runner = { async rpc(op, payload) { calls.push({ op, payload }); return { ok: true, data: { agents: payload.agents } }; } };
  return { root, app, store, rows, calls, controller: create({ app, store, session, runner, ...overrides }) };
}
test('adding a new Agent persists its executable privately and activates only after the Runner acknowledges', async t => {
  const f = fixture(t); const reply = await f.controller.add(input());
  assert.equal(reply.state, 'active'); assert.equal(f.rows.get('custom-test').runner.bins[0], 'sample-agent');
  assert.equal(f.calls[0].op, 'runtime.catalog.apply');
  assert.equal(f.calls[0].payload.agents[0].runner.adapter, 'acp');
  assert.equal(f.store.read()[0].active, true);
  assert.doesNotMatch(JSON.stringify(f.controller.list()), /sample-agent|runner|install/);
  assert.equal(startupAgents(f.app)[0].id, 'custom-test');
  const restored = [];
  create({ app: f.app, session: { addRuntime: row => restored.push(row) }, runner: {} }).restore();
  assert.equal(restored[0].id, 'custom-test');
});
test('uncertain apply keeps a recoverable pending declaration, then an idempotent retry activates exactly one', async t => {
  let fail = true; const f = fixture(t, { runner: { async rpc(_, payload) { if (fail) throw Error('timeout'); return { ok: true, data: { agents: payload.agents } }; } } });
  let result = await f.controller.add(input());
  assert.equal(result.state, 'pending'); assert.equal(f.rows.size, 0); assert.equal(f.store.read()[0].active, false);
  fail = false; result = await f.controller.add(input());
  assert.equal(result.state, 'active'); assert.equal(f.store.read().length, 1); assert.equal(f.rows.size, 1);
  await assert.rejects(f.controller.add({ ...input(), command: 'changed-agent' }), /已存在/);
  assert.equal(f.store.read()[0].declaration.runner.bins[0], 'sample-agent');
});
test('unwritable storage cannot launch or register a runtime', async t => {
  const f = fixture(t, { store: { read: () => [], write() { throw Error('disk full'); } } });
  await assert.rejects(f.controller.add(input()), /disk full/);
  assert.equal(f.calls.length, 0); assert.equal(f.rows.size, 0);
});

test('an incomplete Runner acknowledgment cannot falsely activate an Agent', async t => {
  const f = fixture(t, { runner: { rpc: async () => ({ ok: true, data: { agents: [] } }) } });
  const result = await f.controller.add(input());
  assert.equal(result.state, 'pending'); assert.match(result.reason, /确认不完整/);
  assert.equal(f.rows.size, 0); assert.equal(f.store.read()[0].active, false);
});
test('invalid executable, inline code, privilege claims and builtin identity overrides are not accepted', () => {
  for (const patch of [{ id: 'pi' }, { command: 'powershell.exe' }, { args: ['--eval=code'] }, { args: ['-c', 'code'] },
    { args: Array(33).fill('x') }, { displayName: '' }, { modelMode: 'bad' },
    { modelMode: 'managed', modelEnv: { PATH: 'key' } }, { modelEnv: { API_KEY: 'key' } }])
    assert.throws(() => declaration({ ...input(), ...patch }), undefined, JSON.stringify(patch));
  const row = declaration({ ...input(), accessControl: { supported: true }, goalMode: 'native' });
  assert.equal(row.accessControl.supported, false); assert.equal(row.goalMode, 'none');
});
test('damaged custom metadata stays on disk and cannot prevent builtin startup', t => {
  const f = fixture(t); fs.mkdirSync(path.dirname(f.store.file), { recursive: true }); fs.writeFileSync(f.store.file, '{broken');
  assert.deepEqual(startupAgents(f.app), []); assert.throws(() => f.controller.list());
  assert.equal(fs.readFileSync(f.store.file, 'utf8'), '{broken');
});
test('runtime metadata hot registration does not mutate existing descriptors or expose executable settings', () => {
  const catalog = mutableCatalog(createRuntimeCatalog(source)), before = catalog.runtime('pi');
  catalog.addRuntime(declaration(input()));
  assert.deepEqual(catalog.runtime('pi'), before);
  assert.equal(Object.isFrozen(before), true);
  assert.equal(catalog.runnerRuntimes().at(-1).id, 'custom-test');
  assert.equal(catalog.publicRuntime('custom-test').runner, undefined);
  assert.throws(() => catalog.runtime('custom-test').accessControl.modes.push('full'));
});

test('only a registered managed Agent uses the shared model selector; unsupported servers do not fall back to Pi', async () => {
  const catalog = require('../main/agent-runtime/runtime-catalog');
  const runtimeApi = require('../main/agent-runtime');
  const config = require('../main/pi-session/model-config');
  const managed = declaration({ ...input(), id: 'custom-managed-model', modelMode: 'managed',
    modelEnv: { OPENAI_BASE_URL: 'base', OPENAI_API_KEY: 'key', OPENAI_MODEL: 'model' } });
  catalog.addRuntime(managed); catalog.addRuntime(declaration({ ...input(), id: 'custom-account-model' }));
  assert.ok(runtimeApi.RUNTIMES.some(row => row.id === managed.id), 'public registry metadata must not retain the startup snapshot');
  const identity = { hub: 'http://fixture.invalid', clientId: 'fixture', secret: 'test-only' }, calls = [];
  const fetch = async raw => { calls.push(new URL(raw)); return { ok: true, json: async () => ({ ok: true, key: 'ticket', model: 'chosen' }) }; };
  for (const id of ['custom-managed-model', 'custom-account-model', 'custom-unknown', 'pi'])
    assert.equal((await config.fetchModel(identity, 'chosen', 1000, fetch, false, id)).ok, true);
  assert.deepEqual(calls.map(url => url.searchParams.get('agent')), ['custom-acp', 'custom-account-model', 'custom-unknown', 'pi']);
  const oldHub = await config.fetchModel(identity, '', 1000, async () => ({ ok: true,
    json: async () => ({ ok: false, reason: '此底座不使用企业模型配置，请检查执行底座' }) }), false, 'custom-managed-model');
  assert.equal(oldHub.ok, false); assert.match(oldHub.reason, /更新后台/);
});

test('hot registration preserves an open Pi session and uses the new Runner adapter without credential leakage', async t => {
  const { createPiSessionBridge } = require('../main/agent-runtime/pi-session-bridge');
  const { _uuidV5 } = require('../main/agent-runtime/runner-adapter');
  const catalog = mutableCatalog(createRuntimeCatalog(source)), f = fixture(t);
  const calls = []; let round = 0, closed = false;
  const raw = { sessionId: 'pi-open-before-add', ref: 'existing-pi',
    on: () => () => {}, snapshot: () => ({ status: 'streaming', messages: [], tools: [] }),
    submit: () => ({ accepted: true, completion: Promise.resolve({ ok: true }) }), close: async () => { closed = true; } };
  const runnerRuntime = { async rpc(op, payload) {
    calls.push({ op, payload });
    if (op === 'runtime.detect') return { ok: true, data: { installed: true, state: 'ready' } };
    if (op === 'job.dispatch') { round++; return { ok: true, data: { ref: _uuidV5('9af442c8-cd1d-4b91-a668-22da2b2635bf', payload.dispatchId) } }; }
    if (op === 'job.comment') { round++; return { ok: true, data: { ok: true } }; }
    if (op === 'job.session') return { ok: true, data: { ok: true, status: 'done', round, items: [{ seq: round, kind: 'say', text: 'Done ' + round }] } };
    if (op === 'job.stop') return { ok: true, data: { ok: true } };
    throw Error('Unexpected RPC ' + op);
  } };
  let modelCalls = 0;
  const bridge = createPiSessionBridge({ catalog, runnerAdapters: [], sessionModule: { probe: async () => ({ ok: true }), open: async () => ({ ok: true, session: raw }) },
    dynamicRunnerOptions: { runnerRuntime, modelConfig: { fetchModel: async () => { modelCalls++; throw Error('Account Agent must not request model credentials'); } } } });
  t.after(() => bridge.dispose());
  const prior = await bridge.open({ ref: raw.ref, cwd: f.root }); assert.equal(prior.ok, true);
  bridge.addRuntime(declaration(input())); bridge.addRuntime(declaration(input()));
  assert.strictEqual(bridge.get(raw.ref), prior.session); assert.equal(closed, false);
  assert.equal(bridge.runtimes().filter(row => row.id === input().id).length, 1);
  assert.equal((await bridge.probe(null, input().id)).ok, true);
  const next = await bridge.open({ adapterId: input().id, cwd: f.root, ref: 'new-chat', identity: { clientId: 'fixture' } });
  assert.equal(next.ok, true, next.reason);
  for (const text of ['First turn', 'Continue the same work']) assert.equal((await next.session.submit(text).completion).ok, true);
  assert.equal(calls.filter(row => row.op === 'job.dispatch').length, 1);
  assert.equal(calls.filter(row => row.op === 'job.comment').length, 1);
  assert.equal(calls.find(row => row.op === 'job.dispatch').payload.cfg.local_cli, input().id);
  assert.equal(modelCalls, 0); assert.equal(closed, false);
});
