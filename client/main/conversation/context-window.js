'use strict';

/*
 * Resolve a usable context window for every model path.
 *
 * Providers do not expose the same metadata (and a number of OpenAI-compatible
 * gateways deliberately omit /models).  The UI still needs a bounded number
 * to calculate the meter, while the runtime needs the same number for
 * compaction.  Prefer an administrator supplied value, then a model/provider
 * catalogue match, and finally a conservative 128k fallback.  `estimated`
 * lets the UI explain that the value is a safe estimate without ever showing
 * an empty/unknown meter.
 */

const DEFAULT_CONTEXT_WINDOW = 128000;
const MIN_CONTEXT_WINDOW = 1024;
const MAX_CONTEXT_WINDOW = 8_000_000;

const KNOWN_WINDOWS = [
  { test: /(?:^|[-_:/.])(?:gpt-4\.1|o[134](?:-mini)?)(?:$|[-_:/.])/i, value: 1_048_576 },
  { test: /(?:^|[-_:/.])(?:claude|sonnet|opus|haiku)(?:$|[-_:/.])/i, value: 200000 },
  { test: /(?:^|[-_:/.])gemini-(?:1\.5|2(?:\.0|\.5)?)(?:$|[-_:/.])/i, value: 1_048_576 },
  { test: /(?:^|[-_:/.])deepseek(?:$|[-_:/.])/i, value: 64000 },
  { test: /(?:^|[-_:/.])(?:qwen|通义千问)(?:$|[-_:/.])/i, value: 131072 },
  { test: /(?:^|[-_:/.])(?:glm|chatglm)(?:$|[-_:/.])/i, value: 128000 },
  { test: /(?:^|[-_:/.])(?:moonshot|kimi)(?:$|[-_:/.])/i, value: 128000 },
  { test: /(?:^|[-_:/.])(?:doubao|seed|llama|mistral)(?:$|[-_:/.])/i, value: 128000 },
];

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalize(value) {
  if (typeof value === 'string') {
    const text = value.trim().replace(/,/g, '').toLowerCase();
    if (!text) return 0;
    const match = text.match(/^(\d+(?:\.\d+)?)\s*(k|m|b)?(?:\s*tokens?)?$/i);
    if (match) {
      const amount = Number(match[1]);
      const multiplier = match[2] === 'b' ? 1_000_000_000
        : match[2] === 'm' ? 1_000_000 : match[2] === 'k' ? 1_000 : 1;
      value = amount * multiplier;
    }
  }
  const number = Math.round(finite(value));
  return number >= MIN_CONTEXT_WINDOW && number <= MAX_CONTEXT_WINDOW ? number : 0;
}

function explicit(input) {
  const value = input && typeof input === 'object' ? input : {};
  const model = value.model && typeof value.model === 'object' ? value.model : {};
  for (const candidate of [
    value.contextWindow, value.context_window, value.ctxWindow, value.ctx_window,
    value.maxContextTokens, value.contextLength, value.context_length,
    model.contextWindow, model.context_window, model.ctxWindow, model.ctx_window,
    model.maxContextTokens, model.contextLength, model.context_length,
  ]) {
    const number = normalize(candidate);
    if (number) return number;
  }
  return 0;
}

function infer(input) {
  const value = input && typeof input === 'object' ? input : {};
  const model = value.model && typeof value.model === 'object' ? value.model : {};
  const name = String(value.modelName || value.id || model.id || model.name || '').trim();
  const provider = String(value.provider || value.providerId || model.provider || model.providerId || '').trim();
  /* Explicit suffixes such as moonshot-v1-128k are safer than guessing from a
     date-like model suffix.  Require a k/m/b marker so 250615 is not treated
     as a context length. */
  const suffix = name.match(/(?:^|[-_./])([0-9]+(?:\.[0-9]+)?)\s*(k|m|b)(?:$|[-_./])/i);
  if (suffix) {
    const parsed = normalize(suffix[1] + suffix[2]);
    if (parsed) return parsed;
  }
  const haystack = [name, provider].filter(Boolean).join(' ');
  const found = KNOWN_WINDOWS.find((item) => item.test.test(haystack));
  return found ? found.value : 0;
}

function resolveContextWindow(input) {
  const configured = explicit(input);
  if (configured) return {
    contextWindow: configured, contextWindowKnown: true,
    contextWindowEstimated: false, contextWindowSource: 'configured',
  };
  const inferred = infer(input);
  if (inferred) return {
    contextWindow: inferred, contextWindowKnown: true,
    contextWindowEstimated: true, contextWindowSource: 'catalog',
  };
  return {
    contextWindow: DEFAULT_CONTEXT_WINDOW, contextWindowKnown: true,
    contextWindowEstimated: true, contextWindowSource: 'safe-default',
  };
}

module.exports = {
  DEFAULT_CONTEXT_WINDOW, MIN_CONTEXT_WINDOW, MAX_CONTEXT_WINDOW,
  normalize, resolveContextWindow,
};
