'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../components/requirements/requirement-session-choice.js'), 'utf8');
const task = {id: 'task', status: 'todo'};
const runtime = (id, extra = {}) => ({id, displayName: id, transport: id === 'pi' ? 'direct' : 'runner',
  modelMode: 'managed', capabilities: [], ...extra});
function deferred() { let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve}; }
function fixture({catalog = {ok: true, runtimes: [runtime('pi')]}, probe = async () => ({ok: true})} = {}) {
  const calls = {runtimes: 0, probe: [], enqueue: 0};
  const sessions = {runtimes: async () => {calls.runtimes++; return typeof catalog === 'function' ? catalog() : catalog;},
    probe: async id => {calls.probe.push(id); return probe(id);}};
  const window = {soduWorkAPI: {conversationSession: sessions}, NativeChat: {enqueueTask() {calls.enqueue++;}}};
  vm.runInNewContext(source, {window, setTimeout, clearTimeout});
  return {api: window.RequirementSessionChoice, window, sessions, calls};
}

test('unconstrained requirements can inspect local Agents without starting execution or changing Hub candidates', async () => {
  const f = fixture(), options = {selection: {}, substrates: [{key: 'local:pi', name: 'Hub Pi', available: false}],
    workflows: [{bindingId: 'available-but-not-selected'}]};
  const before = JSON.stringify(options);
  assert.equal(f.api.canUseLocalAgents(task, options), true);
  const result = await f.api.localAgents(task, options);
  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.agents, row => row.key), ['local:pi']);
  assert.equal(result.agents[0].available, true);
  assert.equal(result.agents.some(row => row.key.startsWith('native:')), false);
  assert.equal(JSON.stringify(options), before, 'discovery must not overwrite existing Hub rows or workflow candidates');
  assert.equal(f.calls.enqueue, 0);
});

test('repository, workflow, squad and remote constraints exclude local Agent discovery before IPC', async () => {
  const constraints = [
    {repoId: 'repo'}, {repo: {id: 'repo'}}, {repo: {path: '/project'}},
    {workflowBindingId: 'flow'}, {selectedWorkflowBindingId: 'flow'}, {workflowId: 'flow'},
    {bindingId: 'flow'}, {plugin: {bindingId: 'flow'}}, {strategy: 'workflow'}, {selectedStrategy: 'workflow'},
    {assigneeType: 'squad'}, {runner: {mode: 'remote'}}, {runner: {remote: true}}, {location: {mode: 'remote'}},
    {agentId: 'runner:machine:pi'}, {agent: {id: 'runner:machine:pi'}}, {agent: {key: 'runner:machine:pi'}},
  ];
  const scopes = [
    constraint => [constraint, {}], constraint => [{executionContext: constraint}, {}],
    constraint => [{workRouting: constraint}, {}], constraint => [{workRouting: {executionContext: constraint}}, {}],
    constraint => [{}, {selection: constraint}],
  ];
  for (const [fields, options] of constraints.flatMap(constraint => scopes.map(scope => scope(constraint)))) {
    const f = fixture(), item = {...task, ...fields};
    assert.equal(f.api.canUseLocalAgents(item, options), false, JSON.stringify({fields, options}));
    const result = await f.api.localAgents(item, options);
    assert.equal((result?.agents || []).length, 0);
    assert.equal(f.calls.runtimes, 0);
    assert.equal(f.calls.probe.length, 0);
  }
});

test('missing enqueue, runtime catalog or probe capability never produces a local Agent', async () => {
  for (const missing of ['enqueueTask', 'runtimes', 'probe']) {
    const f = fixture();
    if (missing === 'enqueueTask') delete f.window.NativeChat.enqueueTask;
    else delete f.sessions[missing];
    assert.equal(f.api.canUseLocalAgents(task, {}), false, missing);
    assert.equal((await f.api.localAgents(task, {}))?.agents?.length || 0, 0);
    assert.equal(f.calls.runtimes, 0);
    assert.equal(f.calls.probe.length, 0);
  }
});

test('each successful probe reports one standard local Agent before the remaining probes finish', {timeout: 3000}, async () => {
  const pi = deferred(), claude = deferred(), started = deferred();
  const f = fixture({catalog: {ok: true, runtimes: [runtime('pi'), runtime('claude')]}, probe: id => {
    if (id === 'claude') started.resolve();
    return id === 'pi' ? pi.promise : claude.promise;
  }});
  const reported = [], first = deferred();
  let complete = false;
  const pending = f.api.localAgents(task, {}, item => {reported.push(item); first.resolve();})
    .then(result => {complete = true; return result;});
  pi.resolve({ok: true});
  await first.promise;
  assert.equal(complete, false);
  assert.deepEqual(reported.map(row => row.key), ['local:pi']);
  await started.promise;
  claude.resolve({ok: true});
  const result = await pending;
  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.agents, row => row.key).sort(), ['local:claude', 'local:pi']);
  assert.deepEqual(reported.map(row => row.key).sort(), ['local:claude', 'local:pi']);
  assert.equal(f.calls.enqueue, 0);
});

