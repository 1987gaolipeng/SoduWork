'use strict';

const fs = require('node:fs/promises');
const { constants, lstatSync, realpathSync } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { assertNoLinks } = require('../plugin-resources');
const { portablePath } = require('./portable-workspace');
const { stamp, same } = require('./runtime-artifacts.cjs');
const MAX_FILE = 128 * 1024 * 1024, MAX_BYTES = 512 * 1024 * 1024, MAX_FILES = 4000;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function directory(profile, id) {
  if (!path.isAbsolute(profile) || !id || typeof id !== 'string') throw Error('Invalid artifact store');
  return path.join(profile, 'conversation-artifacts', hash(id));
}

function location(profile, id, archive) {
  if (archive?.version !== 1 || !/^[a-f0-9-]{36}$/.test(archive.generation)) return null;
  const root = path.join(directory(profile, id), archive.generation);
  assertNoLinks(profile, root);
  return root;
}

async function readVersion(root, relative, expected) {
  const file = path.join(root, portablePath(relative));
  const matches = stat => stat.isFile() && stat.nlink === 1n && same(expected, stamp(stat));
  assertNoLinks(root, file);
  const before = await fs.lstat(file, { bigint: true });
  if (!matches(before) || before.size > BigInt(MAX_FILE)) return null;
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    if (!matches(await handle.stat({ bigint: true }))) return null;
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, Math.min(bytes.length - offset, 1024 * 1024), offset);
      if (!bytesRead) return null;
      offset += bytesRead;
    }
    assertNoLinks(root, file);
    return matches(await handle.stat({ bigint: true })) && matches(await fs.lstat(file, { bigint: true })) ? bytes : null;
  } finally { await handle.close(); }
}

function needsBackup(history) {
  return Boolean(history && ((history.items?.length || history.resources?.length) &&
    (!history.archive || history.archivePending || history.archive.omitted > 0)));
}

function entries(history) { return [...(history?.items || []), ...(history?.resources || [])]; }

function archiveRecords(archive) {
  if (!archive) return [];
  return [...(archive.files || []).map(record => ({ ...record, generation: archive.generation })),
    ...(archive.pendingFiles || [])];
}

function projection(profile, id, history) {
  const archive = history?.archive;
  if (!Array.isArray(archive?.files)) return null;
  let root;
  try {
    // An OS-supplied profile may use an 8.3 alias. Resolve only that trusted
    // base; location still rejects any link along the private generation path.
    if (!path.isAbsolute(profile) || !lstatSync(profile).isDirectory()) return null;
    root = location(realpathSync.native(profile), id, archive);
  } catch (_) { return null; }
  if (!root) return null;
  const byName = new Map(archive.files.map(record => [record.relative, record]));
  function archived(rows) {
    return (rows || []).flatMap(entry => {
      const record = byName.get(entry.metadata.relative);
      return record && same(entry.stamp, record.sourceStamp) ? [{ ...entry, archiveOnly: false, stamp: record.stamp }] : [];
    });
  }
  return { root, version: 1, items: archived(history.items), resources: archived(history.resources) };
}

// Carry forward only bytes that were actually archived when a new execution
// workspace replaces the old one. A matching name in the new cwd has no authority.
function retain(previous, current) {
  if (!previous?.archive) return current;
  if (!current || current === previous) return previous;
  const recorded = new Map(archiveRecords(previous.archive).map(file => [file.relative, file]));
  const present = new Set(entries(current).filter(row =>
    same(row.stamp, recorded.get(row.metadata.relative)?.sourceStamp)).map(row => row.metadata.relative));
  const add = rows => (rows || []).filter(row => !present.has(row.metadata.relative) &&
    same(row.stamp, recorded.get(row.metadata.relative)?.sourceStamp)).map(row => ({ ...row, archiveOnly: true }));
  // Keep replacement metadata and the older receipt until the new bytes commit.
  return { ...current, items: [...add(previous.items), ...current.items],
    resources: [...add(previous.resources), ...(current.resources || [])] };
}

function missing(error) { return ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code); }

async function availableBytes(root, relative, expected) {
  try { return await readVersion(root, relative, expected); }
  catch (error) { if (missing(error)) return null; throw error; }
}

async function verified(root, relative, expected) {
  if (!root) return false;
  try {
    const target = path.join(root, portablePath(relative));
    assertNoLinks(root, target);
    const stat = await fs.lstat(target, { bigint: true });
    return stat.isFile() && stat.nlink === 1n && same(expected, stamp(stat));
  } catch (error) { if (missing(error)) return false; throw error; }
}

