'use strict';

// Independent history contains public messages and tool receipts, never SDK
// credentials, executable configuration, or implicit permission grants.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const MAX_BYTES = 128 * 1024 * 1024;
const EMPTY_JOURNAL = crypto.createHash('sha256').digest('hex');
const failure = (code, message) => Object.assign(Error(message), { code });
const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
const { unresolvedTools } = require('./tool-terminal-receipts.cjs');
const runnerHistory = require('../agent-runtime/runner-dispatch-absence.cjs');
function distinguishPiCalls(entries) {
  const used = new Set(), declarations = new Set(), current = new Map(), original = new Map();
  let reused = false;
  for (const { message, data } of entries) {
    if (message?.toolCallId) used.add(message.toolCallId);
    if (data?.event?.toolCallId) used.add(data.event.toolCallId);
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const call of message.content) {
      if (call?.type !== 'toolCall') continue;
      const id = call.id || call.toolCallId;
      if (!id) continue;
      if (declarations.has(id)) reused = true;
      declarations.add(id); used.add(id);
    }
  }
  if (!reused) return original;
  declarations.clear();
  for (const [index, entry] of entries.entries()) {
    const message = entry.message;
    if (message?.role === 'assistant') for (const call of Array.isArray(message.content) ? message.content : []) {
      if (call?.type !== 'toolCall') continue;
      const id = call.id || call.toolCallId;
      if (!id) continue;
      if (declarations.has(id)) {
        let key = 'pi-history:' + index + ':' + id;
        while (used.has(key)) key += ':';
        used.add(key); current.set(id, key); original.set(key, id);
        if (call.id) call.id = key;
        if (call.toolCallId) call.toolCallId = key;
      }
      declarations.add(id);
    }
    // Pi's activity accumulator keys by ID. Scope later declarations before
    // replay so neither the prior terminal nor the later receipt can cross calls.
    const result = message?.role === 'toolResult' ? message : null;
    const event = entry.customType === 'soduwork.task.tool' ? entry.data?.event : null;
    for (const value of [result, event]) if (value && current.has(value.toolCallId))
      value.toolCallId = current.get(value.toolCallId);
  }
  return original;
}
function piTools(entries, snapshot) {
  const ledger = new Map(), epoch = require('./message-time').epoch;
  let after = -1;
  for (const [index, entry] of entries.entries()) {
    const message = entry.type === 'message' ? entry.message : null;
    const at = epoch(message?.completedAt) || epoch(message?.timestamp) || epoch(entry.timestamp);
    if (['user', 'assistant'].includes(message?.role)) after++;
    if (message?.role === 'assistant' && !['error', 'aborted', 'length'].includes(message.stopReason)) {
      // Failed or truncated argument drafts never reach SDK tool execution.
      for (const [block, call] of (Array.isArray(message.content) ? message.content : []).entries()) {
        if (call?.type !== 'toolCall') continue;
        const id = String(call.id || call.toolCallId || 'unidentified:' + index + ':' + block);
        ledger.set(id, { id, name: call.name || '', args: call.arguments || call.args || {},
          after: Math.max(0, after), startedAt: at, updatedAt: at, endedAt: 0, settled: false });
      }
    } else if (message?.role === 'toolResult') {
      const id = String(message.toolCallId || 'unidentified-result:' + index), previous = ledger.get(id);
      ledger.set(id, { ...previous, id, name: message.toolName || previous?.name || '',
        startedAt: previous?.startedAt || 0, updatedAt: at, endedAt: at, settled: true });
    }
    const event = entry.customType === 'soduwork.task.tool' && entry.data?.event;
    if (event && /^tool_execution_(start|update|end)$/.test(event.type)) {
      const id = String(event.toolCallId || 'unidentified-event:' + index), previous = ledger.get(id);
      const terminal = event.type === 'tool_execution_end';
      ledger.set(id, { ...previous, id, name: event.toolName || previous?.name || '', args: event.args || previous?.args || {},
        after: previous?.after ?? Math.max(0, after), startedAt: previous?.startedAt || at,
        updatedAt: at, endedAt: terminal ? at : 0, settled: terminal });
    }
  }
  for (const item of ledger.values()) if (!item.settled && !snapshot.tools.some(tool => tool.id === item.id)) {
    snapshot.tools.push({ id: item.id, callId: item.id, name: item.name, args: item.args,
      state: 'unknown', result: '', after: item.after });
  }
  for (const tool of snapshot.tools) {
    const item = ledger.get(String(tool.id));
    // Archive replay uses the live accumulator, whose wall clock is not an
    // historical fact. Missing native timestamps stay explicitly unknown.
    tool.startedAt = item?.startedAt || 0; tool.updatedAt = item?.updatedAt || 0; tool.endedAt = item?.endedAt || 0;
  }
}
function publicSnapshot(value = {}) {
  const snapshot = { messages: (value.messages || []).map(message => ({ ...message,
    text: typeof message.text === 'string' && message.text ? message.text : (message.blocks || [])
      .filter(block => block.kind === 'text').map(block => block.text || '').join('\n') })), tools: value.tools || [] };
  for (const name of ['goal', 'goalState', 'qualityPhase', 'qualityReason', 'activePlugins', 'turnMetrics', 'historyRecovery'])
    if (value[name] !== undefined) snapshot[name] = value[name];
  if (value.modelSelection?.name) snapshot.modelSelection = { name: value.modelSelection.name };
  return JSON.parse(JSON.stringify(snapshot));
}
function extendsPiArchive(bytes, revision, previous) {
  if (!previous || previous.revision === revision) return true;
  const hash = crypto.createHash('sha256');
  if (Number.isSafeInteger(previous.byteLength))
    return previous.byteLength > 0 && previous.byteLength < bytes.length &&
      hash.update(bytes.subarray(0, previous.byteLength)).digest('hex') === previous.revision;

  // Older replicas stored the whole-file digest without the byte count. An
  // unchanged old JSONL can end before or after its final line terminator.
  let start = 0;
  for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
    const crlf = end > start && bytes[end - 1] === 13;
    hash.update(bytes.subarray(start, crlf ? end - 1 : end));
    if (hash.copy().digest('hex') === previous.revision) return true;
    if (crlf) hash.update(bytes.subarray(end - 1, end));
    hash.update(bytes.subarray(end, end + 1));
    if (hash.copy().digest('hex') === previous.revision) return true;
    start = end + 1;
  }
  return false;
}
async function pi(app, session, id, guard, previous, row, { retired = false } = {}) {
  const found = await session.historyEntry(app, id, { strict: true }); guard(found?.entry);
  if (!found?.ok || !found.entry?.path) throw failure(found?.notFound ? 'NATIVE_HISTORY_MISSING' : 'NATIVE_HISTORY_UNAVAILABLE',
    found?.reason || '原生会话暂时无法读取');
  if (found.entry.id !== id) throw failure('NATIVE_HISTORY_UNAVAILABLE', '原生会话标识不匹配');
  const file = await require('../app-readonly-history.cjs').plainArchivePath(path.join(app.getPath('userData'), 'pi-agent'), found.entry.path);
  const before = await fs.stat(file);
  if (before.size > MAX_BYTES) throw failure('HISTORY_TOO_LARGE', '历史超过本机完整保存上限，原档案保持不变');
  const bytes = await fs.readFile(file); guard();
  const entries = [];
  for (const line of bytes.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); }
    catch (_) { throw failure('NATIVE_HISTORY_UNAVAILABLE', '原生档案尚未完整写入，请稍后重试'); }
    if (entries.length % 500 === 0) { await new Promise(resolve => setImmediate(resolve)); guard(); }
  }
  if (entries[0]?.type !== 'session' || entries[0]?.id !== id) throw failure('NATIVE_HISTORY_UNAVAILABLE', '原生档案标识不匹配');
  if (stamp(before) !== stamp(await fs.stat(file))) throw failure('NATIVE_HISTORY_CHANGED', '会话正在更新，请稍后重试');
  // Authorization must describe the bytes being replayed, not only the earlier
  // directory summary. A task binding may have been appended between those reads.
  const binding = require('../pi-session/session')._taskBindingFromEntries(entries);
  const owners = entries.filter(entry => entry?.type === 'custom' && entry.customType === 'soduwork.work-entry' &&
    entry.data?.version === 1).map(entry => entry.data.owner);
  guard({ id, ...binding, ...(owners.length ? { historyNativeOwners: owners } : {}) });
  const revision = crypto.createHash('sha256').update(bytes).digest('hex');
  if (!extendsPiArchive(bytes, revision, previous))
    throw failure('NATIVE_HISTORY_DIVERGED', '原生会话记录与已保存的完整历史不一致，已保留本机副本。请恢复原档后继续');
  const original = distinguishPiCalls(entries);
  const acc = require('../pi-session/event-stream').create();
  const turns = new Map();
  require('../pi-session/history-seed').seed(acc, { state: {}, sessionManager: { getEntries: () => entries } },
    { completeHistory: true, nativeAgentId: 'pi', onUserMessage(entry, userMessageIndex, message, sequenceIndex) {
      const turnId = message.submissionId || 'pi-history:' + id + ':' + (entry.id || sequenceIndex);
      turns.set(entry, { turnId, userMessageIndex });
    } });
  guard();
  const snapshot = publicSnapshot(acc.state); piTools(entries, snapshot);
  if (original.size) {
    for (const tool of snapshot.tools) if (original.has(tool.id)) tool.callId = original.get(tool.id);
    for (const message of snapshot.messages) for (const block of message.blocks || []) {
      const call = block.toolCall;
      if (original.has(call?.id)) call.id = original.get(call.id);
      if (original.has(call?.toolCallId)) call.toolCallId = original.get(call.toolCallId);
    }
  }
  // The retired segment's indexed native cwd, not a newer logical chat's cwd,
  // must agree with the JSONL before a write can be verified on disk.
  const workspace = retired ? { id: row.id, cwd: found.entry.cwd } : row;
  return { snapshot, source: { id, adapterId: 'pi', revision, byteLength: bytes.length, artifactEvidenceVersion: 2 },
    ...(retired || id === row.id && !row.deliveryWorkspaceKey
      ? require('./pi-history-artifacts.cjs').evidence(entries, workspace, revision, turns) : {}) };
}
function canonicalJson(value) {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
function runnerConflict() {
  return failure('NATIVE_HISTORY_DIVERGED', '执行记录与已保存的完整历史不一致，已保留本机副本。请恢复原档后继续');
}
function matchesLegacyRunner(id, adapterId, snapshot, messages, tools, candidates) {
  // Old replicas have only a cursor. Compare the public events at that exact
  // boundary, before a later delta or terminal event can modify the projection.
  const prefix = id + ':', oldMessages = snapshot.messages.filter(item => typeof item.id === 'string' && item.id.startsWith(prefix));
  const oldTools = snapshot.tools.filter(item => typeof item.id === 'string' && item.id.startsWith(prefix + prefix));
  const nativeSource = require('./native-agent-source.cjs');
  const sameProjection = (item, old) => canonicalJson(old.sourceAgent ?
    { ...item, ...nativeSource.fields(item, adapterId) } : item) === canonicalJson(old);
  if (messages.length !== oldMessages.length || tools.length !== oldTools.length ||
      messages.some((item, i) => !sameProjection(item, oldMessages[i]))) return false;
  const offset = oldMessages.length ? snapshot.messages.indexOf(oldMessages[0]) : oldTools[0]?.after || 0;
  for (const [index, item] of tools.entries()) {
    const old = { ...oldTools[index] }, current = { ...item, id: prefix + item.id, after: offset + item.after };
    // Projection can supplement these exact pending tools with independent
    // image / cancelled-write receipts. The current read verifies those anew.
    if (item.state === 'running' && candidates.get(item.callId) &&
        (old.state === 'done' || old.state === 'cancelled' && old.cancelReason === 'access-change')) {
      old.state = 'running'; delete old.cancelReason; delete old.isError;
    }
    if (!sameProjection(current, old)) return false;
  }
  return true;
}
async function runner(runtime, id, adapterId, guard, previousToolReceipts, previousSource, previousSnapshot) {
  const messages = [], tools = [], streams = new Map(), pendingCalls = new Map();
  const planRows = [], messageCounts = [];
  const candidates = new Map(), localToolReceipts = [];
  const qwen = adapterId === 'qwen';
  const journal = (adapterId === 'codex-harness' || qwen) ? crypto.createHash('sha256') : null;
  const evidence = crypto.createHash('sha256');
  const checkpoint = previousSource ? Number(previousSource.revision) : -1;
  let prefixMatches = true;
  function compareCheckpoint() {
    prefixMatches = previousSource.journalDigest ? evidence.copy().digest('hex') === previousSource.journalDigest
      : previousSnapshot && matchesLegacyRunner(id, adapterId, previousSnapshot, messages, tools, candidates);
  }
  let after = 0, size = 0, target, localWorkspace;
  while (true) {
    let reply;
    try { reply = await runnerHistory.historyPage(runtime, { ref: id, since: after, limit: 200 }, 15000); }
    catch (error) {
      if (error.code === 'RUNNER_HISTORY_BUSY') throw error;
      throw failure('NATIVE_HISTORY_UNAVAILABLE', '执行底座暂时无法读取完整历史');
    }
    guard();
    if (after === 0 && runnerHistory.missingArchive(reply, id))
      throw failure('NATIVE_HISTORY_MISSING', '本机执行底座已确认原始历史不存在');
    if (!reply?.ok || reply.data?.ok === false || !Array.isArray(reply.data?.items))
      throw failure('NATIVE_HISTORY_UNAVAILABLE', '执行底座暂时无法读取完整历史');
    const data = reply.data, events = data.items;
    if (data.ref !== undefined && data.ref !== id) throw failure('NATIVE_HISTORY_UNAVAILABLE', '执行底座历史标识不匹配');
    // Admission status can briefly stand in for an existing journal before
    // launch. A queue receipt cannot establish truncation of the archive.
    if (checkpoint > 0 && data.admissionKey && data.seq === 0 && !events.length)
      throw failure('NATIVE_HISTORY_UNAVAILABLE', '执行记录正在等待队列恢复，请稍后再试');
    // Runner metadata binds this directory to the original desktop allocation.
    // Omit the receipt when pages disagree or the run has no terminal window.
    const workspace = data.ref === id && data.workDir && data.ended && ['done', 'failed', 'stopped', 'interrupted'].includes(data.status)
      ? { id, cwd: data.workDir, taskId: data.taskId, started: data.firstStarted || data.started, ended: data.ended } : null;
    if (after === 0) localWorkspace = workspace;
    else if (JSON.stringify(localWorkspace) !== JSON.stringify(workspace)) localWorkspace = null;
    const latest = Number(data.seq ?? data.last ?? events.at(-1)?.seq ?? after);
    if (!Number.isSafeInteger(latest) || latest < after) throw failure('NATIVE_HISTORY_UNAVAILABLE', '执行底座历史游标无效');
    // A reclaimed journal reports only this page's last cursor. Active runs
    // additionally expose a stable high-water mark across the entire read.
    const highWater = data.seq == null ? null : latest;
    if (target === undefined) target = highWater;
    if (highWater !== target) throw failure('NATIVE_HISTORY_CHANGED', '会话正在更新，请稍后重试');
    const previous = after;
    for (const item of events) {
      if (after === checkpoint) compareCheckpoint();
      if (!item || !Number.isSafeInteger(item.seq) || item.seq !== after + 1 || item.seq > latest)
        throw failure('NATIVE_HISTORY_UNAVAILABLE', '执行底座历史事件游标无效');
      const serialized = canonicalJson(item);
      after = item.seq; size += Buffer.byteLength(serialized);
      journal?.update(JSON.stringify(item)).update('\n');
      evidence.update(serialized).update('\n');
      if (size > MAX_BYTES) throw failure('HISTORY_TOO_LARGE', '历史超过本机完整保存上限');
      const text = String(item.full ?? item.text ?? '');
      const callId = typeof item.callId === 'string' ? item.callId : '';
      const callKey = callId && JSON.stringify([item.round || item._round || 1, item.seg || 1, callId]);
      if (item.kind === 'do' && item.tool === 'Plan') {
        const args = item.arguments;
        const legacy = item.callId === '' && item.toolKind === '' && !item._sourceId && !item.sourceId &&
          typeof args?.command === 'string' && args.command === text && Object.keys(args).length === 1;
        planRows.push({ segment: item.seg, offset: item._stream === 'out' ? item._streamEnd : null,
          toolIndex: tools.length, command: legacy ? args.command : '' });
      }
      const archivedPlan = adapterId === 'codex' && item.kind === 'do' && item.tool === 'todo_list' && callId &&
        (item._sourceId || item.sourceId) === 'item.completed:' + callId + ':0';
      if (journal && callId && ['do', 'out'].includes(item.kind)) {
        // A repeated call ID or a native result disqualifies a supplemental receipt.
        let candidate = null;
        if (!candidates.has(callId) && item.kind === 'do' && (item._sourceId || item.sourceId) === 'tool_use:' + callId + ':0') {
          if (qwen && item.toolKind === 'edit' && item.tool === 'WriteFile') candidate = callId;
          if (!qwen && item.toolKind === 'read' && typeof item.arguments?.path === 'string' && item.arguments.path)
            candidate = { callId, path: item.arguments.path };
        }
        candidates.set(callId, candidate);
      }
      if (item.kind === 'user') {
        pendingCalls.clear();
        messages.push({ id: id + ':' + item.seq, role: 'user', text,
          sentAt: item.sentAt || item.at, attachments: item.attachments || [], submissionId: item.submissionId || '' });
      } else if (archivedPlan || item.kind === 'step' && item.tool === 'Plan') {
        if (text) messages.push({ id: id + ':' + item.seq, role: 'assistant', blocks: [{ kind: 'text', text }], done: true });
      } else if (['say', 'text', 'thinking'].includes(item.kind)) {
        const key = [item.round || item._round || 1, item.seg || 1, item.kind, item.streamId || item.seq].join(':');
        let message = streams.get(key);
        if (!message) { message = { id: id + ':' + key, role: 'assistant', blocks: [{ kind: item.kind === 'thinking' ? 'thinking' : 'text', text: '' }] };
          messages.push(message); streams.set(key, message); }
        if (text || item.delta) message.blocks[0].text = item.delta ? message.blocks[0].text + text : text;
        message.done = item.done !== false; message.completedAt = item.completedAt || item.at;
      } else if (item.kind === 'do') {
        const name = item.tool || 'command';
        if (callKey && pendingCalls.get(callKey)?.name === name) continue;
        const tool = { id: id + ':' + item.seq, callId, name, args: item.arguments || { command: text },
          state: 'running', result: '', after: Math.max(0, messages.length - 1) };
        messageCounts.push(messages.length);
        tools.push(tool);
        if (callKey) pendingCalls.set(callKey, tool);
      } else if (item.kind === 'out') {
        // Diagnostics have no call identity. Native IDs can restart in the next process or turn.
        let tool = pendingCalls.get(callKey);
        pendingCalls.delete(callKey);
        if (!tool) {
          tool = { id: id + ':' + item.seq, callId, name: item.tool || 'output', args: {}, after: Math.max(0, messages.length - 1) };
          messageCounts.push(messages.length); tools.push(tool);
        }
        Object.assign(tool, { result: text, state: item.state === 'cancelled' ? 'cancelled' : item.isError ? 'error' : 'done', isError: !!item.isError });
        if (item.state === 'cancelled' && !item.isError && ['access-change', 'output-limit'].includes(item.cancelReason))
          tool.cancelReason = item.cancelReason;
      }
    }
    if (target !== null && after === target) break;
    if (target === null && after === latest && events.length === 0) break;
    if (after === previous) throw failure('NATIVE_HISTORY_UNAVAILABLE', '执行底座历史分页未前进');
  }
  if (after === checkpoint) compareCheckpoint();
  // Only a stable, completely paged journal can establish divergence.
  if (after < checkpoint || !prefixMatches) throw runnerConflict();
  const unresolved = tools.filter(tool => tool.state === 'running' && candidates.get(tool.callId));
  const journalDigest = unresolved.length ? journal.digest('hex') : '';
  for (let start = 0; start < unresolved.length; start += 1024) {
    const batch = unresolved.slice(start, start + 1024);
    const calls = batch.map(tool => candidates.get(tool.callId));
    // Older or stopped Runners cannot supply additional proof. Their saved
    // transcript stays viewable with these operations explicitly unresolved.
    let reply;
    try { reply = await runtime.rpc(qwen ? 'runtime.history.qwenCancelledWrites' : 'runtime.history.imageReceipts', { ref: id, revision: after, calls }, 15000); }
    catch (_) { /* Supplemental native evidence is optional. */ }
    guard();
    if (!reply?.ok || reply.data?.ref !== id || reply.data.revision !== after || !Array.isArray(reply.data.callIds)) continue;
    const { callIds, binding, archiveMissing } = reply.data;
    if (archiveMissing !== undefined && (archiveMissing !== true || callIds.length)) continue;
    if (qwen && !(typeof binding === 'string' && /^[a-f0-9]{64}$/.test(binding))) continue;
    const confirmed = new Set(callIds);
    for (const tool of batch) {
      // Include every event, not just the sequence number. A replaced call,
      // result, turn or segment must not inherit an earlier image's receipt.
      const proof = typeof binding === 'string' && /^[a-f0-9]{64}$/.test(binding)
        ? crypto.createHash('sha256').update(JSON.stringify([qwen ? 'qwen-cancelled:' + id : id, binding, journalDigest, tool.id, tool.callId])).digest('hex') : '';
      if (archiveMissing ? proof && previousToolReceipts.has(proof) : confirmed.has(tool.callId)) {
        if (qwen) Object.assign(tool, { state: 'cancelled', cancelReason: 'access-change', isError: false });
        else tool.state = 'done';
        if (proof) localToolReceipts.push(proof);
      }
    }
  }
  // Compare any cursor-only legacy checkpoint above with its original projection
  // before reclassifying verified plan notifications.
  const projected = await require('./legacy-acp-plans.cjs').project(runtime, id, adapterId, after, guard,
    planRows, messages, tools, messageCounts);
  return { snapshot: require('./native-agent-source.cjs').snapshot(projected, adapterId),
    source: { id, adapterId, revision: String(after), journalDigest: evidence.digest('hex') },
    localToolReceipts, localWorkspace };
}
// Older switches omitted "started" on the retired descriptor. An empty
// usage badge alone cannot distinguish an unused selection from a lost turn.
function matchesRetiredPrefix(prefix, snapshot) {
  if (!Array.isArray(prefix?.messages) || !prefix.messages.length || !Array.isArray(prefix.tools) ||
      prefix.messages.length !== snapshot.messages.length || prefix.tools.length !== snapshot.tools.length) return false;
  return prefix.messages.every((old, index) => {
    const current = snapshot.messages[index];
    if (old.role !== current.role) return false;
    if (old.role === 'user') return old.text === current.text && Number.isFinite(old.sentAt) &&
      old.sentAt === current.sentAt && canonicalJson(old.attachments || []) === canonicalJson(current.attachments || []);
    if (old.role !== 'assistant' || !old.sourceAgent?.agentId || old.sourceAgent.agentId !== current.sourceAgent?.agentId ||
        !Array.isArray(old.blocks) || old.blocks.length !== current.blocks?.length) return false;
    return old.blocks.every((block, i) => {
      const native = current.blocks[i];
      if (block.kind !== native.kind || typeof block.text !== 'string' || typeof native.text !== 'string') return false;
      // runner-messages kept only the last 50,000 characters of streamed blocks.
      return ['text', 'thinking'].includes(block.kind) &&
        (block.text === native.text || block.text === native.text.slice(-50000));
    });
  }) && prefix.tools.every((old, index) => {
    const current = snapshot.tools[index], segment = String(current.id).split(':')[0];
    return typeof old.id === 'string' && old.id.startsWith(segment + ':') && !!old.callId &&
      old.callId === current.callId && old.name === current.name && old.state === current.state;
  });
}
async function emptyRunnerSegment(app, runtime, part, source, legacyRetired = false) {
  if ((!legacyRetired && part.started !== false) || !part.nativeDispatchId || part.adapterId === 'pi' ||
      (source && !(source.dormant === true && source.revision === '0' && source.journalDigest === EMPTY_JOURNAL)) ||
      require('../agent-runtime/runner-adapter').runnerRefForDispatch(part.nativeDispatchId) !== part.sessionId) return false;
  if (!await runnerHistory.confirmedAbsent(runtime, part.sessionId, undefined, { reportBusy: true })) return false;
  try { return !await require('./task-output-journal').hasRecordedOutput(app, part.sessionId); }
  catch { return false; }
}
// A recovery can allocate a new segment, then close before its first send.
// The frozen prefix does not certify those retired allocations on a later retry.
async function retiredTailAbsent(app, runtime, parts, firstId, guard) {
  const first = parts.findIndex(part => part.sessionId === firstId);
  if (first < 0) return false;
  runtime ||= require('../runner-runtime');
  for (const part of parts.slice(first)) {
    if (part.adapterId === 'pi' || part.started !== false) return false;
    let reply;
    try { reply = await runnerHistory.historyPage(runtime, { ref: part.sessionId, since: 0, limit: 1 }, 15000); }
    catch { guard(); return false; }
    guard();
    if (!runnerHistory.missingArchive(reply, part.sessionId) ||
        !await emptyRunnerSegment(app, runtime, part)) { guard(); return false; }
    guard();
  }
  return true;
}
async function read({ app, session, row, guard, previousToolReceipts = [], previousSources = [], previousSnapshot,
  mayVerifyLegacyRetired = () => false, runtime = require('../runner-runtime') }) {
  const record = require('./runtime-segments').read(app, row.id);
  const parts = record ? [...record.segments, record.active] : [{ sessionId: row.id, adapterId: row.adapterId || 'pi' }];
  const snapshot = { messages: [], tools: [] }, sources = [], localToolReceipts = [];
  let localWorkspace, localJournal;
  const previous = new Set(previousToolReceipts);
  function verifyManifest() {
    if (record && require('./runtime-segments').read(app, row.id) !== record)
      throw failure('NATIVE_HISTORY_CHANGED', '会话的执行段已变化，请重新读取');
    guard();
  }
  if (record?.deviceHistoryComplete) {
    Object.assign(snapshot, publicSnapshot(record.prefix));
    parts.splice(0, parts.length - 1);
  }
  const prior = new Map(previousSources.map(source => [source.id, source]));
  const nativeParts = [...new Map(parts.map(value => [value.sessionId, value])).values()];
  let firstLegacyEmpty;
  async function unavailable(index, part, cause) {
    await probe({ app, session, row, guard });
    verifyManifest();
    const ordinal = record?.deviceHistoryComplete ? record.segments.length + 1 : index + 1;
    const partial = cause?.code === 'RUNNER_HISTORY_BUSY' ? cause :
      failure('NATIVE_SEGMENT_UNAVAILABLE', '无法核验第 ' + ordinal + ' 个执行段（' +
        part.adapterId + '），已显示可读取的历史。请恢复原档后继续');
    partial.history = { snapshot, coverage: { complete: false, sources, unresolvedTools: unresolvedTools(snapshot) } };
    throw partial;
  }
  // Recovered transcripts freeze retired segments in the trusted prefix. An
  // ordinary manifest must still reference all saved sources in their order.
  if (!record?.deviceHistoryComplete && previousSources.some((source, index) => nativeParts[index]?.sessionId !== source.id))
    throw failure('NATIVE_HISTORY_DIVERGED', '原生会话缺少已保存的执行段，已保留本机副本。请恢复原档后继续');
  for (const [index, part] of nativeParts.entries()) {
    if (part === record?.active && firstLegacyEmpty !== undefined && !matchesRetiredPrefix(record.prefix, snapshot))
      await unavailable(firstLegacyEmpty, nativeParts[firstLegacyEmpty]);
    const source = prior.get(part.sessionId);
    if (source && source.adapterId !== part.adapterId) throw runnerConflict();
    let saved;
    try {
      saved = part.adapterId === 'pi' ? await pi(app, session, part.sessionId, guard, source, row)
        : await runner(runtime, part.sessionId, part.adapterId, guard, previous, source, previousSnapshot);
    } catch (error) {
      if (error.code === 'RUNNER_HISTORY_BUSY') return unavailable(index, part, error);
      if (error.historyAccessFailure || !['NATIVE_HISTORY_MISSING', 'NATIVE_HISTORY_UNAVAILABLE'].includes(error.code)) throw error;
      const legacyRetired = record && !record.deviceShared && !record.deviceHistoryComplete && !record.deviceTransferId &&
        !row.deviceTransferId && nativeParts.length === parts.length && part !== record.active && !Object.hasOwn(part, 'started') &&
        Array.isArray(part.usedHarnesses) && !part.usedHarnesses.length && mayVerifyLegacyRetired();
      let empty = false;
      if (error.code === 'NATIVE_HISTORY_MISSING') {
        try { empty = await emptyRunnerSegment(app, runtime, part, source, legacyRetired); }
        catch (cause) {
          if (cause.code === 'RUNNER_HISTORY_BUSY') return unavailable(index, part, cause);
          throw cause;
        }
      }
      if (empty) {
        guard();
        if (legacyRetired) firstLegacyEmpty ??= index;
        sources.push({ id: part.sessionId, adapterId: part.adapterId, revision: '0',
          journalDigest: EMPTY_JOURNAL, dormant: true });
        continue;
      }
      // An independently saved, complete copy of every native source keeps
      // its existing recovery rules. A previously empty segment has no such copy.
      if (previousSources.length === nativeParts.length && previousSources.every((item, i) =>
        !item.dormant && item.id === nativeParts[i].sessionId && item.adapterId === nativeParts[i].adapterId)) throw error;
      if (!snapshot.messages.length && !snapshot.tools.length) throw error;
      await unavailable(index, part);
    }
    for (const proof of saved.localToolReceipts || []) localToolReceipts.push(proof);
    const offset = snapshot.messages.length;
    snapshot.messages.push(...saved.snapshot.messages);
    snapshot.tools.push(...saved.snapshot.tools.map(tool => ({ ...tool, id: part.sessionId + ':' + tool.id, after: Number(tool.after || 0) + offset })));
    sources.push(saved.source);
    if (saved.source.id === row.id) {
      localWorkspace = saved.localWorkspace;
      localJournal = saved.localJournal;
    }
  }
  verifyManifest();
  return { snapshot, ...(localWorkspace ? { localWorkspace } : {}), ...(localJournal ? { localJournal } : {}), coverage: { complete: true, sources, unresolvedTools: unresolvedTools(snapshot) },
    ...(localToolReceipts.length ? { localToolReceipts } : {}) };
}
// A complete device transcript can keep the first segment only in its
// prefix. Its original local bytes are optional and never extend coverage.
function retiredPiOrigin(record) {
  if (!record?.deviceHistoryComplete || record.originAdapter !== 'pi' || record.deviceTransferId ||
      !record.prefix?.messages?.length || record.active.sessionId === record.id) return null;
  return record.segments[0]?.adapterId === 'pi' ? record.segments[0].sessionId : record.id;
}
async function originalPiJournal({ app, session, row, record, guard, previousSources = [] }) {
  const origin = retiredPiOrigin(record);
  if (!origin) return null;
  // Later same-account continuations can omit the logical ID's original
  // segment from segments[]. Try that native ID first when still indexed.
  for (const id of new Set([row.id, origin])) {
    let saved;
    try { saved = await pi(app, session, id, guard, previousSources.find(source => source.id === id), row, { retired: true }); }
    catch (error) {
      guard();
      if (error.historyAccessFailure) throw error;
      continue;
    }
    const prefix = publicSnapshot(record.prefix), messages = saved.snapshot.messages;
    if (!messages.length || !messages.every((m, i) => m.role === prefix.messages[i]?.role &&
        m.text === prefix.messages[i].text && (!m.submissionId || m.submissionId === prefix.messages[i].submissionId))) continue;
    // Public prose can stay unchanged when a tool call is replaced. The
    // frozen prefix must also contain the same completed writes and arguments.
    const frozenTools = new Map(prefix.tools.map(tool => [tool.id, tool]));
    const matches = saved.snapshot.tools.filter(tool => tool.name === 'write' && tool.state === 'done').every(tool => {
      const frozen = frozenTools.get(id + ':' + tool.id) || frozenTools.get(tool.id);
      return frozen?.name === tool.name && frozen.state === tool.state && canonicalJson(frozen.args) === canonicalJson(tool.args);
    });
    if (matches) return { id, journal: saved.localJournal };
  }
  return null;
}
async function probe({ app, session, row, guard }) {
  const record = require('./runtime-segments').read(app, row.id);
  const parts = record ? [...record.segments, record.active] : [{ sessionId: row.id, adapterId: row.adapterId || 'pi' }];
  for (const part of [...new Map(parts.map(value => [value.sessionId, value])).values()]) {
    if (part.adapterId !== 'pi') continue;
    const found = await session.historyEntry(app, part.sessionId, { strict: true });
    if (!found?.ok && found?.notFound) { guard(); continue; }
    if (!found?.ok || found.entry?.id !== part.sessionId)
      throw failure('NATIVE_HISTORY_UNAVAILABLE', found?.reason || '无法核验原生会话的最新归属');
    guard(found.entry);
  }
}
module.exports = { read, probe, originalPiJournal, retiredPiOrigin, publicSnapshot, unresolvedTools, retiredTailAbsent, MAX_BYTES };
