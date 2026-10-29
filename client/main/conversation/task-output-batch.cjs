'use strict';

const methods = new Set(['appendTaskMessage', 'appendTaskTool', 'appendTaskRuntimeEvent']);

// Validate the complete command list before invoking any transcript mutation.
// Native output keys/call IDs retain replay protection if a later save fails.
async function apply(handle, operations) {
  if (!Array.isArray(operations) || operations.length > 1000 || operations.some(row =>
    !row || !methods.has(row.method) || !Array.isArray(row.args) ||
    row.args.length > (row.method === 'appendTaskMessage' ? 8 : 7))) {
    throw TypeError('Invalid task output batch');
  }
  for (const row of operations) await handle[row.method](...row.args);
  return { ok: true };
}

module.exports = { apply };
