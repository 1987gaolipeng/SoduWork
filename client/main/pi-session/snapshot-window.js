'use strict';
const toolDetail = require('./tool-detail');

/* Keep the runtime's complete accumulator private while sending only a
 * bounded transcript to the renderer. A long session remains available to
 * the model, while opening it avoids cloning and painting old Markdown. */
function positive(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function limits(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const messageLimit = positive(opts.messageLimit, 80, 2000);
  return { messageLimit, toolLimit: positive(opts.toolLimit, messageLimit * 2, 4000) };
}

function requestedEnd(options) {
  const end = options?.messageEnd;
  return Number.isSafeInteger(end) && end >= 0 ? end : null;
}

/* Reserve room for active calls before choosing recent completed receipts.
 * Keep at most one window in memory and defer receipt projection until after
 * selection; a single assistant turn may contain thousands of large tools. */
function selectTools(tools, messageStart, toolLimit, pageEnd = null) {
  const running = [], recent = [];
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const tool = tools[index];
    if (!tool) continue;
    const after = Math.max(0, Number(tool.after) || 0);
    if (pageEnd !== null && (after < messageStart || after >= pageEnd)) continue;
    if (tool.state === 'running') {
      running.push(index);
      if (running.length >= toolLimit) break;
      if (recent.length > toolLimit - running.length) recent.length = toolLimit - running.length;
    } else if (recent.length < toolLimit - running.length && after >= messageStart) recent.push(index);
  }
  return running.concat(recent.slice(0, toolLimit - running.length))
    .sort((a, b) => a - b).map(index => tools[index]);
}

function limitSnapshot(snapshot, options, { windowTurnMetrics = false } = {}) {
  const source = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const { messageLimit, toolLimit } = limits(options);
  const messages = Array.isArray(source.messages) ? source.messages : [];
  const tools = Array.isArray(source.tools) ? source.tools : [];
  const cursor = requestedEnd(options);
  const { usageReceipts, archiveWindow, ...display } = source;
  const archive = windowTurnMetrics && archiveWindow;
  let messageEnd = Math.min(cursor ?? messages.length, messages.length);
  let messageStart = Math.max(0, messageEnd - messageLimit);
  if (archive && cursor !== null) {
    const until = Math.min(cursor, archive.totalMessages), start = Math.max(0, until - messageLimit);
    const lowerBound = value => {
      const index = archive.messageIndices.findIndex(id => id >= value);
      return index < 0 ? messages.length : index;
    };
    messageStart = lowerBound(start);
    messageEnd = lowerBound(until);
  }
  const visibleMessages = messages.slice(messageStart, messageEnd);
  const visibleTools = selectTools(tools, messageStart, toolLimit, cursor === null ? null : messageEnd).map(tool => ({
    ...toolDetail.project(tool), after: Math.max(0, (Number(tool.after) || 0) - messageStart),
  }));
  const history = {
    truncated: messageStart > 0 || messageEnd < messages.length || tools.length > visibleTools.length,
    totalMessages: messages.length,
    totalTools: tools.length,
    loadedMessages: visibleMessages.length,
    loadedTools: visibleTools.length,
    messageStart, messageEnd,
    ...(cursor !== null && messages[messageEnd]?.role === 'user' ? { nextIsUser: true } : {}),
    messageLimit, messageIndices: visibleMessages.map((_, index) => messageStart + index),
  };
  let preparations = source.toolPreparations || [];
  if (cursor !== null) preparations = preparations.filter(row => row.after >= messageStart && row.after < messageEnd);
  const result = { ...display, messages: visibleMessages, tools: visibleTools,
    ...((windowTurnMetrics || cursor !== null) && Array.isArray(source.turnMetrics) ? { turnMetrics: source.turnMetrics.filter(row =>
      row.toMessage >= messageStart && row.fromMessage < messageEnd) } : {}),
    toolPreparations: preparations.map(row => ({ ...row, after: Math.max(0, row.after - messageStart) })), history };
  // A native process mirrors the bounded restart tail for synchronous platform
  // consumers. Its archive directory carries the raw coordinates for UI reads.
  if (archive) {
    const indices = archive.messageIndices.slice(messageStart, messageEnd);
    const until = Math.min(cursor ?? archive.totalMessages, archive.totalMessages), start = indices[0] ?? until;
    Object.assign(history, { messageIndices: indices, messageStart: start, messageEnd: until,
      totalMessages: archive.totalMessages, totalTools: archive.totalTools, truncated: true });
    result.turnMetrics = archive.turnMetrics.filter(row => row.toMessage >= start && row.fromMessage < until);
  }
  return result;
}


function seedBounds(sequence, maxMessages, finalType) {
  const max = positive(maxMessages, 240, 10000); let tailStart = 0; let count = 0;
  for (let i = sequence.length - 1; i >= 0; i -= 1) {
    const message = sequence[i] && sequence[i].type === 'message' ? sequence[i].message : null;
    if (message && (message.role === 'user' || message.role === 'assistant') && ++count >= max) { tailStart = i; break; }
  }
  const lastFinalEntry = sequence.reduce((last, item, index) => item && item.type === 'custom' && item.customType === finalType ? index : last, -1);
  return { tailStart, lastFinalEntry };
}

module.exports = { limitSnapshot, seedBounds, limits, selectTools, requestedEnd };
