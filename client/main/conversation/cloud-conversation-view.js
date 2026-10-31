'use strict';

// A passive projection of the existing Hub task, never an executor. Reopening
// a handed-off conversation must not initialize a local model, CLI or SDK.
const stream = require('../pi-session/event-stream');
const windowed = require('../pi-session/snapshot-window');
const outputs = require('../pi-session/outputs');
const journal = require('./task-output-journal');
const toolArgs = require('../../components/shared/execution-tool-args');
const preparation = require('../pi-session/tool-preparation');
const attachmentContract = require('../pi-session/attachment-contract');

function create({ app, ref, record, saved, recordOf = () => record, artifactDirectory: resolvedDirectory }) {
  // Cloud results are always materialized into a private per-conversation
  // cache. Direct cloud sessions use the cache recorded in the view; a local
  // session handed off to the cloud gets `resultCwd` so its original local
  // workspace can never be scanned or reused as remote output.
  const artifactDirectory = () => {
    if (resolvedDirectory) return resolvedDirectory();
    const current = recordOf() || record || {};
    return String(current.resultCwd || (current.entryKind === 'cloud' ? saved.cwd || '' : '') || '');
  };
  const base = saved.snapshot;
  const acc = stream.create(), listeners = new Set(), keys = new Set(), tools = new Set();
  const knownAttachments = new Map();
  for (const message of [...(base.messages || []), base.pendingUser]) {
    if (message?.role !== 'user') continue;
    for (const file of attachmentContract.publicFiles(message.attachments)) {
      if (file.name && !knownAttachments.has(file.name)) knownAttachments.set(file.name, file);
    }
  }
  function displayAttachments(files) {
    return attachmentContract.publicFiles(files, { derivePreviewRef: false }).map(file => {
      const known = knownAttachments.get(file.name);
      if (!known) return file;
      return { ...known, ...file, type: file.type || known.type,
        size: file.size || known.size, previewRef: file.previewRef || known.previewRef };
    });
  }
  const runtimeMessages = require('../agent-runtime/runner-messages').create(acc.state);
  const log = journal.create(app, 'cloud:' + record.transferId);
  let closed = false, cachedSnapshot = null, cachedUi = null, cachedState;
  function apply(row) {
    if (row.kind === 'message') {
      if (keys.has(row.taskOutputKey)) return;
      keys.add(row.taskOutputKey);
      if (row.role === 'user') preparation.clear(acc.state);
      if (row.role === 'user') acc.state.messages.push({ role: 'user', text: row.text,
        attachments: displayAttachments(row.files || []), taskId: row.taskId, taskOutputKey: row.taskOutputKey,
        blocks: [], done: true, scope: stream.SCOPES.NORMAL, sentAt: row.at });
      else {
        const message = acc.appendAssistant(row.text, stream.SCOPES.NORMAL, row.at);
        message.taskId = row.taskId; message.taskOutputKey = row.taskOutputKey;
      }
    } else if (row.kind === 'runtime') {
      if (keys.has(row.taskOutputKey)) return;
      keys.add(row.taskOutputKey);
      const count = acc.state.messages.length;
      runtimeMessages.apply(row.item, String(row.item.full || row.item.text || ''));
      // The ordinary accumulator caches completed message projections. Native
      // usage/final snapshots can amend them after their first visible reply.
      if (acc.state._snapshotCache && (row.item.kind === 'usage' || row.item.done)) {
        acc.state._snapshotCache.messages = new WeakMap();
      }
      for (const message of acc.state.messages.slice(count)) {
        message.taskId = row.taskId; message.taskOutputKey = row.taskOutputKey;
      }
    } else if (row.kind === 'tool') {
      const key = row.event.type + ':' + row.event.toolCallId;
      if (tools.has(key)) return;
      tools.add(key);
      acc.push(row.event.type === 'tool_execution_start'
        ? { ...row.event, args: toolArgs.normalize(row.event) } : row.event);
    }
  }
  log.restore(Number.MAX_SAFE_INTEGER, apply);
  function emit(kind) {
    const snap = handle.uiSnapshot();
    for (const fn of listeners) { try { fn({ kind }, snap); } catch (_) { /* independent view observers */ } }
  }
  function appendRows(rows) {
    if (closed || !rows.length) return;
    // Persist the entire delivered page before advancing the view/cursor. A
    // failed write stays retryable; no timer can lose the final tool receipt.
    log.appendMany(rows.map(row => ({ after: 0, ...row })));
    for (const row of rows) apply(row);
    cachedSnapshot = cachedUi = null;
    emit('task-message');
  }
  const append = row => appendRows([row]);
  function batchRow(operation) {
    const a = operation.args;
    if (operation.method === 'appendTaskMessage') return { kind: 'message', role: a[0], text: a[1],
      files: a[2], taskId: a[3], taskOutputKey: a[4], at: Date.now() };
    if (operation.method === 'appendTaskTool') return { kind: 'tool', event: a[0], taskId: a[1] };
    if (operation.method === 'appendTaskRuntimeEvent') return { kind: 'runtime', item: a[0], taskId: a[1], taskOutputKey: a[2] };
    throw Error('Unknown task output operation');
  }
  const locked = () => ({ ok: false, reason: '这条会话由云端执行，请使用云端会话入口' });
  const taskId = () => recordOf()?.taskId || '';
  const handle = {
    ref, get cwd() { return artifactDirectory(); }, sessionId: record.sessionId, adapterId: saved.adapterId, passiveCloudView: true,
    displayName: base.displayName || saved.adapterId, model: saved.model, ui: {}, intent: '',
    get taskRef() { return taskId(); }, taskTitle: record.title,
    get taskIds() { return taskId() ? [taskId()] : []; },
    get taskBindings() { return taskId() ? [{ taskId: taskId(), title: record.title }] : []; },
    get activeTaskId() { return taskId(); },
    bindTask: async id => id && id === taskId() ? { ok: true } : locked(),
    snapshot() {
      const remoteState = recordOf()?.remoteState || '';
      if (cachedSnapshot && cachedState === remoteState) return cachedSnapshot;
      cachedState = remoteState; cachedUi = null;
      if (/^(completed|done|failed|stopped|cancelled|canceled|error)$/.test(recordOf()?.remoteState || '')) preparation.clear(acc.state);
      const remote = acc.snapshot(), count = (base.messages || []).length;
      const pending = base.pendingUser && !remote.messages.some(row => row.role === 'user') ? [base.pendingUser] : [];
      return cachedSnapshot = { ...base, ...remote, adapterId: saved.adapterId, displayName: base.displayName,
        modelSelection: base.modelSelection, messages: [...(base.messages || []).map(message => message.role === 'user'
          ? { ...message, attachments: displayAttachments(message.attachments) } : message),
          ...pending.map(message => message.role === 'user'
            ? { ...message, attachments: displayAttachments(message.attachments) } : message), ...remote.messages],
        turnMetrics: [...(base.turnMetrics || []), ...(remote.turnMetrics || []).map(row => ({ ...row,
          fromMessage: row.fromMessage + count + pending.length, toMessage: row.toMessage + count + pending.length }))],
        tools: [...(base.tools || []), ...remote.tools.map(row => ({ ...row, after: Number(row.after || 0) + count + pending.length }))],
        toolPreparations: ['running', 'queued'].includes(recordOf()?.remoteState)
          ? (remote.toolPreparations || []).map(row => ({ ...row, after: row.after + count + pending.length })) : [],
        execution: { configured: false, visible: false, queue: [] }, status: 'idle' };
    },
    uiSnapshot(options) {
      const snapshot = handle.snapshot();
      const { messageLimit, toolLimit } = windowed.limits(options);
      const key = messageLimit + ':' + toolLimit;
      if (!cachedUi || cachedUi.key !== key) cachedUi = { key, value: windowed.limitSnapshot(snapshot, options) };
      return cachedUi.value;
    },
    toolDetail(id) { return require('../pi-session/tool-detail').find(acc.state.tools, id) ||
      require('../pi-session/tool-detail').find(base.tools, id); },
    appendTaskBatch(operations) {
      const seen = new Set();
      const rows = operations.map(batchRow).filter(row => {
        const key = row.kind === 'tool' ? row.event.type + ':' + row.event.toolCallId : row.taskOutputKey;
        const existing = row.kind === 'tool' ? tools : keys;
        const token = row.kind + ':' + key;
        if (existing.has(key) || seen.has(token)) return false;
        seen.add(token); return true;
      });
      appendRows(rows);
    },
    status: () => recordOf()?.remoteState || 'idle',
    inFlight: () => ['running', 'queued'].includes(recordOf()?.remoteState), goalView: () => null,
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    historyRow() { return { id: record.sessionId, ref, title: record.title, cwd: '',
      workspaceName: '云端环境', workspaceLabel: '云端环境', location: 'cloud', locationMode: 'remote', cloud: true,
      adapterId: saved.adapterId, at: Date.now(), taskId: taskId(), taskIds: handle.taskIds }; },
    appendTaskMessage(role, text, files, taskId, taskOutputKey) {
      if (keys.has(taskOutputKey)) return;
      append({ kind: 'message', role, text, files, taskId, taskOutputKey, at: Date.now() });
    },
    appendTaskTool(event, taskId) {
      if (tools.has(event.type + ':' + event.toolCallId)) return;
      append({ kind: 'tool', event, taskId });
    },
    appendTaskRuntimeEvent(item, taskId, taskOutputKey) {
      if (keys.has(taskOutputKey)) return;
      append({ kind: 'runtime', item, taskId, taskOutputKey });
    },
    outputs: () => outputs.list(artifactDirectory(), 0), outputSnapshot: () => outputs.scan(artifactDirectory(), 0),
    outputSnapshotAsync: () => outputs.scanAsync(artifactDirectory(), 0),
    submit: () => ({ accepted: false, result: locked() }), send: locked, cancel: locked,
    selectModel: locked, setAccessPolicy: locked, setThinkingMode: locked,
    continueGoal: locked, disableGoal: locked, updateQueue: locked,
    close() { closed = true; listeners.clear(); },
  };
  return handle;
}

module.exports = { create };
