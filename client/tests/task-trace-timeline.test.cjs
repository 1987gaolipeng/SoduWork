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

test('activity translates internal events, statuses and service actors without rewriting user text', () => {
  const html = view().timelineHtml([
    {kind: 'release.candidate', actor: 'agent:conversation'},
    {kind: 'release.approval_requested', actor: 'system'},
    {kind: 'ai.artifacts', detail: {files: ['a.md', 'b.html']}},
    {kind: 'task.execution_started', detail: {from: 'doing', to: 'done'}},
    {kind: 'new.event_type', detail: {note: '<script>keep original note</script>'}},
  ], {embedded: true, comments: [{authorName: 'Alice', body: 'doing is our project name', createdAt: 1}]});
  for (const label of ['交付版本已生成', '已发起审批', '交付文件已关联', '进行中 → 已完成', 'AI 助手', '系统', '讨论留言']) assert.ok(html.includes(label), label);
  assert.doesNotMatch(html, /agent:conversation|release[. ·]+candidate|new.event_type|<script>/);
  assert.match(html, /doing is our project name/);
  assert.match(html, /&lt;script&gt;keep original note/);
});

test('automatic acceptance labels require a matching recorded request, version, actor and verdict', () => {
  const approval = {kind: 'release.approved', actor: 'Alice', detail: {action: 'review', requestId: 'r', versionId: 'v', note: 'AI 验收：human supplied text'}};
  const report = {kind: 'artifact.auto_reviewed', actor: 'Alice', detail: {requestId: 'r', versionId: 'v', verdict: 'approved'}};
  assert.match(view().timelineHtml([approval, report]), /自动验收通过/);
  for (const mismatch of [
    {...report, actor: 'Bob'}, {...report, detail: {...report.detail, requestId: 'other'}},
    {...report, detail: {...report.detail, versionId: 'old'}}, {...report, detail: {...report.detail, verdict: 'pending'}},
  ]) assert.doesNotMatch(view().timelineHtml([approval, mismatch]), /自动验收通过/);
  assert.doesNotMatch(view().timelineHtml([approval]), /自动验收通过|人工通过/);
  assert.match(view().timelineHtml([{...approval, kind: 'release.rejected'}, {...report, detail: {...report.detail, verdict: 'rejected'}}]), /自动验收未通过/);
});

test('long explanations start collapsed but remain complete and all history stays accessible', () => {
  const note = 'Review notes '.repeat(50) + '<final evidence>';
  const rows = Array.from({length: 45}, (_, i) => ({id: i, kind: 'created', at: 1000 + i, detail: {note: 'event-' + i}}));
  const html = view().timelineHtml([...rows, {kind: 'release.approved', detail: {note}, at: 2000}], {embedded: true});
  assert.match(html, /<details class="tfd-event-note" data-tfd-open="[^"]+">/);
  assert.ok(html.includes(note.replace('<final evidence>', '&lt;final evidence&gt;')));
  assert.equal((html.match(/<li>/g) || []).length, 46);
  assert.ok(html.indexOf('event-44') < html.indexOf('event-0'));
  assert.equal(view().timelineHtml([]), '');
  assert.match(view().timelineHtml([], {embedded: true}), /暂无活动记录/);
});

test('a host can omit duplicate activity without hiding other evidence or affecting other hosts', () => {
  const trace = {card: {taskId: 't'}, timeline: [{kind: 'created'}]};
  assert.doesNotMatch(view().html(trace, {suppressTimeline: true}), /tfd-timeline/);
  assert.match(view().html(trace), /tfd-timeline/);
});
