'use strict';
// UI-only projections of native argument generation. Never execution evidence,
// tool results, model history, or budget usage; file contents are not retained.
const pending = new WeakMap();
const agentSource = require('../conversation/agent-source.cjs');
const operations = /^(read|read_file|readfile|write|write_file|writefile|create_file|edit|edit_file|editfile|delete|delete_file|deletefile|remove_file)$/i;
function shortCall(call) {
  if (!call || typeof call !== 'object') return null;
  const id = String(call.id || call.callId || '').slice(0, 500);
  const name = String(call.name || call.tool || '').slice(0, 100);
  const args = call.arguments || call.args || {};
  const path = ['path', 'filePath', 'file_path', 'filename', 'file', 'target']
    .map(key => args[key]).find(value => typeof value === 'string' && value.trim());
  if (!id || !operations.test(name)) return null;
  return { id, name, arguments: path ? { path: path.slice(0, 1500) } : {} };
}
function put(state, call, sourceAgent) {
  const brief = shortCall(call);
  if (!brief || (state.tools || []).some(tool => tool.id === brief.id || tool.callId === brief.id)) return null;
  let rows = pending.get(state);
  if (!rows) { rows = new Map(); pending.set(state, rows); }
  const previous = rows.get(brief.id);
  const row = { id: brief.id, name: brief.name, args: brief.arguments,
    ...agentSource.fields(sourceAgent || call.sourceAgent || previous?.sourceAgent),
    phase: 'preparing', state: 'running', after: Math.max(0, state.messages.length - 1),
    scope: state.currentScope || 'normal', ...(previous ? { after: previous.after } : {}) };
  rows.set(row.id, row);
  return brief;
}
function take(state, id) {
  const rows = pending.get(state), row = rows?.get(String(id || ''));
  rows?.delete(String(id || ''));
  return row;
}
function clear(state) { pending.delete(state); }
function finishTask(state, value) {
  if (!/^(completed|done|failed|stopped|cancelled|canceled|error)$/.test(value.status || '')) return;
  const prefix = 'task:' + value.taskId + ':';
  for (const id of pending.get(state)?.keys() || []) if (id.startsWith(prefix)) take(state, id);
}
function list(state) { return Array.from(pending.get(state)?.values() || [], row => ({ ...row, args: { ...row.args } })); }
function observe(state, event) {
  if (/^tool_execution_(start|update|end)$/.test(event.type)) take(state, event.toolCallId);
  else if (['agent_start', 'agent_settled', 'auto_retry_start'].includes(event.type) ||
      event.type === 'message_end' && ['error', 'aborted', 'length'].includes(event.message?.stopReason)) clear(state);
}
function runtime(state, item) {
  if (item.kind !== 'tool-preparing') return false;
  if (item.phase === 'cancelled') take(state, item.callId);
  else put(state, { id: item.callId, name: item.tool, arguments: item.arguments }, item.sourceAgent);
  return true;
}
module.exports = { shortCall, put, take, clear, finishTask, list, observe, runtime };
