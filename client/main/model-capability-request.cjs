'use strict';
const thinking = require('./conversation/thinking-capabilities');
const { compatibility, DEFAULT_OUTPUT_TOKENS } = require('./model-capability-contract.cjs');

function policy(conf) {
  const config = { ...conf, ...conf.config, id: conf.name };
  const conflict = thinking.conflict(config);
  if (conflict) throw Error(conflict);
  const profile = thinking.profile(config), always = config.thinkingMode === 'always' || config.thinkingAlwaysOn === true ||
    profile.reasoning && profile.thinkingLevelMap?.off === null;
  return { variants: new Set(), compatibility: { maxTokensField: 'max_tokens', toolChoice: 'auto', streamOptions: true,
    ...compatibility(conf.compatibility), ...compatibility(conf.config?.compatibility) },
  config, profile, always, budget: Math.min(always ? 2048 : 512, Number(config.maxOutputTokens) || DEFAULT_OUTPUT_TOKENS, Number(conf.ctxWindow || conf.contextWindow) || 128000) };
}
function thinkingParams(state) {
  // A disabled thinking profile omits its UI format, but a known wire model
  // still needs its provider's explicit off parameter. Generic aliases stay unknown.
  const format = state.config.thinkingFormat || state.profile.format ||
    (state.config.thinkingMode === 'none' ? thinking.profile({ id: state.config.id }).format : '');
  const enabled = state.always;
  const levels = state.profile.thinkingLevelMap || {};
  // A disabled low level must not fall back to the provider's default effort.
  // Use minimal only when explicitly mapped; extended levels also need a map.
  const level = thinking.LEVELS.filter(value => value !== 'off').find(value => levels[value] !== null &&
    (!['minimal', 'xhigh', 'max'].includes(value) || typeof levels[value] === 'string'));
  const effort = enabled && state.profile.supportsReasoningEffort && level
    ? { reasoning_effort: levels[level] || level } : {};
  if (format === 'qwen') return { enable_thinking: enabled, ...effort };
  if (format === 'qwen-chat-template') return { chat_template_kwargs: { enable_thinking: enabled, preserve_thinking: true } };
  if (format === 'deepseek') return { thinking: { type: enabled ? 'enabled' : 'disabled' }, ...effort };
  if (format === 'zai') return { thinking: { type: enabled ? 'enabled' : 'disabled', clear_thinking: false }, ...effort };
  if (format === 'openrouter') return { reasoning: { enabled, ...(enabled ? { effort: 'low' } : {}) } };
  if (format === 'together') return { reasoning: { enabled } };
  if (format === 'baseten') return { chat_template_kwargs: { enable_thinking: enabled } };
  if (format === 'string-thinking') return { thinking: enabled ? 'enabled' : 'disabled' };
  return effort;
}
function payload(conf, state, messages, stream, tools) {
  return { model: conf.name, messages, stream, [state.compatibility.maxTokensField]: state.budget,
    ...thinkingParams(state),
    ...(stream && state.compatibility.streamOptions ? { stream_options: { include_usage: true } } : {}),
    ...(tools ? { tools, ...(state.compatibility.toolChoice === 'named'
      ? { tool_choice: { type: 'function', function: { name: 'soduwork_capability_echo' } } } : { tool_choice: 'auto' }) } : {}) };
}
function optionalParameter(error) {
  if (![400, 422].includes(error?.status)) return '';
  const problem = error.error || error.body?.error || {}, message = String(problem.message || '').toLowerCase();
  const param = String(problem.param || '').toLowerCase();
  const allowed = ['max_tokens', 'max_completion_tokens', 'tool_choice', 'stream_options'];
  const explicit = ['unsupported_parameter', 'unsupported_value', 'unknown_parameter', 'unrecognized_parameter'].includes(String(problem.code || problem.type || '').toLowerCase());
  if (explicit && allowed.includes(param)) return param;
  if (/not support|unsupported|unrecognized|unknown (?:parameter|argument)/.test(message)) {
    return allowed.find(name => new RegExp('(?<![a-z_])' + name + '(?![a-z_])').test(message)) || '';
  }
  return '';
}
function changeParameter(parameter, state, body) {
  const current = state.compatibility.maxTokensField;
  const group = ['max_tokens', 'max_completion_tokens'].includes(parameter) ? 'output' : parameter;
  if (!parameter || !body || !Object.hasOwn(body, parameter) || state.variants.has(group) || group === 'output' && parameter !== current ||
      parameter === 'tool_choice' && state.compatibility.toolChoice === 'auto' ||
      parameter === 'stream_options' && !state.compatibility.streamOptions) return false;
  state.variants.add(group);
  if (group === 'output') state.compatibility.maxTokensField = current === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens';
  else if (parameter === 'tool_choice') state.compatibility.toolChoice = 'auto';
  else state.compatibility.streamOptions = false;
  return true;
}
function negotiate(error, state, body) { return changeParameter(optionalParameter(error), state, body); }
function autoToolChoice(state, body) { return changeParameter('tool_choice', state, body); }
function failure(error, check, signal) {
  const problem = error?.error || error?.body?.error || {}, code = String(problem.code || '').toLowerCase();
  if (signal?.aborted) return { status: signal.reason?.name === 'TimeoutError' ? 'inconclusive' : 'cancelled', code: signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled' };
  // SDK transport errors retain a cause. Classify only finite error names and
  // codes; upstream messages stay private and cannot declare a capability.
  for (let cause = error, depth = 0; cause && depth < 5; cause = cause.cause, depth++) {
    if (cause.code === 'BODY_LIMIT') return { status: 'inconclusive', code: 'response_too_large' };
    if (['APIConnectionTimeoutError', 'TimeoutError'].includes(cause.name)) return { status: 'inconclusive', code: 'timeout' };
  }
  if (['insufficient_quota', 'insufficient_balance', 'billing_hard_limit_reached', 'billing_not_active', '1113'].includes(code)) return { status: 'failed', code: 'billing_unavailable' };
  if ([401, 403].includes(error?.status)) return { status: 'failed', code: 'credentials_or_access' };
  if (error?.status === 404) return { status: 'failed', code: 'model_or_endpoint_missing' };
  if (error?.name === 'APIConnectionError') return { status: 'inconclusive', code: 'temporarily_unavailable' };
  if ([408, 429, 500, 502, 503, 504].includes(error?.status)) return { status: 'inconclusive', code: [408, 504].includes(error.status) ? 'timeout' : 'temporarily_unavailable' };
  if ([400, 422].includes(error?.status)) {
    const param = String(problem.param || '').toLowerCase(), text = String(problem.message || '').trim().toLowerCase();
    if (optionalParameter(error) || ['max_tokens', 'max_completion_tokens', 'tool_choice', 'stream_options'].includes(param) ||
        /tool_choice|stream_options/.test(text)) return { status: 'inconclusive', code: 'parameter_not_supported' };
    const codes = { imageInput: ['image_not_supported', 'unsupported_image', 'unsupported_image_input', 'vision_not_supported', 'image_input_not_supported'],
      toolCalling: ['tools_not_supported', 'tool_calling_not_supported', 'function_calling_not_supported', 'unsupported_tools'],
      streaming: ['streaming_not_supported', 'stream_not_supported', 'unsupported_streaming'] };
    const primary = { imageInput: ['image', 'image_url'], toolCalling: ['tools', 'functions'], streaming: ['stream'] };
    const patterns = { imageInput: /^(?:image(?:s| input)?|vision|multimodal input) (?:is |are )?not supported(?: by (?:this |the )?model)?[.!]?$/,
      toolCalling: /^(?:tools|tool calling|function calling) (?:is |are )?not supported(?: by (?:this |the )?model)?[.!]?$/,
      streaming: /^streaming (?:is )?not supported(?: by (?:this |the )?model)?[.!]?$/ };
    if (codes[check]?.includes(code) || code === 'unsupported_parameter' && primary[check]?.includes(param) || patterns[check]?.test(text))
      return { status: 'unsupported', code: 'capability_not_supported' };
  }
  return { status: 'inconclusive', code: error?.code === 'INCOMPLETE_STREAM' ? 'stream_interrupted' : error?.status ? 'request_not_accepted' : 'invalid_response' };
}
module.exports = { policy, payload, negotiate, autoToolChoice, failure, thinkingParams };