test('invalid runtime ids and transports are not probed, and duplicate directory rows report once', async () => {
  const invalid = [null, {}, runtime(''), runtime('native:pi'), runtime('PI'), runtime('../pi'),
    runtime('pi/more'), runtime('a'.repeat(41)), runtime('unknown', {transport: 'cloud'}),
    runtime('unsupported', {transport: 'acp'}), runtime('missing-transport', {transport: undefined}),
    runtime('not-pi', {transport: 'direct'})];
  const f = fixture({catalog: {ok: true, runtimes: [...invalid, runtime('pi'), runtime('pi'), runtime('custom-agent')]}});
  const reported = [], result = await f.api.localAgents(task, {}, row => reported.push(row));
  assert.equal(result.ok, true);
  assert.deepEqual(f.calls.probe.slice().sort(), ['custom-agent', 'pi']);
  assert.deepEqual(Array.from(result.agents, row => row.key).sort(), ['local:custom-agent', 'local:pi']);
  assert.deepEqual(reported.map(row => row.key).sort(), ['local:custom-agent', 'local:pi']);
});

test('probe failure, exceptions and truthy non-boolean ok never become available Agents', async () => {
  const replies = {pi: {ok: true}, missing: {ok: false}, numeric: {ok: 1}, textual: {ok: 'true'}, empty: null};
  const f = fixture({catalog: {ok: true, runtimes: Object.keys(replies).concat('broken').map(id => runtime(id))},
    probe: async id => {if (id === 'broken') throw Error('probe unavailable'); return replies[id];}});
  const reported = [], result = await f.api.localAgents(task, {}, row => reported.push(row));
  assert.deepEqual(Array.from(result.agents, row => row.key), ['local:pi']);
  assert.deepEqual(reported.map(row => row.key), ['local:pi']);
});

test('unavailable probe states remain excluded even when ok is true', async () => {
  const replies = {pi: {ok: true, state: 'ok'}, bad: {ok: true, state: 'bad'},
    missing: {ok: true, state: 'missing'}, unauthed: {ok: true, state: 'unauthed'},
    nollm: {ok: true, state: 'nollm'}};
  const f = fixture({catalog: {ok: true, runtimes: Object.keys(replies).map(id => runtime(id))},
    probe: async id => replies[id]});
  const reported = [], result = await f.api.localAgents(task, {}, row => reported.push(row));
  assert.deepEqual(Array.from(result.agents, row => row.key), ['local:pi']);
  assert.deepEqual(reported.map(row => row.key), ['local:pi']);
  assert.equal(f.calls.probe.length, Object.keys(replies).length);
});

test('every discovery refresh probes again and preserves runtime model configuration', async () => {
  let available = true;
  const f = fixture({catalog: {ok: true, runtimes: [runtime('pi', {displayName: 'Pi'}),
    runtime('claude', {displayName: 'Claude', modelMode: 'account'})]},
    probe: async () => ({ok: available, version: 'fixture-version'})});
  const first = await f.api.localAgents(task, {});
  const pi = first.agents.find(row => row.key === 'local:pi');
  const claude = first.agents.find(row => row.key === 'local:claude');
  assert.equal(pi.name, 'Pi');
  assert.equal(pi.modelPick, true);
  assert.equal(claude.name, 'Claude');
  assert.equal(claude.modelPick, false);
  for (const agent of first.agents) {
    assert.equal(agent.local, true);
    assert.equal(agent.remote, false);
    assert.equal(agent.executionSource, 'conversation');
    assert.deepEqual(Array.from(agent.versions), ['fixture-version']);
  }
  available = false;
  const second = await f.api.localAgents(task, {});
  assert.equal(second.agents.length, 0, 'a previously successful probe cannot keep an unavailable Agent selectable');
  assert.equal(f.calls.runtimes, 2);
  assert.deepEqual(f.calls.probe.slice().sort(), ['claude', 'claude', 'pi', 'pi']);
  assert.equal(f.calls.enqueue, 0);
});

test('failed or malformed runtime catalogs never fall back to an invented Pi candidate', async () => {
  for (const catalog of [{ok: false, runtimes: [runtime('pi')]}, {ok: true, runtimes: null},
    {ok: true, runtimes: {}}, null, async () => {throw Error('catalog unavailable');}]) {
    const f = fixture({catalog}), reported = [];
    const result = await f.api.localAgents(task, {}, row => reported.push(row));
    assert.equal((result?.agents || []).length, 0);
    assert.equal(f.calls.probe.length, 0);
    assert.equal(reported.length, 0);
  }
});

test('multiple ready runtimes are selectable while connection failures retain actionable diagnostics', async () => {
  const ready = ['pi', 'qwen', 'codex', 'codex-harness', 'dsh'];
  const f = fixture({catalog: {ok:true, runtimes:[...ready, 'opencode', 'claude'].map(id => runtime(id))},
    probe: async id => id === 'opencode' ? {ok:false, state:'missing'} : id === 'claude'
      ? {ok:false, reason:'Runner is not running: local runtime missing'} : {ok:true, state:'ok'}});
  const result = await f.api.localAgents(task, {});
  assert.deepEqual(Array.from(result.agents, row => row.key).sort(), ready.map(id => 'local:' + id).sort());
  assert.deepEqual(Array.from(result.failures, row => [row.id, row.reason]),
    [['claude', 'Runner is not running: local runtime missing']]);
  assert.equal(f.calls.enqueue, 0);
});
