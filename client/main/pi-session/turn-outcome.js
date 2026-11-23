'use strict';
// Presentation receipts only: never resume, abort or schedule execution here.
const { epoch } = require('../conversation/message-time');
const ENTRY_TYPE = 'soduwork.turn.outcome';

function record(state, data) {
  if (!['stopped', 'interrupted'].includes(data?.kind)) return false;
  const user = state.messages.findLast(message => message.role === 'user') || state.leadingTurn;
  if (!user || user.turnOutcome) return false;
  if (data.submissionId && data.submissionId !== user.submissionId) return false;
  if (data.sentAt && epoch(data.sentAt) !== epoch(user.sentAt)) return false;
  const at = epoch(data.at), start = epoch(user.sentAt);
  user.turnOutcome = { kind: data.kind, at,
    elapsedMs: data.kind === 'stopped' && start && at >= start ? at - start : null };
  state.usageRevision = (state.usageRevision || 0) + 1;
  return true;
}

function userStopped(ctx) {
  const user = ctx.acc.state.messages.findLast(message => message.role === 'user');
  if (!user || user.turnOutcome || !ctx.inFlight) return;
  const active = ctx.turnQueue.active()?.options;
  if (active?.submissionId && active.submissionId !== user.submissionId) return;
  if (!active?.submissionId && active?.sentAt && epoch(active.sentAt) !== epoch(user.sentAt)) return;
  const data = { kind: 'stopped', at: Date.now(), sentAt: user.sentAt || 0,
    ...(user.submissionId ? { submissionId: user.submissionId } : {}) };
  record(ctx.acc.state, data);
  try { ctx.piSession.sessionManager.appendCustomEntry(ENTRY_TYPE, data); }
  catch (_) { /* The live receipt remains valid even when storage is unavailable. */ }
}

function restore(state) {
  let user = state.leadingTurn || null, last = null;
  function finish() {
    if (!user || user.turnOutcome) return;
    // No recorded terminal answer: keep the partial output, without claiming
    // the user stopped it or inventing a completion/exit timestamp.
    if (last === user || ['toolUse', 'aborted'].includes(last?.stopReason)) {
      user.turnOutcome = { kind: 'interrupted', at: 0, elapsedMs: null };
    }
  }
  for (const message of state.messages) {
    if (message.role === 'user') { finish(); user = message; }
    last = message;
  }
  finish();
  state.usageRevision = (state.usageRevision || 0) + 1;
}

function historyState(snapshot) {
  if (!['idle', 'aborted'].includes(snapshot.status)) return '';
  const last = (snapshot.turnMetrics || []).at(-1);
  return last?.outcome || '';
}

module.exports = { ENTRY_TYPE, record, userStopped, restore, historyState };
