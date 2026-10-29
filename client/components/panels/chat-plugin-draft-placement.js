/* Place trusted plugin drafts beside the final reply that produced this revision. */
(function (global) {
  'use strict';
  const epoch = value => Number(value) || Date.parse(value || '') || 0;
  const userTime = message => message?.role === 'user' ? epoch(message.sentAt || message.timestamp) : 0;
  // Provider assistant.timestamp is generation start, never completion.
  const completion = message => message?.role === 'assistant' && message.done !== false ? epoch(message.completedAt) : 0;
  const messageIndex = node => {
    const match = /^message:(\d+)$/.exec(node.dataset.chatNode || '');
    return match ? Number(match[1]) : -1;
  };
  // message:N is window-local; only the snapshot's original index can identify cards across windows.
  function ownerIndex(node, snapshot) {
    const index = messageIndex(node);
    if (index < 0) return '';
    const absolute = snapshot?.history?.messageIndices?.[index];
    return String(Number.isInteger(absolute) ? absolute : (Number(snapshot?.history?.messageStart) || 0) + index);
  }
  function matchesOwner(card, message, snapshot) {
    const owner = card.dataset?.pluginDraftOwner;
    return owner == null || owner === '' || owner === ownerIndex(message, snapshot);
  }
  function target(file, snapshot, messages) {
    const at = epoch(file.at), history = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
    const starts = history.flatMap((message, index) => message?.role === 'user' ? [index] : []);
    if (!starts.length) return history.length ? null : undefined; // Pre-snapshot callers retain the legacy fallback.
    const clocks = history.map(message => userTime(message) || completion(message));
    const turns = starts.map((index, position) => {
      const next = starts[position + 1] ?? history.length;
      const lastReply = history.slice(index + 1, next).filter(message => message?.role === 'assistant').at(-1);
      const before = clocks.slice(0, index).filter(time => time > 0);
      const after = clocks.slice(next).filter(time => time > 0);
      return { index, next, lastReply,
        lower: userTime(history[index]) || (before.length ? Math.max(...before) : -Infinity),
        upper: completion(lastReply) || (after.length ? Math.min(...after) : Infinity),
      };
    });
    // Preserve every user boundary. Unknown intervals overlap instead of
    // silently assigning their files to the preceding dated user.
    const possible = turns.filter(turn => !at || (at >= turn.lower && at <= turn.upper));
    const belongs = (node, turn) => messageIndex(node) > turn.index && messageIndex(node) < turn.next;
    let owner = possible.length === 1 ? possible[0] : null;
    if (!owner) {
      const key = String(file.artifactId || file.path || '');
      const mentioned = possible.filter(turn => messages.some(node => belongs(node, turn) &&
        [...node.querySelectorAll('[data-open-app]')].some(link => link.dataset.openApp === key)));
      if (mentioned.length === 1) owner = mentioned[0];
    }
    if (owner?.lastReply?.done === false) return false; // Known unfinished work waits for its final reply.
    // No unique evidence: retain a standalone session entry, never label it
    // as the latest unrelated reply's output.
    return owner ? messages.filter(node => belongs(node, owner) && node.dataset.deliveryFinal === 'true').at(-1) || null : null;
  }
  global.ChatPluginDraftPlacement = { target, ownerIndex, matchesOwner };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.ChatPluginDraftPlacement;
})(typeof window !== 'undefined' ? window : globalThis);
