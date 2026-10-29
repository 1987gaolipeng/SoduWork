const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

test('协作任务会话保留单消息流并绑定任务上下文', () => {
  const chat = read('components/panels/panels-chat.js');
  const compose = read('components/panels/panels-compose.js');
  const shell = read('components/workspace/workspace-shell.js');
  const desk = read('desk.html');
  assert.match(chat, /nchat-collab-slot/);
  assert.match(chat, /eventScope: \{ conversationId:/);
  assert.match(chat, /ChatCollaboration\.mergeEvents/);
  assert.match(chat, /bindTask: _bindCollaborationTask/);
  assert.match(compose, /q\.taskId/);
  assert.match(compose, /NativeChat\.bindTask/);
  assert.match(shell, /WorkspaceHost\.open\('create', \{[\s\S]*taskId: task\.id,[\s\S]*taskSession: true/);
  assert.match(desk, /chat-collaboration\.css/);
  assert.match(desk, /chat-collaboration\.js/);
});

test('协作状态和事件归并覆盖普通、等待、失败和完成态', () => {
  const source = read('components/panels/chat-collaboration.js');
  const window = {};
  vm.runInNewContext(source, { window }, { filename: 'chat-collaboration.js' });
  const view = window.ChatCollaboration;
  assert.equal(view.statusLabel('doing'), '执行中');
  assert.equal(view.statusLabel('waiting-user'), '等待用户');
  assert.equal(view.statusLabel('failed'), '失败');
  assert.equal(view.statusLabel('completed'), '已完成');
  assert.equal(view.phaseOf({}, 'waiting'), 'verify');
  assert.equal(view.phaseOf({}, 'failed'), 'failed');
  assert.equal(view.phaseOf({}, 'doing'), 'execute');
  const rows = view.mergeEvents(
    [{ eventSequence: 1, text: '旧事件' }],
    [{ eventSequence: 1, text: '重放事件' }, { eventSequence: 3, text: '后续事件' }, { eventSequence: 2, text: '中间事件' }],
  );
  assert.equal(JSON.stringify(Array.from(rows, (item) => item.eventSequence)), '[1,2,3]');
  assert.equal(rows[0].text, '重放事件');
});

test('协作工作台由真实任务快照渲染，并支持收起与信息入口', () => {
  const source = read('components/panels/chat-collaboration.js');
  const host = {
    innerHTML: '',
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  const window = {};
  vm.runInNewContext(source, { window }, { filename: 'chat-collaboration.js' });
  const view = window.ChatCollaboration.create({ host });
  view.render({
    collaboration: true, taskId: 'task-1', adapterId: 'codex', status: 'running',
    phase: 'execute', task: {
      id: 'task-1', title: '修复任务派活', description: '验证任务可以在当前会话中执行',
      creatorName: '张三', projectName: 'SoduWork',
    }, execution: {
      agentName: 'Codex', model: 'gpt-5.6', runnerClientId: 'DESKTOP-01',
    },
  });
  assert.doesNotMatch(host.innerHTML, /ncollab-pin-trigger|ncollab-task-rail/);
  assert.doesNotMatch(host.innerHTML, /ncollab-scene-crew|ncollab-inspector|data-collab-pin="task"/);
  view.setPin('dossier');
  assert.match(host.innerHTML, /任务详情|任务目标|验收标准|执行配置|流程进度|门禁与发布|成果与证据/);
  assert.equal((host.innerHTML.match(/data-collab-pin=/g) || []).length, 0);
  view.setCollapsed(true);
  assert.match(host.innerHTML, /class="ncollab ncollab-scene ncollab-anchor is-collapsed"/);
});

test('任务会话控制器按 conversation/task/run 作用域去重并拒绝串流', () => {
  const source = read('components/panels/chat-task-session.js');
  const window = {};
  vm.runInNewContext(source, { window }, { filename: 'chat-task-session.js' });
  const session = window.ChatTaskSession.create({ conversationId: 'conversation-1' });
  session.attach({ id: 'task-1', title: '任务', status: 'todo' },
    { conversationId: 'conversation-1' });
  assert.equal(session.snapshot().taskId, 'task-1');
  assert.equal(session.snapshot().status, 'todo');
  assert.equal(session.applyEvent({
    conversationId: 'conversation-2', taskId: 'task-1', eventSequence: 1,
  }), false);
  assert.equal(session.applyEvent({
    conversationId: 'conversation-1', taskId: 'task-1', runId: 'run-1',
    eventSequence: 1, snapshot: { status: 'running', execution: { runId: 'run-1' } },
  }), true);
  assert.equal(session.applyEvent({
    conversationId: 'conversation-1', taskId: 'task-1', runId: 'run-1',
    eventSequence: 1, snapshot: { status: 'running' },
  }), false);
  assert.equal(session.snapshot().eventCursor, 1);
  assert.equal(session.applyEvent({
    conversationId: 'conversation-1', taskId: 'task-1', runId: 'run-1',
    eventSequence: 3, snapshot: { status: 'completed', execution: { runId: 'run-1' } },
  }), true);
  assert.equal(session.snapshot().status, 'completed');
  assert.equal(session.applyEvent({
    conversationId: 'conversation-1', taskId: 'task-1', runId: 'run-1',
    eventSequence: 2, snapshot: { status: 'running' },
  }), false);
  assert.equal(session.snapshot().status, 'completed');
});

test('协作会话索引只保存非敏感元数据', () => {
  const source = read('components/panels/chat-collaboration-store.js');
  const values = {};
  const window = { localStorage: {
    getItem: (key) => values[key] || null,
    setItem: (key, value) => { values[key] = value; },
  } };
  vm.runInNewContext(source, { window }, { filename: 'chat-collaboration-store.js' });
  window.ChatCollaborationStore.bind('conversation-1', {
    taskId: 'task-1', title: '演示任务', prompt: '不要保存我', credentials: 'secret',
  });
  const saved = JSON.parse(values.soduwork_work_collaboration_sessions_v1)['conversation-1'];
  assert.equal(saved.taskId, 'task-1');
  assert.equal(Object.prototype.hasOwnProperty.call(saved, 'prompt'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(saved, 'credentials'), false);
});

test('task-created collaboration is named and listed before the first message', () => {
  const chat = read('components/panels/panels-chat.js');
  const spec = read('main/conversation/session-spec.js');
  const ipc = read('main/pi-session/ipc.js');
  const session = read('main/pi-session/session.js');
  assert.match(chat, /taskRef: id/);
  assert.match(chat, /taskTitle: title/);
  assert.match(chat, /ChatChrome\.resume\(_collaborationTask\.title\)/);
  assert.match(chat, /WorkspaceShell\.upsertChat/);
  assert.match(spec, /taskTitle: text\(input\.taskTitle, 200\)/);
  assert.match(ipc, /taskTitle: spec\.taskTitle/);
  assert.match(session, /opts\.taskRef \? String\(opts\.taskTitle/);
  assert.match(session, /taskId: handle\.taskRef, collaboration: Boolean\(handle\.taskRef\)/);
});

console.log('collaboration session contract: 4 suites passed');
