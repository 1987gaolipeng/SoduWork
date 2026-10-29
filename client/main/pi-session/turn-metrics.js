'use strict';
const { epoch } = require('../conversation/message-time');

// Match ChatStatus's output/thinking counter. Input and cached input are not
// part of this presentation metric; usageReceipts remains the billing ledger.
function outputTokens(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const read = keys => {
    for (const key of keys) {
      if (usage[key] == null || usage[key] === '') continue;
      const value = Number(usage[key]);
      if (Number.isFinite(value) && value >= 0) return value;
    }
    return null;
  };
  const input = read(['input', 'inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens']);
  const total = read(['total', 'totalTokens', 'total_tokens']);
  const output = read(['output', 'outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens']);
  const reasoning = read(['reasoning', 'reasoningTokens', 'reasoning_tokens', 'output_reasoning_tokens', 'thinking_tokens']);
  if (output !== null) {
    if (reasoning === null) return Math.round(output);
    if (total !== null && input !== null) {
      const cache = Object.hasOwn(usage, 'input')
        ? (read(['cacheRead', 'cacheReadTokens']) || 0) + (read(['cacheWrite', 'cacheWriteTokens']) || 0) : 0;
      return Math.round(Math.max(output, total - input - cache));
    }
    return Math.round(output + reasoning);
  }
  if (total !== null && input !== null) return Math.max(0, Math.round(total - input));
  if (reasoning !== null) return Math.round(reasoning);
  const details = usage.output_tokens_details || usage.outputTokensDetails || usage.completion_tokens_details || {};
  const nested = Number(details.reasoning_tokens ?? details.reasoningTokens ?? 0);
  return Number.isFinite(nested) && nested > 0 ? Math.round(nested) : null;
}

// Reuse the raw snapshot traversal so a first bounded snapshot does not scan
// unrelated history. Only a turn cut by the window needs its earlier receipts.
function collector(state, cache, start) {
  const messages = state.messages, tail = messages[messages.length - 1];
  const previous = cache.turnMetrics;
  const unchanged = previous && previous.messages === messages && previous.count === messages.length &&
    previous.start === start && previous.revision === state.usageRevision &&
    previous.tail === tail && previous.tailDone === tail?.done && previous.tailAt === tail?.completedAt &&
    previous.pending.every(message => message.done !== true);
  if (unchanged) return { visit() {}, finish: () => previous.rows };
  const rows = [], pending = [];
  let turn = null;
  function finishTurn(toMessage) {
    if (!turn || toMessage < start) return;
    rows.push({ fromMessage: turn.fromMessage, toMessage,
      // Persisted timestamps measure submit-to-finish wall time, not runtime
      // budget time (which may exclude permission waits).
      elapsedMs: turn.count && turn.complete && turn.sentAt && turn.endedAt >= turn.sentAt
        ? turn.endedAt - turn.sentAt : null,
      tokens: turn.count && turn.complete && turn.known ? turn.tokens : null });
  }
  function visit(message, index) {
    if (message?.role === 'user') {
      finishTurn(index - 1);
      turn = { fromMessage: index, sentAt: epoch(message.sentAt), endedAt: 0,
        tokens: 0, count: 0, complete: true, known: true };
    } else if (turn && message?.role === 'assistant') {
      turn.count++;
      const complete = message.done === true;
      if (!complete) pending.push(message);
      turn.complete = turn.complete && complete;
      turn.endedAt = epoch(message.completedAt);
      const tokens = outputTokens(message.usage);
      turn.known = turn.known && tokens !== null;
      turn.tokens += tokens || 0;
    }
  }
  if (start > 0 && messages[start]?.role !== 'user') {
    const prefix = [];
    for (let index = start - 1; index >= 0; index--) {
      const message = messages[index];
      prefix.push([message, index]);
      if (message?.role === 'user') break;
    }
    for (let index = prefix.length - 1; index >= 0; index--) visit(...prefix[index]);
  }
  function finish() {
    finishTurn(messages.length - 1);
    cache.turnMetrics = { messages, count: messages.length, start, revision: state.usageRevision,
      tail, tailDone: tail?.done, tailAt: tail?.completedAt, pending, rows };
    return rows;
  }
  return { visit, finish };
}

module.exports = { collector };
