'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const journal = require('../main/conversation/file-change-journal');
const history = require('../main/conversation/device-history-artifacts.cjs');
const storage = require('../main/conversation/device-artifact-archive.cjs');
const versions = require('../main/conversation/artifact-versions.cjs');

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-version-')));
  const profile = path.join(root, 'profile'), workspace = path.join(root, 'project'), id = 'chat-1';
  fs.mkdirSync(profile); fs.mkdirSync(workspace);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspaceKey = crypto.randomUUID();
  const draft = require('../main/conversation/delivery-workspace.cjs').allocate(workspace, workspaceKey);
  const cwd = require('../main/conversation/delivery-workspace.cjs').ensure(workspace, draft);
  const guard = () => {};
  let saved;
  async function deliver(turnId, files) {
    const before = await journal.snapshot(cwd);
    for (const [relative, text] of Object.entries(files)) {
      const target = path.join(cwd, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
    }
    const change = journal.compare(before, await journal.snapshot(cwd), { turnId });
    const next = await history.capture({ row: { id, cwd, adapterId: 'pi' }, previous: saved, journal: change, verifiedTurn: true });
    const captured = await storage.preserve(profile, id, next, saved, guard);
    await storage.retire(profile, id, saved?.archive, captured.archive, true);
    saved = captured;
    return captured.archive;
  }
  return { root, profile, id, workspace, workspaceKey, guard, cwd, deliver };
}

test('same-name originals from two turns survive later edits, restart and a copied profile', async t => {
  const f = fixture(t);
  await f.deliver('first', { 'report.md': 'A' });
  const archive = await f.deliver('second', { 'report.md': 'B2' });
  assert.deepEqual(versions.list(archive).map(row => [row.turnId, row.relative]), [
    ['first', 'report.md'], ['second', 'report.md'] ]);
  assert.equal(new Set(versions.list(archive).map(row => row.versionId)).size, 2);
  fs.rmSync(f.cwd, { recursive: true });
  const restored = path.join(f.root, 'restored');
  fs.cpSync(f.profile, restored, { recursive: true });
  const readers = await versions.readers(restored, f.id, JSON.parse(JSON.stringify(archive)), f.guard);
  assert.deepEqual(readers.map(row => row.turnId), ['first', 'second']);
  for (const [index, turn] of readers.entries()) {
    const item = (await turn.reader.snapshotAsync()).items[0];
    assert.equal(item.versionId, versions.list(archive)[index].versionId);
    assert.equal(fs.readFileSync(item.path, 'utf8'), index ? 'B2' : 'A');
    assert.ok(turn.reader.verify(item.path));
    fs.writeFileSync(item.path, 'tampered original');
    assert.equal(turn.reader.verify(item.path), false);
  }
  assert.deepEqual(await versions.readers(restored, f.id, archive, f.guard), []);
});

test('working copies are independent per turn, preserve local edits and include owned resources', async t => {
  const f = fixture(t);
  await f.deliver('first', { 'web/index.html': '<title>A</title>', 'web/style.css': 'body{background:url(logo.png)}',
    'web/logo.png': 'image', 'other.json': 'unrelated' });
  const htmlV2 = '<title>B2</title><link rel="stylesheet" href="style.css">';
  const archive = await f.deliver('second', { 'web/index.html': htmlV2 });
  const options = { ...f, archive, turnId: 'first' };
  const first = await versions.exportTurn(options);
  assert.ok(first.length >= 3);
  for (const file of first) assert.ok(fs.existsSync(file.path));
  const repeated = await versions.exportTurn(options);
  assert.ok(repeated.every(row => row.unchanged && !row.conflict));
  const html = first.find(item => item.path.endsWith('index.html'));
  fs.writeFileSync(html.path, 'manual');
  const retry = await versions.exportTurn(options);
  assert.ok(retry.find(row => row.path === html.path).conflict);
  assert.equal(fs.readFileSync(html.path, 'utf8'), 'manual');
  const second = await versions.exportTurn({ ...options, turnId: 'second' });
  const nextHtml = second.find(item => item.path.endsWith('index.html'));
  assert.notEqual(nextHtml.path, html.path);
  assert.equal(fs.readFileSync(path.join(path.dirname(nextHtml.path), 'style.css'), 'utf8'), 'body{background:url(logo.png)}');
  assert.equal(fs.readFileSync(path.join(path.dirname(nextHtml.path), 'logo.png'), 'utf8'), 'image');
  assert.equal(second.some(row => row.path.endsWith('other.json')), false);
  assert.equal(fs.readFileSync(nextHtml.path, 'utf8'), htmlV2);
  const reader = (await versions.readers(f.profile, f.id, archive, f.guard))[0].reader;
  assert.equal(fs.readFileSync(reader.snapshot().items.find(row => row.relative === 'web/index.html').path, 'utf8'), '<title>A</title>');
});

