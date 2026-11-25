'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

// A full history projection can invoke discovery, replay tools, or parse a
// large archive. The first turn only needs its exact native user record.
async function received({ app, session, row, owner, guard, runner }) {
  const publicId = row.sessionId, submission = row.nativeSubmissionId || row.attemptId || row.intentId;
  guard();
  if (row.workflowRun || row.turn?.plugins?.length) {
    const root = path.join(app.getPath('userData'), 'plugin-debug-runs');
    const { store } = require('../personal-plugin-debug');
    const receipt = store(path.join(root, 'requests'), owner + ':' + publicId + ':' + submission).read();
    const record = receipt?.runId && store(path.join(root, 'archive'), receipt.runId).read();
    if (record?.conversationId === publicId && record.requestId === submission && record.owner === owner &&
        record.mode === 'conversation' && record.id === receipt.runId) return true;
  }
  const { adapterId, sessionId: id } = row.receiptTarget || row;
  if (adapterId !== 'pi') {
    const runtime = runner || require('../runner-runtime');
    const reply = await runtime.rpc('job.session', { ref: id, since: 0, limit: 100, historyRead: true }, 15000);
    guard();
    return reply?.ok === true && reply.data?.ok !== false && (!reply.data?.ref || reply.data.ref === id) &&
      Array.isArray(reply.data?.items) && reply.data.items.some(item => item?.kind === 'user' && item.submissionId === submission);
  }
  const found = await session.historyEntry(app, id, { strict: true }); guard();
  if (!found?.ok || found.entry?.id !== id || !found.entry.path) return false;
  const source = await require('../app-readonly-history.cjs').plainArchivePath(path.join(app.getPath('userData'), 'pi-agent'), found.entry.path);
  // Stop on the matching user entry. An unavailable or exceptionally long
  // header yields no proof and leaves the original intent recoverable.
  const input = fs.createReadStream(source, { encoding: 'utf8', end: 128 * 1024 * 1024 - 1 });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let header = true;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      if (header) {
        const row = JSON.parse(line);
        if (row.type !== 'session' || row.id !== id) return false;
        header = false; continue;
      }
      if (!line.includes(submission)) continue;
      const item = JSON.parse(line);
      if (item.type === 'message' && item.message?.role === 'user' && item.message.submissionId === submission) {
        guard(); return true;
      }
    }
    return false;
  } finally { lines.close(); input.destroy(); }
}

module.exports = { received };
