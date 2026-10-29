'use strict';

/* Durable archive flags for local Pi conversations.
   The transcript stays in Pi's managed sessions directory so restore/resume
   keeps working. This file contains only ids and timestamps, never messages. */
const fs = require('node:fs');
const path = require('node:path');

const VERSION = 1;
const FILE_NAME = 'archive-state.json';

function location(root) {
  if (typeof root !== 'string' || !root.trim()) throw new Error('会话存档目录无效');
  return path.join(path.resolve(root), FILE_NAME);
}

function normalize(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const conversations = {};
  const input = source.conversations && typeof source.conversations === 'object'
    ? source.conversations : {};
  Object.keys(input).forEach((id) => {
    if (!id || id.length > 512) return;
    const at = Number(input[id]);
    if (Number.isFinite(at) && at > 0) conversations[id] = at;
  });
  return { version: VERSION, conversations };
}

function read(root) {
  try { return normalize(JSON.parse(fs.readFileSync(location(root), 'utf8'))); }
  catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
    return { version: VERSION, conversations: {} };
  }
}

function write(root, state) {
  const file = location(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(normalize(state), null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try { fs.renameSync(temp, file); }
  finally { try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch (_) {} }
}

function isArchived(root, id) {
  const wanted = String(id || '').trim();
  return Boolean(wanted && read(root).conversations[wanted]);
}

function setArchived(root, id, archived) {
  const wanted = String(id || '').trim();
  if (!wanted || wanted.length > 512) throw new Error('会话标识无效');
  const state = read(root);
  if (archived) state.conversations[wanted] = Date.now();
  else delete state.conversations[wanted];
  write(root, state);
  return state.conversations[wanted] || 0;
}

function archivedAt(root, id) {
  const wanted = String(id || '').trim();
  return Number(read(root).conversations[wanted] || 0);
}

function remove(root, id) {
  const wanted = String(id || '').trim();
  if (!wanted) return;
  const state = read(root);
  delete state.conversations[wanted];
  write(root, state);
}

module.exports = { VERSION, FILE_NAME, location, normalize, read, write, isArchived, setArchived, archivedAt, remove };
