'use strict';
// Native Codex emits this exact startup diagnostic as an assistant chunk.
// Reuse the ordinary runtime rule; never hide arbitrary warnings or model text.
const CODEX_MODEL_WARNING = /^Warning: Model metadata for `[^`]+` not found\. Defaulting to fallback metadata; this can degrade performance and cause issues\.\s*/i;
const WARNING_HEAD = 'Warning: Model metadata for `';
const WARNING_TAIL = '` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.';
function cleanStream(value, final = false) {
  const text = String(value || '');
  const trimmed = text.trimStart();
  if (CODEX_MODEL_WARNING.test(trimmed)) return trimmed.replace(CODEX_MODEL_WARNING, '');
  if (!final) {
    // Buffer only a possible exact diagnostic prefix until its identity is known.
    // Keep ordinary content and its whitespace intact once the prefix diverges.
    const head = WARNING_HEAD.toLowerCase(), candidate = trimmed.toLowerCase();
    if (head.startsWith(candidate)) return '';
    if (candidate.startsWith(head)) {
      const rest = candidate.slice(head.length), end = rest.indexOf('`');
      if (end < 0 && !/[\r\n]/.test(rest)) return '';
      if (end > 0 && WARNING_TAIL.toLowerCase().startsWith(rest.slice(end))) return '';
    }
  }
  return text;
}
function clean(value) {
  return cleanStream(value, true).trim();
}
module.exports = { clean, cleanStream };
