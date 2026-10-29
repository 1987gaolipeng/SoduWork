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

/* Reserve room for active calls before choosing recent completed receipts.
 * Keep at most one window in memory and defer receipt projection until after
 * selection; a single assistant turn may contain thousands of large tools. */
function selectTools(tools, messageStart, toolLimit) {
  const running = [], recent = [];
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const tool = tools[index];
    if (!tool) continue;
    if (tool.state === 'running') {
      running.push(index);
      if (running.length >= toolLimit) break;
      if (recent.length > toolLimit - running.length) recent.length = toolLimit - running.length;
    } else if (recent.length < toolLimit - running.length &&
        Math.max(0, Number(tool.after) || 0) >= messageStart) recent.push(index);
  }
  return running.concat(recent.slice(0, toolLimit - running.length))
    .sort((a, b) => a - b).map(index => tools[index]);
}

function limitSnapshot(snapshot, options) {
  const source = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const { messageLimit, toolLimit } = limits(options);
  const messages = Array.isArray(source.messages) ? source.messages : [];
  const tools = Array.isArray(source.tools) ? source.tools : [];
  const messageStart = Math.max(0, messages.length - messageLimit);
  const visibleMessages = messages.slice(messageStart);
  const visibleTools = selectTools(tools, messageStart, toolLimit).map(tool => ({
    ...toolDetail.project(tool), after: Math.max(0, (Number(tool.after) || 0) - messageStart),
  }));
  const history = {
    truncated: messageStart > 0 || tools.length > visibleTools.length,
    totalMessages: messages.length,
    totalTools: tools.length,
    loadedMessages: visibleMessages.length,
    loadedTools: visibleTools.length,
    messageStart,
    messageLimit, messageIndices: visibleMessages.map((_, index) => messageStart + index),
  };
  const { usageReceipts, ...display } = source;
  return { ...display, messages: visibleMessages, tools: visibleTools,
    toolPreparations: (source.toolPreparations || []).map(row => ({ ...row, after: Math.max(0, row.after - messageStart) })), history };
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

module.exports = { limitSnapshot, seedBounds, limits, selectTools };