function validSize(entry) {
  const size = entry.metadata.size;
  return Number.isSafeInteger(size) && size >= 0 && size <= MAX_FILE && String(size) === entry.stamp?.[2];
}

async function syncDirectories(profile, paths) {
  if (process.platform === 'win32') return;
  // Sync child entries before the directories that make them reachable.
  for (const directory of [...paths].sort((a, b) => b.length - a.length)) {
    if (directory !== profile) assertNoLinks(profile, directory);
    const handle = await fs.open(directory, constants.O_RDONLY | (constants.O_DIRECTORY || 0) |
      (constants.O_NOFOLLOW || 0));
    try { await handle.sync(); } finally { await handle.close(); }
  }
}

// Only host-verified file receipts can enter the archive. The SQLite history
// publishes a generation after its files and directory entries are durable.
async function preserve(profile, id, history, previous, guard, { readWorkspace = true } = {}) {
  history = retain(previous, history);
  const rows = entries(history);
  if (!rows.length) return history;
  const prior = previous?.archive;
  const oldFiles = new Map(archiveRecords(prior).map(file => [file.relative, file]));
  const desired = new Map(), selected = new Map(), reserved = new Map();
  const keyOf = name => portablePath(name).normalize('NFC').toLowerCase();
  for (const entry of rows) {
    const name = entry.metadata.relative;
    if (!desired.has(name) || !entry.archiveOnly) desired.set(name, entry);
  }

  // Previously archived receipts reserve capacity even while their media is
  // offline. They can return without exceeding the bound or evicting a result.
  let size = 0;
  for (const entry of rows) {
    guard();
    const name = entry.metadata.relative, key = keyOf(name), old = oldFiles.get(name);
    if (!old || reserved.has(key) || !same(entry.stamp, old.sourceStamp) || !validSize(entry)) continue;
    if (reserved.size >= MAX_FILES || size + entry.metadata.size > MAX_BYTES) continue;
    reserved.set(key, entry.metadata.size);
    size += entry.metadata.size;
    const sourceRoot = location(profile, id, { version: 1, generation: old.generation });
    const recovered = old.generation !== prior.generation;
    let proof = sourceRoot && await verified(sourceRoot, name, old.stamp) ? old.stamp : null;
    if (!proof && sourceRoot && recovered) {
      try { proof = await restoredStamp(profile, sourceRoot, old, entry.metadata.size); }
      catch (error) { if (!missing(error)) throw error; }
    }
    if (proof) {
      selected.set(key, { entry, old: { ...old, stamp: proof }, fallback: entry });
    }
  }
  for (const entry of desired.values()) {
    guard();
    const name = entry.metadata.relative, key = keyOf(name), existing = selected.get(key);
    if (!readWorkspace || !validSize(entry) || entry.archiveOnly || existing && (existing.entry.metadata.relative !== name ||
        same(existing.entry.stamp, entry.stamp))) continue;
    const growth = Math.max(0, entry.metadata.size - (reserved.get(key) || 0));
    if ((!reserved.has(key) && reserved.size >= MAX_FILES) || size + growth > MAX_BYTES) continue;
    if (await verified(history.root, name, entry.stamp)) {
      selected.set(key, { ...existing, entry });
      reserved.set(key, (reserved.get(key) || 0) + growth);
      size += growth;
    }
  }
  function publish(generation, files) {
    const committed = new Map(files.map(file => [file.relative, file.sourceStamp]));
    const pendingFiles = [...oldFiles.values()].filter(record => !committed.has(record.relative));
    const proofs = new Map([...pendingFiles.map(file => [file.relative, file.sourceStamp]), ...committed]);
    const keep = list => (list || []).filter(row => !row.archiveOnly || same(row.stamp, proofs.get(row.metadata.relative)));
    const omitted = [...desired].filter(([name, row]) => !same(row.stamp, committed.get(name))).length;
    return { ...history, items: keep(history.items), resources: keep(history.resources), archivePending: !!pendingFiles.length,
      archive: { version: 1, generation, files, omitted, ...(pendingFiles.length ? { pendingFiles } : {}) } };
  }
  if (prior && [...selected.values()].every(choice => choice.old?.generation === prior.generation &&
      same(choice.entry.stamp, choice.old.sourceStamp))) {
    guard();
    location(profile, id, prior);
    // With no new verified bytes, keep the old generation and its missing
    // files' original digests in place. Restoring a volume can repair them.
    const omitted = [...desired].filter(([name, row]) => {
      const selectedRow = selected.get(keyOf(name))?.entry;
      return selectedRow?.metadata.relative !== name || !same(row.stamp, selectedRow.stamp);
    }).length;
    const pending = !!prior.pendingFiles?.length || selected.size !== prior.files.length;
    if (history.archive === prior && history.archivePending === pending && prior.omitted === omitted) return history;
    return { ...history, archivePending: pending, archive: { ...prior, omitted } };
  }

  const generation = crypto.randomUUID(), base = directory(profile, id), root = path.join(base, generation);
  assertNoLinks(profile, root);
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  assertNoLinks(profile, root);
  await fs.mkdir(root, { mode: 0o700 });
  const owner = await fs.lstat(root, { bigint: true });
  async function owned() {
    assertNoLinks(profile, root);
    const current = await fs.lstat(root, { bigint: true });
    if (!current.isDirectory() || current.dev !== owner.dev || current.ino !== owner.ino)
      throw Error('Artifact archive generation changed during capture');
  }
  const files = [], directories = new Set([profile, path.dirname(base), base, root]);
  try {
    for (const choice of selected.values()) {
      guard();
      let { entry } = choice;
      const { old, fallback } = choice, relative = entry.metadata.relative;
      let bytes;
      if (!old || !same(old.sourceStamp, entry.stamp)) bytes = await availableBytes(history.root, relative, entry.stamp);
      if (!bytes && old) {
        const sourceRoot = location(profile, id, { version: 1, generation: old.generation });
        bytes = await availableBytes(sourceRoot, relative, old.stamp);
        if (bytes && hash(bytes) === old.sha256) entry = fallback;
        else bytes = null;
      }
      if (!bytes && readWorkspace && old && same(old.sourceStamp, entry.stamp) && !entry.archiveOnly)
        bytes = await availableBytes(history.root, relative, entry.stamp);
      if (!bytes) continue;
      guard();
      await owned();
      const target = path.join(root, relative);
      assertNoLinks(profile, target);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      assertNoLinks(profile, target);
      const output = await fs.open(target, 'wx', 0o600);
      let stat;
      try { await output.writeFile(bytes); await output.sync(); stat = await output.stat({ bigint: true }); }
      finally { await output.close(); }
      if (stat.size !== BigInt(bytes.length)) throw Error('Incomplete artifact archive write');
      // Last-write times can finalize on close. Authenticate the closed file
      // before publishing its receipt and reject a replaced directory entry.
      const written = stamp(stat), sha256 = hash(bytes);
      const closed = await restoredStamp(profile, root, { relative, sha256, stamp: written }, bytes.length);
      if (!closed || closed[0] !== written[0] || closed[1] !== written[1])
        throw Error('Artifact archive file changed after writing');
      for (let directory = path.dirname(target); !directories.has(directory); directory = path.dirname(directory))
        directories.add(directory);
      files.push({ relative, sha256, sourceStamp: entry.stamp, stamp: closed });
    }
    guard();
    await owned();
    if (files.length) {
      await syncDirectories(profile, directories);
      guard();
      await owned();
      return publish(generation, files);
    }
  } catch (error) {
    try { await owned(); await fs.rm(root, { recursive: true, force: true }); }
    catch (cleanup) { if (!missing(cleanup)) error.cleanupFailure = cleanup.code || cleanup.name; }
    throw error;
  }
  await owned();
  await fs.rm(root, { recursive: true, force: true });
  return { ...history, archivePending: true, ...(prior ? { archive: prior } : {}) };
}

