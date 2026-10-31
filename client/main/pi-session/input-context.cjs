'use strict';

// Material evidence belongs to the model context, not the user's message bubble.
const START = '<soduwork-material-context>';
const END = '</soduwork-material-context>';
function augment(value, context) {
  const text = String(value || '').replaceAll(START, '&lt;soduwork-material-context&gt;')
    .replaceAll(END, '&lt;/soduwork-material-context&gt;');
  const payload = JSON.stringify({ context }).replaceAll('<', '\\u003c');
  return context ? text + '\n\n' + START + '\n' + payload + '\n' + END : text;
}
function strip(value) {
  const text = String(value || ''), start = text.lastIndexOf(START);
  if (start < 0 || !text.endsWith(END)) return text;
  try {
    const payload = JSON.parse(text.slice(start + START.length, -END.length).trim());
    return typeof payload.context === 'string' ? text.slice(0, start).trimEnd() : text;
  } catch (_) { return text; }
}
module.exports = { augment, strip };
