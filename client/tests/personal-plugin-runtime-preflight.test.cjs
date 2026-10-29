'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const preflight = require('../main/personal-plugin-runtime-preflight.cjs');
const agents = ['pi', 'codex-harness', 'qwen', 'opencode', 'dsh', 'codex'];
const plugin = { localDraft: { key: 'co-build' } };
function node(agent, extra = {}) {
  return { key: agent, name: agent, type: 'ai', status: 'pending', attempt: 0,
    config: { agentKind: 'local:' + agent, model: '' },
    capabilities: { runtime: [], skills: [], mcpServers: [] }, ...extra };
}
function fixture(overrides = {}) {
  const calls = [], models = [], checks = [], probes = [], owners = [];
  const handle = { adapterId: 'pi', model: { id: 'parent-pi-model' } };
  const record = { id: 'flow-1', nodes: agents.map(agent => node(agent)) };
  const options = { app: {}, handle, plugin, identityOf: async () => ({ user: 'alice' }),
    validatePlugin: async () => {},
    probePi: async () => { calls.push({ op: 'direct.probe', payload: { key: 'pi' } }); return { ok: true }; },
    skillDirs: [], deviceGrants: [], assertOwner: async identity => { owners.push(identity.user); },
    runtime: { rpc: async (op, payload) => {
      calls.push({ op, payload });
      assert.equal(op, 'runtime.detect', 'admission cannot dispatch a model/task');
      return { ok: true, data: { installed: true, state: 'ready', auth: 'authed' } };
    } },
    fetchModel: async (...args) => { models.push(args); return { ok: true,
      model: { id: args[1] || args[5] + '-default', key: 'NEVER-RETURN-MODEL-TICKET' } }; },
    resolveCapabilities: async options => { checks.push(options); return {
      capabilityIds: options.requested, skills: options.selectedSkills.map(name => ({ name })), skillDirs: [],
    }; },
    probeConnectors: async (_who, names) => { probes.push(names); return names.map(name => ({ name, state: 'ready' })); },
    ...overrides,
  };
  return { ...preflight.create(options), record, handle, calls, models, checks, probes, owners, options };
}

test('six runtimes select their own model defaults; only the same managed runtime inherits the parent', async () => {
  const f = fixture();
  const before = JSON.stringify(f.record);
  const result = await f.preflight(f.record);
  assert.equal(result.ok, true);
  assert.deepEqual(f.models.map(args => [args[1], args[5]]), [
    ['parent-pi-model', 'pi'], ['', 'codex-harness'], ['', 'qwen'], ['', 'opencode'], ['', 'dsh'],
  ]);
  assert.equal(result.nodes.find(row => row.agent === 'codex').model, '');
  assert.equal(f.calls.length, 6);
  assert.equal(JSON.stringify(f.record), before, 'preflight must not consume attempts or change dispatch state');
  assert.doesNotMatch(JSON.stringify(result), /NEVER-RETURN-MODEL-TICKET/);
});

test('explicit per-node models win and account Codex never inherits a parent model', async () => {
  const f = fixture();
  f.handle.adapterId = 'codex'; f.handle.model.id = 'some-account-model';
  const codex = f.record.nodes.at(-1);
  assert.equal(preflight.select(codex, f.handle, plugin).modelName, '');
  codex.config.model = 'gpt-account-explicit';
  const value = await f.resolveNode(codex, f.record);
  assert.equal(value.modelName, 'gpt-account-explicit');
  assert.equal(value.model, null);
  assert.equal(f.models.length, 0, 'account runtimes must never fetch enterprise model tickets');
  const qwen = f.record.nodes[2]; qwen.config.model = 'qwen-explicit';
  await f.resolveNode(qwen, f.record);
  assert.equal(f.models[0][1], 'qwen-explicit');
  assert.equal(f.models[0][5], 'qwen');
});

