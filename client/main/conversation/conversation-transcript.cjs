'use strict';

const crypto = require('node:crypto');
const { mergeNativeEvidence } = require('./history-evidence.cjs');

function conversationTranscriptEntries(messages) {
  const visible = [];
  for (const message of messages || []) {
    if (!message || !['user', 'assistant'].includes(message.role)) continue;
    // Runner displays the user's input during local preparation. Until
    // native submission begins it can still be cancelled without a journal.
    if (message.role === 'user' && message.runnerPreparing === true) continue;
    // Legacy ACP plan notifications originally appeared as tool activity. They
    // are visible in native replay but were never independent dialogue entries.
    if (message.role === 'assistant' && message.legacyAcpPlan === true) continue;
    // The renderer reads the user's full text; Pi may truncate its display
    // blocks for large pastes. Assistant text comes from the public blocks.
    let text = message.text;
    if ((message.role === 'assistant' || !text) && Array.isArray(message.blocks) && message.blocks.length) {
      text = message.blocks.filter(block => block?.kind === 'text' && typeof block.text === 'string')
        .map(block => block.text).join('\n');
    }
    if (typeof text !== 'string' || !text.length) continue;
    visible.push({ role: message.role, text, ...(message.role === 'assistant' && typeof message.done === 'boolean'
      ? { done: message.done } : {}) });
  }
  return visible;
}

function conversationTranscriptMessages(messages) {
  return conversationTranscriptEntries(messages).map(({ role, text }) => ({ role, text }));
}

function encode({ role, text }, draft = false) {
  return JSON.stringify(draft ? { role, text, done: false } : { role, text });
}

function eligible(row, id) {
  if (!row || row.id !== id || row.deleted) return false;
  const data = mergeNativeEvidence(JSON.parse(row.data));
  return !data.cached && !data.source && !data.sourceLocalId && !data.sourceSessionId && !data.sourceClientId &&
    !data.importDigest && !data.importedHistory && !data.deviceTransferId && !data.historyProtection &&
    !data.workOnly && data.adapterId !== 'account-sync' && (!data.location || data.location === 'local') &&
    (!data.locationMode || data.locationMode === 'local');
}

function hash(previous, data) {
  return crypto.createHash('sha256').update(previous).update(data).digest('hex');
}

function entriesDigest(entries, includeDraftState = false) {
  return entries.reduce((digest, entry) => hash(digest, encode(entry, includeDraftState && entry.done === false)), '');
}

// The caller has aligned the two representations. Keep both commitments since
// the independent dialogue and native history can split assistant text differently.
function recoveryTail(dialogue, verifiedNativeMessages) {
  const prefix = conversationTranscriptMessages(verifiedNativeMessages);
  if (!prefix.length || dialogue.at(-1)?.role !== 'user') return null;
  return { digest: entriesDigest(dialogue, true), prefixDigest: entriesDigest(prefix), prefixLength: prefix.length };
}

