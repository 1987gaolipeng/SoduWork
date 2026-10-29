'use strict';

// Usage is runtime provenance, not the currently selected model or Agent.
const sources = require('./agent-source.cjs');
const nativeSource = require('./native-agent-source.cjs');
// Historical provenance outlives the installable-runtime catalog (for example
// a retired adapter still has an existing brand and archived conversations).
const historicalIds = new Set(['pi', 'codex', 'codex-harness', 'opencode', 'claude', 'qwen', 'dsh', 'harness2']);
const known = id => typeof id === 'string' && (historicalIds.has(id) || sources.normalize({ agentId: id }));
const recordSources = new WeakMap();
const arraySources = new WeakMap();
function merge(...groups) {
  const ids = new Set();
  for (const group of groups) for (const id of Array.isArray(group) ? group : []) {
    if (known(id)) ids.add(id);
  }
  return [...ids];
}
function sourceId(item, adapterId) {
  if (!item || typeof item !== 'object') return '';
  const source = item.sourceAgent || nativeSource.fields(item, adapterId).sourceAgent;
  return known(source?.agentId) ? source.agentId : '';
}
function add(target, item, adapterId) {
  const id = sourceId(item, adapterId);
  if (id) target.add(id);
}
function collect(items, kind, adapterId) {
  if (!Array.isArray(items)) return [];
  let cache = arraySources.get(items);
  if (!cache) { cache = new Map(); arraySources.set(items, cache); }
  const key = kind + ':' + (adapterId || '');
  let state = cache.get(key);
  if (!state || items.length < state.count || (state.count &&
      (items[0] !== state.first || items[state.count - 1] !== state.last))) {
    state = { count: 0, counts: new Map(), pending: new Map() }; cache.set(key, state);
  }
  const adjust = (id, delta) => {
    if (!id) return;
    const count = (state.counts.get(id) || 0) + delta;
    if (count > 0) state.counts.set(id, count); else state.counts.delete(id);
  };
  const visit = (index, previous = '') => {
    const item = items[index], eligible = kind === 'tool' || ['assistant', 'toolResult'].includes(item?.role);
    const id = eligible ? sourceId(item, adapterId) : '';
    if (id !== previous) { adjust(previous, -1); adjust(id, 1); }
    // Completed provenance is immutable, including legacy task output whose
    // source was never recorded. Observe live rows once more as they settle.
    const active = eligible && (kind === 'tool' ? item?.state === 'running' : item?.done === false);
    if (active) state.pending.set(index, id);
    else state.pending.delete(index);
  };
  for (const [index, id] of state.pending) visit(index, id);
  for (let index = state.count; index < items.length; index++) visit(index);
  state.count = items.length; state.first = items[0]; state.last = items[items.length - 1];
  return [...state.counts.keys()];
}
function fromSnapshot(snapshot, adapterId) {
  return merge(collect(snapshot?.messages, 'message', adapterId), collect(snapshot?.tools, 'tool', adapterId));
}
function fromRecord(record) {
  if (!record || typeof record !== 'object') return [];
  const previous = recordSources.get(record);
  if (previous && previous.prefix === record.prefix && previous.segments === record.segments &&
      previous.active === record.active && previous.ids === record.usedHarnesses) return previous.result.slice();
  const result = merge(fromSnapshot(record.prefix), record.usedHarnesses,
    ...(record?.segments || []).map(segment => segment.usedHarnesses), record?.active?.usedHarnesses);
  recordSources.set(record, { prefix: record.prefix, segments: record.segments,
    active: record.active, ids: record.usedHarnesses, result });
  return result.slice();
}
module.exports = { add, merge, fromSnapshot, fromRecord };