test('all missing runtimes, account login, models, skills and connector grants are reported together', async () => {
  const detected = [], modelAgents = [];
  const f = fixture({ runtime: { rpc: async (op, payload) => {
    assert.equal(op, 'runtime.detect'); detected.push(payload.key);
    return { ok: true, data: { installed: payload.key !== 'opencode',
      state: payload.key === 'codex' ? 'unauthed' : 'ready' } };
  } }, probePi: async () => { detected.push('pi'); return { ok: true }; }, fetchModel: async (...args) => {
    modelAgents.push(args[5]);
    if (args[5] === 'dsh') throw Error('private-token-do-not-echo');
    return { ok: true, model: { id: args[5] + '-model' } };
  }, resolveCapabilities: async () => ({ capabilityIds: [], skills: [] }),
  probeConnectors: async () => [{ name: 'db', state: 'blocked', label: 'private-token-do-not-echo' }],
  });
  f.record.nodes[2].capabilities = { runtime: ['computer'], skills: ['research'], mcpServers: ['db'] };
  const value = await f.preflight(f.record);
  assert.equal(value.ok, false);
  assert.deepEqual(detected, agents);
  assert.deepEqual(modelAgents, agents.slice(0, -1));
  assert.deepEqual(value.issues.map(row => [row.nodeKey, row.code]), [
    ['qwen', 'capability_missing'], ['opencode', 'runtime_missing'], ['dsh', 'model_unavailable'],
    ['codex', 'runtime_unauthed'], ['qwen', 'connector_unavailable'],
  ]);
  assert.match(value.issues[0].message, /computer.*research/);
  assert.doesNotMatch(JSON.stringify(value), /private-token/);
});

test('repeated runtime/model/capability probes are deduplicated per whole-plan check', async () => {
  const f = fixture();
  f.record.nodes.push(node('dsh', { key: 'final-review', type: 'ai_review' }));
  await f.preflight(f.record);
  assert.equal(f.calls.length, 6);
  assert.equal(f.models.length, 5);
  assert.equal(f.checks.length, 1);
  await f.preflight(f.record);
  assert.equal(f.calls.length, 12, 'a later resume checks current readiness rather than stale cache');
});

test('resume preflight excludes completed nodes and local approval/completion nodes', async () => {
  const f = fixture();
  f.record.nodes.forEach(row => { row.status = 'completed'; });
  f.record.nodes.push(node('codex', { key: 'review', type: 'ai_review' }),
    { key: 'approve', type: 'human_review', status: 'pending' },
    { key: 'finish', type: 'publish', status: 'pending' });
  const result = await f.preflight(f.record);
  assert.equal(result.ok, true);
  assert.deepEqual(f.calls.map(row => row.payload.key), ['codex']);
  assert.equal(f.models.length, 0);
});

test('unknown, hosted and tagged routes fail closed without falling back to Pi', async () => {
  const f = fixture();
  f.record.nodes = [node('unknown'), node('hosted'), node('pi')];
  f.record.nodes[2].config.runnerTags = ['linux'];
  const value = await f.preflight(f.record);
  assert.equal(value.issues.length, 3);
  assert.equal(value.issues.every(row => row.code === 'runtime_route'), true);
  assert.equal(f.calls.length, 0);
  assert.equal(f.models.length, 0);
});

test('runtime transport failures are aggregated and never expose transport bodies', async () => {
  const f = fixture({ runtime: { rpc: async () => { throw Error('secret private request'); } },
    probePi: async () => { throw Error('secret private request'); } });
  const value = await f.preflight(f.record);
  assert.equal(value.ok, false);
  assert.equal(value.issues.length, 6);
  assert.equal(value.issues.every(row => row.code === 'runtime_unknown'), true);
  assert.doesNotMatch(JSON.stringify(value), /secret private/);
});

test('account change during preflight invalidates all readiness and before-node resolution is guarded', async () => {
  let user = 'alice';
  const f = fixture({ identityOf: async () => ({ user }), assertOwner: identity => {
    if (identity.user !== 'alice') throw Error('account changed');
  }, fetchModel: async () => { user = 'bob'; return { ok: true, model: { id: 'ready' } }; } });
  await assert.rejects(f.preflight(f.record), /account changed/);
  await assert.rejects(f.resolveNode(f.record.nodes[0], f.record), /account changed/);
});

