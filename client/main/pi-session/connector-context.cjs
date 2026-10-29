'use strict';
// Keep capability context separate from plugins and hide it from message bubbles and history previews.
const START = '<soduwork-conversation-connectors>';
const END = '</soduwork-conversation-connectors>';
function neutralize(value) {
  return String(value || '').replaceAll(START, '[conversation-connectors]').replaceAll(END, '[/conversation-connectors]');
}
function augment(text, guide) {
  const visible = neutralize(text);
  if (!guide) return visible;
  return visible + '\n\n' + START + '\n' + JSON.stringify({ runtimeGuide: neutralize(guide).slice(0, 12000) }) + '\n' + END;
}
function strip(value) {
  const text = String(value || ''), start = text.lastIndexOf(START), end = text.lastIndexOf(END);
  return start >= 0 && end >= start ? text.slice(0, start).trimEnd() : text;
}
module.exports = { START, END, augment, strip };
