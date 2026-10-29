'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const modulePath = require.resolve('../main/conversation/titles');
const titles = require(modulePath);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-title-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, app: { getPath: () => root } };
}
test('renames persist across process cache reload without changing task or transcript metadata', t => {
  const { app } = fixture(t);
  const row = { id: 'pi-1', title: 'original', taskTitle: 'Keep task', taskId: 't1', at: 50 };
  const saved = titles.save(app, row.id, '  周报  复核 📝  ');
  assert.equal(saved.title, '周报 复核 📝');
  delete require.cache[modulePath];
  const decorated = require(modulePath).decorate(app, row);
  assert.equal(decorated.title, saved.title);
  assert.equal(decorated.customTitle, saved.title);
  assert.equal(decorated.at, 50);
  assert.equal(decorated.taskTitle, 'Keep task');
  assert.equal(row.title, 'original');
});
test('labels are independent of adapter and cannot escape their metadata directory', t => {
  const { app, root } = fixture(t);
  for (const id of ['pi/1', 'codex:1', 'opencode/2', '../../escape']) titles.save(app, id, id);
  const files = fs.readdirSync(path.join(root, 'conversation-titles'));
  assert.equal(files.length, 4);
  assert.ok(files.every(file => /^[a-f0-9]{64}\.json$/.test(file)));
  assert.deepEqual(fs.readdirSync(root), ['conversation-titles']);
});
test('title validation rejects blank, invalid types and overlong values, but accepts 120 Unicode characters', () => {
  for (const value of ['', ' \n ', null, {}, 'a'.repeat(121)]) assert.throws(() => titles.normalize(value));
  assert.equal(titles.normalize('📝'.repeat(120)), '📝'.repeat(120));
});
test('renaming twice creates a newer revision and leaves no temporary files', t => {
  const { app, root } = fixture(t);
  const a = titles.save(app, 'same', 'A'), b = titles.save(app, 'same', 'B');
  assert.ok(b.titleUpdatedAt > a.titleUpdatedAt);
  assert.equal(titles.decorate(app, { id: 'same', title: 'automatic' }).title, 'B');
  assert.equal(fs.readdirSync(path.join(root, 'conversation-titles')).length, 1);
});
test('profiles are isolated and automatic titles remain unchanged when there is no override', t => {
  const a = fixture(t), b = fixture(t), row = { id: 'same', title: 'Original' };
  titles.save(a.app, row.id, 'Mine');
  assert.equal(titles.decorate(b.app, row), row);
  assert.equal(titles.decorate(a.app, row).title, 'Mine');
});
test('failed persistence cannot return success or poison the in-memory title', t => {
  const { app, root } = fixture(t);
  const original = titles.save(app, 'test', 'Original');
  const rename = fs.renameSync;
  fs.renameSync = () => { throw Error('simulated disk failure'); };
  try { assert.throws(() => titles.save(app, 'test', 'Not saved'), /disk failure/); }
  finally { fs.renameSync = rename; }
  assert.equal(titles.decorate(app, { id: 'test' }).title, original.title);
  assert.equal(fs.readdirSync(path.join(root, 'conversation-titles')).length, 1);
});
