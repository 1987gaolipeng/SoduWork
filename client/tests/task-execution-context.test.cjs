'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(
  path.join(root, 'components', 'panels', 'task-execution-context.js'), 'utf8');
const helperSource = fs.readFileSync(
  path.join(root, 'components', 'panels', 'task-execution-client.js'), 'utf8');
const scope = { window: {} };
vm.runInNewContext(source, scope);
vm.runInNewContext(helperSource, scope);
const Context = scope.window.TaskExecutionContext;
const Client = scope.window.TaskExecutionClient;

test('execution context keeps remote runner identity separate from portable execution', () => {
  const options = {
    defaultModel: 'default-model',
    substrates: [{
      key: 'runner:r-1:codex', id: 'runner:r-1:codex', cli: 'codex', name: 'Codex',
      remote: true, runnerId: 'r-1', clientId: 'c-1', machineKey: 'desk-1',
      host: 'runner-host', runnerVersion: '1.2.3', modelPick: true,
    }],
    repos: [{ id: 'repo-1', projectId: 'project-1', name: 'Demo', branch: 'main' }],
  };
  const context = Context.normalize(options, {
    strategy: 'direct', agentId: 'runner:r-1:codex', repoId: 'repo-1', model: 'gpt-5.6-sol',
  });
  assert.equal(context.location.mode, 'remote');
  assert.match(context.location.label, /Runner/);
  assert.equal(context.runner.runnerId, 'r-1');
  assert.equal(context.repo.projectId, 'project-1');
  const payload = Context.payload(context);
  assert.equal(payload.execution.agentKind, 'local:codex');
  assert.equal(payload.execution.model, 'gpt-5.6-sol');
  assert.equal(payload.execution.runnerId, undefined);
  assert.equal(payload.executionContext.runner.id, 'r-1');
});

test('target expansion preserves each authorized location as a distinct assignee', () => {
  const options = { substrates: [{
    key: 'local:pi', cli: 'pi', name: 'Pi', available: true, modelPick: true,
    locations: [
      { assigneeId: 'local:pi', mode: 'local', label: '本机' },
      { assigneeId: 'runner:desk-1:pi', mode: 'remote', runnerId: 'desk-1',
        clientId: 'desktop-2', label: '工作电脑' },
    ],
  }] };
  const rows = Client.targets(options);
  assert.deepEqual(Array.from(rows, row => row.key), ['local:pi', 'runner:desk-1:pi']);
  assert.equal(rows[1].locationMode, 'remote');
  assert.equal(rows[1].runnerId, 'desk-1');
  assert.equal(Client.substrates(options, true)[1].id, 'runner:desk-1:pi');
});

test('mixed location is explicit and no location defaults to local', () => {
  assert.equal(Context.locationMode({ locationMode: 'mixed' }), 'mixed');
  assert.match(Context.locationLabel({ locationMode: 'mixed' }), /远程 Runner/);
  assert.equal(Context.locationMode({}), 'local');
  assert.equal(Context.locationMode({locationMode:'local',runnerId:'r-own',clientId:'current'}), 'local');
  assert.equal(Context.locationLabel({}), '本机');
});

test('task selectors never inject the company default into native-account agents', () => {
  const options = { defaultModel: 'company-default', substrates: [
    { key: 'local:pi', cli: 'pi', modelPick: true, modelSource: 'gateway' },
    { key: 'local:codex', cli: 'codex', modelPick: false, nativeModelPick: true, modelSource: 'native' },
    { key: 'local:claude', cli: 'claude', modelPick: false, modelSource: 'agent' },
  ] };
  for (const cli of ['codex', 'claude']) {
    const context = Context.normalize(options, { agentId: 'local:' + cli, model: 'company-previous' });
    assert.equal(context.model, '');
    assert.equal(Context.execution(context).model, undefined);
  }
  assert.equal(Context.normalize(options, { agentId: 'local:pi' }).model, '',
    'the selected Agent may have a different saved default');
  assert.equal(Context.normalize(options, { agentId: 'local:pi', model: 'chosen-company' }).model, 'chosen-company');
  const codex = Client.substrates(options, true).find(row => row.cli === 'codex');
  assert.equal(codex.nativeModelPick, true);
  assert.equal(codex.modelSource, 'native');
});

test('all assignment surfaces expose the selected route in their compact subtitle', () => {
  assert.match(Client.agentSub({ remote: true, locationLabel: '远程 Runner · BUILD-PC' }), /远程 Runner/);
  assert.match(Client.agentSub({ remote: false, locationLabel: '本机 · MY-PC' }), /本机/);
});

test('execution option identifiers remain selectable when casing differs between cache and UI', () => {
  const workflow = { bindingId: 'Project-Release-V2', key: 'release-v2', name: 'Release', runnable: true };
  const blocked = { ...workflow, runnable: false, readiness: { blockers: ['needs setup'] } };
  assert.equal(Client.runnableWorkflow([workflow], 'project-release-v2'), workflow);
  assert.equal(Client.runnableWorkflow([workflow], 'RELEASE-V2'), workflow);
  assert.equal(Client.workflowProblem({ blockedWorkflows: [blocked] }, 'PROJECT-RELEASE-V2'), 'needs setup');
});
