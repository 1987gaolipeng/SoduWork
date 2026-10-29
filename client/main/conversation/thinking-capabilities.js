'use strict';

/*
 * SoduWork's proxy intentionally keeps the provider details out of the renderer.
 * A few providers still need a small hint so Pi can translate its neutral
 * thinking level into the OpenAI-compatible request shape. Prefer an explicit
 * server value when one is available, then use conservative model-name hints
 * for the reasoning families that are stable across the supported gateways.
 */
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function text(value) { return String(value == null ? '' : value).trim().toLowerCase(); }

function profile(model) {
  const value = model && typeof model === 'object' ? model : {};
  const id = text(value.id || value.model || value.name);
  const provider = text(value.provider || value.providerName || value.providerId);
  const key = id + ' ' + provider;
  const explicit = typeof value.reasoning === 'boolean' ? value.reasoning : null;
  const mode = text(value.thinkingMode);
  const explicitEffort = typeof value.supportsReasoningEffort === 'boolean'
    ? value.supportsReasoningEffort : null;
  // `fetchModel()` stores the normalized profile on the model as `format`,
  // while catalog responses use `thinkingFormat`. Preserve the normalized
  // value when the profile is passed through a second time (for example when
  // writing Pi's models.json or registering a provider for a turn).
  let format = text(value.thinkingFormat || value.reasoningFormat || value.format);
  let hinted = false;
  if (!format && /deepseek/.test(key)) { format = 'deepseek'; hinted = true; }
  else if (!format && /(?:glm|zhipu|zai)/.test(key)) { format = 'zai'; hinted = true; }
  else if (!format && /(?:qwen|qwq)/.test(key)) { format = 'qwen'; hinted = true; }
  else if (!format && /(?:think|thinking|reason|reasoner|r1\b|o1\b|o3\b|o4\b|gpt-5)/.test(key)) {
    format = 'openai'; hinted = true;
  }
  const reasoning = mode === 'none' ? false
    : (mode === 'always' || mode === 'controllable' ? true
      : (explicit === null ? hinted : explicit));
  if (!reasoning) return { reasoning: false, levels: ['off'], format: '', supportsReasoningEffort: false };
  const thinkingLevelMap = value.thinkingLevelMap && typeof value.thinkingLevelMap === 'object'
    ? Object.fromEntries(Object.entries(value.thinkingLevelMap)
      .filter(([level, mapped]) => LEVELS.includes(level) && (mapped === null || typeof mapped === 'string')))
    : {};
  // Some OpenAI-compatible gateways always emit hidden reasoning and reject
  // every attempt to disable it. Marking `off` as null makes Pi clamp the
  // session to the lowest available thinking level and keeps the UI honest.
  if ((value.thinkingAlwaysOn === true || mode === 'always') &&
      !Object.prototype.hasOwnProperty.call(thinkingLevelMap, 'off')) {
    thinkingLevelMap.off = null;
  }
  const result = {
    reasoning: true,
    levels: LEVELS.slice(),
    format: format || 'openai',
    supportsReasoningEffort: explicitEffort === null ? format !== 'qwen' : explicitEffort,
  };
  if (Object.keys(thinkingLevelMap).length) result.thinkingLevelMap = thinkingLevelMap;
  return result;
}


function view(session) {
  const supported = typeof session.supportsThinking === 'function' && session.supportsThinking();
  const level = String(session.thinkingLevel || 'off');
  const levels = supported && typeof session.getAvailableThinkingLevels === 'function'
    ? session.getAvailableThinkingLevels().map(String).filter(Boolean) : ['off'];
  const available = levels.length ? levels : ['off'];
  const canDisable = available.includes('off');
  return { supported: Boolean(supported), enabled: Boolean(supported && level !== 'off'),
    canDisable: Boolean(supported && canDisable), level: supported ? level : 'off', levels: available };
}

function set(session, enabled) {
  const thinking = view(session);
  if (!thinking.supported) return { ok: false, reason: '\u5f53\u524d\u6a21\u578b\u4e0d\u652f\u6301\u53ef\u63a7\u7684\u601d\u8003\u6a21\u5f0f', thinking };
  if (!thinking.canDisable && !enabled) {
    return { ok: false, reason: '\u5f53\u524d\u6a21\u578b\u59cb\u7ec8\u4f1a\u6267\u884c\u601d\u8003\uff0c\u4e0d\u652f\u6301\u5173\u95ed', thinking };
  }
  const next = Boolean(enabled) ? thinking.levels.find(level => level === 'medium') || thinking.levels.find(level => level !== 'off') || 'medium' : 'off';
  try { session.setThinkingLevel(next); } catch (_) { return { ok: false, reason: '\u601d\u8003\u6a21\u5f0f\u66f4\u65b0\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5', thinking: view(session) }; }
  return { ok: true, thinking: view(session) };
}

module.exports = { LEVELS, profile, view, set };
