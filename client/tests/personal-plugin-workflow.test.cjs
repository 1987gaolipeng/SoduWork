'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const os = require('node:os');
const path = require('node:path');
const personal = require('../main/personal-plugins');

function body(workflow) {
  return {
    template: 'workflow', key: 'delivery-studio', name: '交付工作室', version: '0.1.0',
    description: '用多 Agent 完成并审查一份可验收交付',
    instructions: '理解目标，完成交付，独立审查，最后交给人验收。',
    inputs: [
      { key: 'goal', type: 'string', multiline: true, label: '目标', required: true },
      { key: 'level', type: 'select', label: '交付级别', options: ['团队', { value: 'company', label: '公司' }], default: 'company' },
      { key: 'threshold', type: 'number', label: '质量阈值', default: 80 },
    ],
    skills: ['browser-use', 'delivery-check'],
    mcpServers: ['knowledge-base'], runtimeCapabilities: ['browser', 'repository'], workflow,
  };
}

function graph() {
  return { nodes: [
    {
      key: 'plan', type: 'ai', name: '规划', dependsOn: [],
      outputs: [{ key: 'plan', kind: 'evidence', label: '计划', required: true }],
      config: { prompt: '形成覆盖交付与验证的计划', agentKind: 'local:pi', model: 'plan-model',
        fallbackMode: 'strict', timeoutSeconds: 600 }, retry: { maxAttempts: 2 },
      capabilities: { skills: ['delivery-studio'], mcpServers: ['knowledge-base'], runtime: ['browser'] },
    },
    {
      key: 'build', type: 'ai', name: '实施', dependsOn: ['plan'],
      outputs: [{ key: 'site', kind: 'file', path: 'dist/index.html', label: '完整网站', required: true }],
      config: { prompt: '依据计划完成完整交付并自测', agentKind: 'local:codex', model: 'build-model',
        fallbackMode: 'best-effort', runnerTags: ['windows'], timeoutSeconds: 3600 },
      retry: { maxAttempts: 3 },
    },
    {
      key: 'review', type: 'ai_review', name: '独立审查', dependsOn: ['build'],
      outputs: [{ key: 'verdict', kind: 'evidence', label: '审查结论', required: true }],
      config: { prompt: '独立核对完整性与验收标准', agentKind: 'local:opencode', model: 'review-model' },
    },
    { key: 'accept', type: 'human_review', name: '人工验收', dependsOn: ['review'], outputs: [], config: {} },
    { key: 'complete', type: 'publish', name: '办结沉淀', dependsOn: ['accept'], outputs: [], config: {} },
  ] };
}

test('advanced personal workflow preserves per-node agents, models and typed handoffs', () => {
  const preview = personal.preflight(body(graph()));
  const nodes = preview.workflow.nodes;
  const build = nodes.find((node) => node.key === 'build');
  const review = nodes.find((node) => node.key === 'review');
  assert.equal(build.config.agentKind, 'local:codex');
  assert.equal(build.config.model, 'build-model');
  assert.deepEqual(build.config.runnerTags, ['windows']);
  assert.deepEqual(build.inputs, [{
    key: 'plan_plan', fromNode: 'plan', outputKey: 'plan', label: '计划', required: true,
  }]);
  assert.equal(build.outputs[0].path, 'dist/index.html');
  assert.equal(review.inputs[0].fromNode, 'build');
  assert.equal(preview.simulation.order.map((row) => row.key).join('>'),
    'plan>build>review>accept>complete');
  assert.equal(preview.simulation.order[1].route.agentKind, 'local:codex');
  assert.ok(preview.checks.some((row) => row.key === 'handoff' && row.ok));
  assert.equal(preview.manifest.inputs[0].type, 'textarea');
  assert.deepEqual(preview.manifest.capabilities.skills,
    ['delivery-studio', 'browser-use', 'delivery-check']);
  assert.deepEqual(nodes[0].capabilities.skills, ['delivery-studio']);
  assert.deepEqual(build.capabilities.skills,
    ['delivery-studio', 'browser-use', 'delivery-check']);
  assert.deepEqual(preview.manifest.inputs[1].options.map((item) => item.value), ['团队', 'company']);
  assert.ok(preview.checks.some((row) => row.key === 'inputs' && row.ok));
});

