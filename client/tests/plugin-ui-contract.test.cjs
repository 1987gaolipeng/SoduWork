'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const personal = require('../main/personal-plugins');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function hostWith(items) {
  const api = { pluginCatalog: async () => ({ items }) };
  const window = { SoduWorkAPI: api };
  const context = { window, SoduWorkAPI: api, URL, console, Date, Map, Set,
    String, Array, Object, Number, Boolean, RegExp, encodeURIComponent };
  vm.runInNewContext(read('components/panels/plugin-ui-host.js'), context);
  return window.PluginUIHost;
}

test('legacy plugin and checkpoint action ids open the one registered requirement form', async () => {
  const host = hostWith([]), opened = [];
  host.registerAction({ id: 'work.requirement.create', command: '需求',
    open: context => { opened.push(context); return context; } });
  const checkpoint = { actionId: 'work.task.create', text: '保留草稿与材料', attachments: [{ name: 'context.md' }] };
  const result = await host.invoke(checkpoint.actionId, checkpoint);
  assert.equal(opened.length, 1);
  assert.equal(result.text, checkpoint.text);
  assert.equal(result.actionId, 'work.requirement.create');
  assert.deepEqual(result.attachments, checkpoint.attachments);
  assert.equal(host.actions().length, 1);
  assert.equal(host.actions()[0].id, 'work.requirement.create');
  const built = personal.build({ template: 'method', name: '旧插件需求入口', version: '0.1.0',
    description: '兼容已发布插件的内置入口', instructions: '整理需求。', ui: { contributions: [{
      id: 'create', title: '创建任务', slot: 'workspace.navigation',
      source: { type: 'builtin', actionId: 'work.task.create' },
    }] } });
  assert.equal(built.body.ui.contributions[0].source.actionId, 'work.requirement.create');
  assert.equal(built.manifest.ui.contributions[0].source.actionId, 'work.requirement.create');
});

test('normal plugins contribute no UI and personal UI remains an immutable manifest contract', () => {
  const common = {
    template: 'method', name: '客户复盘', version: '0.1.0',
    description: '根据会话和任务证据整理客户复盘',
    instructions: '读取上下文，整理事实、结论、风险和下一步。',
  };
  assert.deepEqual(personal.build(common).body.ui, { contributions: [] });
  assert.equal(personal.build(common).manifest.ui, undefined);
  const built = personal.build({ ...common, ui: { contributions: [{
    id: 'customer-view', title: '客户工作台', slot: 'task.detail.tab',
    source: { type: 'external', url: 'https://crm.example.com/tasks/{{task.id}}' },
  }] } });
  assert.equal(built.manifest.ui.contributions[0].source.type, 'external');
  assert.ok(built.capabilities.components.some((item) => item.kind === 'ui'));
  const listed = personal._publicPlugin({
    id: 'local:ui', key: built.body.key, name: built.body.name,
    description: built.body.description, enabled: true, builtIn: false,
    currentVersion: built.body.version,
    versions: [{ version: built.body.version, ...built }],
  });
  assert.equal(listed.entrypoints.automation, false);
  assert.equal(listed.capabilities.interactiveUi, true);
  assert.throws(() => personal.build({ ...common, ui: { contributions: [{
    id: 'bad', title: '危险页面', slot: 'task.detail.tab',
    source: { type: 'external', url: 'https://x.test/?token=secret' },
  }] } }), /不含凭据/);
});

test('task UI only mounts installed plugins in the current project and resolves context safely', async () => {
  const contribution = { id: 'crm', title: '客户系统', slot: 'task.detail.tab',
    source: { type: 'external', url: 'https://crm.example.com/task/{{task.id}}' } };
  const host = hostWith([
    { pluginId: 'ready', name: 'CRM', installed: true, enabled: true,
      organizationWide: false, projectIds: ['project-a'], ui: { contributions: [contribution] } },
    { pluginId: 'not-installed', name: 'Hidden', installed: false, enabled: true,
      organizationWide: true, ui: { contributions: [contribution] } },
  ]);
  const rows = await host.contributions('task.detail.tab', {
    task: { id: 'T / 1', projectId: 'project-a' },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pluginId, 'ready');
  assert.equal(host.resolveUrl(rows[0], { task: { id: 'T / 1' } }),
    'https://crm.example.com/task/T%20%2F%201');
  assert.equal((await host.contributions('task.detail.tab', {
    task: { id: 'T2', projectId: 'project-b' },
  })).length, 0);
});

test('workspace navigation is bounded and preserves declared bridge capabilities', async () => {
  const rows = Array.from({ length: 4 }, (_, index) => ({
    id: 'app-' + index, title: 'App ' + index, slot: 'workspace.navigation',
    source: { type: 'external', url: 'https://example.invalid/app/' + index,
      bridge: { capabilities: ['context.read', 'conversation.open'] } },
  }));
  const host = hostWith([{ pluginId: 'apps', name: 'Apps', personal: true, enabled: true,
    ui: { contributions: rows } }]);
  assert.equal(host.MAX_SIDEBAR_APPS, 3);
  const visible = await host.contributions('workspace.navigation', {});
  assert.equal(visible.length, 3);
  assert.deepEqual(visible[0].source.bridge.capabilities,
    ['context.read', 'conversation.open']);

  const shell = read('components/workspace/workspace-shell.js');
  const css = read('components/workspace/workspace-shell.css');
  assert.doesNotMatch(shell, /contributions\('workspace\.navigation'/);
  assert.doesNotMatch(shell, /PluginUIHost\.openContribution/);
  // The fixed Applications navigation icon is not an injected app shortcut.
  assert.doesNotMatch(shell, /\bws-rail-app(?!-icon\b)|data-rail-app-index/);
  assert.doesNotMatch(shell, /ipcRenderer|postMessage/);
  assert.doesNotMatch(css, /\.ws-rail-apps|\.ws-rail-app-glyph/);
});

test('client host uses isolated preview and task detail owns the extension slot', () => {
  const host = read('components/panels/plugin-ui-host.js');
  const detail = read('components/requirements/requirements-detail.js');
  assert.match(host, /soduWorkAPI\.workPreview/);
  assert.match(host, /sourceType = source\.type \|\| source\.kind/);
  assert.doesNotMatch(host, /<iframe|innerHTML\s*=.*source\.url/);
  assert.match(detail, /PluginUIHost\.contributions\('task\.detail\.tab', \{task: item\}\)/);
  assert.match(detail, /PluginUIHost\.openContribution\(row, \{task: item\}\)/);
  assert.match(detail, /if \(request !== seq \|\| panelRequest !== evidenceRequest \|\| !node\.isConnected\) return;/);
  assert.doesNotMatch(host, /attachTaskDetail|deactivateTaskDetail/);
});

test('interactive plugins are visibly marked and excluded from unattended schedules', () => {
  const cards = read('components/panels/panels-capability-plugins.js');
  const presentation = read('components/panels/plugin-ui-host.js');
  const forward = read('components/panels/panels-forward-plugin.js');
  const schedules = read('components/panels/panels-schedules-methods.js');
  assert.match(cards, /catalogPresentation/);
  assert.match(presentation, /交互插件/);
  assert.match(forward, /交互插件/);
  assert.match(schedules, /!_schHasInteractiveUi\(item\)/);
});
