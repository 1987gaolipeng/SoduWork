'use strict';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const meaningful = value => typeof value === 'string' && Boolean(value.trim());
class ProbeIssue extends Error {
  constructor(code, detailCode) { super(code); this.code = code; this.detailCode = detailCode; }
}
const invalid = () => { throw new ProbeIssue('invalid_response', 'invalid_stream_shape'); };
const count = value => Number.isSafeInteger(value) && value >= 0;
function envelope(value, usageOnly = false) {
  const allowed = ['choices', 'id', 'object', 'created', 'model', 'system_fingerprint', 'service_tier', 'usage'];
  if (usageOnly && Object.keys(value).some(key => !allowed.includes(key))) return false;
  for (const key of ['id', 'object', 'model']) if (key in value && typeof value[key] !== 'string') return false;
  for (const key of ['system_fingerprint', 'service_tier']) if (value[key] != null && typeof value[key] !== 'string') return false;
  if ('created' in value && !count(value.created)) return false;
  if (!usageOnly && value.usage == null) return true;
  if (!object(value.usage)) return false;
  if (!['prompt_tokens', 'completion_tokens', 'total_tokens'].some(key => count(value.usage[key]))) return false;
  return Object.entries(value.usage).every(([key, item]) => key.endsWith('_tokens_details')
    ? item === null || object(item) && Object.values(item).every(part => part === null || count(part)) : count(item));
}
function finishReason(reason) {
  if (['length', 'max_tokens', 'max_output_tokens'].includes(reason)) throw new ProbeIssue('response_truncated');
  if (reason === 'content_filter') throw new ProbeIssue('content_filtered');
  if (reason != null && !['stop', 'tool_calls', 'function_call'].includes(reason)) invalid();
}
function functionFields(value) {
  return object(value) && ['name', 'arguments'].every(key => !(key in value) || typeof value[key] === 'string');
}
function messageFields(message, complete = false) {
  if (!object(message)) invalid();
  for (const key of ['content', 'reasoning_content', 'reasoning', 'thinking', 'refusal']) {
    if (message[key] != null && typeof message[key] !== 'string') invalid();
  }
  if ('role' in message && message.role !== 'assistant') invalid();
  if ('tool_calls' in message && !Array.isArray(message.tool_calls)) invalid();
  if (message.function_call != null && !functionFields(message.function_call)) invalid();
  if (complete) {
    for (const call of message.tool_calls || []) {
      if (!object(call) || 'id' in call && typeof call.id !== 'string' || 'type' in call && call.type !== 'function' ||
          'function' in call && !functionFields(call.function)) invalid();
    }
  }
}

