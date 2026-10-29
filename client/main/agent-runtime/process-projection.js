'use strict';

const toolDetail = require('../pi-session/tool-detail');
const PROPERTIES = Object.freeze(['ref', 'sessionId', 'adapterId', 'displayName', 'cwd', 'startedAt', 'outputSince',
  'taskRef', 'taskTitle', 'taskIds', 'taskBindings', 'activeTaskId', 'intent', 'goal', 'skills',
  'skillWarnings', 'fileChanges', 'desktopControlScope', 'deliveryCaptureAtTurnBoundary', 'pluginDebug',
  'taskMessageStreaming']);

// Keep all transcript messages available to synchronous platform consumers.
// Tool bodies remain in the runtime and are fetched by toolDetail(). Only
// changed rows cross IPC; a token must not copy the complete history again.
function createPublisher(handle, send) {
  let revision = 0, previous = { messages: [], tools: [] }, previousData = '';
  let lastRaw = null;
  function rows(name, values) {
    const old = previous[name], next = [], changed = [];
    for (let i = 0; i < values.length; i++) {
      const text = JSON.stringify(values[i]);
      next.push(text);
      if (text !== old[i]) changed.push([i, values[i]]);
    }
    previous[name] = next;
    return { length: values.length, changed };
  }
  function capture(event, raw) {
    if (raw && raw === lastRaw) return { ref: handle.ref, revision: ++revision, data: null,
      messages: { length: previous.messages.length, changed: [] },
      tools: { length: previous.tools.length, changed: [] }, event: event || null };
    lastRaw = raw || null;
    const snapshot = handle.snapshot();
    const { messages = [], tools = [], ...rest } = snapshot;
    const properties = Object.fromEntries(PROPERTIES.map(key => [key, handle[key]]));
    const model = { ...handle.model }; delete model.key; delete model.mcpKey;
    const data = { properties, model, state: rest, status: handle.status(), inFlight: handle.inFlight(),
      history: handle.historyRow(snapshot), goal: handle.goalView(), resumePath: handle.resumeLocation() };
    const encoded = JSON.stringify(data);
    const packet = { ref: handle.ref, revision: ++revision,
      data: encoded === previousData ? null : data,
      messages: rows('messages', messages), tools: rows('tools', tools.map(toolDetail.project)), event: event || null };
    previousData = encoded;
    return packet;
  }
  return { capture, publish(event, raw) { const packet = capture(event, raw); if (packet) send(packet); return packet; } };
}

function apply(target, packet) {
  if (!Number.isSafeInteger(packet.revision) || packet.revision !== target.revision + 1)
    throw Object.assign(Error('Runtime projection sequence is invalid'), { code: 'RUNTIME_EVENT_GAP' });
  for (const name of ['messages', 'tools']) {
    const patch = packet[name];
    if (!patch || !Number.isSafeInteger(patch.length) || patch.length < 0 || patch.length > 100000)
      throw Error('Runtime projection size is invalid');
    if (!Array.isArray(patch.changed)) throw Error('Runtime projection rows are invalid');
    for (const entry of patch.changed) {
      if (!Array.isArray(entry) || entry.length !== 2) throw Error('Runtime projection row is invalid');
      const [index] = entry;
      if (!Number.isSafeInteger(index) || index < 0 || index >= patch.length) throw Error('Runtime projection row is invalid');
    }
  }
  for (const name of ['messages', 'tools']) {
    const patch = packet[name], rows = target[name]; rows.length = patch.length;
    for (const [index, value] of patch.changed) {
      rows[index] = value;
    }
  }
  if (packet.data) target.data = packet.data;
  target.revision = packet.revision;
  return target;
}
module.exports = { PROPERTIES, createPublisher, apply };
