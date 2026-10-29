
















const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');
const deliveryContract = require('../conversation/delivery-contract');

const SKIP_DIRS = new Set(['skills', 'node_modules', '.git', '.pi', '__pycache__', '.venv', 'node-compile-cache']);
const SKIP_EXT = new Set(['.tmp', '.part', '.crdownload', '.swp']);
const MAX_FILES = 60;
const SCAN_CAP = MAX_FILES + 1;       // Scan one extra entry to distinguish an exact limit from truncation.
const MAX_DEPTH = 3;
const IO_LIMIT = 16;
const pendingScans = new Map();
const ioQueue = [];
let activeIO = 0;

// All sessions share this bound. A large old workspace may have no matching
// outputs at all, so the 60-result cap cannot bound its filesystem work.
function fileIO(operation) {
  return new Promise((resolve, reject) => {
    const run = () => {
      activeIO++;
      Promise.resolve().then(operation).then(resolve, reject).finally(() => {
        activeIO--;
        ioQueue.shift()?.();
      });
    };
    if (activeIO < IO_LIMIT) run(); else ioQueue.push(run);
  });
}

function _skip(name) {
  if (!name || name.startsWith('.') || name.startsWith('~$')) return true;
  return SKIP_EXT.has(path.extname(name).toLowerCase());
}

/* Synchronous compatibility entry for legacy API users and tests. Main-process requests use
   scanAsync: the result cap does not bound visits to older workspace files. */
function collect(dir, since, depth, out) {
  if (depth > MAX_DEPTH || out.length >= SCAN_CAP) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  // Read this directory's files before descending. An alphabetically earlier
  // runtime/cache subtree must not consume the entire index before a report
  // beside it is even considered. Do not exclude ordinary files under temp/.
  for (const ent of entries) {
    if (out.length >= SCAN_CAP) break;
    const name = ent.name;
    if (_skip(name)) continue;
    const full = path.join(dir, name);
    if (!ent.isFile()) continue;
    let st;
    try { st = fs.statSync(full); } catch (e) { continue; }
    // Compare at the same precision as stored output timestamps. Filesystem
    // conversion can report an exact millisecond as e.g. 123.999 instead of 124.
    const at = Math.round(st.mtimeMs);
    if (since && at < since) continue;
    out.push({ path: full, name, size: st.size, at });
  }
  for (const ent of entries) {
    if (out.length >= SCAN_CAP) break;
    if (!ent.isDirectory() || _skip(ent.name) || SKIP_DIRS.has(ent.name)) continue;
    collect(path.join(dir, ent.name), since, depth + 1, out);
  }
  return out;
}

async function collectAsync(dir, since, depth, out) {
  if (depth > MAX_DEPTH || out.length >= SCAN_CAP) return out;
  let entries;
  try { entries = await fileIO(() => fs.promises.readdir(dir, { withFileTypes: true })); }
  catch (_) { return out; }
  const files = entries.filter(ent => ent.isFile() && !_skip(ent.name));
  for (let offset = 0; offset < files.length && out.length < SCAN_CAP; offset += IO_LIMIT) {
    const batch = await Promise.all(files.slice(offset, offset + IO_LIMIT).map(async ent => {
      const full = path.join(dir, ent.name);
      try {
        const st = await fileIO(() => fs.promises.stat(full));
        const at = Math.round(st.mtimeMs);
        if (since && at < since) return null;
        return { path: full, name: ent.name, size: st.size, at };
      } catch (_) { return null; }
    }));
    // Concurrent metadata reads must not change which first 60 files win.
    for (const row of batch) {
      if (row && out.length < SCAN_CAP) out.push(row);
    }
  }
  for (const ent of entries) {
    if (out.length >= SCAN_CAP) break;
    if (!ent.isDirectory() || _skip(ent.name) || SKIP_DIRS.has(ent.name)) continue;
    await collectAsync(path.join(dir, ent.name), since, depth + 1, out);
  }
  return out;
}

/* List outputs newest first using since as the session-start boundary. */
function scan(cwd, since, turnSince) {
  return scanned(cwd, since, turnSince, cwd ? collect(cwd, Number(since) || 0, 0, []) : []);
}

function scanned(cwd, since, turnSince, out) {
  const scope = { since: Number(since) || 0, turnSince: Number(turnSince) || 0 };
  const truncated = out.length > MAX_FILES;
  // The extra row only detects truncation. Select by the traversal priority
  // before sorting for display, so a newer overflow row cannot evict a root report.
  const files = out.slice(0, MAX_FILES).sort((a, b) => b.at - a.at).map((item) => ({
    ...item,
    relative: path.relative(cwd, item.path).split(path.sep).join('/'),
    changedInTurn: Boolean(Number(turnSince) && Number(item.at) >= Number(turnSince)),
  }));
  const delivery = deliveryContract.classify(cwd || '', files);
  if (Number(turnSince)) {
    delivery.items = delivery.items.map((item) => ({
      ...item,
      changedInTurn: Number(item.at || 0) >= Number(turnSince),
    }));
  }
  return { files, truncated, delivery, ...scope };
}

function scanAsync(cwd, since, turnSince) {
  const scopeSince = Number(since) || 0, scopeTurn = Number(turnSince) || 0;
  const key = JSON.stringify([cwd || '', scopeSince, scopeTurn]);
  if (pendingScans.has(key)) return pendingScans.get(key);
  // Only share in-flight work, never stale file contents or a failed scan.
  const request = (async () => scanned(cwd, scopeSince, scopeTurn,
    cwd ? await collectAsync(cwd, scopeSince, 0, []) : []))()
    .finally(() => { if (pendingScans.get(key) === request) pendingScans.delete(key); });
  pendingScans.set(key, request);
  return request;
}

function list(cwd, since, turnSince) { return scan(cwd, since, turnSince).files; }

// A fast write can receive a filesystem timestamp slightly before Date.now()
// at the turn boundary. A completed content journal provides stronger evidence
// for an already indexed file, without broadening the time window or file scope.
function withJournal(scanned, journal) {
  const changed = new Map((journal?.files || []).filter(row =>
    ['created', 'modified', 'renamed'].includes(row.action) && row.after?.exists &&
    row.after.path === row.path).map(row => [row.path, row.after]));
  const mark = file => {
    const after = changed.get(file.relative);
    return after && after.size === file.size && Math.round(after.mtimeMs) === file.at
      ? { ...file, changedInTurn: true } : file;
  };
  return { ...scanned, files: scanned.files.map(mark),
    delivery: { ...scanned.delivery, items: scanned.delivery.items.map(mark) } };
}

/*
 * Restrict renderer-opened files to this conversation's workspace.
 */
function inside(cwd, target) {
  if (!cwd || !target) return false;
  let root, p;
  try {
    const realpath = fs.realpathSync.native || fs.realpathSync;
    root = realpath(cwd);
    p = realpath(target);
  } catch (_) {
    return false;
  }
  const rel = path.relative(root, p);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function navigation(cwd, raw) {
  let url;
  try { url = new URL(String(raw || '')); } catch (_) { return { kind: 'blocked' }; }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    return { kind: 'external', url: url.href };
  }
  if (url.protocol === 'file:') {
    try {
      const target = fileURLToPath(url);
      if (inside(cwd, target)) return { kind: 'inside', url: url.href, path: target };
    } catch (_) { /* malformed file URL */ }
  }
  return { kind: 'blocked' };
}

module.exports = { list, scan, scanAsync, withJournal, inside, navigation, _collect: collect };