test('working copy publication rejects linked paths, unknown receipts and revoked access', async t => {
  const f = fixture(t), archive = await f.deliver('a', { 'site/index.html': 'original' });
  const options = { ...f, archive, versionId: versions.list(archive)[0].versionId };
  await assert.rejects(versions.exportCopy({ ...options, versionId: 'unknown' }));
  await assert.rejects(versions.exportCopy({ ...options, workspaceKey: '../escape' }));
  await assert.rejects(versions.exportCopy({ ...options, guard() { throw Error('revoked'); } }), /revoked/);
  const dir = path.join(f.workspace, '会话成果');
  fs.symlinkSync(f.profile, dir, 'junction');
  await assert.rejects(versions.exportCopy(options));
  fs.unlinkSync(dir);
  const published = await versions.exportCopy(options);
  const locked = path.join(f.root, 'user-original');
  fs.writeFileSync(locked, 'user');
  fs.unlinkSync(published.path);
  fs.linkSync(locked, published.path);
  await assert.rejects(versions.exportCopy(options));
  assert.equal(fs.readFileSync(locked, 'utf8'), 'user');
});

test('a rejected archive publication keeps all committed generations and discards only new bytes', async t => {
  const f = fixture(t);
  await f.deliver('first', { 'report.md': 'original' });
  const archive = await f.deliver('second', { 'report.md': 'second' });
  const before = await journal.snapshot(f.cwd);
  fs.writeFileSync(path.join(f.cwd, 'report.md'), 'uncommitted');
  const change = journal.compare(before, await journal.snapshot(f.cwd), { turnId: 'racing-turn' });
  const historyData = await history.capture({ row: { id: f.id, cwd: f.cwd, adapterId: 'pi' }, journal: change, verifiedTurn: true });
  const next = await storage.preserve(f.profile, f.id, historyData, { root: f.cwd, archive, items: [] }, f.guard);
  await storage.retire(f.profile, f.id, archive, next.archive, false);
  assert.ok(!fs.existsSync(storage.location(f.profile, f.id, next.archive)));
  const readers = await versions.readers(f.profile, f.id, archive, f.guard);
  assert.deepEqual(readers.map(({ reader }) => fs.readFileSync(reader.snapshot().items[0].path, 'utf8')), ['original', 'second']);
});

test('a transfer receipt cannot manufacture a local turn or version', async t => {
  const f = fixture(t), before = await journal.snapshot(f.cwd);
  fs.writeFileSync(path.join(f.cwd, 'received.md'), 'incoming');
  const changes = journal.compare(before, await journal.snapshot(f.cwd), { turnId: 'transfer' });
  const captured = await history.capture({ row: { id: f.id, cwd: f.cwd, adapterId: 'pi' },
    journal: changes, verifiedTransfer: true, verifiedTurn: true });
  const saved = await storage.preserve(f.profile, f.id, captured, null, f.guard);
  assert.ok(saved.archive.files.length);
  assert.deepEqual(versions.list(saved.archive), []);
  const legacy = await history.capture({ row: { id: f.id, cwd: f.cwd, adapterId: 'pi' }, journal: changes });
  const archived = await storage.preserve(f.profile, f.id, legacy, null, f.guard);
  assert.deepEqual(versions.list(archived.archive), []);
});

test('completed turns prune copies of unreferenced files from retired full snapshots', async t => {
  const f = fixture(t);
  await f.deliver('one', { 'one.md': 'one' });
  const middle = await f.deliver('two', { 'two.md': 'two' });
  const dir = storage.location(f.profile, f.id, middle);
  assert.ok(fs.existsSync(path.join(dir, 'one.md')));
  const latest = await f.deliver('three', { 'three.md': 'three' });
  assert.ok(!fs.existsSync(path.join(dir, 'one.md')));
  assert.ok(fs.existsSync(path.join(dir, 'two.md')));
  assert.equal((await versions.readers(f.profile, f.id, latest, f.guard)).length, 3);
});

