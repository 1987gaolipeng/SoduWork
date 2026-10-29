'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const personal = require('../main/personal-plugins');

const draft = { template: 'method', key: 'draft-compat', name: '运行方案生成器', version: '1.0.0',
  description: '根据项目资料编制运行方案', instructions: '阅读项目资料并编制可验证的运行方案。' };
const fields = [
  { key: 'language', label: '方案语言', type: 'select', options: ['中文', '英文'], default: '中文' },
  { key: 'secure', label: '安全检查', type: 'boolean', default: false },
  { key: 'count', label: '示例数量', type: 'number', default: 0 },
  { key: 'team', label: '团队名称', type: 'text', required: true },
];

test('array-form generated setup installs as canonical preferences without losing defaults or required settings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-setup-compat-'));
  const app = { getPath: () => root };
  try {
    const input = { ...draft, setup: fields };
    const snapshot = JSON.stringify(input);
    const canonical = { ...draft, setup: { preferences: fields } };
    assert.equal(personal.build(input).checksum, personal.build(canonical).checksum);
    const preview = personal.preflight(input);
    assert.equal(preview.manifest.setup.preferences.length, 4);
    const made = personal.create(app, input).plugin;
    assert.equal(made.setupState, 'needs_setup');
    const exported = personal.exportDraft(app, made.pluginId);
    assert.equal(Array.isArray(exported.setup), false);
    assert.equal(exported.setup.preferences[1].default, false);
    assert.equal(exported.setup.preferences[2].default, 0);
    assert.equal(exported.setup.preferences[3].required, true);
    personal.configure(app, made.pluginId, made.checksum, { team: '运营组' });
    assert.equal(personal.get(app, made.pluginId).setupConfig.language, '中文');
    assert.equal(personal.get(app, made.pluginId).setupConfig.secure, false);
    assert.doesNotMatch(JSON.stringify(personal.exportDraft(app, made.pluginId)), /运营组/);
    assert.equal(personal.create(app, canonical).plugin.checksum, made.checksum);
    assert.equal(personal.catalog(app).filter(item => !item.builtIn).length, 1);
    assert.equal(JSON.stringify(input), snapshot, 'normalization never rewrites the source draft');
    assert.deepEqual(personal.normalizeInstallSetup([]).preferences, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('setup shorthand retains structural, credential, type and option safeguards', () => {
  const invalid = [
    [[{ key: 'apiToken', label: '密钥', type: 'text' }], /不能收集凭据/],
    [[{ key: 'language', label: '语言', type: 'text', default: 'token=not-a-real-fixture-secret' }], /凭据/],
    [[{ ...fields[0], default: '不存在的选项' }], /默认值/],
    [[{ ...fields[1], default: 'false' }], /布尔值/],
    [[{ ...fields[2], minimum: 2, default: 1 }], /数字范围/],
    [[{ ...fields[2], maximum: 5, default: 6 }], /数字范围/],
    [[{ key: 'team', type: 'text', minLength: 5, default: 'abc' }], /内容太短/],
    [[{ key: 'connection', type: 'text', description: 'Enter your API token' }], /凭据/],
    [[{ key: 'connection', type: 'text', placeholder: 'Enter your password' }], /凭据/],
    [[{ key: 'run', label: '执行', type: 'shell', command: 'echo fixture' }], /不支持的类型/],
    [['请填写偏好'], /必须是对象/],
    [[fields[0], fields[0]], /重复/],
    [Array.from({ length: 41 }, (_, n) => ({ key: 'field' + n })), /至多 40/],
    ['无需设置', /必须是对象/],
    [{ commands: ['echo fixture'] }, /不支持的字段/],
  ];
  for (const [setup, expected] of invalid) assert.throws(() => personal.preflight({ ...draft, setup }), expected);
});

test('conversation install failure displays the validation reason and restores the retry button', async () => {
  const errorNode = { hidden: true, textContent: '' };
  const button = { disabled: false, textContent: '检查并安装', closest: () => ({ querySelector: () => errorNode }) };
  const shown = [];
  let fail = true, readCount = 0, opened = 0;
  const window = {
    soduWorkAPI: { conversationSession: { pluginDraft: async () => { readCount++; return { ok: true, body: draft }; } } },
    SoduWorkAPI: { preflightPluginDraft: async () => {
      if (fail) throw Error("Error invoking remote method 'personal-plugin-preflight': Error: 插件 setup 必须是对象");
      return personal.preflight(draft);
    } },
    SoduWorkCapabilityPlugins: { openLocalImport: () => { opened++; } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/panels-plugin-maker-utils.js'), 'utf8'), { window });
  const api = window.SoduWorkPluginMakerUtils;
  await api.openConversationDraft('ref', 'file', button, { say: message => shown.push(message) });
  assert.equal(errorNode.textContent, '插件 setup 必须是对象');
  assert.equal(errorNode.hidden, false);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, '检查并安装');
  assert.equal(opened, 0);
  fail = false;
  await api.openConversationDraft('ref', 'file', button, { say: message => shown.push(message) });
  assert.equal(errorNode.hidden, true);
  assert.equal(readCount, 2, 'retry must read the corrected draft from disk again');
  assert.equal(opened, 1);
  assert.equal(api.errorText(Error('具体检查原因')), '具体检查原因');
  assert.equal(api.errorText(Error("Error invoking remote method 'personal-plugin-preflight': Error: " + '长'.repeat(300))).length, 240);
});

test('plugin transport error cleanup keeps existing HTTP, authentication and network guidance', () => {
  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const sandbox = { window: {}, console: { error() {} } };
  vm.createContext(sandbox);
  vm.runInContext(read('components/panels/panels-plugin-maker-utils.js'), sandbox);
  const humanSource = read('components/pet/pet-ui.js');
  vm.runInContext(humanSource.slice(humanSource.indexOf('function _humanErr('), humanSource.indexOf('let bubbleTimer =')), sandbox);
  const capabilitiesSource = read('components/panels/panels-capabilities.js');
  vm.runInContext(capabilitiesSource.slice(capabilitiesSource.indexOf('  function errorText('), capabilitiesSource.indexOf('  function dirty(')), sandbox);
  assert.equal(sandbox.errorText({ message: 'HTTP 400', detail: '请先配置必填偏好', status: 400 }), '请先配置必填偏好');
  assert.equal(sandbox.errorText({ message: 'HTTP 401', status: 401 }), '没权限或登录过期了');
  assert.equal(sandbox.errorText(Error('Failed to fetch'), '插件包预检没有通过'), '插件包预检没有通过');
  assert.equal(sandbox.errorText(Error("Error invoking remote method 'personal-plugin-create': Error: 请提升版本")), '请提升版本');
});
