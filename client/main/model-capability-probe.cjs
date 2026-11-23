'use strict';
const crypto = require('node:crypto');
const { CHECKS, API_FAMILY, compatibility } = require('./model-capability-contract.cjs');
const request = require('./model-capability-request.cjs');
const image = require('./model-capability-image.cjs');
const { collect, meaningful, ProbeIssue } = require('./model-capability-wire.cjs');
const stamp = () => new Date().toISOString();
const nonce = () => crypto.randomBytes(8).toString('hex');
const tools = [{ type: 'function', function: { name: 'soduwork_capability_echo',
  description: 'Return a supplied capability-test value without side effects.', parameters: { type: 'object',
    properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } } }];

function boundedFetch(fetchImpl, conf, maxBytes, connectMs, operationSignal) {
  const endpoint = new URL(conf.baseUrl.replace(/\/+$/, '') + '/chat/completions').href;
  return async (url, options = {}) => {
    if (String(url) !== endpoint) throw Error('Unexpected model endpoint');
    const headers = new Headers(options.headers);
    if (conf.authMode === 'none' || !conf.key) headers.delete('Authorization');
    const connected = new AbortController();
    const timer = setTimeout(() => connected.abort(new DOMException('Connection timeout', 'TimeoutError')), connectMs);
    let response;
    try { response = await fetchImpl(url, { ...options, headers, redirect: 'error',
      signal: AbortSignal.any([options.signal, connected.signal, operationSignal()].filter(Boolean)) }); }
    finally { clearTimeout(timer); }
    if (!response.body) return response;
    let size = 0;
    return new Response(response.body.pipeThrough(new TransformStream({ transform(part, controller) {
      size += part.byteLength;
      if (size > maxBytes) throw Object.assign(Error('Response limit exceeded'), { code: 'BODY_LIMIT' });
      controller.enqueue(part);
    } })), { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
async function run(conf, requested = CHECKS, options = {}) {
  if (!Array.isArray(requested) || !requested.length || requested.some(key => !CHECKS.includes(key))) throw Error('无效的能力检测项目');
  const checks = {}, state = request.policy(conf), selected = [...new Set(requested)];
  const confirmedCompatibility = compatibility(conf.compatibility);
  const total = AbortSignal.timeout(options.totalMs || 120000);
  const signal = AbortSignal.any([total, options.signal].filter(Boolean));
  let calls = 0, negotiations = 0, reasoningStreamReported = false, blocked = false;
  let client, activeSignal = signal;
  async function execute(messages, stream = false, withTools = false, continuation = false) {
    while (true) {
      if (calls >= 7) throw Object.assign(Error('Request budget exhausted'), { code: 'REQUEST_BUDGET' });
      signal.throwIfAborted(); calls++;
      const operationSignal = AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs || 30000)]);
      activeSignal = operationSignal;
      const body = request.payload(conf, state, messages, stream, withTools ? tools : undefined);
      if (continuation) delete body.tool_choice;
      try {
        const data = await client.chat.completions.create(body, { signal: operationSignal }).asResponse();
        const response = await collect(data, stream, withTools, operationSignal);
        operationSignal.throwIfAborted();
        // Publish only parameters accepted by a completed exchange. A cold
        // timeout must not replace a working runtime with probe defaults.
        confirmedCompatibility.maxTokensField = state.compatibility.maxTokensField;
        if (stream) confirmedCompatibility.streamOptions = state.compatibility.streamOptions;
        reasoningStreamReported ||= stream && response.reasoning;
        if (withTools && typeof body.tool_choice === 'object' && response.finish === 'stop' &&
            meaningful(response.message.content) && !response.toolIndices?.length && !response.legacyCallObserved &&
            negotiations < 2 && request.autoToolChoice(state, body)) { negotiations++; continue; }
        return response;
      } catch (error) {
        if (operationSignal.aborted) throw operationSignal.reason;
        if (negotiations < 2 && request.negotiate(error, state, body)) { negotiations++; continue; }
        throw error;
      }
    }
  }
  if ((conf.kind || 'openai-compat') === 'openai-compat') {
    const OpenAI = require('openai');
    client = new OpenAI({ apiKey: conf.key || 'soduwork-local-no-key', baseURL: conf.baseUrl,
      maxRetries: 0, timeout: options.timeoutMs || 30000,
      fetch: boundedFetch(options.fetchImpl || global.fetch, conf, options.maxBytes || 256 * 1024, options.connectMs || 10000, () => activeSignal) });
  }
  for (const check of selected) {
    const checkedAt = stamp(); let result;
    let stage = check === 'toolCalling' ? 'tool_call' : check === 'streaming' ? 'stream' : 'output';
    if (!client) result = { status: 'inconclusive', code: 'protocol_not_tested' };
    else if (blocked) result = { status: 'skipped', code: 'connection_blocked' };
    else {
      options.progress?.({ check, status: 'running' });
      try {
        let expected = nonce(), content = 'Reply only with ' + expected + '.';
        if (check === 'imageInput') {
          const challenge = (options.challenge || image.challenge)(); expected = challenge.expected;
          content = [{ type: 'text', text: 'Read the six digits in this image. Reply only with those digits.' },
            { type: 'image_url', image_url: { url: challenge.url } }];
        } else if (check === 'toolCalling') content = 'Call soduwork_capability_echo with value ' + expected + '. This is a capability check. After the tool responds, reply only with the tool result value.';
        const messages = [{ role: 'user', content }];
        const response = await execute(messages, check === 'streaming' || check === 'toolCalling', check === 'toolCalling');
        let passed = check === 'imageInput' ? typeof response.message.content === 'string' && response.message.content.trim() === expected
          : meaningful(response.message.content) || response.reasoning;
        if (check === 'toolCalling') {
          const invalidTool = detail => { throw new ProbeIssue('expected_output_missing', detail); };
          const calls = response.message.tool_calls;
          if (!Array.isArray(calls) || calls.length !== 1 || response.toolIndices?.length !== 1 || response.toolIndices[0] !== 0)
            invalidTool('tool_call_count_mismatch');
          if (response.finish !== 'tool_calls') invalidTool('tool_finish_reason_mismatch');
          const call = calls[0];
          if (call.type !== 'function' || !meaningful(call.id) || call.id.length > 200 || call.function?.name !== 'soduwork_capability_echo')
            invalidTool('tool_call_invalid');
          let argumentsValue;
          try { argumentsValue = JSON.parse(call.function.arguments); } catch { invalidTool('tool_arguments_invalid'); }
          if (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue) ||
              argumentsValue.value !== expected || Object.keys(argumentsValue).length !== 1) invalidTool('tool_arguments_invalid');
          stage = 'tool_result';
          const value = nonce();
          // Match runtime continuation: streamed, tools retained, receipt last.
          const followup = await execute([...messages, response.message, { role: 'tool', tool_call_id: call.id, content: value }], true, true, true);
          if (followup.finish !== 'stop') invalidTool('tool_result_finish_reason_mismatch');
          if (followup.legacyCallObserved || followup.message.tool_calls?.length || followup.message.function_call || followup.message.content?.trim() !== value) invalidTool('tool_receipt_mismatch');
          confirmedCompatibility.toolChoice = state.compatibility.toolChoice;
          passed = true;
        }
        if (response.finish === 'length') result = { status: 'inconclusive', code: 'budget_exhausted' };
        else if (!['stop', 'tool_calls'].includes(response.finish)) result = { status: 'inconclusive', code: 'invalid_response' };
        else result = { status: passed ? 'passed' : 'inconclusive', code: passed ? 'verified' : 'expected_output_missing',
          ...(!passed ? { detailCode: 'expected_output_mismatch' } : {}) };
      } catch (error) {
        result = error instanceof ProbeIssue ? { status: 'inconclusive', code: error.code,
          ...(error.detailCode ? { detailCode: error.detailCode } : {}) } : request.failure(error, check, signal);
        if (error.code === 'REQUEST_BUDGET') result = { status: 'inconclusive', code: 'budget_exhausted' };
        blocked = ['credentials_or_access', 'model_or_endpoint_missing', 'billing_unavailable'].includes(result.code);
      }
    }
    checks[check] = { ...result, stage, checkedAt };
    options.progress?.({ check, ...checks[check] });
  }
  return { reportVersion: 3, apiFamily: API_FAMILY, checks, checkedAt: stamp(), reasoningStreamReported,
    compatibility: confirmedCompatibility, requestCount: calls };
}
module.exports = { run };
