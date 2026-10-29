'use strict';
// User labels are presentation metadata, never task titles or agent transcripts.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const caches = new Map();

function location(app, id) {
  if (typeof id !== 'string' || !id.trim() || id.length > 512) throw Error('会话标识无效');
  const root = path.join(app.getPath('userData'), 'conversation-titles');
  return path.join(root, crypto.createHash('sha256').update(id).digest('hex') + '.json');
}
function normalize(title) {
  if (typeof title !== 'string') throw Error('请输入会话名称');
  const value = title.replace(/\s+/g, ' ').trim();
  if (!value) throw Error('会话名称不能为空');
  if (Array.from(value).length > 120) throw Error('会话名称最多 120 个字符');
  return value;
}
function read(app, id) {
  if (!app || !id) return null;
  const file = location(app, id);
  if (caches.has(file)) return caches.get(file);
  let record = null;
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.id === id) record = { title: normalize(saved.title), titleUpdatedAt: Number(saved.titleUpdatedAt) || 0 };
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[conversation-titles] Could not load saved name:', error.message);
  }
  caches.set(file, record);
  return record;
}
function decorate(app, row) {
  if (!row) return row;
  const saved = read(app, row.id || row.sessionId);
  return saved ? { ...row, ...saved, customTitle: saved.title } : row;
}
function save(app, id, rawTitle) {
  const file = location(app, id), title = normalize(rawTitle);
  const previous = read(app, id);
  const record = { id, title, titleUpdatedAt: Math.max(Date.now(), (previous?.titleUpdatedAt || 0) + 1) };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(record), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  caches.set(file, record);
  return { ...record, customTitle: title };
}
function remove(app, id) {
  const file = location(app, id);
  caches.delete(file);
  try { fs.unlinkSync(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
module.exports = { decorate, save, remove, normalize };
