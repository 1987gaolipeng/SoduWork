'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { epoch } = require('./message-time');
const { resolveToolPath } = require('../access-control/policy');
const { portablePath } = require('./portable-workspace');
const { publishedDirectory } = require('./delivery-workspace.cjs');

// v1.13.19 did not persist Pi's workspace journal. A completed native write
// supplies the exact expected bytes, even for an explicitly selected project.
// Only completed calls in the current workspace can supply file identities.
function evidence(entries, row, revision) {
  let cwd = entries[0].cwd, moved = false, lastMessage;
  const calls = new Map(), written = new Map();
  for (const entry of entries) {
    if (entry.type === 'custom' && entry.customType === 'soduwork.workspace.moved' &&
        entry.data?.version === 1 && entry.data.cwd) {
      cwd = entry.data.cwd;
      moved = true;
      calls.clear();
      written.clear();
    }
    if (entry.type !== 'message' || !entry.message) continue;
    const message = entry.message;
    lastMessage = entry;
    if (message.role === 'user') calls.clear();
    if (message.role === 'assistant' && !['error', 'aborted', 'length'].includes(message.stopReason)) {
      for (const call of Array.isArray(message.content) ? message.content : []) {
        if (call?.type !== 'toolCall' || !call.id || call.name !== 'write') continue;
        const { path: target, content } = call.arguments || {};
        if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || typeof target !== 'string' || !target ||
            target.split(/[\\/]/).includes('..') || typeof content !== 'string') continue;
        try {
          const relative = portablePath(path.relative(cwd, resolveToolPath('write', target, cwd)).split(path.sep).join('/'));
          const [parent, key] = relative.split('/');
          if (!publishedDirectory(cwd, path.join(cwd, parent), key)) calls.set(call.id, { relative, content });
        } catch (_) { /* The native target must resolve to a portable path in this workspace. */ }
      }
    }
    if (message.role !== 'toolResult') continue;
    const call = calls.get(message.toolCallId);
    calls.delete(message.toolCallId);
    if (!call || message.toolName !== 'write' || message.isError !== false ||
        message.details?.soduWorkAccessChange?.state === 'cancelled') continue;
    const { relative, content } = call;
    written.set(relative, { action: 'modified', path: relative, after: { path: relative, exists: true,
      size: Buffer.byteLength(content), hash: crypto.createHash('sha256').update(content).digest('hex') } });
  }
  if (!cwd || cwd !== row.cwd || !path.isAbsolute(cwd)) return {};
  const localJournal = written.size ? { cwd, turnId: 'pi-archive:' + revision, files: [...written.values()] } : undefined;
  // A scratch ref in the old local replica is independent of the archive's
  // cwd. Both must agree before inventorying shell-generated or binary files.
  // Explicit projects and moved/resumed scratch refs get only verified writes.
  const ended = epoch(lastMessage?.timestamp), started = epoch(entries[0].timestamp);
  const localWorkspace = !moved && row.ref === path.basename(cwd) && started && ended >= started &&
    lastMessage?.message.role === 'assistant' && lastMessage.message.stopReason === 'stop'
    ? { id: row.id, cwd, taskId: row.ref, started, ended } : undefined;
  return { localJournal, localWorkspace };
}

module.exports = { evidence };
