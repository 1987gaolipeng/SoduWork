'use strict';

const { conversationTranscriptMessages } = require('./conversation-transcript.cjs');

function assistantRun(messages, start) {
  const parts = [];
  let end = start;
  while (end < messages.length && messages[end].role === 'assistant') parts.push(messages[end++].text);
  return { end, text: parts.join('') };
}

// Native archives and the UI can split the same answer at different stream boundaries.
function withTranscript(data, dialogue) {
  if (!dialogue.length) return data;
  const native = data?.snapshot?.messages || [];
  const visible = conversationTranscriptMessages(native);
  let matched = 0, index = 0, consumed = 0, comparedUntil = 0;
  while (index < visible.length && matched < dialogue.length) {
    const item = visible[index], wanted = dialogue[matched];
    if (item.role !== wanted.role) break;
    if (index >= comparedUntil && consumed === 0 && item.role === 'assistant' && item.text !== wanted.text &&
        (visible[index + 1]?.role === 'assistant' || dialogue[matched + 1]?.role === 'assistant')) {
      const archived = assistantRun(visible, index), displayed = assistantRun(dialogue, matched);
      comparedUntil = archived.end;
      if (archived.text === displayed.text) {
        matched = displayed.end; index = archived.end; continue;
      }
    }
    if (wanted.text.startsWith(item.text, consumed)) {
      if (consumed + item.text.length === wanted.text.length) {
        matched++; index++; consumed = 0; continue;
      }
      if (wanted.role !== 'assistant') break;
      consumed += item.text.length; index++; continue;
    }
    if (wanted.role === 'assistant' && matched === dialogue.length - 1 &&
        (item.text.startsWith(wanted.text.slice(consumed)) || wanted.done === false && data?.coverage?.complete)) return data;
    break;
  }
  if (matched === dialogue.length) return data;

  const extra = dialogue.slice(matched).map(({ role, text }) => ({ role, text }));
  const conflict = index < visible.length;
  if (conflict) {
    // Independent records that disagree stay visibly separate. Neither can
    // prove the order or execution state of the other version.
    extra[0].historyTranscriptBoundary = true;
  } else if (consumed) {
    // The existing native blocks already show the start of this answer.
    extra[0].text = extra[0].text.slice(consumed);
  }
  return { ...data, snapshot: { ...data?.snapshot, messages: [...native, ...extra], tools: data?.snapshot?.tools || [] },
    coverage: { ...data?.coverage, complete: false } };
}
module.exports = { withTranscript };