function create(db, exact, transaction) {
  const tail = db.prepare('SELECT position,data FROM conversation_transcript WHERE replica=? ORDER BY position DESC LIMIT 1');
  const storedPrefix = db.prepare('SELECT digest FROM conversation_transcript WHERE replica=? AND position=?');
  const tipDigest = db.prepare('SELECT digest FROM conversation_transcript WHERE replica=? ORDER BY position DESC LIMIT 1');
  const write = db.prepare(`INSERT INTO conversation_transcript(replica,position,data,digest) VALUES(?,?,?,?)
    ON CONFLICT(replica,position) DO UPDATE SET data=excluded.data,digest=excluded.digest
    WHERE conversation_transcript.digest<>excluded.digest`);
  const select = db.prepare('SELECT position,data,digest FROM conversation_transcript WHERE replica=? ORDER BY position');

  function saveConversationTranscript(id, messages, { expectedRevision, expectedCatalogRevision, expectedTransferId, pendingTailDigest } = {}) {
    const next = conversationTranscriptEntries(messages);
    const bytes = next.reduce((sum, message) => sum + Buffer.byteLength(message.text), 0);
    if (bytes > 128 * 1024 * 1024) throw Error('Conversation transcript exceeds the local history limit');
    return transaction(() => {
      const row = exact(id);
      if (!eligible(row, id) || expectedTransferId !== '' || row.revision !== expectedRevision ||
          row.catalog_revision !== expectedCatalogRevision) return { ok: false, stale: true };
      // Retyping the exact old text can make the optimistic display look like
      // a valid append. Its first native receipt still owns this replacement.
      if (pendingTailDigest && tipDigest.get(id)?.digest === pendingTailDigest) return { ok: true, unchanged: true };
      if (!next.length) return { ok: true, unchanged: true };
      const last = tail.get(id), start = last?.position || 0;
      if (last && next.length <= start) return { ok: false, diverged: true };
      let digest = '';
      // The prefix digest verifies every preceding message without rereading
      // their text from SQLite or rewriting rows on each streaming update.
      for (let i = 0; i < start; i++) digest = hash(digest, encode(next[i]));
      if (start && digest !== storedPrefix.get(id, start - 1)?.digest) return { ok: false, diverged: true };
      const old = last ? JSON.parse(last.data) : null;
      if (old) {
        if (hash(digest, last.data) !== storedPrefix.get(id, start)?.digest) throw Error('Conversation transcript checksum mismatch');
        const current = next[start];
        // Pi's terminal event may correct or hide an earlier displayed draft.
        // Only the explicit streaming tail can settle to different text. A
        // new user message also proves that a now-hidden draft's turn ended.
        const settledDraft = old.done === false && (current.done === true || current.role === 'user' || start < next.length - 1);
        const extendsText = old.role === current.role && (old.text === current.text ||
          (old.role === 'assistant' && current.text.startsWith(old.text)));
        if (!extendsText && !settledDraft) return { ok: false, diverged: true };
      }
      for (let i = start; i < next.length; i++) {
        const draft = i === next.length - 1 && next[i].done === false && (i !== start || !old || old.done === false);
        const data = encode(next[i], draft);
        digest = hash(digest, data);
        write.run(id, i, data, digest);
      }
      return { ok: true };
    });
  }

  function conversationTranscript(id, { includeDraftState = false } = {}) {
    if (!eligible(exact(id), id)) return [];
    const messages = [];
    let digest = '';
    for (const row of select.iterate(id)) {
      digest = hash(digest, row.data);
      if (row.position !== messages.length || row.digest !== digest)
        throw Object.assign(Error('Conversation transcript checksum mismatch'), { code: 'TRANSCRIPT_CHECKSUM_MISMATCH' });
      const { role, text, done } = JSON.parse(row.data);
      messages.push({ role, text, ...(includeDraftState && done === false ? { done } : {}) });
    }
    return messages;
  }
  // Called inside the native archive transaction. A changed input is allowed
  // only if both the original dialogue and the newly signed prefix still match.
  function reconcileNativeTail(id, marker, messages) {
    if (!Number.isSafeInteger(marker.prefixLength) || marker.prefixLength < 1) return;
    if (tipDigest.get(id)?.digest !== marker.digest) return;
    const old = conversationTranscript(id, { includeDraftState: true });
    if (old.at(-1)?.role !== 'user') return;
    const next = conversationTranscriptEntries(messages);
    if (next[marker.prefixLength]?.role !== 'user' ||
        entriesDigest(next.slice(0, marker.prefixLength)) !== marker.prefixDigest) return;
    let digest = '';
    let changed = false;
    for (let i = 0; i < next.length; i++) {
      const draft = i === next.length - 1 && next[i].done === false;
      const data = encode(next[i], draft);
      digest = hash(digest, data);
      if (!changed) changed = old[i]?.role !== next[i].role || old[i].text !== next[i].text || (old[i].done === false) !== draft;
      if (changed) write.run(id, i, data, digest);
    }
    if (next.length < old.length)
      db.prepare('DELETE FROM conversation_transcript WHERE replica=? AND position>=?').run(id, next.length);
  }
  function conversationTranscriptDigest(id) {
    return eligible(exact(id), id) ? tipDigest.get(id)?.digest : undefined;
  }
  return { saveConversationTranscript, conversationTranscript, conversationTranscriptDigest, reconcileNativeTail };
}

module.exports = { conversationTranscriptEntries, conversationTranscriptMessages, recoveryTail, create };