test('a multi-file export interrupted before publication can retry on a volume without hard links', async t => {
  const f = fixture(t);
  const archive = await f.deliver('multi', { 'first.md': 'one', 'nested/second.md': 'two' });
  const base = path.join(f.workspace, '会话成果', f.workspaceKey);
  let staged = false;
  const guard = () => {
    if (!fs.existsSync(base)) return;
    for (const name of fs.readdirSync(base)) {
      if (name.startsWith('.soduwork-copy-') && fs.readdirSync(path.join(base, name)).length) {
        staged = true;
        throw Error('interrupt');
      }
    }
  };
  const options = { ...f, archive, turnId: 'multi' };
  t.mock.method(fs, 'linkSync', () => { throw Object.assign(Error('No hard links'), { code: 'ENOTSUP' }); });
  await assert.rejects(versions.exportTurn({ ...options, guard }), /interrupt/);
  assert.ok(staged);
  assert.deepEqual(fs.readdirSync(base), []);
  const copies = await Promise.all([versions.exportTurn(options), versions.exportTurn(options)]);
  assert.equal(fs.readdirSync(base).length, 1);
  assert.deepEqual(copies[0].map(row => fs.readFileSync(row.path, 'utf8')), ['one', 'two']);
  assert.deepEqual(copies[0].map(row => row.path), copies[1].map(row => row.path));
  fs.unlinkSync(copies[0][0].path);
  fs.writeFileSync(copies[0][1].path, 'manual');
  const rebuilt = await versions.exportTurn(options);
  assert.notEqual(copies[0][1].path, rebuilt[1].path);
  assert.equal(fs.readFileSync(copies[0][1].path, 'utf8'), 'manual');
  assert.deepEqual(rebuilt.map(row => fs.readFileSync(row.path, 'utf8')), ['one', 'two']);
  assert.deepEqual((await versions.exportTurn(options)).map(row => row.path), rebuilt.map(row => row.path));
});


test('a relocated ancestor cannot redirect working copies into a different project', async t => {
  const f = fixture(t), archive = await f.deliver('guarded', { 'report.md': 'verified' });
  // The canonical project supplied by the desktop may be replaced while a
  // native exporter awaits I/O or an ownership check.
  const projects = path.join(f.root, 'projects'), workspace = path.join(projects, 'selected');
  const replacement = path.join(f.root, 'replacement');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(replacement, 'selected'), { recursive: true });
  fs.renameSync(projects, projects + '-moved');
  fs.symlinkSync(replacement, projects, 'junction');
  await assert.rejects(versions.exportTurn({ ...f, workspace, archive, turnId: 'guarded' }), /目录已变化/);
  assert.deepEqual(fs.readdirSync(path.join(replacement, 'selected')), []);
});

test('a retained native segment cannot assign an old artifact to a turn of its choosing', async t => {
  const f = fixture(t), before = await journal.snapshot(f.cwd);
  fs.writeFileSync(path.join(f.cwd, 'report.md'), 'owned');
  const changes = journal.compare(before, await journal.snapshot(f.cwd), { turnId: 'first' });
  const old = await history.capture({ row: { id: f.id, cwd: f.cwd, adapterId: 'pi' },
    journal: changes, verifiedTurn: true });
  old.items[0].source = { sessionId: 'other', turnId: 'foreign-turn', userMessageIndex: 0 };
  const replay = await history.capture({ row: { id: f.id, cwd: f.cwd, adapterId: 'pi' }, retained: old });
  const saved = await storage.preserve(f.profile, f.id, replay, null, f.guard);
  assert.equal(saved.archive.files.length, 1);
  assert.deepEqual(versions.list(saved.archive), []);
});

test('archive and copy names reject reserved Windows devices even on a Unix source', () => {
  const { portablePath } = require('../main/conversation/portable-workspace');
  for (const relative of ['site/COM¹.txt', 'LPT³.md', 'CONOUT$.md', 'CONIN$', 'com1 .txt', 'summary.md:stream']) {
    assert.throws(() => portablePath(relative));
  }
  assert.equal(portablePath('site/com123.md'), 'site/com123.md');
});
