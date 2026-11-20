'use strict';
const turnOutcome = require('./turn-outcome');
const goalFinalizer = require('../conversation/goal-finalizer');

/* Conversation history is a projection of persisted rows plus live handles.
   Keeping it outside session.js prevents UI presence from leaking into runtime. */
function presenceState(status) {
  if (status === 'streaming' || status === 'compacting') return 'running';
  if (status === 'queued') return 'waiting';
  if (status === 'waiting-user') return 'waiting';
  if (status === 'unreachable' || status === 'no-output' || status === 'incomplete') return 'failed';
  if (status === 'aborted') return 'stopped';
  return status === 'idle' ? 'completed' : 'archived';
}

/* A cold archive row has no live handle. A turn that ends with tool calls but
   no results, with tool results the model never answered, or with an
   unanswered user message was cut off (for example by quitting the app) and
   must not be presented as completed. Live handles override this state. */
function archivedTurnState(entries) {
  const stored = Array.isArray(entries) ? entries : [];
  const lastUser = stored.findLastIndex(entry => entry?.type === 'message' && entry.message?.role === 'user');
  const user = lastUser >= 0 ? require('../conversation/message-time').storedMessage(stored[lastUser]) : null;
  if (user && stored.slice(lastUser + 1).some(entry => entry?.type === 'custom' &&
      entry.customType === turnOutcome.ENTRY_TYPE && entry.data?.kind === 'stopped' &&
      (!entry.data.submissionId || entry.data.submissionId === user.submissionId) &&
      (!entry.data.sentAt || entry.data.sentAt === user.sentAt))) return 'aborted';
  for (let index = stored.length - 1; index >= 0; index -= 1) {
    if (stored[index]?.customType === goalFinalizer.ENTRY_TYPE &&
        goalFinalizer.fromEntries([stored[index]])) return 'idle';
    const message = stored[index]?.type === 'message' && stored[index].message;
    if (!message) continue;
    if (message.role === 'assistant') {
      if (message.stopReason === 'toolUse') return 'interrupted';
      if (message.stopReason === 'aborted') return 'aborted';
      if (message.stopReason === 'error') return 'unreachable';
      if (message.stopReason === 'length') return 'incomplete';
      return 'idle';
    }
    if (message.role === 'toolResult' || message.role === 'user') return 'interrupted';
  }
  return 'idle';
}

// The incremental archive index deliberately does not retain message bodies.
// Keep just enough terminal metadata to use the same classifier on real files.
function archiveTurn() {
  let user = null, last = null, stopped = null;
  return {
    observe(entry) {
      if (entry?.type === 'message') {
        const message = entry.message;
        if (!['user', 'assistant', 'toolResult'].includes(message?.role)) return;
        if (message.role === 'user') {
          const stored = require('../conversation/message-time').storedMessage(entry);
          user = { type: 'message', message: { role: 'user', sentAt: stored.sentAt, submissionId: stored.submissionId } };
          stopped = null;
        }
        last = { type: 'message', message: { role: message.role, stopReason: message.stopReason } };
      } else if (entry?.customType === turnOutcome.ENTRY_TYPE && entry.data?.kind === 'stopped') {
        stopped = { type: 'custom', customType: turnOutcome.ENTRY_TYPE, data: {
          kind: 'stopped', sentAt: entry.data.sentAt, submissionId: entry.data.submissionId } };
      } else if (entry?.customType === goalFinalizer.ENTRY_TYPE && goalFinalizer.fromEntries([entry])) {
        last = { type: 'message', message: { role: 'assistant', stopReason: 'stop' } }; stopped = null;
      }
    },
    state() { return archivedTurnState([user, last?.message.role === 'user' ? null : last, stopped].filter(Boolean)); },
  };
}

function messageTitle(snapshot) {
  const first = ((snapshot && snapshot.messages) || []).find(item => item && item.role === 'user');
  const raw = first && (first.text || first.content || first.message);
  const text = Array.isArray(raw)
    ? raw.map(item => item && (item.text || item.content) || '').join(' ')
    : String(raw || '');
  if (!text.trim()) return '';
  // Use the same envelope policy as archived history so live and cold rows cannot disagree.
  return require('./session-helpers').title({ firstMessage: text });
}

function originalMessageTitle(entries, messages) {
  // A restored UI contains only the bounded tail. Resolve the name once from
  // the original archive, stopping at its first visible user request instead
  // of replaying or projecting old assistant/tool receipts.
  const stored = Array.isArray(entries) ? entries : [];
  const archive = stored.some(entry => entry?.type === 'message' && entry.message);
  const acc = require('./event-stream').create();
  for (const entry of archive ? stored : messages || []) {
    const message = archive ? entry?.type === 'message' && entry.message : entry;
    if (message?.role !== 'user') continue;
    acc.push({ type: 'message_end', message, replay: true });
    const text = acc.state.messages.at(-1)?.text;
    if (typeof text === 'string' && text.trim()) return require('./session-helpers').title({ firstMessage: text });
  }
  return '';
}

function mergeHistory(diskRows, handles, limit) {
  const live = new Map((handles || []).map(handle => {
    const row = handle && typeof handle.historyRow === 'function' ? handle.historyRow() : null;
    return row && row.id ? [String(row.id), row] : null;
  }).filter(Boolean));
  const merged = (diskRows || []).map(row => {
    const current = live.get(String(row.id || ''));
    if (!current) return row;
    live.delete(String(row.id));
    return { ...row, ...current, path: row.path || current.path || '' };
  });
  live.forEach(row => merged.push(row));
  return merged.sort((left, right) => Number(right.at || 0) - Number(left.at || 0))
    .slice(0, Math.max(1, Number(limit) || 20));
}

module.exports = { presenceState, archivedTurnState, archiveTurn, messageTitle, originalMessageTitle, mergeHistory };
