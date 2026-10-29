'use strict';

// The UI execution contract reserves this exact directory for screenshots.
// Keep discovery separate from delivery and from the general hidden-file scan.
const fs = require('node:fs');
const path = require('node:path');
// The six-shot instruction is per turn. Retain a bounded conversation history
// consistent with the ordinary 60-file index so earlier previews keep working.
const MAX_IMAGES = 60, MAX_ENTRIES = 128, MAX_BYTES = 20 * 1024 * 1024;
const EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const realpath = fs.realpathSync.native || fs.realpathSync;

function directory(root) {
  let target = root;
  for (const part of ['.soduwork', 'evidence']) {
    target = path.join(target, part);
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return '';
  }
  return target;
}

function raster(header, extension) {
  if (extension === '.png') return header.length >= 24 &&
    header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    header.toString('ascii', 12, 16) === 'IHDR' &&
    header.readUInt32BE(16) > 0 && header.readUInt32BE(20) > 0 &&
    header.readUInt32BE(16) * header.readUInt32BE(20) <= 40000000;
  if (extension === '.jpg' || extension === '.jpeg') return header.length >= 4 &&
    header[0] === 255 && header[1] === 216 && header[2] === 255;
  if (extension === '.gif') return header.length >= 10 && /^(GIF87a|GIF89a)$/.test(header.toString('ascii', 0, 6)) &&
    header.readUInt16LE(6) > 0 && header.readUInt16LE(8) > 0;
  return extension === '.webp' && header.length >= 16 && header.toString('ascii', 0, 4) === 'RIFF' &&
    header.toString('ascii', 8, 12) === 'WEBP' && /^(VP8 |VP8L|VP8X)$/.test(header.toString('ascii', 12, 16));
}

function collect(cwd, options = {}) {
  if (!cwd) return [];
  let root, folder, dir;
  try {
    root = realpath(cwd); folder = directory(root);
    if (!folder) return [];
    dir = fs.opendirSync(folder);
  } catch (_) { return []; }
  const since = Math.max(0, Number(options.since) || 0), turnSince = Math.max(0, Number(options.turnSince) || 0);
  const latest = Date.now() + 1000, images = [];
  try {
    for (let visited = 0; visited < MAX_ENTRIES; visited++) {
      const entry = dir.readSync();
      if (!entry) break;
      const extension = path.extname(entry.name).toLowerCase();
      if (!entry.isFile() || entry.isSymbolicLink() || !EXTENSIONS.has(extension) || entry.name.startsWith('.')) continue;
      let fd;
      try {
        // Revalidate the directory and canonical file before reading any bytes.
        if (directory(root) !== folder) continue;
        const candidate = path.join(folder, entry.name), stat = fs.lstatSync(candidate);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_BYTES) continue;
        const target = realpath(candidate);
        if (path.relative(folder, target) !== entry.name) continue;
        fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const current = fs.fstatSync(fd), at = Math.round(current.mtimeMs);
        if (!current.isFile() || current.ino !== stat.ino || current.dev !== stat.dev ||
            current.size <= 0 || current.size > MAX_BYTES || at < since || at > latest) continue;
        const bytes = Buffer.alloc(32), length = fs.readSync(fd, bytes, 0, bytes.length, 0);
        if (!raster(bytes.subarray(0, length), extension)) continue;
        // Keep the session's path spelling for stable artifact identity (a
        // Windows workspace may use an 8.3 alias); reads revalidate realpath.
        images.push({ path: path.resolve(cwd, '.soduwork', 'evidence', entry.name),
          relative: '.soduwork/evidence/' + entry.name, name: entry.name,
          size: current.size, at, changedInTurn: Boolean(turnSince && at >= turnSince),
          primary: false, processEvidence: true });
      } catch (_) { /* Deleted, unreadable or replaced screenshots stay unavailable. */ }
      finally { if (fd !== undefined) fs.closeSync(fd); }
    }
  } catch (_) { /* A disappearing directory does not interrupt ordinary outputs. */ }
  finally { try { dir.closeSync(); } catch (_) {} }
  return images.sort((left, right) => right.at - left.at || left.relative.localeCompare(right.relative)).slice(0, MAX_IMAGES);
}

module.exports = { collect };
