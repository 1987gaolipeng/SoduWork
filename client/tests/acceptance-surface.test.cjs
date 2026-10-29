/* Enforce one review decision surface in task details without conversation-navigation review actions. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname, name), 'utf8');

test('acceptance decision has exactly one surface: the acceptance card in the requirement drawer', () => {
  const detail = read('../components/requirements/requirements-detail.js');
  const view = read('../components/requirements/requirements-view.js');
  // Do not restore the removed conversation-based review action.
  assert.doesNotMatch(detail, /data-rq-approval>/);
  assert.doesNotMatch(detail, /source:\s*'approval'/);
  // TaskTraceApproval renders and binds cards with authoritative Hub evidence and permissions.
  assert.match(detail, /TaskTraceApproval\.html\(/);
  assert.match(detail, /TaskTraceApproval\.bind\(/);
  assert.match(detail, /data-rq-approval-card/);
  // The board opens that same drawer; it must not create a second direct
  // SoduWork acceptance action or session.
  assert.doesNotMatch(view, /data-rq-acceptance/);
  assert.match(view, /核对成果并选择验收方式/);
});

test('approval inbox rows open the requirement details, not the conversation', () => {
  const inbox = read('../components/panels/task-approval-inbox.js');
  assert.doesNotMatch(inbox, /openTaskConversation/);
  assert.match(inbox, /RequirementsDetail\.open\(/);
  assert.match(inbox, /打开需求详情，核对后继续/);
  assert.doesNotMatch(inbox, /在对话中查看证据并处理/);
});

test('approval notification entry with a task routes to the requirement details', () => {
  const bridge = read('../core/win-bridge.js');
  const entry = bridge.slice(
    bridge.indexOf('global.openApprovalsEntry'),
    bridge.indexOf('global.openHistoryEntry'));
  assert.doesNotMatch(entry, /openTaskConversation/);
  assert.match(entry, /RequirementsDetail\.open\(/);
  assert.match(entry, /routeToWorkWindow\('history', \{ requirementId/);
});

test('requirement pool hides the acceptance action after this user has decided', () => {
  const view = read('../components/requirements/requirements-view.js');
  assert.match(view, /const actionable = pending && \(!pending\.status \|\| pending\.status === 'pending'\) && !pending\.myDecision/);
  assert.match(view, /const acceptance = actionable \|\| global\.TaskTraceApproval/);
});

test('conversation entries stay device-gated and labelled as device-local', () => {
  assert.match(read('../components/requirements/requirements-view.js'), /打开执行会话（仅本机）/);
  assert.match(read('../components/requirements/requirements-detail.js'), /打开执行会话（仅本机）/);
  // Remove stale Hub receipts so cross-device fallback can actually take effect.
  const nav = read('../core/task-conversation-navigation.js');
  assert.match(nav, /conversationTurn: null/);
  assert.match(nav, /resolved\.source === 'approval' && resolved\.focusApproval/);
});

test('review rejection keeps one simple return path and supports reference files', () => {
  const card = read('../components/panels/task-trace-approval.js');
  // Default rejection to shared rework with feedback and keep reference materials separate from deliverables.
  assert.doesNotMatch(card, /data-tfd-rework value=/);
  // The optional attachment ID list is sent with a rejection so the server can
  // distinguish same-named rework files from delivery artifacts.
  assert.match(card, /decideApproval\(id, decision, text(?:,\s*undefined,\s*reworkAttachmentIds)?\)/);
  assert.match(card, /data-tfd-rework-file/);
  assert.match(card, /不会计入交付产物/);
  assert.match(card, /review \? '<div class="tfd-inline-rework-files"/);

  const api = read('../api.js');
  assert.match(api, /async decideApproval\(requestId, decision, note, rework(?:, reworkAttachmentIds)?\)/);
  assert.match(api, /uploadApprovalReworkMaterial/);
  assert.match(api, /uploadTaskReworkMaterial/);

  const approvals = read('../../hub-backend/app/api/approvals.py');
  assert.match(approvals, /rework-materials/);
  assert.match(approvals, /request\.action != "review"/);
  assert.match(approvals, /role == "rework_input"/);
  const tasks = read('../../hub-backend/app/api/tasks.py');
  assert.match(tasks, /role == "rework_input"/);
  assert.match(tasks, /source_ref == "task-rework:"/);
});

test('需求池验收卡不展示过程文件选择，验收会话仍保留协议兼容能力', () => {
  const card = read('../components/panels/task-trace-approval.js');
  const turn = read('../main/pi-session/acceptance-turn.js');
  const backend = read('../../hub-backend/app/services/task_acceptance_review.py');
  assert.doesNotMatch(card, /data-tfd-acceptance-files-panel|选择过程文件|data-tfd-acceptance-file/);
  assert.match(turn, /optionalAttachments/);
  assert.match(turn, /requestedOptional/);
  assert.match(backend, /optionalAttachments/);
});

test('同人验收复用普通执行会话时只放行显式验收上下文', () => {
  const nav = read('../core/task-conversation-navigation.js');
  const task = read('../components/panels/chat-task-controller.js');
  const sessions = read('../components/panels/chat-session-controller.js');
  const ipc = read('../main/pi-session/ipc.js');
  assert.match(nav, /reuseExecutionSession/);
  assert.match(nav, /acceptanceExecutionSession = false/);
  assert.match(task, /acceptanceExecutionSession/);
  assert.match(sessions, /acceptanceExecutionSession: true/);
  assert.match(ipc, /acceptanceExecutionSession !== true/);
});

test('工作区切换到聊天页时不丢失同人验收的临时标记与过程文件选择', () => {
  const compose = read('../components/panels/panels-compose.js');
  const count = (pattern) => (compose.match(pattern) || []).length;
  // Existing-chat and fresh-chat handoffs must preserve the same acceptance
  // contract; dropping either path leaves the composer blank for one entry.
  assert.equal(count(/reuseExecutionSession: q\.reuseExecutionSession === true/g), 2);
  assert.equal(count(/acceptanceExecutionSession: q\.acceptanceExecutionSession === true/g), 2);
  assert.equal(count(/acceptanceAttachmentIds: Array\.isArray\(q\.acceptanceAttachmentIds\)/g), 2);
});

test('需求池在另一会话完成验收后刷新原对话任务与审批快照', () => {
  const chat = read('../components/panels/panels-chat.js');
  const event = chat.slice(chat.indexOf("soduwork-work-task-change"), chat.indexOf("async function _pullOuts"));
  assert.match(event, /detail\.type !== 'task\.updated'/);
  assert.match(event, /_bindCollaborationTask\(id/);
  assert.match(event, /_clearFinishedAcceptanceContext\(id, detail\.task/);
  assert.match(event, /_loadCollabTask\(id\)/);
  const renderer = read('../components/panels/chat-message-renderer.js');
  assert.match(renderer, /entry\.task\?\.reviewedAt/);
});

test('hub decide endpoint honours rework=false by returning the task to the backlog', () => {
  const endpoint = read('../../hub-backend/app/api/approvals.py');
  // Missing or true flags enable automatic rework; only explicit false returns to pending.
  assert.match(endpoint, /if body\.get\("rework"\) is False:/);
  assert.match(endpoint, /task_rework\.return_to_backlog\(/);
  assert.match(endpoint, /task_rework\.resume_after_rejection\(/);
  // Explain the destination in execution-device review notifications.
  assert.match(endpoint, /已退回待开始，回需求池等人工重新安排/);

  const rework = read('../../hub-backend/app/services/task_rework.py');
  assert.match(rework, /async def return_to_backlog\(/);
  assert.match(rework, /"mode": "backlog", "started": True/);
  // During workflow ownership, record evidence without forcing task state.
  assert.match(rework, /review\.backlog_skipped_engine/);
});

test('creator direct acceptance reuses the same card face; quick buttons stay retired', () => {
  const detail = read('../components/requirements/requirements-detail.js');
  // Prevent duplicate quick-review actions from returning to the drawer.
  assert.doesNotMatch(detail, /data-rq-review\b/);
  assert.doesNotMatch(detail, /data-rq-reject/);
  assert.doesNotMatch(detail, /确认交付/);
  // Creator review without a Hub approval uses synthetic direct:{taskId} and injected directApi.
  // Keep one review presentation and action vocabulary across both paths.
  assert.match(detail, /id: 'direct:' \+ task\.id/);
  assert.match(detail, /directApi: \{/);
  const card = read('../components/panels/task-trace-approval.js');
  // Direct cards skip nonexistent approvalDetail requests.
  assert.match(card, /startsWith\('direct:'\)/);
   // Route Hub decisions through decideApproval and direct decisions through directApi with shared validation and draft behavior.
  assert.match(card, /directApi\.approve\(text\)/);
   assert.match(card, /directApi\.reject\(text(?:,\s*reworkAttachmentIds)?\)/);
});

test('waiting hint names the designated approver instead of offering a second surface', () => {
  const detail = read('../components/requirements/requirements-detail.js');
  // Show the assigned reviewer instead of allowing creators to bypass another person's approval.
  assert.match(detail, /R\.waitingOn\(task, ctx\)/);
  assert.match(detail, /由 ' \+ esc\(waitingNames\.join\('、'\)\) \+ ' 确认/);
  assert.match(detail, /normalized && !waitingNames\.length && global\.TaskTraceApproval/);
  const coreFile = read('../core/requirements.js');
  assert.match(coreFile, /function waitingOn\(/);
  const board = read('../components/requirements/requirements-board.js');
  assert.match(board, /waiting\.set\(String\(row\.taskId\), row\.waitingOn/);
  const inbox = read('../components/panels/task-approval-inbox.js');
  assert.match(inbox, /mineWaiting/);
  assert.match(inbox, /function waiting\(\)/);
});
