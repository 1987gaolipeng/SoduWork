'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'components', 'panels', 'task-trace-view.js'), 'utf8');

function view() {
  const context = {
    SoduWorkI18n: {getLocale: () => 'zh-CN'},
    SoduWorkAPI: {attachmentUrl: () => ''},
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.TaskTraceView;
}

test('audit timeline sorts millisecond receipts and translates conversation turns', () => {
  const html = view().html({
    schemaVersion: '1.0',
    card: {taskId: 'task-1'},
    timeline: [
      {id: 'queued', kind: 'conversation.turn', detail: {state: 'queued'}, actor: 'executor', at: 1761481800000},
      {id: 'done', kind: 'conversation.turn', detail: {state: 'completed'}, actor: 'executor', at: 1761481860000},
    ],
  });
  assert.match(html, /执行本轮已完成/);
  assert.match(html, /执行已排队/);
  assert.doesNotMatch(html, /conversation\.turn/);
  assert.ok(html.indexOf('执行本轮已完成') < html.indexOf('执行已排队'));
  const localTime = new Date(1761481860000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  assert.ok(html.includes(localTime), 'show the millisecond receipt in the device timezone');
});
