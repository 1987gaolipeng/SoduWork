'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('capability editors load before the catalog shell in both renderers', () => {
  for (const page of ['index.html', 'desk.html']) {
    const html = read(page);
    assert.match(html, /panels-capability-editors\.js/);
    assert.ok(html.indexOf('panels-capability-directory.js') <
      html.indexOf('panels-capability-editors.js'));
    assert.ok(html.indexOf('panels-capability-editors.js') <
      html.indexOf('panels-capabilities.js'));
  }
});

test('catalog shell and editor module keep separate maintainable boundaries', () => {
  const shell = read('components/panels/panels-capabilities.js');
  const editors = read('components/panels/panels-capability-editors.js');
  const api = read('api.js');
  const connector = read('components/panels/connector-editor.js');
  assert.match(shell, /SoduWorkCapabilityEditors\.create/);
  assert.match(editors, /function openCreateSkill/);
  assert.match(editors, /function chooseSkillPackage/);
  assert.match(editors, /function openMcpEditor/);
  assert.match(connector, /String\(options\.name\s*\|\|\s*''\)/);
  assert.match(connector, /options\.onSaved/);
  assert.match(editors, /preflightMySkill/);
  assert.match(api, /preflightMyMcpServer/);
  assert.match(api, /probeMyMcpServer/);
  assert.match(connector, /probeMyMcpServer/);
  assert.match(connector, /capMcpProbe/);
  assert.match(connector, /SoduWorkConnectorConfig.status/);
  assert.match(connector, /ctx\.setState\(result,catalog\)/);
});

test('missing skill route gives an actionable version message without confusing a private/missing package', async () => {
  for (const [status, message, expected] of [
    [404, 'Not Found', '后台尚未提供技能内容接口'],
    [404, 'Skill 或文件不存在，或当前无权查看', 'Skill 或文件不存在，或当前无权查看'],
    [403, '没有权限', '没有权限'],
    [500, '服务器内部错误', '服务器内部错误'],
  ]) {
    const globals = { window: {} };
    vm.runInNewContext(read('components/panels/panels-capability-editors.js'), globals);
    const nodes = new Map();
    const layer = { hidden: false, querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, { classList: { add() {} }, textContent: '', innerHTML: '' });
      return nodes.get(selector);
    } };
    const editor = globals.window.SoduWorkCapabilityEditors.create({
      api: { skillDetails: async () => { throw Object.assign(new Error(message), { status }); } },
      h: String, errorText: e => e.message, openModal: () => layer,
    });
    await editor.openSkillDetails('fixture');
    assert.ok(nodes.get('#capModalBody').textContent.includes(expected));
    assert.match(nodes.get('#capModalFoot').innerHTML, /data-detail-retry/);
  }
});
