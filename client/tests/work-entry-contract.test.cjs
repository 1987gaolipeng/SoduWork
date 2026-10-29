'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

test('Issue command and all historical slash aliases resolve to the same form and preserve user detail', () => {
  const context = { window: { addEventListener() {} }, document: { addEventListener() {} } };
  vm.runInNewContext(read('components/panels/plugin-ui-host.js'), context);
  context.PluginUIHost = context.window.PluginUIHost;
  vm.runInNewContext(read('components/panels/work-entry-sheet.js'), context);
  for (const name of ['需求', '新建需求', '创建需求', '沉淀需求', 'Bug', '工单', '改进', 'issue', 'request', '任务', '创建任务', '安排执行', '派活', 'task', 'ISSUE']) {
    const command = context.PluginUIHost.commandFromText('/' + name + ' 保留这段请求');
    assert.equal(command?.actionId, 'work.requirement.create', name);
    assert.equal(command.text, '保留这段请求');
  }
  assert.equal(context.PluginUIHost.commandFromText('普通对话'), null);
  assert.equal(context.PluginUIHost.commandFromText('/需求转任务'), null);
});

test('both desktop entries use only the unified task backed board and common materials form', () => {
  for (const entry of ['desk.html', 'index.html']) {
    const html = read(entry);
    for (const script of ['core/requirements.js', 'requirements-board.js', 'requirements-detail.js',
      'plugin-ui-host.js', 'work-entry-sheet.js', 'conversation-attachments.js']) assert.ok(html.includes(script));
    assert.match(html, /requirements-board\.css/);
    assert.doesNotMatch(html, /panels-work-items|work-delivery-sheet|work-entry-attachments|task-board\.css/);
  }
  assert.doesNotMatch(read('api.js'), /getWorkItems|createWorkItemDelivery|\/work-items/);
});

test('one form retains materials and explicitly separates team visibility from execution rights', () => {
  const entry = read('components/panels/work-entry-sheet.js');
  const detail = read('components/requirements/requirements-detail.js');
  assert.match(entry, /ConversationAttachments\.create/);
  assert.match(entry, /attachments\.files\(\)/);
  assert.match(entry, /visibility: s\.visibility \|\| 'related'/);
  assert.match(detail, /task\.canViewExecution !== false/);
  assert.match(detail, /editVersion = editing \? task\.requirementVersion : null/);
  assert.match(detail, /requirementVersion: editing \? editVersion : task\.requirementVersion/);
  assert.match(detail, /migratedRequirements/);
  assert.match(detail, /openTaskAttachment/);
  const store = read('core/store.js');
  assert.match(store, /hasTaskDeletePermission\(current\)\|\|current\.maintenanceBlocked===true/);
  const permission = store.match(/function hasTaskDeletePermission\(t\)\{[^\n]+\}/)?.[0];
  assert.ok(permission, 'deletion must use the Hub permission projection');
  const allowed = require('node:vm').runInNewContext('(' + permission + ')');
  assert.equal(allowed({readOnly: true, canDeleteRequirement: true}), true);
  assert.equal(allowed({canDeleteRequirement: false, canEditRequirement: true}), false);
  assert.equal(allowed({canEditRequirement: true}), true);
  assert.equal(allowed({readOnly: false}), false, 'execution access alone is not deletion authority');
});

test('slash work refinement preserves typed request and material context without a conversion stage', () => {
  const chat = read('components/panels/panels-chat.js');
  const actions = read('components/panels/panels-chat-work-actions.js');
  const sheet = read('components/panels/work-entry-sheet.js');
  assert.match(chat, /conversationContext: (?:ctx\.)?_workConversationContext/);
  assert.match(actions, /text: typed,[\s\S]*parseText: detail/);
  assert.match(actions, /conversationContext\.attachments/);
  assert.match(sheet, /s\.parseText \|\| s\.text/);
  assert.match(sheet, /refineTail = work\.catch/);
  assert.match(sheet, /request !== scope/);
  assert.doesNotMatch(actions + sheet, /WorkDeliverySheet|createWorkItemDelivery/);
});