test('authorization renewal forces target-runtime refresh without borrowing the parent model', async () => {
  const f = fixture();
  await f.resolveNode(f.record.nodes[3], f.record, true);
  assert.equal(f.models[0][1], '');
  assert.equal(f.models[0][4], true);
  assert.equal(f.models[0][5], 'opencode');
});

test('preflight rejects a changed plugin or denied source before consuming any attempts', async () => {
  const f = fixture({ validatePlugin: async () => {
    throw Object.assign(Error('请重新选择插件'), { code: 'plugin_changed' });
  } });
  const before = JSON.stringify(f.record);
  const result = await f.preflight(f.record);
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, 'plugin_changed');
  assert.equal(JSON.stringify(f.record), before);
});

test('preflight detects runtimes that cannot honor the parent access mode', async () => {
  const path = require('node:path'), rules = require('../main/access-control/policy');
  const f = fixture();
  f.handle.cwd = path.resolve(__dirname);
  f.handle.snapshot = () => ({ accessPolicy: rules.create('readonly', f.handle.cwd) });
  const result = await f.preflight(f.record);
  assert.equal(result.ok, false);
  assert.equal(result.issues.length, 6);
  assert.equal(result.issues.every(row => row.code === 'access_unsupported'), true);
});

test('Pi admission probes the direct SDK contract; unsupported Runner agents remain blocked honestly', async () => {
  const path = require('node:path'), rules = require('../main/access-control/policy');
  const f = fixture({ probePi: async () => ({ ok: true, accessControl: {
    supported: true, schema: rules.SCHEMA, modes: [...rules.MODES] } }) });
  f.handle.cwd = path.resolve(__dirname);
  f.handle.snapshot = () => ({ accessPolicy: rules.create('standard', f.handle.cwd) });
  f.record.nodes = [node('pi'), node('dsh'), node('codex')];
  const value = await f.preflight(f.record);
  assert.deepEqual(f.calls.map(call => call.payload.key), ['dsh', 'codex']);
  assert.deepEqual(value.issues.map(item => item.nodeKey), ['dsh', 'codex']);
  assert.equal(value.issues.every(item => item.code === 'access_unsupported'), true);
  assert.doesNotMatch(value.issues[0].message, /升级/);
});

test('access inheritance retains chosen modes and ignores stale pending policy without widening legacy grants', () => {
  const path = require('node:path'), rules = require('../main/access-control/policy');
  const f = fixture(), cwd = path.resolve(__dirname), child = path.join(cwd, 'child');
  f.handle.cwd = cwd;
  let snapshot; f.handle.snapshot = () => snapshot;
  for (const mode of rules.MODES) {
    snapshot = { accessPolicy: { ...rules.create(mode, cwd), revision: 4 },
      nextAccessPolicy: { ...rules.create('full', cwd), revision: 3 } };
    assert.deepEqual(f.accessPolicy(child), { ...snapshot.accessPolicy, workspaceRoot: child });
    snapshot.nextAccessPolicy = { ...rules.create('readonly', cwd), revision: 5 };
    assert.equal(f.accessPolicy(child).mode, 'readonly');
    assert.equal(f.accessPolicy(child).revision, 5);
  }
  snapshot = { permissionMode: 'full', mode: 'work' };
  assert.equal(f.accessPolicy(child).mode, 'standard', 'legacy full does not mean versioned unrestricted access');
  snapshot = { permissionMode: 'readonly' };
  assert.equal(f.accessPolicy(child).mode, 'readonly');
  snapshot = { accessPolicy: rules.create('standard', cwd),
    nextAccessPolicy: { ...rules.create('full', cwd), revision: 2 },
    accessControl: { changeTakesEffect: 'current-turn' } };
  assert.equal(f.accessPolicy(child, true).mode, 'standard', 'unacknowledged current-turn pending is not a grant');
  snapshot.accessControl.changeTakesEffect = 'next-turn';
  assert.equal(f.accessPolicy(child, true).mode, 'full', 'accepted queued selection is inherited');
});
