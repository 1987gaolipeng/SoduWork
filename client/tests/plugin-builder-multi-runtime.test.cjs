'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const personal = require('../main/personal-plugins');
const preflight = require('../main/personal-plugin-runtime-preflight.cjs');
const catalog = require('../main/agent-runtime/runtime-catalog');

function draft(first = 'PI', second = 'Qwen Code') {
  return { template: 'workflow', key: 'multi-runtime-repro', name: '双底座协作',
    version: '1.0.0', description: '规划与实施分别使用 Pi 和 Qwen Code',
    instructions: '先规划，再根据上游计划实施，最终由用户确认。',
    workflow: { nodes: [
      { key: 'plan', type: 'ai', name: '规划', dependsOn: [],
        outputs: [{ key: 'plan', kind: 'evidence' }], config: { agentKind: first, prompt: '制定计划' } },
      { key: 'build', type: 'ai', name: '实施', dependsOn: ['plan'],
        outputs: [{ key: 'result', kind: 'file', path: 'result.md' }],
        config: { agentKind: second, prompt: '读取计划并实施' } },
      { key: 'accept', type: 'human_review', dependsOn: ['build'], config: {} },
      { key: 'complete', type: 'publish', dependsOn: ['accept'], config: {} },
    ] } };
}

test('a Pi and Qwen Code draft installs and exports canonical routes without changing node intent', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-multi-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root };
  for (const [first, second] of [['PI', 'Qwen Code'], ['local:pi', 'local:qwen-code'], ['Pi', 'qwencode']]) {
    const raw = draft(first, second), before = JSON.stringify(raw);
    const preview = personal.preflight(raw);
    assert.deepEqual(preview.workflow.nodes.slice(0, 2).map(node => node.config.agentKind), ['local:pi', 'local:qwen']);
    assert.equal(JSON.stringify(raw), before, 'checking a draft must not mutate the source');
    const installed = personal.create(app, raw).plugin;
    const exported = personal.exportDraft(app, installed.pluginId);
    assert.deepEqual(exported.workflow.nodes.slice(0, 2).map(node => node.config.agentKind), ['local:pi', 'local:qwen']);
    assert.equal(exported.workflow.nodes[1].inputs[0].fromNode, 'plan');
    assert.equal(preflight.select(exported.workflow.nodes[1], { adapterId: 'pi', model: { id: 'pi-only' } }, installed).agent, 'qwen');
  }
});

test('previously installed Qwen Code aliases resolve to Qwen without rewriting the immutable draft', () => {
  for (const name of ['local:qwen-code', 'local:qwencode', 'local:Qwen Code']) {
    const raw = { config: { agentKind: name }, capabilities: {} }, before = JSON.stringify(raw);
    const route = preflight.select(raw, { adapterId: 'pi', model: { id: 'pi-only' } }, { localDraft: {} });
    assert.equal(route.agent, 'qwen');
    assert.equal(route.modelName, '', 'Qwen must select its own model, never inherit the Pi model');
    assert.equal(JSON.stringify(raw), before);
  }
});

test('unknown and machine-bound routes still fail closed; portable future kinds remain portable', () => {
  for (const route of ['qwen-cloud', 'runner:someone:qwen', 'https://example.invalid/qwen']) {
    assert.throws(() => personal.preflight(draft('local:pi', route)), /不支持的 Agent/);
  }
  const portable = personal.preflight(draft('local:pi', 'local:future-agent'));
  assert.equal(portable.workflow.nodes[1].config.agentKind, 'local:future-agent');
  assert.throws(() => preflight.select(portable.workflow.nodes[1], { adapterId: 'pi' }, {}), /非本机路由/);
  const concrete = draft('local:pi', 'local:qwen');
  concrete.workflow.nodes[1].config.runnerId = 'untrusted-device';
  assert.throws(() => personal.preflight(concrete), /不能绑定具体机器/);
});

test('misspelled route fields cannot silently execute the parent instead of the requested Qwen node', () => {
  for (const routing of [{ execution: { adapterId: 'qwen' } }, { execution: { runtime: 'Qwen Code' } },
    { adapterId: 'qwen' }, { agent: 'qwen' }, { agentKind: 'local:pi', execution: { runtime: 'qwen' } }]) {
    const raw = draft('local:pi', 'local:qwen');
    raw.workflow.nodes[1].config = { prompt: '依据计划执行', ...routing };
    assert.throws(() => personal.preflight(raw), /config\.agentKind/);
    assert.throws(() => preflight.select(raw.workflow.nodes[1], { adapterId: 'pi' }, {}), /config\.agentKind/);
  }
});

