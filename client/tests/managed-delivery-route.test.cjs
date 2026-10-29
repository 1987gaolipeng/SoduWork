'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const backend = (file) => fs.readFileSync(
  path.resolve(root, '..', 'hub-backend', 'app', file), 'utf8');

test('创建保留项目背景，执行入口独立保留流程上下文', () => {
  const draft = read('components/panels/panels-compose-draft.js');
  const submit = read('components/panels/panels-compose-submit.js');
  assert.doesNotMatch(draft, /TaskExecutionClient\.load|startTaskPlugin|dispatchToAI/);
  assert.match(submit, /repoId: draft\.repo \|\| ''/);
  assert.match(submit, /executionContext: null/);
  assert.doesNotMatch(draft, /workScenarioKey:|workScenarioName:/);
  assert.match(submit, /bindingId: ctx\.flowId/);
  assert.match(submit, /executionContext: ctx\.executionContext/);
});

test('workflow acceptance or rejection never falls back to an extra direct dispatch', async () => {
  for (const accepted of [true, false]) {
    const calls = [], window = { SoduWorkAPI: {
      startTaskPlugin: async (id, body) => { calls.push(['workflow', id, body]); return { ok: accepted, reason: 'fixture rejection' }; },
      dispatchToAI: async () => { calls.push(['direct']); return { ok: true }; },
    } };
    vm.runInNewContext(read('components/panels/panels-compose-submit.js'), { window });
    const result = await window.ComposeDraftSubmit.handOff({ id: 'same-task', who: { kind: 'workflow' },
      flowId: 'chosen-flow', repoId: 'repo', brief: 'scope', executionContext: { strategy: 'workflow' } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'workflow');
    assert.equal(calls[0][1], 'same-task');
    assert.equal(calls[0][2].bindingId, 'chosen-flow');
    assert.equal(calls[0][2].repoId, 'repo');
    assert.equal(Boolean(result.warn), !accepted);
  }
});

test('managed workflow selection fails closed while explicit direct selection stays direct', () => {
  const api = backend('services/task_dispatch.py');
  const managed = api.indexOf('if managed_work_route.is_managed(t) and not explicit_direct:');
  const zero = api.indexOf('from ..services import zero_work_route', managed);
  const direct = api.indexOf('dispatch_attempts.existing', managed);

  assert.ok(managed > 0 && zero > managed && direct > zero);
  assert.match(api.slice(managed, zero), /except managed_work_route\.ManagedWorkflowError/);
  assert.match(api.slice(managed, zero), /status_code=409/);
  assert.match(api, /explicit_direct = managed_work_route\.direct_requested\(body\)/);
  assert.match(api, /None if personal_plugin or explicit_direct else/);
});

test('managed task completion requires workflow delivery truth', () => {
  const truth = backend('services/delivery_truth.py');
  const lifecycle = backend('services/task_status.py');

  assert.match(truth, /managed_workflow_required/);
  assert.match(truth, /managed_work_route\.is_managed\(task\) and has_engineering\s+and authority != "workflow" and not explicit_direct/);
  assert.match(lifecycle, /truth = await delivery_truth\.evaluate\(session, task\)/);
  assert.match(lifecycle, /if not truth\.get\("canComplete"\):/);
});
