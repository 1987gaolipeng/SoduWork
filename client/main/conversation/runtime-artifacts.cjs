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
const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => value === b[index]);

function target(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes('\0') ||
      path.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) return '';
  const candidate = path.resolve(root, relative);
  // Reject links even if they resolve inside the workspace: a retained name
  // must keep pointing at the exact originally indexed filesystem object.
  return path.relative(candidate, realpath(candidate)) === '' ? candidate : '';
}

function capture(cwd, snapshot, source, recordedPackages) {
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
  return { version: 1, root, items, ...(recordedPackages?.root === root ? { recordedPackages } : {}) };
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

function forContinuation(cwd, recovered, previous) {
  if (!recovered && !previous) return undefined;
  const files = restore(cwd, recovered);
  files.push(...restore(cwd, previous, files));
  try {
    const root = realpath(cwd);
    const packages = require('./device-history-plugins.cjs');
    const entries = new Map();
    for (const input of [previous?.recordedPackages, recovered]) {
      if (input?.root !== root || !Array.isArray(input.resources)) continue;
      for (const row of [...input.items, ...input.resources]) {
        const name = row.metadata?.relative;
        if (!name || !(packages.candidate(name) || packages.resource(name) || packages.BASELINE.test(name))) continue;
        const older = entries.get(name);
        if (!older || same(older.stamp, row.stamp) || restore(cwd, { version: 1, root, items: [row] }).length)
          entries.set(name, row);
      }
    }
    const items = [...entries.values()].filter(row => packages.candidate(row.metadata.relative));
    if (!files.length && !items.length) return undefined;
    const turnId = recovered?.packageTurnId || previous?.recordedPackages?.packageTurnId;
    const recordedPackages = items.length ? { version: 1, root, items, packageTurnId: turnId, turnId,
      resources: [...entries.values()].filter(row => !packages.candidate(row.metadata.relative)) } : undefined;
    return capture(cwd, { items: files }, undefined, recordedPackages);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) return undefined;
    throw error;
  }
}

// A continued device chat keeps its original package authority even if the
// native segment sees the same paths in a later filesystem inventory.
const continued = new WeakMap();

function continuedPlugins(handle) {
  const base = handle?.artifactHistory?.recordedPackages;
  if (!base) return null;
  const cwd = handle.cwd, owner = handle.deliveryOwner, id = handle.sessionId;
  const cached = continued.get(handle);
  if (cached?.current()) return cached;
  const current = () => handle.cwd === cwd && handle.sessionId === id &&
    handle.deliveryOwner === owner && handle.artifactHistory?.recordedPackages === base;
  const guard = () => {
    if (!current()) throw Error('会话成果来源已变化，请刷新后重试');
  };
  const history = require('./device-history-artifacts.cjs');
  const packages = require('./device-history-plugins.cjs');
  const names = new Set(base.items.map(row => row.metadata.relative).filter(packages.candidate));
  const paths = [...names].map(name => path.resolve(cwd, name));
  const processed = new Set([base.packageTurnId].filter(Boolean));
  let pending = Promise.resolve();
  const state = { current, paths, receipt: base, view: history.view(cwd, base, guard),
    refresh(journal) {
      if (!journal?.turnId || journal.truncated || !Array.isArray(journal.files) || processed.has(journal.turnId)) return pending;
      // A completed, content-matching turn can update the draft or a resource
      // in place. Filesystem timestamps alone cannot authorize a replacement.
      const files = journal.files.filter(row => typeof row.path === 'string' &&
        (names.has(row.path) || packages.resource(row.path) || packages.BASELINE.test(row.path)));
      if (!files.length) return pending;
      processed.add(journal.turnId);
      const update = pending.then(async () => {
        guard();
        const receipt = await history.capture({ row: { id, adapterId: handle.adapterId, cwd },
          previous: state.receipt, journal: { ...journal, files } });
        guard();
        if (receipt) {
          state.receipt = receipt;
          state.view = history.view(cwd, receipt, guard);
        }
      });
      pending = update.catch(() => { processed.delete(journal.turnId); });
      return update;
    } };
  continued.set(handle, state);
  return state;
}

module.exports = { capture, restore, forContinuation, continuedPlugins, stamp, same };
