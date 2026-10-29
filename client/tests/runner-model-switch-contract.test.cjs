'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createRunnerRuntimeAdapter, getRunnerSessionDetails, _uuidV5 } = require('../main/agent-runtime/runner-adapter');
const catalog = require('../main/agent-runtime/runtime-catalog'), native = require('../main/agent-runtime/native-model-catalog');

for (const agentId of ['qwen', 'codex']) test(agentId + ' sends provider model IDs and matching reasoning config only when changing execution', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-model-contract-'));
  const alias = 'switch-contract', ref = _uuidV5('9af442c8-cd1d-4b91-a668-22da2b2635bf', 'chat:' + alias + ':' + agentId);
  const calls = []; let turn = 0, accepted;
  const old = native.list; native.list = () => ({ models: ['a', 'b', 'c'].map(id => ({ id,
    reasoningLevels: ['low', 'medium', 'high'], defaultReasoning: 'medium' })) });
  t.after(() => { native.list = old; fs.rmSync(root, { recursive: true, force: true, maxRetries: 4 }); });
  const adapter = createRunnerRuntimeAdapter({ runtimeSpec: catalog.runtime(agentId), runnerRuntime: { async rpc(op, input) {
    calls.push({ op, input });
    if (op === 'job.dispatch') { turn++; accepted = { agentId, modelName: input.cfg.llm?.model || input.cfg.codex_model }; return { ok: true, data: { ref } }; }
    if (op === 'job.comment') { turn++; accepted = input.executionSelection || accepted; return { ok: true, data: { ok: true, acceptedSelection: accepted } }; }
    if (op === 'job.session') return { ok: true, data: { status: 'done', round: turn, activeExecutionSelection: accepted,
      items: [{ seq: turn, kind: 'say', text: 'Turn ' + turn }] } };
    if (op === 'job.stop') return { ok: true, data: { ok: true } };
    throw Error(op);
  } }, modelConfig: { fetchModel: async (_identity, name) => ({ ok: true, model: { id: 'provider-' + name, name,
    key: 'test', baseUrl: 'http://example.invalid/v1' } }) } });
  const s = await adapter.createSession({ runtimeId: 'test', identity: { clientId: 'test' }, native: { runner: { openOptions:
    { ref: alias, cwd: root, modelName: 'a', reasoningEffort: 'high' } } } });
  t.after(() => s.dispose()); const h = getRunnerSessionDetails(s).handle;
  const send = async text => { const result = await s.send({ text }).completion; assert.equal(result.ok, true, JSON.stringify(result)); };
  assert.equal((await h.selectModel('b')).ok, true); await send('First'); await send('Same model');
  assert.equal(calls.find(x => x.op === 'job.comment').input.executionSelection, undefined);
  assert.equal((await h.selectModel('c')).ok, true); await send('New model');
  const changed = calls.filter(x => x.op === 'job.comment').at(-1).input;
  assert.equal(changed.ref, ref);
  assert.equal(changed.executionSelection.modelName, agentId === 'codex' ? 'c' : 'provider-c');
  if (agentId === 'codex') {
    assert.equal(changed.executionSelection.reasoningEffort, 'high'); assert.equal(changed.cfg.codex_reasoning_effort, 'high');
  } else assert.equal(changed.cfg.llm.model, changed.executionSelection.modelName);
  await send('Same new model'); assert.equal(calls.filter(x => x.op === 'job.comment').at(-1).input.executionSelection, undefined);
});
