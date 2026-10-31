'use strict';

// Storage-only SDK access belongs to the runtime too. A plan carries no model
// configuration and cannot be used to append to an arbitrary archive.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const ENTRY_TYPE = 'soduwork.work-entry';
const PLAN_TTL_MS = 120000, MAX_PLANS = 512;
const plans = new Map();
function denied() { return Object.assign(Error('会话存储计划无效或已过期，请重新创建'), { code: 'INVALID_ARCHIVE_PLAN' }); }
function inside(root, target) {
  const relative = path.relative(root, target);
  return Boolean(relative) && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function plainPath(root, target) {
  if (target !== root && !inside(root, target)) throw denied();
  let current = root;
  for (const part of ['', ...path.relative(root, target).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw denied(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function roots(app) {
  const userData = path.resolve(app.getPath('userData'));
  const agentDir = path.join(userData, 'pi-agent'), root = path.join(agentDir, 'sessions');
  plainPath(userData, root);
  return { userData, agentDir, root };
}
function safeFile(app, file) {
  const { userData, root } = roots(app), target = path.resolve(file || '');
  if (!path.isAbsolute(file || '') || !inside(root, target) || path.extname(target) !== '.jsonl') throw denied();
  plainPath(userData, target);
  return target;
}
async function storageSdk(app) {
  for (const entry of require('../pi-session/session-helpers').entryCandidates(app)) {
    const file = path.join(path.dirname(entry), 'core', 'session-manager.js');
    if (fs.existsSync(file)) return import(pathToFileURL(file).href);
  }
  throw Error('会话存储组件未安装，请修复客户端后重试');
}
function descriptor(row) {
  return { id: row.id, file: row.file, header: structuredClone(row.header), title: row.title, owner: row.owner, nonce: row.nonce };
}
function find(app, supplied) {
  if (!supplied || typeof supplied.nonce !== 'string') throw denied();
  const row = plans.get(supplied.nonce);
  if (!row || row.root !== path.resolve(app.getPath('userData'))) throw denied();
  if (Date.now() - row.createdAt >= PLAN_TTL_MS) { plans.delete(row.nonce); throw denied(); }
  if (JSON.stringify(descriptor(row)) !== JSON.stringify({ id: supplied.id, file: supplied.file,
    header: supplied.header, title: supplied.title, owner: supplied.owner, nonce: supplied.nonce })) throw denied();
  safeFile(app, row.file);
  return row;
}
function readOwned(row) {
  const stat = fs.lstatSync(row.file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 256 * 1024) throw denied();
  // NTFS file ids can repeat for a recreated path, so the committed byte size
  // carries the replacement detection on platforms where dev/ino repeat.
  if (row.fileIdentity && (stat.dev !== row.fileIdentity.dev || stat.ino !== row.fileIdentity.ino ||
      (row.fileIdentity.size !== undefined && stat.size !== row.fileIdentity.size))) throw denied();
  const bytes = fs.readFileSync(row.file);
  if (!bytes.subarray(0, row.headerBytes.length).equals(row.headerBytes)) throw denied();
  return { stat, bytes };
}
async function plan(app, cwd, title, owner) {
  if (!path.isAbsolute(cwd || '') || typeof title !== 'string' || title.length > 500 ||
      !/^[a-f0-9]{32}$/.test(String(owner || ''))) throw denied();
  const base = roots(app);
  const sdk = await storageSdk(app);
  roots(app);
  for (const [key, row] of plans) if (Date.now() - row.createdAt >= PLAN_TTL_MS) plans.delete(key);
  if (plans.size >= MAX_PLANS) throw Error('待创建的会话过多，请稍后重试');
  const manager = sdk.SessionManager.create(cwd, sdk.getDefaultSessionDir(cwd, base.agentDir));
  const file = safeFile(app, manager.getSessionFile()), id = manager.getSessionId();
  if (fs.existsSync(file)) throw denied();
  const header = structuredClone(manager.getHeader());
  if (!header || header.type !== 'session' || header.id !== id) throw denied();
  const row = { root: base.userData, id, file, header, title, owner,
    nonce: crypto.randomBytes(32).toString('hex'), createdAt: Date.now(), state: 'planned',
    headerBytes: Buffer.from(JSON.stringify(header) + '\n') };
  plans.set(row.nonce, row);
  return descriptor(row);
}
async function commit(app, supplied) {
  const row = find(app, supplied);
  if (row.state !== 'planned') throw denied();
  row.state = 'committing';
  try {
    const sdk = await storageSdk(app);
    find(app, supplied);
    const owned = readOwned(row);
    if (!owned.bytes.equals(row.headerBytes)) throw denied();
    row.fileIdentity = { dev: owned.stat.dev, ino: owned.stat.ino };
    const manager = sdk.SessionManager.open(row.file);
    if (manager.getSessionId() !== row.id || JSON.stringify(manager.getHeader()) !== JSON.stringify(row.header)) throw denied();
    manager.appendSessionInfo(row.title);
    manager.appendCustomEntry(ENTRY_TYPE, { version: 1, owner: row.owner });
    row.state = 'committed';
    const committed = readOwned(row);
    row.fileIdentity = { dev: committed.stat.dev, ino: committed.stat.ino, size: committed.stat.size };
    row.digest = crypto.createHash('sha256').update(committed.bytes).digest('hex');
    return { id: row.id, file: row.file, committed: true, sha256: row.digest };
  } catch (error) { row.state = 'failed'; throw error; }
}
function abandon(app, supplied) {
  const row = find(app, supplied);
  if (row.state === 'committing') throw denied();
  try {
    const owned = readOwned(row);
    const digest = crypto.createHash('sha256').update(owned.bytes).digest('hex');
    if (!owned.bytes.equals(row.headerBytes) && (!row.digest || digest !== row.digest)) throw denied();
    fs.unlinkSync(row.file);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  finally { plans.delete(row.nonce); }
  return { id: row.id, abandoned: true };
}

module.exports = { plan, commit, abandon, PLAN_TTL_MS };
