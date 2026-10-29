'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const os = require('node:os');
const path = require('node:path');
const personal = require('../main/personal-plugins');
const publication = fs.readFileSync(path.join(__dirname,
  '../components/panels/plugin-publication-ux.js'), 'utf8');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-capability-package-'));
  return {
    root,
    app: { getPath: () => root },
    close: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('个人方法插件按直接能力包展示，内部执行计划不冒充工作流', () => {
  const f = fixture();
  try {
    const made = personal.create(f.app, {
      template: 'method',
      name: '需求澄清',
      version: '0.1.0',
      description: '把模糊想法整理成清晰需求',
      instructions: '提取目标、边界和完成标准，输出可执行需求。',
      mcpServers: '',
    });
    const card = personal.catalog(f.app, false).find(
      (item) => item.pluginId === made.plugin.pluginId);
    assert.ok(card);
    assert.equal(card.capabilities.hasWorkflow, false);
    assert.equal(card.capabilities.executionMode, 'direct');
    assert.deepEqual(card.workflow, []);


    assert.deepEqual(card.entrypoints, {
      conversation: true, task: false, automation: true,
    });
    assert.deepEqual(card.capabilities.components.map((item) => item.kind),
      ['instructions', 'skills', 'contract']);
    assert.equal(card.capabilities.permissionSummary.riskLevel, 'low');
  } finally {
    f.close();
  }
});

test('个人工作流插件展示真实流程草稿：本机定时可按方法执行，但不伪装成企业级编排', () => {
  const f = fixture();
  try {
    const made = personal.create(f.app, {
      template: 'workflow',
      name: '交付闭环',
      version: '0.1.0',
      description: '按规划、执行和验收完成交付',
      instructions: '先理解与规划，再执行，最后交给人验收。',
      mcpServers: '',
    });
    const card = personal.catalog(f.app, false).find(
      (item) => item.pluginId === made.plugin.pluginId);
    assert.equal(card.capabilities.hasWorkflow, true);
    assert.equal(card.capabilities.executionMode, 'workflow');
    assert.equal(card.entrypoints.task, false);
    /*
     * Personal workflow steps can guide one local automation turn; formal multistep
     * orchestration remains outside the task entry until enterprise publication.
     */
    assert.equal(card.entrypoints.automation, true);
    assert.deepEqual(card.workflow.map((item) => item.key), ['understand', 'work', 'accept', 'complete']);
    assert.ok(card.capabilities.components.some((item) => item.kind === 'workflow'));
  } finally {
    f.close();
  }
});

test('个人插件声明的基础执行能力进入节点、风险摘要和公开卡片', () => {
  const f = fixture();
  try {
    const made = personal.create(f.app, {
      template: 'method',
      name: '网页竞品巡检',
      version: '0.1.0',
      description: '浏览竞品网页并整理可验证结论',
      instructions: '访问目标网页，记录依据，输出带来源的结论。',
      mcpServers: '',
      runtimeCapabilities: ['browser', 'computer'],
      evaluationInstruction: '巡检示例竞品首页并整理结论',
      evaluationCriteria: '结论包含页面依据\n列出风险和下一步',
    });
    const card = personal.catalog(f.app, false).find(
      (item) => item.pluginId === made.plugin.pluginId);
    assert.deepEqual(card.capabilities.runtime, ['browser', 'computer']);
    assert.equal(card.capabilities.permissionSummary.riskLevel, 'high');
    assert.ok(card.capabilities.components.some(
      (item) => item.kind === 'runtime' && item.count === 2));
    assert.equal(card.capabilities.qualitySummary.state, 'declared');
    assert.equal(card.capabilities.qualitySummary.caseCount, 1);
    assert.deepEqual(card.capabilities.evaluationCases[0].criteria,
      ['结论包含页面依据', '列出风险和下一步']);
    const detail = personal.get(f.app, made.plugin.pluginId);
    assert.deepEqual(detail.localDraft.runtime, ['browser', 'computer']);
  } finally {
    f.close();
  }
});

test('个人插件拒绝伪造未知执行能力', () => {
  const f = fixture();
  try {
    assert.throws(() => personal.preflight({
      template: 'method', name: '越权插件', version: '0.1.0',
      description: '申请不存在的机器能力',
      instructions: '执行未授权能力。',
      runtimeCapabilities: ['root-shell'],
    }), /不支持的执行能力/);
  } finally {
    f.close();
  }
});

test('个人插件拒绝只有试题没有验收标准的伪评测', () => {
  const f = fixture();
  try {
    assert.throws(() => personal.preflight({
      template: 'method', name: '不完整评测', version: '0.1.0',
      description: '评测契约不完整',
      instructions: '完成任务。',
      evaluationInstruction: '执行一个样例',
    }), /需要一起填写/);
  } finally {
    f.close();
  }
});

test('客户端能把当前不可变版本交给插件开发助手生成升级草稿', () => {
  const panel = fs.readFileSync(path.join(__dirname,
    '../components/panels/panels-capability-plugins.js'), 'utf8');
  const shell = fs.readFileSync(path.join(__dirname,
    '../components/panels/panels-capabilities.js'), 'utf8');
  assert.match(panel, /capPersonalImprove/);
  assert.match(panel, /detail\.localDraft/);
  assert.match(shell, /existingDraft/);
  assert.match(shell, /提升 SemVer/);
  assert.match(shell, /soduwork-plugin-draft\.json/);
});

test('个人插件的当前不可变版本可通过原生窗口导出并在其他设备导入', () => {
  const panel = fs.readFileSync(path.join(__dirname,
    '../components/panels/panels-capability-plugins.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8');
  const storage = fs.readFileSync(path.join(__dirname,
    '../main/personal-plugins.js'), 'utf8');
  assert.match(panel, /capPersonalExport/);
  assert.match(panel, /导出插件压缩包/);
  assert.match(preload, /personal-plugin-export/);
  assert.match(storage, /soduwork-personal-plugin-draft/);
  assert.match(storage, /showSaveDialog/);
});

test('插件目录按来源筛选统一列表，企业离线仍可管理个人插件', () => {
  const panel = fs.readFileSync(path.join(__dirname,
    '../components/panels/panels-capability-plugins.js'), 'utf8');
  assert.match(panel, /global\.SoduWorkPluginPresentation/);
  assert.match(panel, /presentation\.libraryModel/);
  assert.doesNotMatch(panel, /catalogSection\('我的插件'|catalogSection\('企业已安装'|发现更多企业能力/);
  assert.match(panel, /企业插件暂时不可用/);
  assert.match(panel, /本机个人插件仍可正常使用/);
  assert.match(panel, /capPluginRemoteRetry/);
});

test('插件详情可一键进入新会话试用，企业发布支持团队部门范围', async () => {
  const panel = fs.readFileSync(path.join(__dirname,
    '../components/panels/panels-capability-plugins.js'), 'utf8');
  const shell = fs.readFileSync(path.join(__dirname,
    '../components/panels/panels-capabilities.js'), 'utf8');
  const mcpGate = fs.readFileSync(path.join(__dirname,
    '../components/panels/plugin-mcp-gate.js'), 'utf8');
  const api = fs.readFileSync(path.join(__dirname, '../api.js'), 'utf8');
  assert.match(panel, /capPluginTry/);
  assert.match(panel, /ctx\.tryPlugin\(item\)/);
  assert.match(shell, /tryPlugin: async function/);
  assert.match(shell, /SoduWorkPluginMcpGate\.ensure/);
  const window = {}, opened = [];
  require('node:vm').runInNewContext(mcpGate, { window });
  let checked = 0, resumed = 0;
  const ready = await window.SoduWorkPluginMcpGate.ensure({
    name: 'fixture', capabilities: { mcpServers: ['required-fixture'] },
  }, {
    api: { myMcpServers: async () => {
      checked++;
      return { personal: [{ name: 'other-fixture', enabled: true }], company: [], enabledCompany: [] };
    } },
    setCatalog() {}, say() {}, errorText: error => error.message, openPanel: async () => {},
    openEditor: (...args) => opened.push(args), resume: () => { resumed++; },
  });
  assert.equal(checked, 1);
  assert.equal(ready, false, 'an unrelated enabled connector cannot satisfy the declared dependency');
  assert.equal(resumed, 0, 'missing connection cannot start the trial');
  assert.equal(opened.length, 1);
  assert.equal(opened[0][0], null);
  assert.equal(opened[0][2].name, 'required-fixture');
  assert.match(shell, /pluginId: item\.pluginId/);
  assert.match(shell, /newSession: true/);
  assert.match(publication, /value="org_units"/);
  assert.match(publication, /capAudienceUnitList/);
  assert.match(api, /orgUnitIds: orgUnitIds \|\| \[\]/);
});

test('个人插件发布使用本机加密身份签名，私钥不经过渲染层或后台', () => {
  const panel = fs.readFileSync(path.join(__dirname,
    '../components/panels/panels-capability-plugins.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8');
  const api = fs.readFileSync(path.join(__dirname, '../api.js'), 'utf8');
  const storage = fs.readFileSync(path.join(__dirname,
    '../main/personal-plugins.js'), 'utf8');
  assert.match(publication, /本机发布身份/);
  assert.match(publication, /signPersonalPluginDraft/);
  assert.match(publication, /发布身份待登记/);
  assert.match(publication, /不需要重新上传/);
  assert.match(preload, /personal-plugin-publisher-identity/);
  assert.match(preload, /personal-plugin-sign/);
  assert.match(api, /plugins\/drafts\/signing-payload/);
  assert.match(storage, /safeStorage\.encryptString/);
  assert.match(storage, /crypto\.sign/);
  assert.doesNotMatch(preload, /privateKeyCipher/);
});

test('企业插件退回原因在客户端可见并能回到个人插件继续改进', () => {
  const panel = fs.readFileSync(path.join(__dirname,
    '../components/panels/panels-capability-plugins.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname,
    '../components/panels/panels-capability-plugins.css'), 'utf8');
  assert.match(publication, /reviewDecision/);
  assert.match(publication, /reviewNote/);
  assert.match(publication, /退回修改/);
  assert.match(publication, /function openSubmission/);
  assert.match(publication, /capSubmissionImprove/);
  assert.match(publication, /打开个人插件继续改进/);
  assert.match(publication, /重新提交会生成新的不可变版本/);
  assert.match(css, /cap-review-feedback/);
});