async function retire(profile, id, before, after, accepted) {
  if (before === after) return;
  // A pending file names the physical generation to retry if its media returns.
  // A failed CAS owns only its newly created generation.
  const origins = archive => new Set([archive?.generation, ...(archive?.pendingFiles || []).map(file => file.generation)].filter(Boolean));
  const retained = origins(accepted ? after : before);
  const obsolete = accepted ? origins(before) : [after?.generation];
  for (const generation of obsolete)
    if (generation && !retained.has(generation)) await discard(profile, id, generation);
}

async function discard(profile, id, generation) {
  const root = generation ? location(profile, id, { version: 1, generation }) : directory(profile, id);
  if (!root) return;
  assertNoLinks(profile, root);
  await fs.rm(root, { recursive: true, force: true });
}

// Detach a deleted chat in a single filesystem operation. Reclaiming a large
// tree can continue after the sidebar has acknowledged the SQLite tombstone.
const reclamations = new Map();
function reclaim(profile) {
  if (reclamations.has(profile)) return reclamations.get(profile);
  const store = path.join(profile, 'conversation-artifacts');
  const work = (async () => {
    assertNoLinks(profile, store);
    const rows = await fs.readdir(store, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const row of rows) {
      if (!row.isDirectory() || !/^removed-[a-f0-9-]{36}$/.test(row.name)) continue;
      const target = path.join(store, row.name);
      assertNoLinks(profile, target);
      await fs.rm(target, { recursive: true, force: true });
    }
  })().finally(() => reclamations.delete(profile));
  reclamations.set(profile, work);
  return work;
}

