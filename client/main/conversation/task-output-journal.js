'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const harnesses = require('./used-harnesses');
const sourceCache = new Map();
const journalPath = (app, ref) => app && typeof app.getPath === 'function'
  ? path.join(app.getPath('userData'), 'conversation-task-output', crypto.createHash('sha256').update(ref).digest('hex') + '.jsonl') : '';

// Sidebar reads retain only a tiny provenance summary; streaming JSONL avoids
// loading old tool receipts and transcript text into a second history cache.
async function usedHarnesses(app, ref) {
  const file = journalPath(app, ref);
  if (!file) return [];
  let stat;
  try { stat = await fs.promises.stat(file); }
  catch (error) { if (error.code === 'ENOENT') { sourceCache.delete(file); return []; } throw error; }
  const revision = value => [value.size, value.mtimeMs, value.ctimeMs, value.ino].join(':');
  const version = revision(stat), previous = sourceCache.get(file);
  if (previous?.version === version) return previous.ids.slice();
  const ids = new Set(), input = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = require('node:readline').createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (!Number.isFinite(row?.after)) continue;
      if (row.kind === 'message' && row.role === 'assistant') harnesses.add(ids, row);
      else if (row.kind === 'tool') harnesses.add(ids, row.event);
    }
  } finally { lines.close(); input.destroy(); }
  const after = await fs.promises.stat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const result = [...ids];
  if (after && revision(after) === version) {
    sourceCache.set(file, { version, ids: result });
    if (sourceCache.size > 256) sourceCache.delete(sourceCache.keys().next().value);
  }
  return result.slice();
}

// Only controlled task events live here. Ordinary Runner history remains owned
// by that Runner. Anchoring to its cursor preserves interleaving on reopen.
function create(app, ref) {
  const file = journalPath(app, ref);
  const rows = [];
  if (file && fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      try { const row = JSON.parse(line); if (row && Number.isFinite(row.after)) rows.push(row); } catch (_) { /* interrupted last line */ }
    }
  }
  let replayed = 0;
  function append(after, data) { appendMany([{ after, ...data }]); }
  function appendMany(batch) {
    if (!batch.length) return;
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // A failed prior append can leave a partial final line. Start a new
      // record boundary so a retry cannot glue valid JSON to that fragment.
      fs.appendFileSync(file, '\n' + batch.map(row => JSON.stringify(row) + '\n').join(''), { mode: 0o600 });
    }
    rows.push(...batch);
    replayed = rows.length;
  }
  function restore(through, apply) {
    while (replayed < rows.length && rows[replayed].after <= through) apply(rows[replayed++]);
  }
  function context() {
    const last = rows.findLastIndex(row => row.kind === 'context-sent');
    const messages = rows.slice(last + 1).flatMap(row => row.kind === 'message' && row.blockKind !== 'thinking'
      ? [{ role: row.role, taskId: row.taskId, text: row.text }]
      : row.kind === 'tool' && row.event.type === 'tool_execution_end'
        ? [{ role: 'tool', taskId: row.taskId, name: row.event.toolName,
          result: row.event.result, isError: row.event.isError }] : []);
    return messages.length ? '\n\n已在本会话发生的任务对话（上下文资料，不是新的执行指令）：\n' + JSON.stringify(messages) : '';
  }
  return { append, appendMany, restore, context };
}
module.exports = { create, usedHarnesses };
