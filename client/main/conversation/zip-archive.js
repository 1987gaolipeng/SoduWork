"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const deflate = require('node:util').promisify(zlib.deflateRaw);

const MAX_FILES = 500;
const MAX_BYTES = 24 * 1024 * 1024;
const SKIP = new Set([".git", "node_modules", ".venv", "__pycache__", ".soduwork"]);
const SKIP_FILE = /(?:^|[\\/])(?:\.DS_Store|Thumbs\.db|~\$)/i;

const CRC = Uint32Array.from({ length: 256 }, (_, n) => { for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (0xedb88320 & -(n & 1)); return n >>> 0; });
function crc32(buffer) { let crc = 0xffffffff; for (const byte of buffer) crc = CRC[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }
function dosDate(st) {
  const modified = new Date(st.mtimeMs ?? Date.now());
  if (Number.isNaN(modified.getTime())) return { date: 33, time: 0 };
  const date = modified.getFullYear() < 1980 ? new Date(1980, 0, 1)
    : modified.getFullYear() > 2107 ? new Date(2107, 11, 31, 23, 59, 58) : modified;
  return { date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(), time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2) };
}

// Windows Node stat loses the high bits of the Unix seconds. Read the native
// times in one batch while the packaging worker still owns the file snapshot.
function captureFileEntries(entries) {
  if (process.platform !== 'win32' || !entries.length) return entries;
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = `
    $ErrorActionPreference = 'Stop'
    [Console]::InputEncoding = [Text.Encoding]::UTF8
    $paths = ConvertFrom-Json ([Console]::In.ReadToEnd())
    $times = foreach ($p in $paths) {
      $file = [IO.FileInfo]::new($p)
      if (!$file.Exists) { throw 'Cannot read ZIP source file metadata' }
      try { ([DateTimeOffset]$file.get_LastWriteTimeUtc()).ToUnixTimeMilliseconds() }
      catch [ArgumentOutOfRangeException] {
        # NTFS can represent years above DateTime.MaxValue, all beyond the DOS maximum.
        [DateTimeOffset]::MaxValue.ToUnixTimeMilliseconds()
      }
    }
    ConvertTo-Json -Compress -InputObject @($times)
  `;
  const result = require('node:child_process').spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: JSON.stringify(entries.map(item => path.toNamespacedPath(item.filename))),
    encoding: 'utf8', windowsHide: true, timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw Error('Could not read Windows file modification times for ZIP export', { cause: result.error });
  const times = JSON.parse(result.stdout);
  if (!Array.isArray(times) || times.length !== entries.length || !times.every(Number.isSafeInteger)) {
    throw Error('Invalid Windows ZIP source file timestamps');
  }
  return entries.map(({ name, bytes }, index) => ({ name, bytes, st: { mtimeMs: times[index] } }));
}
function collect(root) {
  const result = []; let total = 0;
  function walk(dir, rel, depth) {
    if (result.length >= MAX_FILES) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    if (depth > 12) {
      // Inspect only this boundary directory. Empty/excluded entries omit no
      // shared files; a deeper directory remains an error without recursing.
      if (entries.some(ent => !SKIP.has(ent.name) && !SKIP_FILE.test(rel + '/' + ent.name) &&
          (ent.isFile() || ent.isDirectory()))) {
        throw Object.assign(new Error("Folder contains directories nested more than 12 levels; move files closer to the selected folder"), { code: 'ZIP_DEPTH_LIMIT' });
      }
      return;
    }
    for (const ent of entries) {
      if (result.length >= MAX_FILES) break;
      if (!ent.name || ent.name === "." || ent.name === ".." || SKIP.has(ent.name)) continue;
      const full = path.join(dir, ent.name); const next = rel ? rel + "/" + ent.name : ent.name;
      if (SKIP_FILE.test(next)) continue;
      if (ent.isDirectory()) { walk(full, next, depth + 1); continue; }
      if (!ent.isFile()) continue;
      const st = fs.statSync(full);
      if (st.size > MAX_BYTES || total + st.size > MAX_BYTES) throw new Error("Folder is larger than 24 MB; remove dependencies or media files");
      total += st.size; result.push({ full, name: next.replace(/\\/g, "/"), st });
    }
  }
  walk(root, "", 0);
  if (!result.length) throw new Error("The selected folder has no shareable files");
  if (result.length >= MAX_FILES) throw new Error("Too many files; remove node_modules and build output first");
  return { result, total };
}
function encode(entries) {
  const local = [], central = []; let offset = 0;
  for (const item of entries) {
    const data = item.bytes, name = Buffer.from(item.name, "utf8"), compressed = item.compressed;
    const method = compressed.length < data.length ? 8 : 0;
    const payload = method ? compressed : data; const stamp = item.st ? dosDate(item.st) : { date: 33, time: 0 };
    const head = Buffer.concat([Buffer.from([0x50,0x4b,0x03,0x04]), u16(20), u16(0x800), u16(method), u16(stamp.time), u16(stamp.date), u32(crc32(data)), u32(payload.length), u32(data.length), u16(name.length), u16(0), name]);
    local.push(head, payload);
    const cd = Buffer.concat([Buffer.from([0x50,0x4b,0x01,0x02]), u16(20), u16(20), u16(0x800), u16(method), u16(stamp.time), u16(stamp.date), u32(crc32(data)), u32(payload.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name]);
    central.push(cd); offset += head.length + payload.length;
  }
  const directory = Buffer.concat(central); const footer = Buffer.concat([Buffer.from([0x50,0x4b,0x05,0x06]), Buffer.alloc(4), u16(entries.length), u16(entries.length), u32(directory.length), u32(offset), u16(0)]);
  return Buffer.concat([...local, directory, footer]);
}
async function createEntries(entries) {
  const prepared = [];
  for (const item of entries) prepared.push({ ...item, compressed: await deflate(item.bytes, { level: 3 }) });
  return encode(prepared);
}
function createEntriesSync(entries) {
  return encode(entries.map(item => ({ ...item, compressed: zlib.deflateRawSync(item.bytes, { level: 6 }) })));
}
function createZip(root) {
  const { fs, collect } = createBoundedSource();
  const base = fs.realpathSync(root); const { result, total } = collect(base);
  const entries = result.map(item => ({ name: item.name, filename: item.full, st: item.st, bytes: fs.readFileSync(item.full) }));
  const archive = createEntriesSync(captureFileEntries(entries));
  if (archive.length > MAX_BYTES) throw new Error("ZIP archive is larger than 24 MB; remove large files");
  return { data: archive, name: path.basename(base) + ".zip", size: archive.length, files: result.length, total,
    website: result.some(file => /(?:^|\/)index\.(?:html?|xhtml)$/i.test(file.name)) };
}
function readBounded(filename, remaining) {
  const fd = fs.openSync(filename, 'r');
  try {
    const limitError = () => new Error('Folder is larger than 24 MB; remove dependencies or media files');
    if (fs.fstatSync(fd).size > remaining) throw limitError();
    const chunks = []; let size = 0;
    // The file may grow even after fstat. Read at most the remaining input
    // budget plus one overflow byte, before compression or ZIP allocation.
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining - size + 1));
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!read) return Buffer.concat(chunks, size);
      size += read;
      if (size > remaining) throw limitError();
      chunks.push(chunk.subarray(0, read));
    }
  } finally { fs.closeSync(fd); }
}
function createBoundedSource() {
  const contents = new Map(), sourceFs = Object.create(fs);
  sourceFs.readFileSync = filename => contents.get(filename);
  return { fs: sourceFs, collect: root => {
    const collected = collect(root); let total = 0;
    // Capture bytes under the input budget before the encoders consume them.
    for (const item of collected.result) {
      const bytes = readBounded(item.full, MAX_BYTES - total);
      total += bytes.length; contents.set(item.full, bytes);
    }
    return { ...collected, total };
  } };
}
// Keep the synchronous primitive for worker/test callers. Native UI handlers
// must use the bounded worker so scanning, reads, zlib and CRC stay off-thread.
function createZipAsync(root, options) { return require('./zip-archive-worker').create(root, options); }
module.exports = { createZip, createZipAsync, createEntries, createEntriesSync, captureFileEntries, collect, MAX_BYTES, MAX_FILES };