test('the installed builder supplies the actual runtime IDs and current collaboration entry', () => {
  const instructions = personal.get({ getPath: () => os.tmpdir() }, personal.BUILDER_ID).localDraft.instructions;
  for (const runtime of catalog.runtimes()) {
    assert.ok(instructions.includes(runtime.displayName + '=local:' + runtime.id), runtime.displayName + ' route must come from the real catalog');
  }
  assert.match(instructions, /Qwen Code=local:qwen/);
  assert.match(instructions, /template=workflow/);
  assert.match(instructions, /个人.*ai.*ai_review.*human_review.*publish/);
  assert.doesNotMatch(instructions, /普通 \/插件 仍只按工作方法执行/);
  assert.match(instructions, /本机.*模型.*不能.*猜/);
  assert.doesNotMatch(instructions, /研发自动化可以使用 ai、ai_review、spec/);
  assert.match(instructions, /默认.*本机/);
  const example = instructions.split('\n').find(line => line.startsWith('最小双底座流程示例'));
  const sample = JSON.parse(example.slice(example.indexOf('{')));
  assert.equal(sample.template, 'workflow');
  assert.deepEqual(sample.runtimeCapabilities, ['files']);
  assert.deepEqual(sample.mcpServers, []);
  assert.deepEqual(sample.skills, []);
  assert.deepEqual(sample.setup, { preferences: [] });
  assert.equal(sample.workflow.nodes[0].outputs[0].kind, 'file');
  assert.equal(sample.workflow.nodes[0].outputs[0].path, 'plan.md');
  assert.deepEqual(sample.workflow.nodes[1].inputs, [{ key: 'plan', fromNode: 'plan', outputKey: 'plan', required: true }]);
  assert.match(sample.workflow.nodes[1].config.prompt, /上游已校验材料.*inputKey=plan.*path/);
  assert.match(instructions, /inputs.*不.*path/);
  const checked = personal.preflight(sample);
  assert.deepEqual(checked.workflow.nodes.slice(0, 2).map(node => node.config.agentKind), ['local:pi', 'local:qwen']);
  assert.equal(checked.workflow.nodes[1].inputs[0].fromNode, 'plan');
  assert.equal(checked.workflow.nodes[2].type, 'human_review');
  assert.deepEqual(checked.workflow.nodes[2].dependsOn, ['plan', 'work']);
  assert.deepEqual(checked.workflow.nodes[2].inputs.map(input => input.fromNode), ['plan', 'work']);
  assert.match(instructions, /每个 inputs\[\]\.fromNode.*dependsOn.*包括 human_review/);
  assert.ok(instructions.length < 8000, 'the shipped prompt must not silently truncate the workflow contract');
});

test('builder delivery example is accepted by the real manifest parser and exposes only the installable draft', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-builder-delivery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root }, builder = personal.get(app, personal.BUILDER_ID);
  assert.equal(builder.version, '1.4.3');
  assert.match(builder.localDraft.instructions, /source\.type=package.*entry=ui\/index\.html/);
  const instructions = builder.localDraft.instructions;
  const parseLine = prefix => {
    const line = instructions.split('\n').find(value => value.startsWith(prefix));
    assert.ok(line, 'the shipped builder must contain ' + prefix);
    return JSON.parse(line.slice(line.indexOf('{')));
  };
  const sample = parseLine('最小双底座流程示例');
  const manifest = parseLine('交付清单示例');
  const installed = personal.create(app, sample).plugin;
  assert.deepEqual(personal.exportDraft(app, installed.pluginId).runtime, ['files']);
  fs.mkdirSync(path.join(root, '.soduwork'));
  fs.writeFileSync(path.join(root, 'soduwork-plugin-draft.json'), JSON.stringify(sample));
  fs.writeFileSync(path.join(root, '.soduwork/delivery.json'), JSON.stringify(manifest));
  const delivery = require('../main/conversation/delivery-contract');
  const files = ['soduwork-plugin-draft.json', '过程说明.md'].map(relative => ({ relative, name: relative,
    path: path.join(root, relative), size: 100, at: Date.now(), changedInTurn: true }));
  const result = delivery.classify(root, files);
  assert.equal(result.source, 'manifest');
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.items.map(item => [item.relative, item.kind, item.primary]),
    [['soduwork-plugin-draft.json', 'file', true]]);
});

