'use strict';
// Replay archived messages through the same accumulator used by live output.
const stream = require('./event-stream');
const messageTime = require('../conversation/message-time');
const snapshotWindow = require('./snapshot-window');
const goalFinalizer = require('../conversation/goal-finalizer');
const agentSource = require('../conversation/agent-source.cjs');
const nativeAgentSource = require('../conversation/native-agent-source.cjs');
const usageValues = require('../agent-runtime/usage-values');
const localImage = require('./local-image-turn.cjs');
const turnOutcome = require('./turn-outcome');
const turnMetrics = require('./turn-metrics');
const SCOPE_ENTRY_TYPE = 'soduwork.message.scope';

// Keep financial facts independently of the bounded presentation replay. Do
// not retain old content/tool payloads just to reconstruct cumulative usage.
function accountingReceipt(entry, nativeAgentId) {
  const message = messageTime.storedMessage(entry);
  if (message?.role !== 'assistant' || !message.usage || typeof message.usage !== 'object') return null;
  const usage = usageValues.empty();
  const raw = message.usage.cost?.total === 0 && message.usage.costKnown === undefined
    ? { ...message.usage, costKnown: false } : message.usage;
  usageValues.add(usage, raw);
  const source = nativeAgentSource.fields(message, nativeAgentId);
  // Older local and managed calls shared the SDK provider name. Without an
  // ownership marker or resolved Hub attribution their origin is unknowable;
  // do not disclose ambiguous legacy usage when an archive is reopened.
  const ambiguousLegacy = message.usageLocalOnly === undefined && message.provider === 'soduwork' &&
    !String(message.usageProvider || '').trim() && !String(message.quotaUsageToken || '').trim();
  return { usage, at: messageTime.epoch(message.completedAt) || messageTime.epoch(message.timestamp),
    model: String(message.model || ''), provider: String(message.usageProvider || message.provider || ''),
    agent: source.sourceAgent?.agentId || '',
    ...(message.usageLocalOnly === true ? { localOnly: true } : {}),
    ...(ambiguousLegacy ? { reportable: false } : {}),
    ...(typeof message.quotaUsageToken === 'string' && message.quotaUsageToken
      ? { quotaUsageToken: message.quotaUsageToken } : {}) };
}

