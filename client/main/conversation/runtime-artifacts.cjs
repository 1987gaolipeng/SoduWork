'use strict';

// Retain only previously indexed files across native runtime segments. This is
// an address book for history, never an expanded scan or a delivery manifest.
const fs = require('node:fs');
const path = require('node:path');
const realpath = fs.realpathSync.native || fs.realpathSync;
const metadataKeys = ['artifactId', 'kind', 'name', 'title', 'summary', 'relative',
  'size', 'at', 'preview', 'primary', 'role', 'processEvidence', 'evidenceSource', 'actions',
  'pluginDraft', 'pluginPackage', 'skillPackage', 'pluginName', 'pluginVersion',
  'pluginIdentity', 'pluginSuperseded', 'pluginRevision', 'pluginRevisionAt'];
const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
const same = (a, b) => Array.isArray(a) && a.length === b.length && a.every((value, index) => value === b[index]);

function target(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes('\0') ||
      path.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) return '';
  const candidate = path.resolve(root, relative);
  // Reject links even if they resolve inside the workspace: a retained name
  // must keep pointing at the exact originally indexed filesystem object.
  return path.relative(candidate, realpath(candidate)) === '' ? candidate : '';
}

function capture(cwd, snapshot, source) {
  const root = realpath(cwd);
  const items = [];
  for (const file of snapshot?.items || []) {
    if (!file.artifactId || !file.path) continue;
    try {
      const relative = path.relative(path.resolve(cwd), path.resolve(file.path)).split(path.sep).join('/');
      const candidate = target(root, relative);
      if (!candidate) continue;
      const stat = fs.lstatSync(candidate, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.size) !== Number(file.size) ||
          Math.round(Number(stat.mtimeNs) / 1e6) !== Number(file.at)) continue;
      if (file.historical && !same(file.historicalVersion, stamp(stat))) continue;
      const metadata = Object.fromEntries(metadataKeys.filter(key => Object.hasOwn(file, key)).map(key => [key, file[key]]));
      metadata.relative = relative;
      if (file.historical) metadata.primary = file.historicalPrimary;
      items.push({ metadata, stamp: stamp(stat), source: file.historicalSource || source });
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) throw error;
      // Deleted or replaced results remain missing; switching never recreates them.
    }
  }
  return { version: 1, root, items };
}

function restore(cwd, history, current = []) {
  if (history?.version !== 1 || !Array.isArray(history.items)) return [];
  let root;
  try { root = realpath(cwd); } catch (_) { return []; }
  if (typeof history.root !== 'string' || path.relative(root, history.root) !== '') return [];
  const indexed = new Set(current.map(item => item.artifactId));
  const files = [];
  for (const row of history.items) {
    const file = row?.metadata;
    if (!file?.artifactId || indexed.has(file.artifactId)) continue;
    try {
      const candidate = target(root, file.relative);
      if (!candidate) continue;
      const stat = fs.lstatSync(candidate, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || !same(row.stamp, stamp(stat))) continue;
      files.push({ ...file, path: path.resolve(cwd, file.relative), primary: false,
        changedInTurn: false, historical: true, historicalPrimary: file.primary !== false,
        historicalSource: row.source, historicalVersion: row.stamp });
      indexed.add(file.artifactId);
    } catch (_) { /* Unavailable or changed historical files do not authorize new bytes. */ }
  }
  return files;
}

module.exports = { capture, restore };