test('advanced workflow stays in the immutable local version and portable export', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-advanced-plugin-'));
  const app = { getPath: () => root };
  try {
    const created = personal.create(app, body(graph()));
    assert.equal(created.plugin.workflow.length, 5);
    assert.equal(created.plugin.localDraft.workflow.nodes[1].config.model, 'build-model');
    assert.equal(created.plugin.localDraft.inputs[2].default, 80);
    const exported = personal.exportDraft(app, created.plugin.pluginId);
    assert.equal(exported.workflow.nodes[2].config.agentKind, 'local:opencode');
    assert.equal(exported.inputs[1].default, 'company');
    assert.equal(personal.preflight(exported).workflow.nodes.length, 5);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('employees can author and export a standalone enterprise release plugin', () => {
  const release = body({ nodes: [
    {
      key: 'readiness', type: 'ai', name: '上线材料核对', dependsOn: [],
      outputs: [{ key: 'decision', kind: 'decision', path: 'release-decision.json', required: true }],
      config: { prompt: '核对已合并固定版本、质量证据与回滚依据并生成结构化决定' },
    },
    { key: 'approval', type: 'approval', name: '发布审批', dependsOn: ['readiness'],
      config: { action: 'deploy' } },
    { key: 'release', type: 'deploy_chain', name: '企业发布链', dependsOn: ['approval'], config: {} },
    { key: 'verify', type: 'validate', name: '上线核对', dependsOn: ['release'],
      config: { deployVerify: true, shaCheck: true, http: [] } },
    { key: 'complete', type: 'publish', name: '归档回执', dependsOn: ['verify'], config: {} },
  ] });
  release.key = 'standalone-release'; release.name = '独立上线';
  release.distribution = 'standalone';
  release.entrypoints = { conversation: false, task: true, automation: true };
  const preview = personal.preflight(release);
  assert.equal(preview.manifest.distribution, 'standalone');
  assert.deepEqual(preview.manifest.entrypoints,
    { conversation: false, task: true, automation: true });
  assert.deepEqual(preview.workflow.nodes.map(node => node.type),
    ['ai', 'approval', 'deploy_chain', 'validate', 'publish']);
  assert.equal(preview.workflow.nodes[3].config.shaCheck, true);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-release-plugin-'));
  try {
    const created = personal.create({ getPath: () => root }, release);
    assert.equal(personal.exportDraft({ getPath: () => root }, created.plugin.pluginId)
      .workflow.nodes[2].type, 'deploy_chain');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('advanced workflow rejects cycles, broken contracts and capability escalation', () => {
  const cyclic = graph();
  cyclic.nodes[0].dependsOn = ['build'];
  assert.throws(() => personal.preflight(body(cyclic)), /循环依赖/);

  const noOutput = graph();
  noOutput.nodes[1].outputs = [];
  assert.throws(() => personal.preflight(body(noOutput)), /至少要声明一项/);

  const escalated = graph();
  escalated.nodes[1].capabilities = { skills: ['delivery-studio'], mcpServers: ['finance-prod'] };
  assert.throws(() => personal.preflight(body(escalated)), /未声明的能力/);

  const unknownSkill = graph();
  unknownSkill.nodes[1].capabilities = { skills: ['not-declared'] };
  assert.throws(() => personal.preflight(body(unknownSkill)), /未声明的能力/);
});

test('advanced workflow rejects concrete machines, unsupported agents and embedded secrets', () => {
  const concrete = graph();
  concrete.nodes[1].config.runnerId = 'runner-trial';
  assert.throws(() => personal.preflight(body(concrete)), /不能绑定具体机器/);

  const unknown = graph();
  unknown.nodes[1].config.agentKind = 'runner:someone:pi';
  assert.throws(() => personal.preflight(body(unknown)), /不支持的 Agent/);

  const secret = graph();
  secret.nodes[1].config.apiToken = 'real-value';
  assert.throws(() => personal.preflight(body(secret)), /不能保存密码、密钥或令牌/);
});
test('portable future agent kinds survive authoring but concrete runners stay forbidden', () => {
  const future = graph();
  future.nodes[1].config.agentKind = 'local:future-agent';
  const preview = personal.preflight(body(future));
  assert.equal(preview.workflow.nodes[1].config.agentKind, 'local:future-agent');
});


test('public task inputs reject credentials and unsafe defaults', () => {
  const secretField = body(graph());
  secretField.inputs = [{ key: 'apiToken', type: 'text', label: '令牌' }];
  assert.throws(() => personal.preflight(secretField), /不能收集凭据/);

  const secretDefault = body(graph());
  secretDefault.inputs = [{
    key: 'note', type: 'text', label: '备注', default: 'token=very-secret-value',
  }];
  assert.throws(() => personal.preflight(secretDefault), /疑似包含凭据/);
});

test('plugin maker is split from catalog and loaded in both client window forms', () => {
  const root = path.join(__dirname, '..');
  const maker = fs.readFileSync(path.join(root, 'components/panels/panels-plugin-maker.js'), 'utf8');
  const utils = fs.readFileSync(path.join(root, 'components/panels/panels-plugin-maker-utils.js'), 'utf8');
  const skills = fs.readFileSync(path.join(root, 'components/panels/panels-plugin-maker-skills.js'), 'utf8');
  const catalog = fs.readFileSync(path.join(root, 'components/panels/panels-capability-plugins.js'), 'utf8');
  const desk = fs.readFileSync(path.join(root, 'desk.html'), 'utf8');
  const overlay = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(maker, /data-node-field="agentKind"/);
  assert.match(maker, /data-node-dependency/);
  assert.match(maker, /data-output-field="kind"/);
  assert.match(maker, /不执行真实操作/);
  assert.match(catalog, /SoduWorkPluginMaker\.open/);
  assert.match(maker, /编辑插件新版本/);
  assert.match(maker, /data-input-field="type"/);
  assert.match(maker, /新版本必须高于当前/);
  assert.match(maker, /inputs: fieldEditor\.inputs\(\)/);
  assert.match(maker, /inputs\(\) \{ return publicInputs\.map\(serializeInput\)/);
  assert.match(maker, /cap-maker-setup/);
  assert.match(maker, /setupFields\.map\(serializeSetup\)/);
  assert.match(maker, /保存独立插件/);
  assert.match(maker, /body\.distribution !== 'standalone'/);
  assert.match(skills, /data-plugin-skill/);
  assert.match(maker, /skills:\s*\[\.\.\.pluginSkills\]/);
  assert.match(utils, /SoduWorkPluginMakerUtils/);
  assert.match(skills, /api\.mySkills\(\)/);
  assert.match(catalog, /id="capPersonalEdit">编辑新版本/);
  assert.match(catalog, /openMaker\(ctx, detail\.localDraft, detail\.localVersions/);
  assert.ok(desk.indexOf('panels-plugin-maker-utils.js') < desk.indexOf('panels-plugin-maker-skills.js'));
  assert.ok(overlay.indexOf('panels-plugin-maker-utils.js') < overlay.indexOf('panels-plugin-maker-skills.js'));
  assert.ok(desk.indexOf('panels-plugin-maker-skills.js') < desk.indexOf('panels-plugin-maker.js'));
  assert.ok(overlay.indexOf('panels-plugin-maker-skills.js') < overlay.indexOf('panels-plugin-maker.js'));
});