function _applyStoredScope(acc, data) {
  const scope = String(data && data.scope || '');
  if (scope === stream.SCOPES.GOAL_EXECUTION) acc.beginGoalTurn();
  else if (scope === stream.SCOPES.GOAL_REVIEW) acc.beginAudit();
  else if (scope === stream.SCOPES.GOAL_FINAL) acc.beginFinalAnswer();
  else if (scope === stream.SCOPES.NORMAL) acc.endGoalTurn();
  else if (scope) acc.setScope(scope);
}
function _seed(acc, piSession, options) {
  const opts = options || {};
  let msgs = [];
  try { msgs = (piSession.state && piSession.state.messages) || []; } catch (e) { return 0; }
  let entries = [];
  try { entries = piSession.sessionManager && piSession.sessionManager.getEntries() || []; } catch (e) { entries = []; }
  const hasEntryMessages = entries.some((item) => item && item.type === 'message' && item.message);
  const sequence = hasEntryMessages ? entries : msgs.map((message) => ({ type: 'message', message }));
  const page = opts.page;
  const bounds = page ? { tailStart: page.from, lastFinalEntry: -1 } :
    snapshotWindow.seedBounds(sequence, opts.maxMessages, goalFinalizer.ENTRY_TYPE);
  const { tailStart, lastFinalEntry } = opts.completeHistory === true ? { ...bounds, tailStart: 0 } : bounds;
  // Keep only the clipped turn's identity/receipt, not its old content. A
  // long tool turn can otherwise lose its outcome when its user is windowed out.
  const prefix = stream.create();
  const indexed = (opts.archivePages || page) && tailStart > 0;
  const positions = opts.archivePages ? [] : null;
  const hasStoredScopes = page?.hasStoredScopes ?? entries.some(item => item?.type === 'custom' && item.customType === SCOPE_ENTRY_TYPE);
  const legacyInternalGoal = !hasStoredScopes && Boolean(opts.internalGoal);
  let legacyGoalStarted = false, finalRestored = false;
  let earlierMessages = 0, leadingMetrics = null;
  const earlierTools = new Set();
  for (let index = 0; index < tailStart; index++) {
    const entry = sequence[index];
    if (entry?.type === 'message' && entry.message?.role === 'user') {
      const event = prefix.push({ type: 'message_end', message: messageTime.storedMessage(entry), replay: true });
      if (indexed && event.kind === 'message') {
        positions?.push(index);
        leadingMetrics = turnMetrics.userTurn(prefix.state.messages.at(-1), earlierMessages++);
      }
      if (indexed && legacyInternalGoal && !legacyGoalStarted && !finalRestored) {
        prefix.beginGoalTurn(); legacyGoalStarted = true;
      }
      prefix.state.messages = prefix.state.messages.slice(-1);
    } else if (entry?.customType === turnOutcome.ENTRY_TYPE) {
      turnOutcome.record(prefix.state, entry.data);
    } else if (indexed && entry?.type === 'message' && entry.message?.role === 'assistant') {
      prefix.state.continuationPending = false;
      positions?.push(index);
      earlierMessages++;
      if (leadingMetrics) turnMetrics.addAssistant(leadingMetrics, messageTime.storedMessage(entry), true);
    } else if (indexed && !page && entry?.type === 'message' && entry.message?.role === 'toolResult') {
      earlierTools.add(entry.message.toolCallId);
    } else if (indexed && !page && entry?.customType === 'soduwork.task.tool' && entry.data?.event?.toolCallId) {
      earlierTools.add(entry.data.event.toolCallId);
    } else if (indexed && entry?.customType === SCOPE_ENTRY_TYPE) {
      _applyStoredScope(prefix, entry.data || {});
    } else if (indexed && entry?.customType === goalFinalizer.ENTRY_TYPE && goalFinalizer.fromEntries([entry])) {
      prefix.endGoalTurn(); finalRestored = true;
      if (index !== lastFinalEntry && index !== page?.skip) {
        positions?.push(index);
        earlierMessages++;
      }
    }
  }
  const leading = prefix.state.messages.at(-1);
  acc.state.leadingTurn = leading ? { sentAt: leading.sentAt, submissionId: leading.submissionId,
    turnOutcome: leading.turnOutcome } : null;
  let n = 0;
  const toolCalls = new Map(), accountingHistory = [];
  sequence.forEach((entry, sequenceIndex) => {
    if (indexed && sequenceIndex === tailStart) {
      // Scope controls (including legacy hidden user turns) may precede
      // the requested page. Carry their state without replaying old bodies.
      acc.state.goalActive = prefix.state.goalActive;
      acc.state.currentScope = prefix.state.currentScope;
      acc.state.continuationPending = prefix.state.continuationPending;
      acc.state.auditFrom = prefix.state.auditFrom >= 0 && prefix.state.auditUntil < 0 ? acc.state.messages.length : -1;
      acc.state.auditUntil = -1;
    }
    if (page && sequenceIndex === page.skip) return;
    if (page && sequenceIndex >= page.to) {
      // Only the terminal receipts of a turn crossing the page end are needed.
      // Never rebuild its off-page tool arguments, results or Markdown.
      if (entry?.message?.role === 'assistant') {
        const m = messageTime.storedMessage(entry);
        const hasText = Array.isArray(m.content) && m.content.some(block =>
          block?.type === 'text' && typeof block.text === 'string' && block.text.trim());
        acc.state.messages.push({ role: 'assistant', done: true, blocks: hasText ? [{ kind: 'text', text: '…' }] : [],
          completedAt: m.completedAt, usage: m.usage, stopReason: m.stopReason });
      } else if (entry?.customType === turnOutcome.ENTRY_TYPE) turnOutcome.record(acc.state, entry.data);
      else if (entry?.customType === SCOPE_ENTRY_TYPE) _applyStoredScope(acc, entry.data || {});
      else if (entry?.customType === goalFinalizer.ENTRY_TYPE && goalFinalizer.fromEntries([entry])) {
        acc.state.messages.push({ role: 'assistant', done: true, blocks: [],
          completedAt: messageTime.epoch(entry.data?.at) || messageTime.epoch(entry.timestamp) });
      }
      return;
    }
    if (!page && entry?.type === 'message') {
      const receipt = accountingReceipt(entry, opts.nativeAgentId);
      if (receipt) accountingHistory.push(receipt);
    }
    const inTail = sequenceIndex >= tailStart;
    if (entry && entry.type === 'custom') {
      if (entry.customType === localImage.USAGE_ENTRY) {
        const receipt = !page && localImage.imageReceipt(entry.data?.model, entry.data?.usage, entry.data?.at);
        if (receipt) accountingHistory.push(receipt);
        return;
      }
      if (entry.customType === SCOPE_ENTRY_TYPE) {
        _applyStoredScope(acc, entry.data || {});
        return;
      }
      if (!inTail && sequenceIndex !== lastFinalEntry) return;
      if (entry.customType === turnOutcome.ENTRY_TYPE) {
        turnOutcome.record(acc.state, entry.data);
        return;
      }
      if (entry.customType === 'soduwork.task.tool' && entry.data && entry.data.event) {
        acc.push(entry.data.event);
        return;
      }
      if (entry.customType === goalFinalizer.ENTRY_TYPE) {
        const stored = goalFinalizer.fromEntries([entry]);
        if (stored) {
          acc.beginFinalAnswer();
          acc.appendAssistant(stored.rendered, stream.SCOPES.GOAL_FINAL,
            messageTime.epoch(entry.data?.at) || messageTime.epoch(entry.timestamp));
          acc.endGoalTurn();
          finalRestored = true;
          n += 1;
        }
      }
      return;
    }
    if (!inTail) return;
    const stored = entry && entry.type === 'message' ? messageTime.storedMessage(entry) : null;
    const m = nativeAgentSource.message(stored, opts.nativeAgentId);
    if (!m || !m.role) return;
    try {
      if (m.role === 'user') {
        acc.push({ type: 'message_end', message: m, replay: true });
        n += 1;
        /*
         * For legacy archives without scope checkpoints, display the initial goal request and hide
         * subsequent execution and review until soduwork.goal.final publishes delivery.
         */
        if (legacyInternalGoal && !legacyGoalStarted && !finalRestored) {
          acc.beginGoalTurn();
          legacyGoalStarted = true;
        }
        return;
      }
      if (m.role === 'toolResult') {
        const call = toolCalls.get(String(m.toolCallId || '')) || {};
        const source = agentSource.fields(m.sourceAgent || call.sourceAgent);
        // Reconstruct tool start and end events so history uses the live activity representation.
        acc.push({ type: 'tool_execution_start', toolCallId: m.toolCallId,
                   toolName: m.toolName || call.name, args: call.arguments || call.args || null, ...source });
        acc.push({ type: 'tool_execution_end', toolCallId: m.toolCallId, toolName: m.toolName,
                   result: { content: m.content || [] }, ...source,
                   ...(m.details?.soduWorkAccessChange?.state === 'cancelled' &&
                     m.details.soduWorkAccessChange.cancelReason === 'access-change'
                     ? { state: 'cancelled', cancelReason: 'access-change', isError: false }
                     : { isError: !!m.isError }) });
        return;
      }
      if (m.role !== 'assistant') return;
      /*
       * Reconstruct content-block end events from archived assistant content and reuse the
       * normalizer instead of adding a separate history renderer.
       */
      acc.push({ type: 'message_start', message: m });
      const blocks = Array.isArray(m.content) ? m.content : [];
      blocks.forEach((c, i) => {
        if (!c) return;
        if (c.type === 'text') {
          acc.push({ type: 'message_update',
                     assistantMessageEvent: { type: 'text_end', contentIndex: i, content: c.text || '' } });
        } else if (c.type === 'thinking') {
          acc.push({ type: 'message_update',
                     assistantMessageEvent: { type: 'thinking_end', contentIndex: i, content: c.thinking || '' } });
        } else if (c.type === 'toolCall') {
          toolCalls.set(String(c.id || c.toolCallId || ''), { ...c, ...agentSource.fields(m.sourceAgent) });
          acc.push({ type: 'message_update',
                     assistantMessageEvent: { type: 'toolcall_end', contentIndex: i, toolCall: c } });
        }
      });
      acc.push({ type: 'message_end', message: m, replay: true });
      n += 1;
    } catch (e) { /* Skip unreadable entries without discarding the entire history. */ }
  });
  // Replace rather than append on reseed; replayed tail messages already
  // belong to this full baseline and must not be counted a second time.
  acc.state.accountingHistory = accountingHistory;
  acc.state.accountingMessageFrom = acc.state.messages.length;
  acc.state.usageRevision = (acc.state.usageRevision || 0) + 1;
  // Display history may include other branches and imported task receipts.
  // Measurement belongs only to the active native branch after compaction.
  let branch = sequence;
  try { branch = piSession.sessionManager?.getBranch?.() || sequence; } catch (_) {}
  acc.state.contextUsage = null;
  let modelId = piSession.model?.id;
  let provider = piSession.model?.provider;
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const entry = branch[i];
    if (entry?.type === 'compaction') break;
    const message = entry?.type === 'message' ? entry.message : null;
    const modelChange = entry?.type === 'model_change';
    if (!modelChange && (message?.role !== 'assistant' || message.taskOutputKey || message.model === 'task-executor')) continue;
    const id = modelChange ? entry.modelId : message.model;
    const source = modelChange ? entry.provider : message.provider;
    if ((modelId && id && id !== modelId) || (provider && source && source !== provider)) break;
    modelId ||= id;
    provider ||= source;
    if (message) {
      const usage = stream.reportedContextUsage(message);
      if (usage) {
        acc.state.contextUsage = usage;
        break;
      }
    }
  }
  if (acc.state && acc.state.protocolIssue && typeof acc.recoverProtocol === 'function') {
    // Keep the raw archive for audit, but do not reopen an old quarantined frame as a live failure.
    acc.recoverProtocol();
  }
  if (n) acc.push({ type: 'agent_settled' });      // Mark restored history as settled rather than actively thinking.
  turnOutcome.restore(acc.state);
  if (indexed && earlierMessages) {
    if (page) earlierMessages = page.start;
    if (leadingMetrics && acc.state.leadingTurn) {
      leadingMetrics.fromMessage -= earlierMessages;
      acc.state.leadingTurn.metrics = leadingMetrics;
    }
    for (const tool of acc.state.tools) earlierTools.delete(tool.id);
    const toolOffset = earlierTools.size;
    acc.state.archivePrefix = { messages: earlierMessages, tools: toolOffset };
    if (page) return n;
    acc.completeArchiveSnapshot = () => {
      // Freeze the complete native record once, when retiring the live Pi segment.
      // The bounded UI pages intentionally omit tool bodies and cannot be joined for handover.
      const complete = stream.create();
      _seed(complete, piSession, { ...opts, archivePages: false, completeHistory: true });
      if (complete.state.messages.length < earlierMessages + acc.state.messages.length ||
          complete.state.tools.length < toolOffset + acc.state.tools.length)
        throw Error('尚未完整保存本段会话，请稍后再切换 Agent');
      return complete.snapshot();
    };
    const live = acc.uiSnapshot;
    acc.uiSnapshot = options => {
      const end = snapshotWindow.requestedEnd(options);
      if (end === null) return live(options);
      const limits = snapshotWindow.limits(options);
      const total = earlierMessages + acc.state.messages.length;
      const until = Math.min(end, total), start = Math.max(0, until - limits.messageLimit);
      if (start >= earlierMessages) return live({ ...options, messageEnd: until - earlierMessages });
      const before = Math.min(earlierMessages, until);
      const from = positions[start] ?? tailStart, to = positions[before] ?? tailStart;
      let through = to;
      while (through < sequence.length) {
        const item = sequence[through];
        if (item?.message?.role === 'user' && stream.visibleUser(item.message.content)) break;
        through++;
      }
      const reader = stream.create(), entries = sequence.slice(0, through);
      _seed(reader, { state: {}, sessionManager: { getEntries: () => entries } }, {
        ...opts, archivePages: false, page: { from, to, start, hasStoredScopes, skip: lastFinalEntry < tailStart ? lastFinalEntry : -1 } });
      const result = reader.uiSnapshot({ ...limits, messageEnd: before - start });
      if (until > before) {
        const recent = live({ ...limits, messageEnd: until - before, messageLimit: until - before });
        const firstRaw = recent.history.messageIndices[0] - earlierMessages;
        const merged = recent.messages[0] && require('./event-snapshot').mergeContinuation(result.messages.at(-1),
          recent.messages[0], acc.state.messages[firstRaw]?.continuation);
        if (merged) result.messages[result.messages.length - 1] = merged;
        const offset = result.messages.length - (merged ? 1 : 0);
        result.messages.push(...recent.messages.slice(merged ? 1 : 0));
        result.history.messageIndices.push(...recent.history.messageIndices.slice(merged ? 1 : 0));
        result.tools.push(...recent.tools.map(tool => ({ ...tool, after: tool.after + offset })));
        result.toolPreparations.push(...recent.toolPreparations.map(row => ({ ...row, after: row.after + offset })));
        result.tools = snapshotWindow.selectTools(result.tools, 0, limits.toolLimit);
        const turns = new Map([...result.turnMetrics, ...recent.turnMetrics].map(row => [row.fromMessage, row]));
        result.turnMetrics = [...turns.values()];
      }
      Object.assign(result.history, { totalMessages: total, totalTools: toolOffset + acc.state.tools.length,
        messageStart: start, messageEnd: until, loadedMessages: result.messages.length, loadedTools: result.tools.length, truncated: true });
      return result;
    };
  }
  return n;
}

module.exports = { seed: _seed, SCOPE_ENTRY_TYPE };
