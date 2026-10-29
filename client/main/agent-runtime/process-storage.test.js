'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { plan, commit, abandon, PLAN_TTL_MS } = require('./process-storage');
const owner = 'a'.repeat(32);
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-storage-plan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'workspace'); fs.mkdirSync(cwd);
  const app = { isPackaged: false, getPath: () => root };
  const planned = await plan(app, cwd, 'Work form only', owner);
  return { root, cwd, app, planned, write() {
    fs.writeFileSync(planned.file, JSON.stringify(planned.header) + '\n', { flag: 'wx', mode: 0o600 });
  } };
}

test('planning produces a real SDK header but no conversation file or model configuration', async t => {
  const f = await fixture(t);
  assert.equal(f.planned.header.type, 'session');
  assert.equal(f.planned.header.id, f.planned.id);
  assert.equal(f.planned.header.cwd, f.cwd);
  assert.equal(f.planned.owner, owner);
  assert.match(f.planned.nonce, /^[a-f0-9]{64}$/);
  assert.equal(fs.existsSync(f.planned.file), false);
  assert.equal(fs.existsSync(path.join(f.root, 'pi-agent', 'models.json')), false);
  assert.equal(abandon(f.app, f.planned).abandoned, true);
});

test('commit requires the exclusive header and appends real SDK title and work ownership without messages', async t => {
  const f = await fixture(t); f.write();
  const result = await commit(f.app, f.planned);
  assert.equal(result.committed, true);
  const entries = fs.readFileSync(f.planned.file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(entries[0], JSON.parse(JSON.stringify(f.planned.header)));
  assert.equal(entries[1].type, 'session_info');
  assert.equal(entries[1].name, 'Work form only');
  assert.equal(entries[2].customType, 'soduwork.work-entry');
  assert.deepEqual(entries[2].data, { version: 1, owner });
  assert.ok(entries.every(entry => entry.type !== 'message'));
  await assert.rejects(commit(f.app, f.planned), { code: 'INVALID_ARCHIVE_PLAN' });
  assert.equal(abandon(f.app, f.planned).abandoned, true);
  assert.equal(fs.existsSync(f.planned.file), false);
});

test('unknown, forged, copied-profile and mutated plans cannot commit or delete files', async t => {
  const f = await fixture(t); f.write();
  for (const supplied of [{ ...f.planned, nonce: 'b'.repeat(64) }, { ...f.planned, owner: 'c'.repeat(32) },
    { ...f.planned, title: 'Changed title' }, { ...f.planned, file: path.join(f.root, 'outside.jsonl') },
    { ...f.planned, header: { ...f.planned.header, cwd: f.root } }]) {
    await assert.rejects(commit(f.app, supplied), { code: 'INVALID_ARCHIVE_PLAN' });
    assert.throws(() => abandon(f.app, supplied), { code: 'INVALID_ARCHIVE_PLAN' });
  }
  const other = { getPath: () => path.join(f.root, 'other-profile') };
  await assert.rejects(commit(other, f.planned), { code: 'INVALID_ARCHIVE_PLAN' });
  assert.equal(fs.existsSync(f.planned.file), true);
  abandon(f.app, f.planned);
});

test('missing, modified and nonexclusive archive headers cannot be committed', async t => {
  const missing = await fixture(t);
  await assert.rejects(commit(missing.app, missing.planned), { code: 'ENOENT' });
  abandon(missing.app, missing.planned);
  const modified = await fixture(t); modified.write();
  fs.appendFileSync(modified.planned.file, '{"type":"message"}\n');
  await assert.rejects(commit(modified.app, modified.planned), { code: 'INVALID_ARCHIVE_PLAN' });
  assert.throws(() => abandon(modified.app, modified.planned), { code: 'INVALID_ARCHIVE_PLAN' });
  assert.equal(fs.existsSync(modified.planned.file), true);
  const linked = await fixture(t); linked.write();
  const other = path.join(linked.root, 'other.jsonl'); fs.linkSync(linked.planned.file, other);
  await assert.rejects(commit(linked.app, linked.planned), { code: 'INVALID_ARCHIVE_PLAN' });
  assert.equal(fs.existsSync(other), true);
});

test('expired nonce is rejected and cannot delete a subsequently created file', async t => {
  const f = await fixture(t); f.write();
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + PLAN_TTL_MS + 1);
  await assert.rejects(commit(f.app, f.planned), { code: 'INVALID_ARCHIVE_PLAN' });
  assert.throws(() => abandon(f.app, f.planned), { code: 'INVALID_ARCHIVE_PLAN' });
  assert.equal(fs.existsSync(f.planned.file), true);
});

test('a committed conversation that has started or was replaced is never removed by abandon', async t => {
  const f = await fixture(t); f.write(); await commit(f.app, f.planned);
  fs.appendFileSync(f.planned.file, '{"type":"message","message":{"role":"user"}}\n');
  assert.throws(() => abandon(f.app, f.planned), { code: 'INVALID_ARCHIVE_PLAN' });
  assert.equal(fs.existsSync(f.planned.file), true);
  const replaced = await fixture(t); replaced.write(); await commit(replaced.app, replaced.planned);
  fs.renameSync(replaced.planned.file, replaced.planned.file + '.original');
  fs.writeFileSync(replaced.planned.file, JSON.stringify(replaced.planned.header) + '\n');
  assert.throws(() => abandon(replaced.app, replaced.planned), { code: 'INVALID_ARCHIVE_PLAN' });
  assert.equal(fs.existsSync(replaced.planned.file), true);
});

test('a symlinked archive directory is rejected before the SDK can create anything outside the profile', async t => {
  const f = await fixture(t); abandon(f.app, f.planned);
  const sessions = path.join(f.root, 'pi-agent', 'sessions'), external = path.join(f.root, 'external');
  fs.rmSync(sessions, { recursive: true }); fs.mkdirSync(external);
  try { fs.symlinkSync(external, sessions, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('OS does not permit fixture symlinks'); return; } throw error; }
  await assert.rejects(plan(f.app, f.cwd, 'Denied path', owner), { code: 'INVALID_ARCHIVE_PLAN' });
  assert.deepEqual(fs.readdirSync(external), []);
});
