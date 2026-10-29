'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const loadTrace = (sandbox) => {
  vm.runInNewContext(read('components/panels/task-trace-approval.js'), sandbox);
  vm.runInNewContext(read('components/panels/task-trace-view.js'), sandbox);
};

test('work-directory copy falls back when the browser clipboard rejects access', async () => {
  const calls = [];
  const area = { value: '', style: {}, setAttribute() {}, focus() {}, select() {},
    remove() { calls.push(['removed']); } };
  const sandbox = { window: {}, navigator: { clipboard: { writeText: async () => { throw Error('permission denied'); } } },
    document: { createElement: () => area, body: { appendChild: node => calls.push(['attached', node]) },
      execCommand: name => { calls.push(['command', name]); return true; } } };
  const value = 'C:/工作成果/交付文件';
  vm.runInNewContext(read('components/panels/task-trace-execution-details.js'), sandbox);
  assert.equal(await sandbox.window.TaskTraceExecutionDetails.copyText(value), true);
  assert.equal(area.value, value);
  assert.equal(calls[0][0], 'attached');
  assert.deepEqual(calls.slice(1), [['command', 'copy'], ['removed']]);
});

test('task route uses distinct completed, current, waiting and failed tones', () => {
  const css = read('components/panels/task-trace-view.css');
  const done = css.slice(css.indexOf('.tfd-route li.is-ok button>i{'),
    css.indexOf('.tfd-route li.is-ok b{'));
  assert.ok(done.includes('background:var(--bg-0)'));
  assert.ok(css.includes('.tfd-route li.is-run button>i,.tfd-route li.is-current button>i'));
  assert.ok(css.includes('.tfd-route li.is-wait button>i,.tfd-route li.is-warn button>i'));
  assert.ok(css.includes('.tfd-route li.is-bad button>i'));
});

test('task execution details and evidence groups are collapsed by default', () => {
  const source = read('components/panels/task-trace-view.js');
  assert.ok(source.includes('data-tfd-open="approvals"><summary>'));
  assert.ok(source.includes('data-tfd-open="deployments"><summary>'));
  assert.ok(source.includes('data-tfd-open="ai-sessions"><summary>'));
  // Collapse unselected node details and expand the selected node by default.
  assert.ok(source.includes('data-tfd-open="' + "' + esc(key) + '" + '"\''));
  assert.ok(source.includes("(current ? ' open' : '')"));
});

test('AI workflow stages disclose requested and actual agent routes including fallback', () => {
  const source = read('components/panels/task-trace-view.js');
  const css = read('components/panels/task-trace-view.css');
  assert.ok(source.includes('计划执行'));
  assert.ok(source.includes('实际执行'));
  assert.ok(source.includes('executor.fallbackReason'));
  assert.ok(css.includes('.tfd-executor{'));
});

test('workflow handoff shows typed sources without rendering upstream payloads', () => {
  const sandbox = { window: {} };
  vm.runInNewContext(read('components/panels/task-trace-execution-details.js'), sandbox);
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
  const html = sandbox.window.TaskTraceExecutionDetails.handoffHtml({ input: {
    contextSnapshot: {
      mode: 'declared', checksum: '1234567890abcdef', truncated: false,
      references: [{ key: 'approvedSpec', fromNode: 'analyze', outputKey: 'requirements' }],
    },
    resolvedInputs: { approvedSpec: {
      available: true, sourceNode: 'analyze', outputKey: 'requirements', kind: 'file',
      label: '已批准需求', value: 'secret-path.md', content: 'must-not-render',
    } },
  } }, { esc });
  assert.match(html, /UPSTREAM HANDOFF/);
  assert.match(html, /已批准需求/);
  assert.match(html, /analyze → requirements/);
  assert.doesNotMatch(html, /secret-path|must-not-render/);
});

test('standard gate renders blockers, requirements and screenshot evidence', () => {
  const sandbox = { window: {}, console };
  loadTrace(sandbox);
  const html = sandbox.window.TaskTraceView.gateHtml({
    schemaVersion: 'soduwork.gate/1.1', title: 'UAT gate',
    subject: { artifactSeq: 2, fingerprint: 'abc123', environmentName: 'Trial' },
    criteria: [{ label: 'Sharing works' }],
    requirements: [{ label: 'Health check', satisfied: true },
      { label: 'Screenshot', satisfied: false }],
    evidence: [{ kind: 'image', isImage: true, title: 'Homepage proof',
      url: '/api/v1/attachments/proof', size: 2048,
      verification: { state: 'unverified' } }],
    readiness: { canApprove: false, blockers: ['Screenshot'], evidenceCount: 1 },
  });
  assert.match(html, /tfd-gate is-blocked/);
  assert.match(html, /tfd-evidence-gallery/);
  assert.match(html, /<img[^>]+attachments\/proof/);
  assert.match(html, /Sharing works/);
  assert.match(html, /Screenshot/);
  assert.match(html, /待验证/);
});

