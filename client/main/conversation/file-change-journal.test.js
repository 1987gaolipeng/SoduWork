'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const journal = require('./file-change-journal');

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-change-journal-'));
}

test('compare reports created, modified and deleted files with bounded content', async () => {
  const cwd = await tempDir();
  await fs.writeFile(path.join(cwd, 'changed.md'), 'before\n', 'utf8');
  await fs.writeFile(path.join(cwd, 'deleted.txt'), 'gone\n', 'utf8');
  const before = await journal.snapshot(cwd);
  await fs.writeFile(path.join(cwd, 'changed.md'), 'after\n', 'utf8');
  await fs.writeFile(path.join(cwd, 'created.js'), 'export default 1;\n', 'utf8');
  await fs.rm(path.join(cwd, 'deleted.txt'));
  const after = await journal.snapshot(cwd);
  const result = journal.compare(before, after, { turnId: 'turn-1' });
  assert.deepEqual(result.stats, { created: 1, modified: 1, deleted: 1, renamed: 0, total: 3 });
  assert.equal(result.turnId, 'turn-1');
  const modified = result.files.find(file => file.path === 'changed.md');
  assert.equal(modified.action, 'modified');
  assert.equal(modified.before.text, 'before\n');
  assert.equal(modified.after.text, 'after\n');
  assert.equal(result.files.find(file => file.path === 'created.js').action, 'created');
  assert.equal(result.files.find(file => file.path === 'deleted.txt').action, 'deleted');
  await fs.rm(cwd, { recursive: true, force: true });
});

test('snapshot excludes runtime directories and does not follow symlinks', async () => {
  const cwd = await tempDir();
  await fs.mkdir(path.join(cwd, 'node_modules'), { recursive: true });
  await fs.writeFile(path.join(cwd, 'node_modules', 'ignored.js'), 'ignored', 'utf8');
  await fs.writeFile(path.join(cwd, 'visible.js'), 'visible', 'utf8');
  const outside = await tempDir();
  await fs.writeFile(path.join(outside, 'secret.js'), 'secret', 'utf8');
  try { await fs.symlink(outside, path.join(cwd, 'linked')); } catch (_) { /* Windows may deny symlinks in CI. */ }
  const snap = await journal.snapshot(cwd);
  assert.ok(snap.files['visible.js']);
  assert.equal(snap.files['node_modules/ignored.js'], undefined);
  assert.equal(snap.files['linked/secret.js'], undefined);
  await fs.rm(cwd, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

test('snapshot without a workspace never scans the process cwd', async () => {
  const snap = await journal.snapshot('');
  assert.equal(snap.cwd, '');
  assert.deepEqual(snap.files, {});
});

test('capture returns changes and preserves the wrapped result', async () => {
  const cwd = await tempDir();
  const captured = await journal.capture(cwd, 'turn-2', async () => {
    await fs.writeFile(path.join(cwd, 'result.json'), '{"ok":true}\n', 'utf8');
    return 42;
  });
  assert.equal(captured.value, 42);
  assert.equal(captured.changes.stats.created, 1);
  assert.equal(captured.changes.files[0].after.text, '{"ok":true}\n');
  await fs.rm(cwd, { recursive: true, force: true });
});

test('compare recognizes a same-content rename', async () => {
  const cwd = await tempDir();
  await fs.writeFile(path.join(cwd, 'old.txt'), 'same', 'utf8');
  const before = await journal.snapshot(cwd);
  await fs.rename(path.join(cwd, 'old.txt'), path.join(cwd, 'new.txt'));
  const after = await journal.snapshot(cwd);
  const result = journal.compare(before, after, { turnId: 'turn-rename' });
  assert.deepEqual(result.stats, { created: 0, modified: 0, deleted: 0, renamed: 1, total: 1 });
  assert.deepEqual(result.files[0], {
    path: 'new.txt', previousPath: 'old.txt', action: 'renamed',
    before: result.files[0].before, after: result.files[0].after,
  });
  await fs.rm(cwd, { recursive: true, force: true });
});

test('capture attaches file changes when the wrapped operation fails', async () => {
  const cwd = await tempDir();
  await assert.rejects(
    journal.capture(cwd, 'turn-3', async () => {
      await fs.writeFile(path.join(cwd, 'partial.txt'), 'partial', 'utf8');
      throw new Error('failed');
    }),
    error => error.message === 'failed' && error.fileChanges?.stats.created === 1,
  );
  await fs.rm(cwd, { recursive: true, force: true });
});