async function detach(profile, id) {
  const root = directory(profile, id);
  assertNoLinks(profile, root);
  const removed = path.join(path.dirname(root), 'removed-' + crypto.randomUUID());
  try { await fs.rename(root, removed); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  // A simultaneous sweep can have already enumerated the directory.
  const pending = reclamations.get(profile);
  void Promise.resolve(pending).catch(() => {}).then(() => reclaim(profile)).catch(() => {});
}

// A profile backup preserves archived bytes and their SQLite digests but can
// assign new filesystem identities. Only re-attest the private generation.
async function restoredStamp(profile, root, record, size, parents = new Set()) {
  const file = path.join(root, portablePath(record.relative));
  const parent = path.dirname(file);
  if (!parents.has(parent)) { assertNoLinks(profile, parent); parents.add(parent); }
  const before = await fs.lstat(file, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(size)) return null;
  const candidate = stamp(before);
  if (same(record.stamp, candidate)) return record.stamp;
  const matches = stat => stat.isFile() && stat.nlink === 1n && same(candidate, stamp(stat));
  assertNoLinks(profile, file);
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    if (!matches(await handle.stat({ bigint: true }))) return null;
    const sha = crypto.createHash('sha256');
    if (size) {
      for await (const chunk of handle.createReadStream({ autoClose: false, start: 0, end: size - 1 })) sha.update(chunk);
    }
    assertNoLinks(profile, file);
    if (sha.digest('hex') !== record.sha256 || !matches(await handle.stat({ bigint: true })) ||
        !matches(await fs.lstat(file, { bigint: true }))) return null;
    return candidate;
  } finally { await handle.close(); }
}

async function rebind(profile, id, history, guard) {
  guard();
  const archive = history?.archive;
  if (!Array.isArray(archive?.files) || !archive.files.length || archive.files.length > MAX_FILES) return history;
  const pending = () => history.archivePending ? history : { ...history, archivePending: true };
  let root, identity;
  try {
    root = location(profile, id, archive);
    if (!root) return history;
    const stat = await fs.lstat(root, { bigint: true });
    if (!stat.isDirectory()) return pending();
    identity = stamp(stat);
  } catch (_) { return pending(); }
  const receipts = new Map(archive.files.map(record => [record.relative, record]));
  const rows = entries(history);
  const byName = new Map(rows.filter(row => same(row.stamp, receipts.get(row.metadata?.relative)?.sourceStamp))
    .map(row => [row.metadata.relative, row]));
  const files = [], parents = new Set([root]);
  let changed = false, complete = true, total = 0;
  async function inspect(record) {
    const row = byName.get(record.relative);
    if (!row || !validSize(row) || String(row.metadata.size) !== record.stamp?.[2] ||
        !/^[a-f0-9]{64}$/.test(record.sha256)) return null;
    total += row.metadata.size;
    if (total > MAX_BYTES) return null;
    try { return await restoredStamp(profile, root, record, row.metadata.size, parents); }
    catch (_) { return null; }
  }
  // Directory times do not change for an in-place edit or an added hard
  // link. Check every file; bound concurrent reads when a backup needs hashing.
  for (let offset = 0; offset < archive.files.length; offset += 16) {
    guard();
    const batch = archive.files.slice(offset, offset + 16);
    const stamps = await Promise.all(batch.map(inspect));
    if (total > MAX_BYTES) return history;
    for (const [index, record] of batch.entries()) {
      const next = stamps[index];
      if (!next) complete = false;
      const replace = next && next !== record.stamp;
      if (replace) changed = true;
      files.push(replace ? { ...record, stamp: next } : record);
    }
  }
  guard();
  try {
    if (!same(identity, stamp(await fs.lstat(location(profile, id, archive), { bigint: true })))) return pending();
  } catch (_) { return pending(); }
  const rebound = changed ? { ...history, archive: { ...archive, files } } : history;
  if (!complete) return rebound.archivePending ? rebound : { ...rebound, archivePending: true };
  // An offline volume can return without needing a new generation. Keep an
  // existing pending flag if later workspace receipts are still unarchived.
  if (rebound.archivePending && !archive.omitted && rows.every(row =>
    same(row.stamp, receipts.get(row.metadata.relative)?.sourceStamp))) return { ...rebound, archivePending: false };
  return rebound;
}

module.exports = { needsBackup, preserve, projection, retain, retire, discard, detach, reclaim, readVersion, rebind };
