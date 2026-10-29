'use strict';
const { createHash } = require('node:crypto');

// Bound failed/empty/repeated work, not the amount of distinct work in a turn.
// Keep only recent fingerprints; never retain tool arguments or output bodies.
const MAX_NO_PROGRESS = 16;
const HISTORY_SIZE = 64;
function create() { return { pending: new Map(), recent: new Set(), noProgress: 0 }; }
function fingerprint(value) {
  try {
    const json = JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
    return createHash('sha256').update(json).digest('hex');
  } catch (_) { return ''; }
}
function observe(state, event) {
  const id = String(event?.toolCallId || '');
  if (!id) return;
  if (event.type === 'tool_execution_start') {
    if (!state.pending.has(id)) state.pending.set(id, fingerprint([event.toolName, event.args]));
    return;
  }
  if (event.type !== 'tool_execution_end' || !state.pending.has(id)) return;
  const call = state.pending.get(id);
  state.pending.delete(id);
  const content = event.result?.content;
  // Native successful commands such as mkdir may have no stdout. A confirmed
  // successful completion with distinct arguments still advances the work;
  // repeating the same silent operation remains covered by its fingerprint.
  const meaningful = event.isError === false && event.state !== 'cancelled' ||
    Array.isArray(content) && content.some(part =>
      part?.type === 'text' ? String(part.text || '').trim() : part?.type === 'image' && part.data);
  const result = meaningful && call && fingerprint([call, content]);
  const repeated = result && state.recent.has(result);
  state.noProgress = event.isError || event.result?.isError || !result || repeated ? state.noProgress + 1 : 0;
  if (result) {
    state.recent.delete(result);
    state.recent.add(result);
    if (state.recent.size > HISTORY_SIZE) state.recent.delete(state.recent.values().next().value);
  }
}
function blocked(state) { return state.noProgress >= MAX_NO_PROGRESS; }
module.exports = { create, observe, blocked, MAX_NO_PROGRESS };
