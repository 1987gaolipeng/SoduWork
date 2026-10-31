'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

// One main-process writer. Each newline-delimited checkpoint is independently
// verifiable. A torn final write cannot destroy the previous acknowledged state.
function load(directory) {
  let state = null;
  try {
    const lines = fs.readFileSync(path.join(directory, 'release-notes-state.jsonl'), 'utf8').split('\n');
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        if (typeof record.payload === 'string' && digest(record.payload) === record.sha256) {
          const candidate = JSON.parse(record.payload);
          if (candidate.schema === 1) state = candidate;
        }
      } catch (_) { /* Incomplete checkpoint; retain the last valid one. */ }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return state;
}
function save(directory, state) {
  fs.mkdirSync(directory, { recursive: true });
  const payload = JSON.stringify(state);
  // Leading newline also separates a previously interrupted partial record.
  const record = '\n' + JSON.stringify({ payload, sha256: digest(payload) }) + '\n';
  const fd = fs.openSync(path.join(directory, 'release-notes-state.jsonl'), 'a', 0o600);
  try { fs.writeFileSync(fd, record, 'utf8'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
module.exports = { load, save };
