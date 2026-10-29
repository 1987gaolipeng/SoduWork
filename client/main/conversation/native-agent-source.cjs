'use strict';
// A native session/archive has one immutable runtime owner. Enrich only its
// own output; imported task output must supply its actual child's provenance.
const sources = require('./agent-source.cjs');
const installed = new WeakMap();
function fields(value, agentId) {
  if (value?.sourceAgent) return sources.fields(value.sourceAgent);
  if (value?.taskId || value?.taskOutputKey || /^task:/.test(String(value?.id || '')) ||
      value?.model === 'task-executor') return {};
  return sources.fields({ agentId });
}
function project(value, agentId) {
  const sourceAgent = fields(value, agentId).sourceAgent;
  if (!sourceAgent) {
    if (!Object.hasOwn(value, 'sourceAgent')) return value;
    const clean = { ...value }; delete clean.sourceAgent; return clean;
  }
  if (value.sourceAgent && Object.keys(value.sourceAgent).length === Object.keys(sourceAgent).length &&
      Object.keys(sourceAgent).every(key => value.sourceAgent[key] === sourceAgent[key])) return value;
  return { ...value, sourceAgent };
}
function message(value, agentId) {
  if (!value || !['assistant', 'toolResult'].includes(value.role)) return value;
  return project(value, agentId);
}
function event(value, agentId) {
  if (!value || typeof value !== 'object') return value;
  if (value.message) return { ...value, message: message(value.message, agentId) };
  if (/^tool_execution_(start|update|end)$/.test(value.type) || value.type === 'message_update')
    return { ...value, ...fields(value, agentId) };
  return value;
}
function install(manager, agentId) {
  if (!manager || typeof manager.appendMessage !== 'function' || !sources.normalize({ agentId })) return;
  if (installed.has(manager)) return;
  const append = manager.appendMessage;
  manager.appendMessage = function (value, ...rest) {
    return append.call(this, message(value, agentId), ...rest);
  };
  installed.set(manager, agentId);
}
function snapshot(value, agentId) {
  if (!value || !sources.normalize({ agentId })) return value;
  const rows = items => (items || []).map(item => project(item, agentId));
  return { ...value, messages: (value.messages || []).map(item => message(item, agentId)),
    tools: rows(value.tools), ...(value.toolPreparations ? { toolPreparations: rows(value.toolPreparations) } : {}) };
}
module.exports = { fields, message, event, install, snapshot };
