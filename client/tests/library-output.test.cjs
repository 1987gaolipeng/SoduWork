'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const output = require('../main/library-output.cjs');
const artifacts = require('../main/conversation/artifact-runtime.js');
const { MAX_BYTES } = require('../main/library-binary.cjs');

function workspace(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-library-output-'));
  const cwd = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(cwd); fs.mkdirSync(outside);
  t.after(() => {
    const resolved = fs.realpathSync(base);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('soduwork-library-output-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { cwd, outside };
}

function write(root, name, bytes) {
  const filename = path.join(root, name);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, bytes);
  return filename;
}

function exact(result, bytes, name, mimeType) {
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.name, name);
  assert.equal(result.mimeType, mimeType);
  assert.equal(result.size, bytes.length);
  assert.deepEqual(Buffer.from(result.data, 'base64'), bytes);
}

test('library output reads original HTML, PNG and Markdown bytes without preview truncation', t => {
  const { cwd } = workspace(t);
  const fixtures = [
    ['网页成果.html', 'text/html', Buffer.from('<!doctype html><html><body>' + '完整的成果🙂\r\n'.repeat(150000) + '</body></html>')],
    ['图像成果.PNG', 'image/png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKk0AAAAASUVORK5CYII=', 'base64')],
    ['说明文档.md', 'text/markdown', Buffer.from('# 原始成果\r\n' + '中英双语 example 🎉\r\n'.repeat(150000) + '\n最后一行')],
  ];
  for (const [name, mimeType, bytes] of fixtures) {
    if (mimeType !== 'image/png') assert.ok(bytes.length > 2 * 1024 * 1024);
    exact(output.read({ cwd }, write(cwd, name, bytes)), bytes, name, mimeType);
  }
});

test('library output resolves public artifact IDs from the trusted session delivery index', t => {
  const { cwd, outside } = workspace(t);
  const bytes = Buffer.from('# Indexed result\n可信成果，保持原始内容。');
  const name = 'indexed.md';
  const filename = write(cwd, 'results/' + name, bytes);
  const other = write(outside, name, Buffer.from('not this file'));
  const delivery = { items: [{ artifactId: 'artifact-indexed', path: filename, relative: 'results/' + name,
    kind: 'document', name, primary: true, size: bytes.length }] };
  const publicArtifact = artifacts.decorate('test-session', delivery)[0];
  assert.equal(Object.hasOwn(publicArtifact, 'path'), false);
  let snapshots = 0;
  const session = { cwd, outputSnapshot: () => { snapshots++; return { files: [], delivery }; } };
  exact(output.read(session, publicArtifact), bytes, name, 'text/markdown');
  exact(output.read(session, { artifactId: publicArtifact.artifactId, path: other }), bytes, name, 'text/markdown');
  assert.equal(snapshots, 2);
});

test('library output resolves relative paths against the session working directory', t => {
  const { cwd } = workspace(t);
  const bytes = Buffer.from('# Relative file\n嵌套目录里的原文');
  write(cwd, 'nested/result.md', bytes);
  exact(output.read({ cwd }, path.join('nested', 'result.md')), bytes, 'result.md', 'text/markdown');
});

test('library output rejects unknown artifact IDs instead of falling back to any path', t => {
  const { cwd } = workspace(t);
  const filename = write(cwd, 'valid.md', Buffer.from('Exists but is not indexed'));
  const session = { cwd, outputSnapshot: () => ({ files: [], delivery: { items: [] } }) };
  for (const target of [
    { artifactId: 'unknown', path: filename },
    { artifactId: filename },
    { artifactId: 'valid.md', relative: 'valid.md' },
  ]) {
    const result = output.read(session, target);
    assert.equal(result.ok, false);
    assert.equal(Object.hasOwn(result, 'data'), false);
    assert.match(result.reason, /更新|刷新/);
  }
});

test('library output rejects paths and indexed artifacts outside the session workspace', t => {
  const { cwd, outside } = workspace(t);
  const filename = write(outside, 'private.md', Buffer.from('Outside this session'));
  const session = { cwd, outputSnapshot: () => ({ delivery: { items: [{ artifactId: 'outside', path: filename }] } }) };
  for (const target of [filename, path.relative(cwd, filename), { artifactId: 'outside' }]) {
    const result = output.read(session, target);
    assert.equal(result.ok, false);
    assert.equal(Object.hasOwn(result, 'data'), false);
    assert.match(result.reason, /工作目录|工作区/);
  }
});

test('library output rejects a directory junction or symlink that escapes the workspace', t => {
  const { cwd, outside } = workspace(t);
  write(outside, 'private.md', Buffer.from('Escaped target'));
  const link = path.join(cwd, 'linked-folder');
  // Windows junctions exercise real-path confinement without requiring the
  // developer-mode privilege needed for a file symlink.
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  const filename = path.join(link, 'private.md');
  assert.equal(fs.readFileSync(filename, 'utf8'), 'Escaped target');
  const session = { cwd, outputSnapshot: () => ({ delivery: { items: [{ artifactId: 'linked', path: filename }] } }) };
  for (const target of [filename, path.join('linked-folder', 'private.md'), { artifactId: 'linked' }]) {
    const result = output.read(session, target);
    assert.equal(result.ok, false);
    assert.equal(Object.hasOwn(result, 'data'), false);
  }
});

test('library output rejects files larger than 64MB before returning transfer bytes', t => {
  const { cwd } = workspace(t);
  const filename = write(cwd, 'large.html', Buffer.alloc(0));
  const descriptor = fs.openSync(filename, 'r+');
  try { fs.ftruncateSync(descriptor, MAX_BYTES + 1); } finally { fs.closeSync(descriptor); }
  assert.equal(fs.statSync(filename).size, MAX_BYTES + 1);
  const session = { cwd, outputSnapshot: () => ({ delivery: { items: [{ artifactId: 'large', path: filename }] } }) };
  for (const target of [filename, { artifactId: 'large' }]) {
    const result = output.read(session, target);
    assert.equal(result.ok, false);
    assert.match(result.reason, /64MB/);
    assert.equal(Object.hasOwn(result, 'data'), false);
  }
});

test('library output reports missing sessions, missing files and directories as failures', t => {
  const { cwd } = workspace(t);
  fs.mkdirSync(path.join(cwd, 'directory'));
  for (const [session, target] of [[null, 'result.md'], [{ cwd }, 'missing.md'], [{ cwd }, 'directory'], [{ cwd }, {}]]) {
    const result = output.read(session, target);
    assert.equal(result.ok, false);
    assert.equal(typeof result.reason, 'string');
    assert.equal(Object.hasOwn(result, 'data'), false);
  }
});
