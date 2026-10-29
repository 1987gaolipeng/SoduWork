'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const handoff = require('../main/conversation/cloud-handoff');
const links = require('../components/panels/chat-output-links.js');

test('cloud output attachment rows accept deliverables only and reject traversal', () => {
  const rows = handoff._outputAttachmentRows([
    { id: 'old', filename: 'site/index.html', role: 'output', size: 1, createdAt: 1,
      url: '/api/v1/attachments/old?ticket=x' },
    { id: 'new', filename: 'site/index.html', role: 'output', size: 2, createdAt: 2,
      url: '/api/v1/attachments/new?ticket=x' },
    { id: 'evidence', filename: 'screenshots/check.png', role: 'verification', size: 2,
      url: '/api/v1/attachments/evidence?ticket=x' },
    { id: 'escape', filename: '../outside.txt', role: 'output', size: 2,
      url: '/api/v1/attachments/escape?ticket=x' },
  ]);
  assert.deepEqual(rows.map(row => [row.id, row.filename]), [['new', 'site/index.html']]);
});

test('materialized cloud files merge remote metadata without retaining task download identity', async () => {
  const local = { path: 'C:/soduwork/cloud-cache/site/index.html', relative: 'site/index.html', name: 'index.html',
    artifactId: 'artifact:site/index.html', size: 42, at: 1 };
  const result = await links.load(
    { outputs: async () => ({ ok: true, artifacts: [local], cloudOutputs: [{
      taskId: 'task-1', attachmentId: 'attachment-1', relative: 'site/index.html', size: 42, artifactId: local.artifactId }] }) },
    'cloud-ref', ['task-1'], [],
    { listAttachments: async () => [{ id: 'attachment-1', taskId: 'task-1', filename: 'site/index.html', role: 'output', size: 42, createdAt: 3,
      url: '/api/v1/attachments/attachment-1?ticket=x' }] },
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].taskId, undefined);
  assert.equal(result[0].cloudTaskId, 'task-1');
  assert.equal(result[0].remoteMaterialized, true);
  assert.equal(result[0].artifactId, 'artifact:site/index.html');
});

test('supporting cloud files are promoted from the trusted local index when listed by the task', async () => {
  const result = await links.load(
    { outputs: async () => ({ ok: true,
      artifacts: [{ path: 'C:/soduwork/cloud-cache/index.html', relative: 'index.html', name: 'index.html', artifactId: 'artifact:index' }],
      files: [
        { path: 'C:/soduwork/cloud-cache/index.html', relative: 'index.html', name: 'index.html', artifactId: 'artifact:index' },
        { path: 'C:/soduwork/cloud-cache/js/main.js', relative: 'js/main.js', name: 'main.js' },
      ], cloudOutputs: [{ taskId: 'task-1', attachmentId: 'attachment-1', relative: 'js/main.js', size: 3 }] }) },
    'cloud-ref', ['task-1'], [],
    { listAttachments: async () => [{ id: 'attachment-1', taskId: 'task-1', filename: 'js/main.js', role: 'output', size: 3,
      url: '/api/v1/attachments/attachment-1?ticket=x' }] },
  );
  const file = result.find(row => row.relative === 'js/main.js');
  assert.equal(file.remoteMaterialized, true);
  assert.equal(file.taskId, undefined);
  assert.equal(file.cloudTaskId, 'task-1');
});

