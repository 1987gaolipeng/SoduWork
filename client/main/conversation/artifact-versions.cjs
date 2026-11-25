'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { assertNoLinks } = require('../plugin-resources');
const { portablePath, MAX_FILES } = require('./portable-workspace');
const { same, stamp } = require('./runtime-artifacts.cjs');
const storage = () => require('./device-artifact-archive.cjs');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function versionId(turnId, relative, sha256) {
  return digest(JSON.stringify([turnId, relative, sha256]));
}

// These references can only select from the host's committed inventory.
function dependencies(name, bytes) {
  if (bytes.length > 4 * 1024 * 1024) return [];
  const ext = path.posix.extname(name).toLowerCase();
  let refs;
  if (/^\.(?:html?|css|m?js|svg|md|markdown)$/.test(ext)) {
    const { dependencyText, references } = require('./delivery-package');
    try { refs = references(dependencyText(bytes, name), ext); } catch (_) { return []; }
  } else if (require('./device-history-plugins.cjs').candidate(name) && ext === '.json') {
    try {
      const parsed = JSON.parse(bytes.toString('utf8'));
      refs = (parsed.resources || []).filter(row => row && !Object.hasOwn(row, 'content')).map(row => row.path);
    } catch (_) { return []; }
  } else return [];
  const result = new Set();
  for (const ref of refs) {
    if (typeof ref !== 'string') continue;
    let token;
    try { token = decodeURIComponent(ref.split(/[?#]/)[0]); } catch (_) { continue; }
    if (!token || token.length > 500 || token.includes('\\') || /^\.m?js$/.test(ext) && !/^[./]/.test(token)) continue;
    result.add(token);
    if (result.size >= 4000) break;
  }
  return [...result];
}

// Filesystem case and Unicode rules depend on the source volume. A spelling
// from a document can select an existing receipt only if the source filesystem
// resolves it to that exact regular file without links in either path.
function dependencyLookup(root, byName) {
  const byStamp = new Map();
  for (const row of byName.values()) {
    const key = row.stamp.join(':');
    if (!byStamp.has(key)) byStamp.set(key, []);
    byStamp.get(key).push(row);
  }
  const resolved = new Map(byName);
  return relative => {
    if (resolved.has(relative)) return resolved.get(relative);
    resolved.set(relative, undefined);
    try {
      const requested = path.join(root, portablePath(relative));
      assertNoLinks(root, requested);
      const stat = fs.lstatSync(requested, { bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n) return undefined;
      for (const row of byStamp.get(stamp(stat).join(':')) || []) {
        const original = path.join(root, portablePath(row.metadata.relative));
        assertNoLinks(root, original);
        const recorded = fs.lstatSync(original, { bigint: true });
        if (!recorded.isFile() || recorded.nlink !== 1n || !same(stamp(recorded), row.stamp)) continue;
        if (stat.ino === 0n && fs.realpathSync.native(requested) !== fs.realpathSync.native(original)) continue;
        resolved.set(relative, row);
        return row;
      }
    } catch (_) { /* A missing or changed source cannot authorize a new spelling. */ }
    return undefined;
  };
}

// The archive receipt, not a filename supplied by the model, identifies the bytes.
// Keep each completed turn's first committed version when a later capture retries.
function record(archive, prior, history) {
  const versions = [...(prior?.versions || [])];
  const turnPath = (turnId, relative) => JSON.stringify([turnId, relative]);
  const indices = new Map(versions.map((row, index) => [turnPath(row.turnId, row.relative), index]));
  const aliasOwners = new Map(), aliasCounts = new Map();
  for (const row of versions) {
    for (const alias of row.aliases || []) aliasOwners.set(turnPath(row.turnId, alias), row.relative);
    aliasCounts.set(row.turnId, (aliasCounts.get(row.turnId) || 0) + (row.aliases?.length || 0));
  }
  let aliasesChanged = false;
  const committed = new Map(archive.files.map(file => [file.relative, file]));
  const newDeliveries = [];
  const byName = new Map([...(history.items || []), ...(history.resources || [])]
    .filter(row => row.source?.turnId && !row.archiveOnly &&
      same(row.stamp, committed.get(row.metadata.relative)?.sourceStamp)).map(row => [row.metadata.relative, row]));
  function add(rows, resource, owner) {
    for (const row of rows || []) {
      const source = owner || row.source, turnId = source?.turnId, relative = row.metadata.relative;
      if (!turnId || row.archiveOnly) continue;
      const file = committed.get(relative), key = turnPath(turnId, relative);
      if (!file || indices.has(key) || !same(file.sourceStamp, row.stamp)) continue;
      indices.set(key, versions.length);
      if (!resource) newDeliveries.push({ relative, source });
      versions.push({ turnId, relative, versionId: versionId(turnId, relative, file.sha256),
        generation: archive.generation, sha256: file.sha256, stamp: file.stamp,
        metadata: row.metadata, source, resource, aliases: [] });
    }
  }
  add(history.items, false);
  add(history.resources, true);
  // A changed website can still depend on previously committed assets. Use only
  // this session's verified resources and freeze them beside its new entry.
  const lookup = newDeliveries.length && dependencyLookup(history.root, byName);
  for (const { relative, source } of newDeliveries) {
    const webRoot = path.posix.dirname(relative), pending = [{ canonical: relative, requested: relative }];
    const queued = new Set([relative]);
    while (pending.length) {
      const node = pending.pop();
      for (const ref of committed.get(node.canonical)?.dependencies || []) {
        // Browsers resolve nested URLs relative to the requested spelling.
        const target = ref.startsWith('/') ? path.posix.join(webRoot, ref.slice(1)) : path.posix.join(path.posix.dirname(node.requested), ref);
        const row = lookup(target);
        if (!row || row.source.sessionId !== source.sessionId) continue;
        add([row], true, source);
        const canonical = row.metadata.relative, turnId = source.turnId;
        const alias = turnPath(turnId, target);
        if (target !== canonical && !indices.has(alias) && !aliasOwners.has(alias)) {
          const index = indices.get(turnPath(turnId, canonical)), version = versions[index];
          const count = aliasCounts.get(turnId) || 0;
          if (!version || version.sha256 !== committed.get(canonical)?.sha256 || count >= MAX_FILES) continue;
          versions[index] = { ...version, aliases: [...(version.aliases || []), target] };
          aliasOwners.set(alias, canonical);
          aliasCounts.set(turnId, count + 1);
          aliasesChanged = true;
        }
        if (!queued.has(target) && queued.size < MAX_FILES) {
          queued.add(target);
          pending.push({ canonical, requested: target });
        }
      }
    }
  }
  if (versions.length) archive.versions = versions;
  return aliasesChanged || versions.length !== (prior?.versions?.length || 0);
}

function list(archive) {
  return (archive?.versions || []).filter(row => !row.resource && !row.metadata?.previewOf).map(row => ({
    turnId: row.turnId, versionId: row.versionId, relative: row.relative,
    size: row.metadata.size, sha256: row.sha256 }));
}

async function proof(profile, id, version) {
  const root = storage().location(profile, id, { version: 1, generation: version.generation });
  if (!root || !/^[a-f0-9]{64}$/.test(version.sha256)) throw Error('成果原件无效');
  const current = await storage().restoredStamp(profile, root, version, version.metadata.size);
  if (!current) throw Error('成果原件已变化');
  return { root, stamp: current };
}

function mergedReader(groups, guard, authorize) {
  const ids = new Map(groups.flatMap(group => [...group.ids]));
  const owners = groups.map(group => group.reader);
  function decorate(parts) {
    const items = parts.flatMap(part => part.items).map(item => ({ ...item, versionId: ids.get(item.path) }));
    const delivery = { schemaVersion: 1, source: 'history', items: items.filter(item => item.primary && !item.processEvidence) };
    return { items, delivery, got: { files: [], delivery } };
  }
  function owner(item) {
    guard();
    const found = owners.find(reader => reader.verify(item.path));
    if (!found) throw Error('成果原件已变化');
    return found;
  }
  return {
    authorize,
    root: groups.length === 1 ? groups[0].root : undefined,
    packageFiles() {
      guard();
      return groups.flatMap(group => group.proofs.filter(file => group.reader.verify(path.join(file.root, file.relative))));
    },
    rootFor(item) {
      const target = typeof item === 'string' ? item : item.path;
      return groups.find(group => group.reader.verify(target))?.root;
    },
    verify(target, stat) { guard(); return owners.some(reader => reader.verify(target, stat)); },
    snapshot() { guard(); return decorate(owners.map(reader => reader.snapshot())); },
    async snapshotAsync() { await authorize(); return decorate(await Promise.all(owners.map(reader => reader.snapshotAsync()))); },
    readSkill(item) { return owner(item).readSkill(item); },
    readPlugin(item) { return owner(item).readPlugin(item); },
    verifyPlugin(item) { return owner(item).verifyPlugin(item); },
  };
}

async function readers(profile, id, archive, guard, authorize = guard) {
  const entries = archive?.versions || [];
  if (!entries.length) return [];
  await authorize();
  if (!fs.lstatSync(profile).isDirectory()) throw Error('成果目录无效');
  profile = fs.realpathSync.native(profile);
  const byTurn = new Map();
  for (const version of entries) {
    guard();
    let checked;
    try { checked = await proof(profile, id, version); }
    catch (_) { continue; }
    const { root } = checked;
    const turn = byTurn.get(version.turnId) || { groups: new Map(), userMessageIndex: version.source.userMessageIndex };
    byTurn.set(version.turnId, turn);
    const group = turn.groups.get(root) || { version: 1, root, items: [], resources: [], ids: new Map(), proofs: [] };
    turn.groups.set(root, group);
    group[version.resource ? 'resources' : 'items'].push({ metadata: version.metadata, source: version.source, stamp: checked.stamp });
    group.ids.set(path.resolve(root, version.relative), version.versionId);
    if (!version.metadata.previewOf) group.proofs.push({ relative: version.relative, aliases: version.aliases,
      root, sha256: version.sha256, stamp: checked.stamp });
  }
  await authorize();
  return [...byTurn].map(([turnId, turn]) => {
    const groups = [...turn.groups.values()].map(group => ({
      root: group.root, ids: group.ids, proofs: group.proofs, reader: require('./device-history-artifacts.cjs').view(group.root, group, guard, authorize) }));
    return { turnId, userMessageIndex: turn.userMessageIndex, reader: mergedReader(groups, guard, authorize) };
  });
}

function copyRow(workspace, destination, version, unchanged, conflict) {
  const target = path.join(destination, portablePath(version.relative));
  return { versionId: version.versionId, path: target, relative: path.relative(workspace, target), unchanged, conflict };
}

async function existingCopies(workspace, destination, versions, guard) {
  assertNoLinks(workspace, destination);
  if (!fs.existsSync(destination)) return null;
  if (!fs.lstatSync(destination).isDirectory()) throw Error('工作副本目录无效');
  const copies = [];
  for (const version of versions) {
    await guard();
    const row = copyRow(workspace, destination, version, false, true);
    assertNoLinks(workspace, row.path);
    const stat = await fs.promises.lstat(row.path, { bigint: true }).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) { copies.push({ ...row, missing: true }); continue; }
    if (!stat.isFile() || stat.nlink !== 1n) throw Error('工作副本不能是链接或特殊文件');
    const checked = await storage().restoredStamp(workspace, destination, {
      relative: version.relative, sha256: version.sha256 }, version.metadata.size);
    copies.push({ ...row, unchanged: !!checked, conflict: !checked });
  }
  await guard();
  return copies;
}

async function exportTurn({ profile, id, archive, turnId, workspace, workspaceKey, guard }) {
  const versions = (archive?.versions || []).filter(row => row.turnId === turnId && !row.metadata?.previewOf);
  if (!versions.length) return [];
  if (!require('./delivery-workspace.cjs').validKey(workspaceKey) || !path.isAbsolute(workspace) ||
      !fs.lstatSync(workspace).isDirectory()) throw Error('工作副本目录无效');
  if (!fs.lstatSync(profile).isDirectory()) throw Error('成果目录无效');
  profile = fs.realpathSync.native(profile);
  const realWorkspace = fs.realpathSync.native(workspace);
  if (path.relative(realWorkspace, workspace)) throw Error('工作副本目录已变化');
  workspace = realWorkspace;
  const workspaceStat = fs.lstatSync(workspace, { bigint: true });
  function checkWorkspace() {
    const stat = fs.lstatSync(workspace, { bigint: true });
    if (!stat.isDirectory() || stat.dev !== workspaceStat.dev || stat.ino !== workspaceStat.ino ||
        path.relative(fs.realpathSync.native(workspace), workspace)) throw Error('工作副本目录已变化');
  }
  const authorize = async () => { await guard(); checkWorkspace(); };
  const base = path.join(workspace, '会话成果', workspaceKey);
  const ordinary = path.join(base, 'turn-' + digest(turnId).slice(0, 24));
  let destination = ordinary;
  await authorize();
  const existing = await existingCopies(workspace, ordinary, versions, authorize);
  if (existing) {
    if (existing.every(row => !row.missing)) return existing;
    // An older partial publication or a manually removed file cannot be repaired
    // by replacing the user's directory. Publish a separate complete revision.
    const suffix = digest(JSON.stringify(versions.map(row => row.versionId).sort())).slice(0, 24);
    destination = ordinary + '-' + suffix;
    const alternate = await existingCopies(workspace, destination, versions, authorize);
    if (alternate) return alternate;
  }

  assertNoLinks(workspace, destination);
  fs.mkdirSync(base, { recursive: true });
  assertNoLinks(workspace, destination);
  const staging = path.join(base, '.soduwork-copy-' + crypto.randomUUID());
  fs.mkdirSync(staging, { mode: 0o700 });
  const owner = fs.lstatSync(staging, { bigint: true });
  function checkStaging() {
    checkWorkspace();
    assertNoLinks(workspace, staging);
    const stat = fs.lstatSync(staging, { bigint: true });
    if (!stat.isDirectory() || stat.dev !== owner.dev || stat.ino !== owner.ino)
      throw Error('工作副本临时目录已变化');
  }

  const directories = new Set([staging]), staged = new Map();
  let published = false;
  try {
    for (const version of versions) {
      await authorize();
      const original = await proof(profile, id, version);
      const bytes = await storage().readVersion(original.root, version.relative, original.stamp);
      if (!bytes || digest(bytes) !== version.sha256) throw Error('成果原件已变化');
      checkStaging();
      const target = path.join(staging, portablePath(version.relative));
      assertNoLinks(workspace, target);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      assertNoLinks(workspace, target);
      const handle = await fs.promises.open(target, 'wx', 0o600);
      let written;
      try { await handle.writeFile(bytes); await handle.sync(); written = await handle.stat({ bigint: true }); }
      finally { await handle.close(); }
      const closed = await storage().restoredStamp(workspace, staging, {
        relative: version.relative, sha256: version.sha256, stamp: stamp(written) }, version.metadata.size);
      if (!closed || closed[0] !== String(written.dev) || closed[1] !== String(written.ino)) throw Error('工作副本内容已变化');
      staged.set(target, closed);
      for (let dir = path.dirname(target); !directories.has(dir); dir = path.dirname(dir)) directories.add(dir);
    }
    await storage().syncDirectories(workspace, directories);
    await authorize();
    checkStaging();
    assertNoLinks(workspace, destination);
    for (const directory of directories) {
      assertNoLinks(workspace, directory);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const child = path.join(directory, entry.name);
        if (entry.isDirectory() && directories.has(child)) continue;
        if (!entry.isFile() || !staged.has(child)) throw Error('工作副本目录已变化');
      }
    }
    for (const [target, expected] of staged) {
      const current = fs.lstatSync(target, { bigint: true });
      if (current.nlink !== 1n || !same(expected, stamp(current))) throw Error('工作副本内容已变化');
    }
    // Publish a complete sibling directory on the same volume. This works on
    // removable filesystems without hard links and never replaces existing files.
    try {
      if (fs.existsSync(destination)) return await existingCopies(workspace, destination, versions, authorize);
      fs.renameSync(staging, destination);
      published = true;
    } catch (error) {
      const raced = await existingCopies(workspace, destination, versions, authorize);
      if (!raced) throw error;
      return raced;
    }
    await storage().syncDirectories(workspace, new Set([workspace, path.dirname(base), base]));
    return versions.map(version => copyRow(workspace, destination, version, false, false));
  } finally {
    if (!published) {
      checkStaging();
      await fs.promises.rm(staging, { recursive: true, force: true });
    }
  }
}

async function exportCopy(options) {
  const version = options.archive?.versions?.find(row => row.versionId === options.versionId);
  if (!version || version.metadata?.previewOf) throw Error('找不到指定的成果版本');
  const copies = await exportTurn({ ...options, turnId: version.turnId });
  return copies.find(copy => copy.versionId === version.versionId);
}

module.exports = { dependencies, record, list, readers, exportCopy, exportTurn };