// Decode the bounded raw response instead of relying on SDK event filtering.
// Both detectors must see malformed envelopes, terminal markers and trailing data.
class StreamEvidence {
  constructor() {
    this.decoder = new TextDecoder('utf-8', { fatal: true });
    this.line = ''; this.data = []; this.event = ''; this.afterCR = false;
    this.finished = false; this.done = false; this.finishReason = null;
    this.legacyCallObserved = false;
    this.content = ''; this.thoughts = ''; this.reasoning = false; this.observed = false; this.calls = new Map();
  }
  feed(bytes) {
    try { this.text(this.decoder.decode(bytes, { stream: true })); }
    catch (error) { if (error instanceof TypeError) invalid(); throw error; }
  }
  text(text) {
    for (const char of text) {
      if (this.afterCR) { this.afterCR = false; if (char === '\n') continue; }
      if (char === '\n' || char === '\r') { this.endLine(); this.afterCR = char === '\r'; }
      else this.line += char;
    }
  }
  endLine() {
    const line = this.line; this.line = '';
    if (!line) return this.endEvent();
    if (line.startsWith(':')) return;
    const separator = line.indexOf(':'), key = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (key === 'data') this.data.push(value);
    else if (key === 'event') this.event = value;
  }
  endEvent() {
    const kind = this.event, data = this.data.join('\n'), hadData = this.data.length;
    this.event = ''; this.data = [];
    if (kind === 'error') throw new ProbeIssue('stream_error');
    if (['ping', 'heartbeat'].includes(kind)) {
      let value;
      try { value = JSON.parse(data); } catch { return; }
      if (object(value) && (value.error != null || value.type === 'error')) throw new ProbeIssue('stream_error');
      return;
    }
    if (!['', 'message'].includes(kind)) invalid();
    if (!data && !hadData) return;
    if (this.done) invalid();
    if (data.trim() === '[DONE]') { this.done = true; return; }
    let value;
    try { value = JSON.parse(data); } catch { invalid(); }
    if (!object(value)) invalid();
    if (value.error != null || value.type === 'error') throw new ProbeIssue('stream_error');
    const choices = value.choices;
    if (choices === undefined || Array.isArray(choices) && choices.length === 0) {
      if (!envelope(value, true)) invalid();
      return;
    }
    if (!envelope(value) || !Array.isArray(choices) || choices.length !== 1) invalid();
    const choice = choices[0];
    if (!object(choice) || choice.index !== undefined && choice.index !== 0) invalid();
    if (choice.logprobs != null && !object(choice.logprobs)) invalid();
    const delta = choice.delta;
    if (!object(delta) || this.finished && (Object.keys(delta).length || choice.finish_reason != null)) invalid();
    messageFields(delta);
    if (delta.function_call != null) this.legacyCallObserved = true;
    finishReason(choice.finish_reason);
    if (choice.finish_reason != null) { this.finishReason = choice.finish_reason; this.finished = true; }
    if (delta.content != null) this.content += delta.content;
    this.reasoning ||= ['reasoning_content', 'reasoning', 'thinking'].some(key => meaningful(delta[key]));
    if (typeof delta.reasoning_content === 'string') this.thoughts += delta.reasoning_content;
    if ('tool_calls' in delta && !Array.isArray(delta.tool_calls)) invalid();
    const parts = delta.tool_calls || [];
    for (const part of parts) {
      if (!object(part)) invalid();
      const index = part.index === undefined ? 0 : part.index;
      if (!Number.isInteger(index) || index < 0 || index >= 16 || parts.length > 1 && part.index === undefined) invalid();
      if ('type' in part && part.type !== 'function') invalid();
      if ('function' in part && !object(part.function)) invalid();
      const fn = part.function || {};
      const call = this.calls.get(index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
      for (const [target, source, key, limit] of [[call, part, 'id', 200], [call.function, fn, 'name', 128], [call.function, fn, 'arguments', 262144]]) {
        if (key in source) {
          if (typeof source[key] !== 'string') invalid();
          target[key] += source[key];
          if (target[key].length > limit) throw new ProbeIssue('response_limit');
        }
      }
      this.calls.set(index, call);
    }
    this.observed ||= this.reasoning || meaningful(delta.content);
  }
  finish(requireOutput) {
    try { this.text(this.decoder.decode()); } catch (error) { if (error instanceof TypeError) invalid(); throw error; }
    if (this.line || this.data.length || this.event || !this.finished && !this.done) throw new ProbeIssue('stream_incomplete');
    if (requireOutput && !this.observed) throw new ProbeIssue('expected_output_missing', 'expected_output_mismatch');
    const message = { role: 'assistant', content: this.content || null };
    if (this.calls.size) message.tool_calls = [...this.calls].sort(([a], [b]) => a - b).map(([, call]) => call);
    if (this.thoughts) message.reasoning_content = this.thoughts;
    return { message, finish: this.finishReason, reasoning: this.reasoning, toolIndices: [...this.calls.keys()],
      legacyCallObserved: this.legacyCallObserved };
  }
}
async function* chunks(response, signal) {
  const reader = response.body.getReader();
  const abort = () => { reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      yield part.value;
    }
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
async function collect(response, stream, tools = false, signal) {
  try {
    if (!response.body) invalid();
    if (stream) {
      if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) throw new ProbeIssue('stream_not_observed');
      const evidence = new StreamEvidence();
      for await (const bytes of chunks(response, signal)) evidence.feed(bytes);
      return evidence.finish(!tools);
    }
    const parts = [];
    for await (const bytes of chunks(response, signal)) parts.push(bytes);
    const raw = Buffer.concat(parts);
    let data;
    try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
    catch (error) { if (error instanceof SyntaxError || error instanceof TypeError) invalid(); throw error; }
    if (!object(data) || data.error != null || data.type === 'error' || !Array.isArray(data.choices) || data.choices.length !== 1) invalid();
    const choice = data.choices[0];
    if (!object(choice) || choice.index !== undefined && choice.index !== 0) invalid();
    if (choice.logprobs != null && !object(choice.logprobs)) invalid();
    messageFields(choice.message, true); finishReason(choice.finish_reason);
    return { message: choice.message, finish: choice.finish_reason,
      reasoning: ['reasoning_content', 'reasoning', 'thinking'].some(key => meaningful(choice.message[key])) };
  } catch (error) {
    if (!stream && error instanceof ProbeIssue && error.detailCode === 'invalid_stream_shape') throw new ProbeIssue(error.code);
    throw error;
  } finally {
    // Cleanup must not extend the operation deadline if a transport stalls.
    if (response.body && !response.body.locked) response.body.cancel().catch(() => {});
  }
}
module.exports = { collect, meaningful, ProbeIssue };
