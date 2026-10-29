'use strict';

/*
 * A small, transport-neutral description of files changed by one local turn.
 *
 * The execution adapters deliberately do not need to know whether a model
 * used an edit tool, a shell command, or a generated script.  We take a
 * bounded workspace snapshot before and after the turn and compare the
 * snapshots here.  The result is consumed by the UI and by cloud delivery;
 * it is not used to decide whether a turn succeeded.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

const SCHEMA_VERSION = 1;
const DEFAULTS = Object.freeze({
  maxFiles: 2000,
  maxDepth: 6,
  maxTextBytes: 1024 * 1024,
  maxHashBytes: 32 * 1024 * 1024,
  maxTotalTextBytes: 8 * 1024 * 1024,
});
const SKIP_DIRS = new Set([
  '.git', '.hg', '.svn', '.pi', 'node_modules', '__pycache__',
  '.venv', 'node-compile-cache', 'skills',
]);
const SKIP_EXT = new Set(['.tmp', '.part', '.crdownload', '.swp']);

function options(raw) { return { ...DEFAULTS, ...(raw || {}) }; }

function throwIfAborted(signal) {
  if (!signal || !signal.aborted) return;
  const error = new Error('Workspace file snapshot was cancelled');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  throw error;
}

function ignored(name) {
  return !name || name.startsWith('.') || name.startsWith('~$') ||
    SKIP_DIRS.has(name) || SKIP_EXT.has(path.extname(name).toLowerCase());
}

function safeRelative(root, full) {
  const rel = path.relative(root, full).split(path.sep).join('/');
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : '';
}

function isBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  for (const byte of sample) if (byte === 0) return true;
  return false;
}

function hash(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }

async function readFileRecord(root, full, relative, stat, opts, budget) {
  throwIfAborted(opts.signal);
  const base = {
    path: relative,
    size: Number(stat.size) || 0,
    mtimeMs: Number(stat.mtimeMs) || 0,
    exists: true,
    isBinary: false,
    text: null,
    textTruncated: false,
  };
  // Large binaries are represented by metadata only.  This keeps a turn
  // snapshot from blocking the Electron main process or crossing IPC limits.
  if (base.size > opts.maxHashBytes) {
    base.hash = `meta:${base.size}:${base.mtimeMs}`;
    base.textTruncated = true;
    return base;
  }
  let bytes;
  try { bytes = await fsp.readFile(full, opts.signal ? { signal: opts.signal } : undefined); }
  catch (_) { throwIfAborted(opts.signal); return null; }
  base.hash = hash(bytes);
  base.isBinary = isBinary(bytes);
  if (!base.isBinary && base.size <= opts.maxTextBytes && budget.used + bytes.length <= opts.maxTotalTextBytes) {
    base.text = bytes.toString('utf8');
    budget.used += bytes.length;
  } else if (!base.isBinary && base.size <= opts.maxTextBytes) {
    base.textTruncated = true;
  }
  return base;
}

async function walk(root, opts) {
  const files = new Map();
  const budget = { used: 0 };
  let truncated = false;
  async function visit(dir, depth) {
    throwIfAborted(opts.signal);
    if (depth > opts.maxDepth || files.size >= opts.maxFiles) {
      truncated = true;
      return;
    }
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch (_) { throwIfAborted(opts.signal); return; }
    // Process files before descending into folders.  A cache directory must
    // not consume the complete cap before a report beside it is indexed.
    for (const ent of entries) {
      throwIfAborted(opts.signal);
      if (files.size >= opts.maxFiles) { truncated = true; break; }
      if (!ent.isFile() || ignored(ent.name)) continue;
      const full = path.join(dir, ent.name);
      const relative = safeRelative(root, full);
      if (!relative) continue;
      let stat;
      try { stat = await fsp.stat(full); }
      catch (_) { throwIfAborted(opts.signal); continue; }
      const record = await readFileRecord(root, full, relative, stat, opts, budget);
      if (record) files.set(relative, record);
    }
    if (files.size >= opts.maxFiles) { truncated = true; return; }
    for (const ent of entries) {
      throwIfAborted(opts.signal);
      if (!ent.isDirectory() || ignored(ent.name)) continue;
      // Symlinks are not Dirent directories, so they cannot escape cwd.
      await visit(path.join(dir, ent.name), depth + 1);
      if (files.size >= opts.maxFiles) { truncated = true; break; }
    }
  }
  await visit(root, 0);
  return { files, truncated };
}

async function snapshot(cwd, rawOptions) {
  const opts = options(rawOptions);
  throwIfAborted(opts.signal);
  if (!String(cwd || '').trim()) {
    return { schemaVersion: SCHEMA_VERSION, cwd: '', files: {}, truncated: false, capturedAt: Date.now() };
  }
  let root;
  try { root = await fsp.realpath(path.resolve(String(cwd || ''))); } catch (_) {
    throwIfAborted(opts.signal);
    return { schemaVersion: SCHEMA_VERSION, cwd: '', files: {}, truncated: false, capturedAt: Date.now() };
  }
  let stat;
  try { stat = await fsp.stat(root); }
  catch (_) {
    throwIfAborted(opts.signal);
    return { schemaVersion: SCHEMA_VERSION, cwd: root, files: {}, truncated: false, capturedAt: Date.now() };
  }
  if (!stat.isDirectory()) return { schemaVersion: SCHEMA_VERSION, cwd: root, files: {}, truncated: false, capturedAt: Date.now() };
  const walked = await walk(root, opts);
  throwIfAborted(opts.signal);
  const files = {};
  for (const [relative, record] of walked.files) files[relative] = record;
  return { schemaVersion: SCHEMA_VERSION, cwd: root, files, truncated: walked.truncated, capturedAt: Date.now() };
}

function publicRecord(record) {
  if (!record) return null;
  const { path: filePath, size, mtimeMs, exists, isBinary, hash: digest, text, textTruncated } = record;
  return { path: filePath, size, mtimeMs, exists, isBinary, hash: digest, text, textTruncated };
}

function compare(before, after, metadata = {}) {
  const left = before?.files || {}, right = after?.files || {};
  const names = new Set([...Object.keys(left), ...Object.keys(right)]);
  const files = [];
  const deleted = [];
  const created = [];
  for (const relative of [...names].sort((a, b) => a.localeCompare(b))) {
    const oldFile = left[relative] || null;
    const newFile = right[relative] || null;
    if (oldFile && newFile && oldFile.hash === newFile.hash) continue;
    const action = !oldFile ? 'created' : !newFile ? 'deleted' : 'modified';
    const row = { path: relative, action, before: publicRecord(oldFile), after: publicRecord(newFile) };
    files.push(row);
    if (action === 'created') created.push(row);
    if (action === 'deleted') deleted.push(row);
  }
  // A same-content delete/create pair is a rename.  Keep the destination in
  // `path`, retain the original path explicitly, and leave unrelated pairs
  // as ordinary creates/deletes.  This avoids claiming a rename when two
  // files merely happen to contain identical content.
  const renamed = [];
  for (const oldRow of deleted) {
    const index = created.findIndex(newRow => oldRow.before?.hash &&
      oldRow.before.hash === newRow.after?.hash);
    if (index < 0) continue;
    const newRow = created[index];
    renamed.push({
      path: newRow.path,
      previousPath: oldRow.path,
      action: 'renamed',
      before: oldRow.before,
      after: newRow.after,
    });
    files.splice(files.indexOf(oldRow), 1);
    files.splice(files.indexOf(newRow), 1);
  }
  files.push(...renamed);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    schemaVersion: SCHEMA_VERSION,
    cwd: String(after?.cwd || before?.cwd || metadata.cwd || ''),
    turnId: String(metadata.turnId || ''),
    capturedAt: Date.now(),
    truncated: Boolean(before?.truncated || after?.truncated),
    files,
    stats: {
      created: files.filter(file => file.action === 'created').length,
      modified: files.filter(file => file.action === 'modified').length,
      deleted: files.filter(file => file.action === 'deleted').length,
      renamed: files.filter(file => file.action === 'renamed').length,
      total: files.length,
    },
  };
}

async function capture(cwd, turnId, fn, rawOptions) {
  const before = await snapshot(cwd, rawOptions);
  let value, error;
  try { value = await fn(); } catch (err) { error = err; }
  const after = await snapshot(cwd, rawOptions);
  const changes = compare(before, after, { turnId });
  if (error) { error.fileChanges = changes; throw error; }
  return { value, changes };
}

module.exports = {
  SCHEMA_VERSION,
  DEFAULTS,
  snapshot,
  compare,
  capture,
  _isBinary: isBinary,
};