test('task view keeps only the current pending approval in context', () => {
  const sandbox = { window: {}, console };
  loadTrace(sandbox);
  const html = sandbox.window.TaskExecutionJourney.html({
    task: { id: 'task-current' }, runs: [], stages: [], phases: [], deployments: [],
    ai: [], execution: { sessions: [] }, artifacts: [], attachments: [], timeline: [],
    delivery: { schemaVersion: 'soduwork.delivery/1', state: 'waiting_human', blockers: [
      { action: 'approval', title: '等待当前审批', detail: '请确认固定版本' }],
      complete: false, canComplete: false, authority: 'workflow', artifact: {} },
    approvals: [
      { id: 'approval-old', status: 'approved', action: 'review',
        confirmation: { title: '历史审批' } },
      { id: 'approval-current', status: 'pending', action: 'review', required: 1,
        confirmation: { title: '当前版本验收', lockedArtifact: { seq: 3, commit: 'abcdef123456789' } },
        gate: { schemaVersion: 'soduwork.gate/1', readiness: { canApprove: true }, requirements: [] },
      },
    ],
  }, { variant: 'task' });
  assert.match(html, /tfd-inline-approval/);
  assert.match(html, /data-tfd-approval-id="approval-current"/);
  assert.match(html, /当前版本验收/);
  assert.doesNotMatch(html, /approval-old/);
  assert.doesNotMatch(html, /历史审批/);
  assert.doesNotMatch(html, /data-tfd-open="approvals"><summary>/);
});

test('high-risk inline approval requires explicit version verification', () => {
  const sandbox = { window: {}, console };
  loadTrace(sandbox);
  const html = sandbox.window.TaskExecutionJourney.html({
    task: { id: 'task-deploy' }, runs: [], stages: [], phases: [], deployments: [],
    ai: [], execution: { sessions: [] }, artifacts: [], attachments: [], timeline: [],
    delivery: { schemaVersion: 'soduwork.delivery/1', state: 'waiting_human', blockers: [],
      complete: false, canComplete: false, authority: 'workflow', artifact: {} },
    approvals: [{ id: 'approval-deploy', status: 'pending', action: 'deploy', required: 1,
      confirmation: { title: '发布授权', lockedArtifact: { seq: 4, checksum: 'checksum-123456' } },
      gate: { schemaVersion: 'soduwork.gate/1', readiness: { canApprove: true }, requirements: [] } }],
  }, { variant: 'task' });
  assert.match(html, /data-tfd-approval-verify/);
  assert.match(html, /data-tfd-approval-action="approve" disabled/);
  assert.match(html, /data-tfd-approval-action="reject"/);
});

test('task view follows the active node approval when multiple approvals are pending', () => {
  const sandbox = { window: {}, console };
  loadTrace(sandbox);
  const html = sandbox.window.TaskExecutionJourney.html({
    task: { id: 'task-multi-approval' }, runs: [{ state: 'waiting_human', workflow: [], nodes: [],
      currentNode: 'uat' }], stages: [{ id: 'uat', key: 'uat', type: 'approval',
      state: 'waiting_human', output: { requestId: 'approval-uat' } }], phases: [], deployments: [],
    ai: [], execution: { sessions: [] }, artifacts: [], attachments: [], timeline: [],
    delivery: { schemaVersion: 'soduwork.delivery/1', state: 'waiting_human', blockers: [],
      complete: false, canComplete: false, authority: 'workflow', artifact: {} },
    approvals: [
      { id: 'approval-uat', status: 'pending', action: 'uat',
        confirmation: { title: '环境验收' }, gate: { readiness: { canApprove: true } } },
      { id: 'approval-merge', status: 'pending', action: 'merge',
        confirmation: { title: '合并授权' }, gate: { readiness: { canApprove: true } } },
    ],
  }, { variant: 'task' });
  assert.match(html, /data-tfd-approval-id="approval-uat"/);
  assert.match(html, /环境验收/);
  assert.doesNotMatch(html, /合并授权/);
});

test('全链路里的会话只给重点进展，不再复制整条事件流', () => {

  const details = fs.readFileSync(path.join(__dirname, '../components/panels/task-trace-execution-details.js'), 'utf8');
  const view = fs.readFileSync(path.join(__dirname, '../components/panels/task-trace-view.js'), 'utf8');
  assert.match(details, /tfd-session-digest/);
  assert.doesNotMatch(details, /tfd-session-events/);
  // Execution views omit the redundant conversation group.
  assert.match(view, /if \(opts\.variant === 'execution'\) return '';/);
  // Make URL and change-reference evidence directly inspectable through links.
  assert.match(view, /const body = item\.url\s*\? '<a href="' \+ esc\(fullUrl\(item\)\)/);
});

test('需求详情的旅程不再渲染第二张决策卡（决策唯一面）', () => {
  /*
   * Suppress duplicate actionable approval cards when the host already presents the same
   * decision, preventing conflicting submissions and inconsistent labels.
   */
  const sandbox = { window: {}, console };
  loadTrace(sandbox);
  const trace = {approvals: [{id: 'gate-1', status: 'pending', action: 'review',
    confirmation: {title: '验收交付结果'}}]};
  const withCard = sandbox.window.TaskTraceView.html(trace, {variant: 'task'});
  assert.match(withCard, /tfd-inline-approval/);
  const suppressed = sandbox.window.TaskTraceView.html(trace,
    {variant: 'task', suppressInlineApproval: true});
  assert.doesNotMatch(suppressed, /tfd-inline-approval/);
  assert.doesNotMatch(suppressed, /data-tfd-approval-action/);
  // Retain lifecycle and delivery evidence in the read-only trace.
  assert.match(suppressed, /tfd-shell/);
  // Only the host with an existing decision card opts into suppression; chat and execution surfaces keep their entry points.
  const detail = fs.readFileSync(path.join(__dirname, '../components/requirements/requirements-detail.js'), 'utf8');
  assert.match(detail, /suppressInlineApproval: true/);
});
