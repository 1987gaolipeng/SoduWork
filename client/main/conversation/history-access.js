'use strict';

// Local archives survive device account changes. Their persisted owner, never
// the device or the presence of a live runtime, determines who may read them.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const runtime = require('../platform-connections/runtime.cjs');
function actor(app, identity) {
  const auth = require('../device-auth');
  if (identity === undefined) identity = require('./requirement-context').cachedIdentity(app);
  let owner = '';
  try { owner = runtime.scope(identity); } catch (_) { owner = auth.localOwner(app); }
  return { identity, owner, candidates: auth.profiles(app) };
}
function saved(app, directory, id) {
  const file = path.join(app.getPath('userData'), directory,
    crypto.createHash('sha256').update(String(id)).digest('hex') + '.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function assertOwner(app, id, captured = actor(app), row = {}) {
  if (!id || !captured.owner) throw Error('请先登录 SoduWork 后查看会话');
  const records = ['session-memory-bindings', 'requirement-session-context', 'conversation-runtime-segments']
    .map(directory => saved(app, directory, id)).filter(Boolean);
  const owners = records.map(record => record.owner);
  if (row.workOwner) owners.push(row.workOwner);
  const cloud = saved(app, 'conversation-handoffs', id);
  if (cloud) {
    if (cloud.sessionId !== id || !cloud.owner || cloud.owner !== runtime.connectionScope(captured.identity))
      throw Error('这条云端会话属于其他账号或服务，请切回原连接');
    // A verified cloud receipt also owns a remote-only conversation.
    if (!owners.length) return;
  }
  if (!owners.length || owners.some(owner => !owner || (owner !== captured.owner &&
      !runtime.scopeMatches(owner, captured.identity, captured.candidates))))
    throw Error('无法确认这条会话属于当前账号，请切回原账号');
}
function visible(app, rows, identity) {
  const captured = actor(app, identity);
  return rows.filter(row => {
    try { assertOwner(app, row.sessionId || row.id, captured, row); return true; }
    catch (_) { return false; }
  }).map(row => { const { workOwner, ...visible } = row; return visible; });
}
function assertCurrent(app, captured) {
  const current = actor(app);
  if (!captured.owner || current.owner !== captured.owner)
    throw Error('账号已切换，请在当前账号重新打开会话');
}
module.exports = { actor, assertOwner, assertCurrent, visible };
