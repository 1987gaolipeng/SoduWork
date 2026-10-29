'use strict';
// Message timestamps are presentation facts, never the runtime's replay clock.
function epoch(value) {
  const number = typeof value === 'number' ? value :
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[T ]/.test(value) ? Date.parse(value) : 0;
  return Number.isFinite(number) && number > 0 && number <= 8640000000000000 ? number : 0;
}
function stampPiEvent(event, sentAt) {
  if (event?.type !== 'message_end' || event.replay) return event;
  const message = event.message;
  if (!message || typeof message !== 'object') return event;
  if (message.role === 'user') {
    message.sentAt = epoch(message.sentAt) || epoch(sentAt) || epoch(message.timestamp) || Date.now();
  } else if (message.role === 'assistant') {
    // The provider timestamp is created when generation begins. The SDK emits
    // this event before appending the same message object to its session file.
    message.completedAt = epoch(message.completedAt) || Date.now();
  }
  return event;
}
function storedMessage(entry) {
  const message = entry?.message;
  if (!message || typeof message !== 'object') return null;
  if (message.role === 'user') return { ...message,
    sentAt: epoch(message.sentAt) || epoch(message.timestamp) || epoch(entry.timestamp) };
  if (message.role === 'assistant') return { ...message,
    completedAt: epoch(message.completedAt) || epoch(entry.timestamp) };
  return message;
}
module.exports = { epoch, stampPiEvent, storedMessage };