test('cloud approval rendering suppresses stale task decisions for every committed-cloud projection', () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const list = { innerHTML: '', dataset: {}, children: [], addEventListener() {}, querySelectorAll: () => [] };
  const el = { querySelector: selector => selector === '#nchatList' ? list : null };
  let approvalRenders = 0;
  const sandbox = {
    ChatContextMeter: { create: () => ({ _ctxHtml: () => '' }) },
    ChatScrollFollow: { create: () => ({ _ensureScrollFollow: () => null, _nearBottom: () => true,
      _updateScrollButton() {}, _preserveReadingPosition: () => () => {} }) },
    ChatTools: { goalProgressRows: () => [], appendTimeline() {}, appendGoalProgress() {}, paintSendButton() {} },
    TaskTraceApproval: { html() { approvalRenders++; return '<section data-fixture-decision="1"></section>'; } },
  };
  sandbox.window = sandbox;
  for (const file of ['chat-markdown.js', 'chat-acceptance-results.js', 'chat-message-renderer.js']) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels', file), 'utf8'), sandbox);
  }
  const entry = { taskId: 'task-cloud', task: { title: 'Cloud result' },
    trace: { approvals: [{ id: 'stale-approval', action: 'execute', status: 'pending' }] } };
  const ctx = { _ref: 'cloud-approval-fixture', esc: value => String(value), _mount: () => el,
    _snap: {}, _sessionOptions: {}, _pending: '', _pendingAttachmentNames: [], _outs: [],
    _collabTasks: new Map([[entry.taskId, entry]]), _collabEntries: () => [entry],
    _renderQueue() {}, _syncThinkingClock() {}, _thinkingStatusHtml: () => '',
    _renderTaskStartPrompt() {}, _syncSlowStatusTicker() {}, _collabEntryStatus: () => 'running' };
  const renderer = sandbox.ChatMessageRenderer.create(ctx);
  const cases = [
    ['local conversation', {}, {}, {}, true],
    ['uncommitted handoff', { cloudHandoff: { phase: 'preparing' } }, {}, {}, true],
    ['committed handoff', { cloudHandoff: { phase: 'committed' } }, {}, {}, false],
    ['nested restored snapshot', { snapshot: { cloudHandoff: { phase: 'committed' } } }, {}, {}, false],
    ['cloud execution flag', { execution: { cloud: true } }, {}, {}, false],
    ['cloud execution mode', { execution: { mode: 'cloud' } }, {}, {}, false],
    ['manual acceptance view', {}, { acceptanceSession: true }, {}, false],
    ['execution acceptance view', {}, { acceptanceExecutionSession: true }, {}, false],
    ['task reviewed before trace refresh', {}, {}, { reviewedAt: '2026-10-18T23:00:00Z' }, false],
    ['legacy reviewed task', {}, {}, { reviewed_at: '2026-10-18T23:00:00Z' }, false],
  ];
  for (const [name, snapshot, options, task, visible] of cases) {
    ctx._snap = { status: 'idle', messages: [], tools: [], ...snapshot };
    ctx._sessionOptions = options; entry.task = { title: 'Cloud result', ...task };
    const previous = approvalRenders;
    renderer._render();
    assert.equal(approvalRenders - previous, visible ? 1 : 0, name + ': decision renderer must match current authority');
    assert.equal(list.innerHTML.includes('data-fixture-decision'), visible, name + ': stale actions must not remain in the transcript');
  }
});

test('unmaterialized cloud attachments are blocked from the native download opener', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require('node:path').join(__dirname, '../components/panels/panels-chat.js'), 'utf8');
  assert.match(source, /cloudPending/);
  assert.match(fs.readFileSync(require('node:path').join(__dirname, '../components/panels/chat-output-links.js'), 'utf8'), /file\.cloudPending/);
});

test('cloud conversations are excluded from the local acceptance queue history', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require('node:path').join(__dirname, '../components/panels/chat-send-queue.js'), 'utf8');
  assert.match(source, /const cloudConversation = ctx\._snap\?\.cloudHandoff\?\.phase === ['"]committed['"]/);
  assert.match(source, /filter\(entry => !cloudConversation/);
});

test('matching filename and size alone cannot claim a local file is a downloaded cloud attachment', async () => {
  const local = { artifactId: 'local', path: 'C:/fixture/report.md', relative: 'report.md', size: 4 };
  for (const cloudOutputs of [[], [{ taskId: 'another-task', attachmentId: 'remote', relative: 'report.md', size: 4, artifactId: 'local' }]]) {
    const result = await links.load({ outputs: async () => ({ ok: true, artifacts: [local], cloudOutputs }) }, 'ref', ['task'], [],
      { listAttachments: async () => [{ id: 'remote', taskId: 'task', filename: 'report.md', role: 'output', size: 4 }] });
    assert.equal(result.length, 2);
    assert.equal(result.find(row => row.artifactId === 'local').remoteMaterialized, undefined);
    assert.equal(result.find(row => row.attachmentId === 'remote').taskId, 'task');
  }
});

test('pending cloud file clicks share materialization, return a trusted batch and retry failures', async () => {
  const file = { taskId: 'task', attachmentId: 'remote', cloudPending: true, name: 'report.md' };
  const artifact = { artifactId: 'local', relative: 'report.md', cloudTaskId: 'task', remoteAttachmentId: 'remote' };
  let calls = 0, finish;
  const api = { cloud: { materialize: () => { calls++; return new Promise(resolve => { finish = resolve; }); } } };
  const one = links.materialize(file, api, 'ref'), two = links.materialize(file, api, 'ref');
  assert.equal(calls, 1);
  finish({ ok: true, artifact, artifacts: [artifact] });
  const local = await one;
  assert.deepEqual(await two, local);
  assert.equal(local.cloudPending, undefined); assert.equal(local.taskId, undefined);
  assert.equal(local.remoteAttachmentId, 'remote'); assert.deepEqual(local.materializedArtifacts, [artifact]);
  api.cloud.materialize = async () => ({ ok: false, reason: 'fixture rejected' });
  await assert.rejects(links.materialize(file, api, 'ref'), /fixture rejected/);
  api.cloud.materialize = async () => ({ ok: true, artifact });
  assert.equal((await links.materialize(file, api, 'ref')).artifactId, 'local');
});

test('a Git summary cannot revive source files as cards from older remote attachment rows', async () => {
  const result = await links.load({ outputs: async () => ({ ok: true, artifacts: [],
    files: [{ artifactId: 'source', relative: 'src/main.js' }], delivery: { presentation: 'summary', items: [] } }) },
  'ref', ['task'], [], { listAttachments: async () => { throw Error('summary does not need remote files'); } });
  assert.deepEqual(result, []);
});
