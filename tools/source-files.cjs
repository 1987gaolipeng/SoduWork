"use strict";
// Source archives must never inherit a parent checkout's Git index.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const MANIFEST = 'tools/distribution/SOURCE-MANIFEST.json';
function snapshotFiles(root) {
  const file = path.join(root, MANIFEST);
  if (!fs.existsSync(file)) return null;
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (manifest.schema !== 1 || manifest.ok !== true ||
      !String(manifest.scope).startsWith('Current source snapshot only;') ||
      !Array.isArray(manifest.files) || !manifest.files.length) throw Error('Invalid source snapshot manifest');
  const files = new Set();
  for (const entry of manifest.files) {
    const name = entry.path;
    if (typeof name !== 'string' || !name || name.includes('\\') || name.includes(':') ||
        name.startsWith('/') || name.split('/').some(x => !x || x === '.' || x === '..') ||
        !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || files.has(name)) {
      throw Error('Invalid source snapshot entry');
    }
    files.add(name);
  }
  return [...files].sort();
}
function sourceFiles(root) {
  root = path.resolve(root);
  // Worktrees have a .git file; ordinary clones have a .git directory.
  if (fs.existsSync(path.join(root, '.git'))) {
    return [...new Set(execFileSync(process.platform === 'win32' ? 'git.exe' : 'git',
      ['ls-files', '-co', '--exclude-standard', '-z'],
      { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).split('\0').filter(name => name && name !== MANIFEST))].sort();
  }
  const files = snapshotFiles(root);
  if (!files) throw Error('Source checkout has neither its own .git nor tools/distribution/SOURCE-MANIFEST.json');
  for (const name of files) {
    let current = root;
    for (const part of name.split('/')) {
      current = path.join(current, part);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw Error('Snapshot contains a symbolic link: ' + name);
    }
    if (!fs.statSync(current).isFile()) throw Error('Snapshot file is missing: ' + name);
  }
  return files;
}
function snapshotApprovals(root, entries) {
  const snapshot = snapshotFiles(root);
  if (!snapshot) return entries;
  // Apply approvals to included paths and files added after importing an archive.
  const files = new Set([...snapshot, ...sourceFiles(root)]);
  return entries.filter(entry => files.has(entry.file));
}
module.exports = { sourceFiles, snapshotFiles, snapshotApprovals };
