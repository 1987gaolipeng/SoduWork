'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

function api() {
  const context = { SoduWorkAPI: { attachmentUrl: (item) => item.url || '' } };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(read('components', 'panels', 'task-trace-rail-view.js'), context);
  return context.TaskTraceRailView;
}

const trace = {
  schemaVersion: '1.0',
  summary: {
    totalStages: 3, completedStages: 1, currentStageId: 'build',
    currentStageName: '\u5b9e\u73b0\u529f\u80fd', currentState: 'running',
    nextAction: '\u5b8c\u6210\u524d\u540e\u7aef\u81ea\u6d4b',
  },
  card: { taskId: 'task-1', executor: { assignee: 'Codex', host: 'office-pc' } },
  stages: [{
    id: 'spec', key: 'spec', name: '\u7406\u89e3\u9700\u6c42', state: 'succeeded', evidence: [],
  }, {
    id: 'build', key: 'build', name: '\u5b9e\u73b0\u529f\u80fd', state: 'running',
    executor: { assignee: 'Codex', host: 'office-pc' },
    evidence: [{ title: '\u524d\u7aef\u622a\u56fe', summary: '\u684c\u9762\u7aef\u9a8c\u8bc1', isImage: true,
      url: 'https://example.invalid/evidence.png', producer: { name: 'Browser Use' } }],
  }, {
    id: 'release', key: 'release', name: '\u53d1\u5e03\u9a8c\u8bc1', state: 'planned', evidence: [],
  }],
  delivery: {
    schemaVersion: '1.0', state: 'running', complete: false,
    manifest: { primary: [{ name: 'result.docx', url: 'https://example.invalid/result.docx' }], supporting: [] },
    blockers: [], artifact: { kind: 'office' },
  },
};

test('AI execution rail keeps only live status, actual route, evidence and delivery', () => {
  const html = api().html(trace, { selectedStageId: 'build' });
  assert.match(html, /class="trv-now is-live"/);
  assert.equal((html.match(/data-tfd-stage=/g) || []).length, 3);
  assert.match(html, /\u524d\u7aef\u622a\u56fe/);
  assert.match(html, /Browser Use/);
  assert.match(html, /result\.docx/);
  assert.doesNotMatch(html, /tfd-loop|TASK JOURNEY|\u5ba1\u8ba1\u65f6\u95f4\u7ebf|\u5386\u53f2\u6267\u884c\u8bb0\u5f55/);
});

test('modern conversation loads the shared evidence rail, without the retired AI detail page', () => {
  const view = read('components', 'panels', 'task-trace-view.js');
  assert.match(view, /opts\.variant === 'execution' && opts\.compact && window\.TaskTraceRailView/);
  for (const entry of ['index.html', 'desk.html']) {
    const html = read(entry);
    assert.match(html, /task-trace-rail-view\.css/);
    assert.match(html, /task-trace-rail-view\.js/);
    assert.match(html, /task-execution-stream\.js/);
    assert.doesNotMatch(html, /panels-desk-session\.js/);
  }
});
