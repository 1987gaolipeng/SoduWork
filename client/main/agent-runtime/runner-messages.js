'use strict';
const preparation = require('../pi-session/tool-preparation');
const { epoch } = require('../conversation/message-time');
const source = require('../conversation/agent-source.cjs');
// Only events explicitly emitted by a native runtime become reasoning/usage.
// Session totals and context occupancy never become assistant message usage.
function create(state, redact = value => value) {
  const streams = new Map();
  const rawStreams = new Map();
  const pendingPositions = new Map();
  const filterDiagnostics = ['codex', 'codex-harness'].includes(state.adapterId);
  function finish(completedAt) {
    preparation.clear(state);
    let inserted = 0;
    for (const [key, pending] of pendingPositions) {
      const text = require('./assistant-text.cjs').cleanStream(rawStreams.get(key), true);
      if (!text.trim()) continue;
      const message = { role: 'assistant', ...source.fields({ agentId: state.adapterId }),
        blocks: [{ kind: pending.kind, text: redact(text) }], done: false };
      state.messages.splice(pending.position + inserted++, 0, message);
      streams.set(key, message);
    }
    pendingPositions.clear();
    for (const message of streams.values()) {
      message.done = true;
      for (const block of message.blocks) block.done = true;
      if (!message.completedAt && epoch(completedAt)) message.completedAt = epoch(completedAt);
    }
    streams.clear();
    rawStreams.clear();
  }
  function apply(item, text) {
    item = { ...item, ...source.fields({ agentId: state.adapterId }) };
    if (preparation.runtime(state, item)) return true;
    if (item.kind === 'thinking' || item.kind === 'text' ||
        (item.kind === 'say' && (item.delta || item.streamId))) {
      const key = [item.round || item._round || state.round || 1, item.seg || 1,
        item.kind, item.streamId || item.seq].join(':');
      if (filterDiagnostics) {
        const previous = rawStreams.get(key) || '';
        const raw = (text || !item.done || item.delta ? (item.delta ? previous + text : text) : previous).slice(-50000);
        rawStreams.set(key, raw);
        text = require('./assistant-text.cjs').cleanStream(raw, item.done === true);
      }
      let message = streams.get(key);
      if (!message) {
        if (!text) {
          if (filterDiagnostics && !pendingPositions.has(key)) pendingPositions.set(key, {
            position: state.messages.length, kind: item.kind === 'thinking' ? 'thinking' : 'text',
          });
          return true;
        }
        pendingPositions.delete(key);
        message = { role: 'assistant', ...source.fields(item.sourceAgent), blocks: [{ kind: item.kind === 'thinking' ? 'thinking' : 'text', text: '' }], done: false };
        state.messages.push(message); streams.set(key, message);
      }
      const block = message.blocks[0];
      // Some native final events carry only completion metadata. Keep already
      // exposed content when no replacement text was supplied.
      if (text || !item.done || item.delta) {
        block.text = String(redact(item.delta && !filterDiagnostics ? block.text + text : text)).slice(-50000);
      }
      message.done = item.done === true;
      block.done = message.done;
      if (message.done && !message.completedAt) message.completedAt = epoch(item.completedAt) || epoch(item.at);
      return true;
    }
    if (item.kind !== 'usage') return false;
    const raw = item.usage;
    if (!raw || !['step', 'message', 'turn'].includes(item.usageScope)) return true;
    const count = key => Number.isFinite(raw[key]) && raw[key] >= 0 ? Math.floor(raw[key]) : 0;
    const input = count('input'), output = Math.max(count('output'), count('reasoning'));
    if (!input && !output) return true;
    // An authoritative message/step covers its preceding thought and text
    // fragments. Explicit zero counts prevent the renderer estimating them
    // again in addition to the real aggregate. A turn total replaces every
    // previously billed message within this user turn.
    const covered = [];
    for (let i = state.messages.length - 1; i >= 0 && state.messages[i].role !== 'user'; i--) {
      const row = state.messages[i];
      if (row.role !== 'assistant') continue;
      if (item.usageScope !== 'turn' && row.usage) break;
      covered.unshift(row);
    }
    for (const row of covered) {
      row.usage = { input: 0, output: 0, totalTokens: 0, inputIncludesCache: true };
      row.done = true;
      for (const block of row.blocks || []) block.done = true;
      if (!row.completedAt) row.completedAt = epoch(item.at);
    }
    let message = covered.at(-1);
    if (!message) {
      message = { role: 'assistant', ...source.fields(item.sourceAgent), blocks: [], done: true, completedAt: epoch(item.at) };
      state.messages.push(message);
    }
    message.usage = { input, output, cacheRead: count('cacheRead'),
      cacheWrite: count('cacheWrite'), reasoning: count('reasoning'),
      inputIncludesCache: true, totalTokens: input + output };
    // A late native receipt amends completed rows without adding messages.
    // Invalidate both output totals and accounting caches in passive replay.
    state.usageRevision = Number(state.usageRevision || 0) + 1;
    return true;
  }
  function argumentsOf(item, fallback) {
    const source = item.arguments && typeof item.arguments === 'object' ? item.arguments : null;
    if (!source) return { command: fallback }; // Older Runner compatibility.
    const args = {};
    for (const key of ['path', 'filePath', 'file_path', 'command', 'pattern', 'query']) {
      if (typeof source[key] === 'string') args[key] = redact(source[key].slice(0, 1500));
    }
    return args;
  }
  return { apply, finish, argumentsOf, takePreparation: item => preparation.take(state, item.callId) };
}
module.exports = { create };
