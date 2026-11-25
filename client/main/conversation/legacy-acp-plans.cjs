'use strict';

const crypto = require('node:crypto');

async function project(runtime, id, adapterId, revision, guard, rows, messages, tools, messageCounts) {
  const original = { messages, tools };
  if (!rows.some(row => row.command) || rows.length > 4096) return original;
  let reply;
  try { reply = await runtime.rpc('runtime.history.acpPlans', { ref: id, adapterId, revision }, 15000); }
  catch (_) { /* An earlier Runner may not expose the original ACP records. */ }
  guard();
  const receipt = reply?.data;
  if (!reply?.ok || receipt?.ref !== id || receipt.revision !== revision ||
      !Array.isArray(receipt.plans) || receipt.plans.length !== rows.length) return original;
  const confirmed = new Map();
  // Compare the entire ordered sequence, including real tools named Plan and
  // repeated command text across process/turn boundaries.
  for (const [index, row] of rows.entries()) {
    const item = receipt.plans[index];
    if (!Array.isArray(item) || item.length !== 3 || !Number.isSafeInteger(row.offset) || row.offset <= 0 ||
        !Number.isSafeInteger(row.segment) || row.segment <= 0 ||
        item[0] !== row.segment || item[1] !== row.offset) return original;
    if (item[2] === '') continue;
    if (!row.command || crypto.createHash('sha256').update(row.command).digest('hex') !== item[2]) return original;
    confirmed.set(row.toolIndex, row.command);
  }
  if (!confirmed.size) return original;
  const projected = { messages: [], tools: [] };
  let nextMessage = 0, inserted = 0;
  for (const [index, tool] of tools.entries()) {
    const before = messageCounts[index], command = confirmed.get(index);
    if (command) {
      while (nextMessage < before) projected.messages.push(messages[nextMessage++]);
      projected.messages.push({ id: tool.id, role: 'assistant', legacyAcpPlan: true,
        blocks: [{ kind: 'text', text: command }], done: true });
      inserted++;
    } else {
      projected.tools.push({ ...tool, after: Math.max(0, before + inserted - 1) });
    }
  }
  while (nextMessage < messages.length) projected.messages.push(messages[nextMessage++]);
  return projected;
}

module.exports = { project };
