'use strict';

/* Enterprise workflow identity: every workflow picker must show the enterprise origin and delivery
   environment, such as QA or the project-configured environment, before execution starts. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function loadFormat() {
  const sandbox = {};
  sandbox.window = sandbox;
  vm.runInNewContext(read('components/panels/plugin-catalog-format.js'), sandbox);
  return sandbox.SoduWorkPluginCatalogFormat;
}

test('processInfo/processBadge：企业流程给徽标，办公能力不给', () => {
  const fmt = loadFormat();
  const enterprise = {
    process: {
      enterprise: true, label: '企业研发流程',
      route: 'AI 修改 → Gerrit 评审 → 合并 → 公司 CICD 发布',
      environments: [{ label: 'QA 测试环境', scope: 'company' }],
    },
  };
  const info = fmt.processInfo(enterprise);
  assert.equal(info.label, '企业研发流程');
  assert.match(info.route, /CICD/);
  assert.deepEqual(info.environments, ['QA 测试环境']);
  const badge = fmt.processBadge(enterprise);
  assert.match(badge, /is-enterprise-flow/);
  assert.match(badge, /企业研发流程/);
  assert.match(badge, /QA 测试环境/);

  assert.equal(fmt.processInfo({ process: { enterprise: false } }), null);
  assert.equal(fmt.processInfo({}), null);
  assert.equal(fmt.processBadge({}), '');
  // Provide fallback text when enterprise identity lacks a display label.
  assert.match(fmt.processBadge({ process: { enterprise: true } }), /企业流程/);
});

test('processBadge 对流程说明做 HTML 转义', () => {
  const fmt = loadFormat();
  const badge = fmt.processBadge({ process: {
    enterprise: true, label: '<b>x</b>', route: '"quoted"' } });
  assert.doesNotMatch(badge, /<b>x<\/b>/);
  assert.match(badge, /&lt;b&gt;/);
});

test('四个选择入口都接上了流程身份', () => {
  // Share workflow identity formatting between catalog cards and detail views.
  const cards = read('components/panels/panels-capability-plugins.js');
  assert.match(cards, /processBadge\(item\)/);
  assert.match(cards, /processSectionHtml\(item\)/);
  assert.match(read('components/panels/plugin-catalog-format.js'), /企业流程说明/);
  // Marketplace rows.
  assert.match(read('components/panels/panels-capability-directory.js'),
    /processBadge\(item\)/);
  // Workflow options identify their execution route and delivery environment.
  const add = read('components/panels/panels-add.js');
  assert.match(add, /process\.enterprise/);
  assert.match(add, /交付环境：/);
  // Requirement creation records intent without prematurely selecting execution or delivery configuration.
  const draft = read('components/panels/panels-compose-draft.js');
  assert.doesNotMatch(draft, /_flowTag|交付环境：/);
  assert.match(draft, /基本信息/);
  // Forwarding shows only backend-runnable methods with explicit delivery and readiness information.
  const forward = read('components/panels/panels-forward-plugin.js');
  assert.match(forward, /fwp-identity/);
  assert.match(forward, /process\.label/);
  assert.match(forward, /_fwpEnvironment\(plugin\)/);
  assert.match(forward, /fwp-process/);
  assert.match(forward, /fwp-readiness/);
  assert.match(forward, /plugin\.runnable !== false/);
  assert.match(forward, /data-fwp-ready/);
  // Conversation mention selector.
  assert.match(read('components/panels/chat-plugin-mention.js'),
    /process\.enterprise/);
});