test('the shipped builder separates select labels from values and checks the final on-disk revision', () => {
  const builder = personal.get({ getPath: () => os.tmpdir() }, personal.BUILDER_ID);
  const instructions = builder.localDraft.instructions;
  const line = instructions.split('\n').find(value => value.startsWith('公开参数示例：'));
  assert.ok(line, 'ship a concrete inputs example for the reported run_mode failure');
  const field = JSON.parse(line.slice(line.indexOf('{')));
  assert.equal(field.key, 'run_mode');
  assert.notEqual(field.options[0].value, field.options[0].label);
  assert.equal(field.default, field.options[0].value);
  assert.equal(personal.preflight({ ...draft(), inputs: [field] }).ok, true);
  assert.throws(() => personal.preflight({ ...draft(), inputs: [{ ...field, default: field.options[0].label }] }), /run_mode.*默认值不在选项/);
  assert.match(instructions, /磁盘重读.*最终.*草稿/);
  assert.match(instructions, /inputs.*default.*options.*value/);
  assert.match(instructions, /自检失败.*修复.*重新检查/);
  assert.ok(instructions.length < 8000);
});

test('object capability declarations explain the exact expected field type and preserve legacy text lists', () => {
  for (const [field, value] of [['runtimeCapabilities', { files: true }], ['runtime', { files: true }],
    ['mcpServers', {}], ['mcpServers', { crm: { command: 'not-a-plugin-field' } }],
    ['runtimeCapabilities', [{ files: true }]], ['mcpServers', [{}]]]) {
    assert.throws(() => personal.preflight({ ...draft(), [field]: value }), error => {
      assert.ok(error.message.includes(field));
      assert.match(error.message, /字符串数组/);
      assert.doesNotMatch(error.message, /\[object Object\]/);
      return true;
    });
  }
  const valid = personal.preflight({ ...draft(), runtimeCapabilities: 'files,terminal', mcpServers: 'crm, wiki' });
  assert.deepEqual(valid.workflow.nodes[0].capabilities.runtime, ['files', 'terminal']);
  assert.deepEqual(valid.workflow.nodes[0].capabilities.mcpServers, ['crm', 'wiki']);
  assert.throws(() => personal.preflight({ ...draft(), runtimeCapabilities: ['untrusted-runtime'] }), /不支持的执行能力/);
});

test('installation checks disclose enterprise-only nodes and tagged routes before local execution', () => {
  const raw = draft('local:pi', 'local:qwen');
  raw.workflow.nodes[0].type = 'spec';
  raw.workflow.nodes[0].config = { instruction: '整理要求' };
  delete raw.workflow.nodes[1].config.agentKind;
  raw.workflow.nodes[1].config.runnerTags = ['coding', 'frontend'];
  const result = personal.preflight(raw);
  assert.equal(result.ok, true, 'portable enterprise workflows remain installable');
  assert.doesNotMatch(result.checks.find(item => item.key === 'dag').label, /可以执行/);
  const local = result.checks.find(item => item.key === 'local-workflow');
  assert.equal(local.ok, false);
  assert.match(local.label, /规划.*企业|企业.*规划/);
  assert.match(local.label, /实施.*执行机标签|执行机标签.*实施/);
  assert.match(local.label, /config\.agentKind/);
  const good = personal.preflight(draft()).checks.find(item => item.key === 'local-workflow');
  assert.equal(good.ok, true);
  assert.match(good.label, /运行前.*底座.*权限/);
});

test('human review must directly depend on every input source and reports the missing source precisely', () => {
  const raw = draft('local:pi', 'local:qwen');
  const accept = raw.workflow.nodes.find(node => node.key === 'accept');
  accept.inputs = [{ key: 'plan', fromNode: 'plan', outputKey: 'plan' },
    { key: 'result', fromNode: 'build', outputKey: 'result' }];
  const before = JSON.stringify(raw);
  assert.throws(() => personal.preflight(raw), error => {
    assert.match(error.message, /accept.*直接上游/);
    assert.match(error.message, /plan.*dependsOn/);
    assert.match(error.message, /间接依赖/);
    return true;
  });
  assert.equal(JSON.stringify(raw), before, 'a rejected draft must not acquire inferred dependency permissions');
  const corrected = structuredClone(raw);
  corrected.workflow.nodes.find(node => node.key === 'accept').dependsOn = ['plan', 'build'];
  const graph = personal.preflight(corrected).workflow;
  assert.deepEqual(graph.nodes[2].inputs.map(input => input.fromNode), ['plan', 'build']);
  assert.deepEqual(graph.nodes[2].dependsOn, ['plan', 'build']);
});
