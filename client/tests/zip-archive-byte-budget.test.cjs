'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const zlib = require('node:zlib');
const archive = require('../main/conversation/zip-archive');

function folder(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-zip-bytes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function changeAfterStat(t, target, bytes) {
  const stat = fs.statSync;
  t.mock.method(fs, 'statSync', function (filename, ...args) {
    const result = stat.call(fs, filename, ...args);
    if (filename === target) fs.writeFileSync(target, bytes);
    return result;
  });
}

test('a file growing beyond the input budget after collection is rejected even if it compresses well', t => {
  const root = folder(t), target = path.join(root, 'report.txt');
  fs.writeFileSync(target, 'small');
  changeAfterStat(t, target, Buffer.alloc(archive.MAX_BYTES + 1, 65));
  assert.throws(() => archive.createZip(root), /24 MB/);
});

test('files growing after collection cannot exceed the combined input budget', t => {
  const root = folder(t), target = path.join(root, 'b.txt');
  fs.writeFileSync(path.join(root, 'a.txt'), Buffer.alloc(12 * 1024 * 1024, 65));
  fs.writeFileSync(target, 'small');
  changeAfterStat(t, target, Buffer.alloc(13 * 1024 * 1024, 66));
  assert.throws(() => archive.createZip(root), /24 MB/);
});

test('growth after opening a file is bounded and closes the file on failure', t => {
  const root = folder(t), target = path.join(root, 'report.txt');
  fs.writeFileSync(target, 'small');
  let changed = false, reads = 0, closes = 0;
  const opened = new Set();
  const grow = () => {
    if (!changed) { changed = true; fs.writeFileSync(target, Buffer.alloc(archive.MAX_BYTES + 1, 65)); }
  };
  const readFile = fs.readFileSync, read = fs.readSync, open = fs.openSync, close = fs.closeSync;
  t.mock.method(fs, 'openSync', function (...args) {
    const fd = open.apply(fs, args); if (args[1] === 'r') opened.add(fd); return fd;
  });
  t.mock.method(fs, 'readFileSync', function (...args) { grow(); return readFile.apply(fs, args); });
  t.mock.method(fs, 'readSync', function (...args) { grow(); const size = read.apply(fs, args); reads += size; return size; });
  t.mock.method(fs, 'closeSync', function (...args) {
    if (opened.delete(args[0])) closes++; return close.apply(fs, args);
  });
  assert.throws(() => archive.createZip(root), /24 MB/);
  assert.ok(reads <= archive.MAX_BYTES + 1, 'read at most the budget plus one overflow byte');
  assert.ok(closes > 0, 'failed reads release the file descriptor');
  assert.equal(opened.size, 0);
});

test('changed files within the budget retain exact bytes and report the bytes actually archived', t => {
  const root = folder(t), target = path.join(root, 'report.txt');
  const expected = Buffer.from('updated report');
  fs.writeFileSync(target, 'old'); changeAfterStat(t, target, expected);
  const result = archive.createZip(root), bytes = result.data;
  assert.equal(result.total, expected.length);
  const at = 30 + bytes.readUInt16LE(26) + bytes.readUInt16LE(28);
  const payload = bytes.subarray(at, at + bytes.readUInt32LE(18));
  assert.deepEqual(bytes.readUInt16LE(8) === 8 ? zlib.inflateRawSync(payload) : payload, expected);
});

test('an unchanged compressible file at exactly the input budget is still shareable', t => {
  const root = folder(t), target = path.join(root, 'report.txt');
  fs.writeFileSync(target, Buffer.alloc(archive.MAX_BYTES, 65));
  const result = archive.createZip(root);
  assert.equal(result.total, archive.MAX_BYTES); assert.equal(result.files, 1);
  assert.ok(result.size < archive.MAX_BYTES);
});

test('encoding cannot replace bytes already captured from another source file', t => {
  const root = folder(t), target = path.join(root, 'b.txt');
  fs.writeFileSync(path.join(root, 'a.txt'), 'first');
  fs.writeFileSync(target, 'second');
  const expected = archive.createZip(root), deflate = zlib.deflateRawSync;
  let changed = false;
  t.mock.method(zlib, 'deflateRawSync', function (...args) {
    if (!changed) {
      changed = true;
      fs.writeFileSync(target, 'changed during encoding');
    }
    return deflate.apply(zlib, args);
  });
  const result = archive.createZip(root);
  assert.equal(fs.readFileSync(target, 'utf8'), 'changed during encoding');
  assert.equal(result.total, expected.total);
  assert.deepEqual(result.data, expected.data);
});
