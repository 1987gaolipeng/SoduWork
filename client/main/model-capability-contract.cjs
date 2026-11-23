'use strict';

// Trusted host-side projection. Renderer writes contain declarations, never evidence.
const crypto = require('node:crypto');
// A fallback, not a discovered provider limit. Explicit output budgets take precedence.
const DEFAULT_OUTPUT_TOKENS = 16384;
const CAPABILITIES = ['imageInput', 'toolCalling', 'streaming'];
const CHECKS = ['connection', ...CAPABILITIES];
const STATES = ['unknown', 'supported', 'unsupported'];
const API_FAMILY = 'chat-completions';
const conclusive = check => ['passed', 'unsupported'].includes(check?.status);
const supported = check => check?.status === 'passed' ? 'supported' : 'unsupported';

function compatibility(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return {
    ...(['max_tokens', 'max_completion_tokens'].includes(raw.maxTokensField) ? { maxTokensField: raw.maxTokensField } : {}),
    ...(['auto', 'named'].includes(raw.toolChoice) ? { toolChoice: raw.toolChoice } : {}),
    ...(typeof raw.streamOptions === 'boolean' ? { streamOptions: raw.streamOptions } : {}),
  };
}
function publicEvidence(evidence) {
  if (!evidence || evidence.reportVersion === 3) return evidence;
  // v2 proved tool emission but never streaming continuation after a receipt.
  // Preserve its other checks and explicit unsupported results.
  const project = rows => Object.fromEntries(Object.entries(rows || {}).map(([key, check]) => [key,
    (evidence.reportVersion === 2 ? key === 'toolCalling' && check?.status === 'passed'
      : ['toolCalling', 'streaming'].includes(key) && conclusive(check))
      ? { ...check, status: 'inconclusive', code: 'legacy_recheck_required' } : check]));
  const checks = project(evidence.checks), verified = project(evidence.verifiedChecks);
  for (const [key, check] of Object.entries(verified)) {
    if (check?.code === 'legacy_recheck_required' && !checks[key]) checks[key] = check;
  }
  return { ...evidence, checks,
    ...(evidence.verifiedChecks ? { verifiedChecks: Object.fromEntries(Object.entries(verified).filter(([, check]) => conclusive(check))) } : {}) };
}
function evidenceChecks(evidence) {
  evidence = publicEvidence(evidence);
  if (!evidence || evidence.apiFamily && evidence.apiFamily !== API_FAMILY) return {};
  return Object.fromEntries(Object.entries(evidence.verifiedChecks || evidence.checks || {}).filter(([, value]) => conclusive(value)));
}
function profile(config = {}, evidence) {
  evidence = publicEvidence(evidence);
  const known = evidenceChecks(evidence), result = {};
  for (const key of CAPABILITIES) {
    const declared = config.capabilities?.[key];
    let state = STATES.includes(declared) ? declared : 'unknown';
    let source = state === 'unknown' ? 'unknown' : 'configured';
    if (state === 'unknown' && key === 'imageInput' && config.imageRouting === 'native') {
      state = 'supported'; source = 'legacy-native';
    }
    const verified = known[key], latest = evidence?.checks?.[key];
    if (state === 'unknown' && conclusive(verified)) { state = supported(verified); source = 'verified'; }
    const observedState = key === 'imageInput' && evidence?.imageInputRejectedSincePass === true ? 'unsupported' : supported(verified);
    result[key] = { state, source,
      ...(latest?.checkedAt ? { checkedAt: latest.checkedAt, checkStatus: latest.status } : {}),
      ...(conclusive(verified) ? { verifiedState: supported(verified), lastVerifiedAt: verified.checkedAt } : {}),
      ...(source !== 'verified' && state !== 'unknown' && conclusive(verified) && observedState !== state ? { conflict: true } : {}),
    };
  }
  const reported = evidence?.apiFamily !== 'responses' && evidence?.reasoningStreamReported === true;
  result.reasoningStream = { state: reported ? 'reported' : 'unknown', source: reported ? 'verified' : 'unknown' };
  return result;
}
function mergeEvidence(previous, next) {
  previous = publicEvidence(previous); next = publicEvidence(next);
  const same = previous?.configRevision === next.configRevision &&
    (previous?.apiFamily || API_FAMILY) === (next.apiFamily || API_FAMILY);
  if (same && Number(previous.runSequence || 0) > Number(next.runSequence || 0)) return previous;
  const verifiedChecks = same ? { ...evidenceChecks(previous) } : {};
  const checks = same ? { ...previous.checks } : {};
  let imageInputRejectedSincePass = same && previous?.imageInputRejectedSincePass === true;
  for (const [key, value] of Object.entries(next.checks || {})) {
    if (!CHECKS.includes(key)) continue;
    // Also protect imported v1 evidence, whose records do not carry a sequence.
    if (!next.runSequence && checks[key]?.checkedAt && value.checkedAt && checks[key].checkedAt > value.checkedAt) continue;
    checks[key] = value;
    if (!conclusive(value)) continue;
    if (key === 'imageInput') {
      // Chat retains proven support; manual conflicts follow the latest conclusive attempt.
      imageInputRejectedSincePass = Boolean(next.configRevision && value.status === 'unsupported' && verifiedChecks[key]?.status === 'passed');
      if (imageInputRejectedSincePass) continue;
    }
    verifiedChecks[key] = value;
  }
  return { ...next, reportVersion: 3, apiFamily: next.apiFamily || API_FAMILY, checks, verifiedChecks, imageInputRejectedSincePass,
    compatibility: compatibility({ ...(same ? previous.compatibility : {}), ...next.compatibility }),
    reasoningStreamReported: Boolean(next.reasoningStreamReported || same && previous.reasoningStreamReported) };
}
function runtimeFields(config = {}, evidence) {
  const capabilityProfile = profile(config, evidence);
  let imageRouting = config.imageRouting;
  if (!['native', 'vision-fallback'].includes(imageRouting)) {
    imageRouting = capabilityProfile.imageInput.state === 'supported' ? 'native' : 'vision-fallback';
  }
  return { capabilityProfile, imageRouting,
    input: imageRouting === 'native' && capabilityProfile.imageInput.state === 'supported' ? ['text', 'image'] : ['text'],
    visionFallbackAvailable: false, maxOutputTokens: config.maxOutputTokens || DEFAULT_OUTPUT_TOKENS,
    compatibility: compatibility(evidence?.apiFamily && evidence.apiFamily !== API_FAMILY ? {} : evidence?.compatibility),
  };
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function runtimeRevision(target, fields) {
  return crypto.createHash('sha256').update(JSON.stringify(stable({ target,
    states: Object.fromEntries(CAPABILITIES.map(key => [key, fields.capabilityProfile?.[key]?.state || 'unknown'])),
    input: fields.input, imageRouting: fields.imageRouting, maxOutputTokens: fields.maxOutputTokens,
    compatibility: compatibility(fields.compatibility),
  }))).digest('hex');
}
function validate(config = {}, context = 0) {
  if (config.capabilities != null && (!config.capabilities || typeof config.capabilities !== 'object' ||
      Array.isArray(config.capabilities) || Object.entries(config.capabilities).some(([key, value]) => !CAPABILITIES.includes(key) || !STATES.includes(value)))) {
    throw Error('模型能力配置无效');
  }
  if (config.imageRouting != null && !['auto', 'native', 'vision-fallback'].includes(config.imageRouting)) throw Error('图片输入方式无效');
  if (config.imageRouting === 'native' && config.capabilities?.imageInput === 'unsupported') throw Error('原生识图与不支持图片输入的配置冲突');
  if (config.maxOutputTokens != null && (!Number.isInteger(config.maxOutputTokens) || config.maxOutputTokens < 1024 || config.maxOutputTokens > 262144)) throw Error('最大输出 Token 配置无效');
  if (context && (context < 1024 || context > 10000000 || config.maxOutputTokens > context)) throw Error('上下文窗口与输出上限配置冲突');
}
function piCompatibility(model) {
  const value = compatibility(model?.compatibility);
  return { ...(value.maxTokensField ? { maxTokensField: value.maxTokensField } : {}),
    ...(typeof value.streamOptions === 'boolean' ? { supportsUsageInStreaming: value.streamOptions } : {}) };
}
function incompatibility(model, required = []) {
  if (required.includes('streaming') && model?.capabilityProfile?.streaming?.state === 'unsupported') {
    return '当前模型已确认不支持流式输出，当前执行方式需要流式接口，请选择兼容服务';
  }
  if (required.includes('toolCalling') && model?.capabilityProfile?.toolCalling?.state === 'unsupported') {
    return '当前模型已确认不支持工具调用，无法执行所选工具能力，请选择兼容模型';
  }
  return '';
}
function assertRequired(model, required) {
  const reason = incompatibility(model, required);
  if (reason) throw Object.assign(Error(reason), { code: 'MODEL_CAPABILITY_INCOMPATIBLE' });
}
module.exports = { DEFAULT_OUTPUT_TOKENS, CAPABILITIES, CHECKS, API_FAMILY, profile, runtimeFields, mergeEvidence, publicEvidence,
  runtimeRevision, compatibility, piCompatibility, stable, validate, incompatibility, assertRequired };
