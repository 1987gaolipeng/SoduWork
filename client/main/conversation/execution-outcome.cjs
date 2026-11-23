'use strict';

const terminalStates = new Set(['completed', 'failed', 'stopped']);
const terminalStatuses = new Set(['idle', 'failed', 'unreachable', 'no-output', 'incomplete', 'aborted']);

function recover(row) {
  const outcome = row?.executionOutcome;
  if (!row || row.cached || row.source || row.importedHistory || row.cloud || row.accountProjection ||
      row.remoteProjection || row.accountConversation || (row.adapterId || 'pi') !== 'pi' ||
      row.runtimeUnavailable !== true || row.runtimeFailure?.code !== 'RUNTIME_PROCESS_GONE' ||
      row.runtimeFailure.interrupted !== false || outcome?.version !== 1 || outcome.source !== 'runtime' ||
      !terminalStates.has(outcome.state) || !terminalStatuses.has(outcome.status) ||
      !row.creator?.account || outcome.owner !== row.creator.account || outcome.hub !== row.creator.hub) return null;
  // Only the exact outcome saved with this idle-loss marker can repair its overlay.
  return { ...row, state: outcome.state, status: outcome.status, live: false };
}

module.exports = { recover };
