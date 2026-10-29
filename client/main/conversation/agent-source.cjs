'use strict';

const catalog = require('../agent-runtime/runtime-catalog');

// Attribution is trusted runtime metadata, never inferred from assistant text,
// model names or an old conversation's currently selected Agent.
function normalize(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.agentId !== 'string' || !catalog.runtime(value.agentId)) return null;
  const result = { agentId: value.agentId };
  for (const [key, limit] of [['nodeKey', 120], ['nodeName', 160], ['runId', 120]]) {
    if (typeof value[key] !== 'string') continue;
    const text = value[key].replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, limit);
    if (text) result[key] = text;
  }
  return Object.freeze(result);
}
function fields(value) {
  const sourceAgent = normalize(value);
  return sourceAgent ? { sourceAgent } : {};
}
function same(left, right) {
  const a = normalize(left), b = normalize(right);
  if (!a || !b) return !a && !b;
  return ['agentId', 'runId', 'nodeKey'].every(key => (a[key] || '') === (b[key] || ''));
}

module.exports = { normalize, fields, same };
