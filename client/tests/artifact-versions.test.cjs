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

test('reopened cards reveal and package their own turn after the workspace is removed', async t => {
  const f = fixture(t);
  await f.deliver('first', { 'one.md': 'original one', 'two.md': 'original two' });
  const archive = await f.deliver('second', { 'one.md': 'later revision' });
  fs.rmSync(f.cwd, { recursive: true });
  const runtime = require('../main/conversation/artifact-runtime');
  const view = { sessionId: f.id, localReplica: true };
  let allowed = true;
  const guard = () => { if (!allowed) throw Error('closed'); };
  runtime.bindTurnArchives(view, () => versions.readers(f.profile, f.id, archive, guard));
  const rows = versions.list(archive);
  const idsFor = turn => rows.filter(row => row.turnId === turn).map(row => 'version:' + row.versionId);
  const ids = idsFor('first');
  assert.equal(ids.length, 2);
  const packages = require('../main/conversation/delivery-package-worker');
  const bundle = await packages.prepare(view, ids);
  assert.equal(bundle.contentType, 'application/zip');
  assert.deepEqual(bundle.manifest.files.map(row => [row.path, row.role]), [['one.md', 'primary'], ['two.md', 'primary']]);
  const single = await packages.prepare(view, [ids[0]]);
  assert.match(single.bytes.toString(), /^original /);
  await assert.rejects(packages.prepare(view, [ids[0], ...idsFor('second')]), /该轮成果/);
  await assert.rejects(packages.prepare(view, [ids[0], 'ordinary-file']), /同一轮/);
  const handlers = new Map(), calls = [];
  const frame = {}, event = { senderFrame: frame, sender: { mainFrame: frame, isDestroyed: () => false,
    getURL: () => require('node:url').pathToFileURL(path.resolve(__dirname, '../desk.html')).href } };
  require('../main/conversation/local-delivery-action').install({
    app: { getPath: () => f.profile }, ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    session: { get: () => view }, ownerOf: () => 'viewer',
    shell: { showItemInFolder: file => calls.push(['reveal', file]), openPath: file => { calls.push(['open', file]); return ''; } },
  });
  const click = (action, selection, options) => handlers.get('conversation-delivery-' + action)(event, 'view', selection, options);
  assert.deepEqual(await click('open-local', [ids[0]]), { ok: true });
  assert.equal(calls[0][0], 'reveal');
  assert.ok(calls[0][1].startsWith(path.join(f.profile, 'delivery-archives') + path.sep));
  assert.deepEqual(fs.readFileSync(calls[0][1]), single.bytes);
  assert.deepEqual(await click('open-archive', ids, { revision: bundle.manifest.revision }), { ok: true });
  assert.equal(calls[1][0], 'open');
  assert.deepEqual(fs.readFileSync(calls[1][1]), bundle.bytes);
  assert.equal((await click('open-archive', [ids[0]])).ok, false);
  allowed = false;
  assert.equal((await click('open-local', ids)).ok, false);
  assert.equal(calls.length, 2);
});

test('a Pi backup without turn receipts remains addressable after an empty or same-name replacement workspace', async t => {
  const f = fixture(t);
  async function capture(cwd, html, css, turnId, completed) {
    const before = await journal.snapshot(cwd);
    fs.writeFileSync(path.join(cwd, 'index.html'), html);
    fs.writeFileSync(path.join(cwd, 'page.css'), css);
    fs.writeFileSync(path.join(cwd, 'notes.md'), 'unrelated');
    const changes = journal.compare(before, await journal.snapshot(cwd), { turnId });
    return history.capture({ row: { id: f.id, cwd, adapterId: 'pi' }, journal: changes, verifiedTurn: completed });
  }
  const html = '<link rel="stylesheet" href="page.css"><h1>original</h1>';
  const old = await storage.preserve(f.profile, f.id, await capture(f.cwd, html, '/* original */', 'old-scan', false), null, f.guard);
  assert.deepEqual(versions.list(old.archive), []);
  fs.rmSync(f.cwd, { recursive: true });
  const cwd = fs.mkdtempSync(path.join(f.root, 'next-'));
  const runtime = require('../main/conversation/artifact-runtime');
  const handle = { cwd, outputs: () => [] }, ref = 'reopened';
  t.after(() => runtime.closeRef(ref));
  let saved = await versions.pinLegacyWebsites(f.profile, f.id, old, f.guard);
  const [original] = versions.list(saved.archive);
  assert.match(original.turnId, /^pi-archive:/);
  assert.equal(await versions.pinLegacyWebsites(f.profile, f.id, saved, f.guard), saved);
  runtime.bindTurnArchives(handle, () => versions.readers(f.profile, f.id, saved.archive, f.guard));
  async function previewOriginal(id = 'version:' + original.versionId) {
    const result = await runtime.preview(handle, ref, id);
    assert.equal(result.ok, true, result.reason);
    assert.equal(await (await fetch(result.url)).text(), html);
    assert.equal(await (await fetch(new URL('page.css', result.url))).text(), '/* original */');
    assert.equal((await fetch(new URL('notes.md', result.url))).status, 404);
    runtime.closeRef(ref);
  }
  await previewOriginal();
  // A later replay can recover the old message index without its workspace.
  // Previously issued links still work, while the card has one visible owner.
  const located = structuredClone(saved);
  const page = located.items.find(row => row.metadata.relative === 'index.html');
  page.source = { ...page.source, turnId: 'pi-history:first', userMessageIndex: 0 };
  saved = await storage.preserve(f.profile, f.id, located, saved, f.guard, { readWorkspace: false });
  const index = await runtime.viewSnapshotAsync(handle);
  assert.deepEqual(index.items.filter(item => item.versionId && item.relative === 'index.html').map(item => item.turnId),
    ['pi-history:first']);
  await previewOriginal(index.items.find(item => item.turnId === 'pi-history:first').artifactId);
  await previewOriginal();
  const changed = await capture(cwd, '<h1>replacement</h1>', '/* replacement */', 'new-turn', true);
  saved = await storage.preserve(f.profile, f.id, changed, old, f.guard, { pinPiWebsites: true });
  await storage.retire(f.profile, f.id, old.archive, saved.archive, true);
  await previewOriginal();
  const newest = versions.list(saved.archive).find(item => item.relative === 'index.html' && item.turnId === 'new-turn');
  const current = await runtime.resolveView(handle, 'version:' + newest.versionId);
  assert.equal(fs.readFileSync(current.path, 'utf8'), '<h1>replacement</h1>');
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

test('a later turn freezes differently spelled dependencies only when the source volume confirms the receipt', async t => {
  const f = fixture(t);
  await f.deliver('first', { 'site/Assets/Style.CSS': 'body{background:url(../images/logo.png)} i{background:url(icon.png)}', 'site/Assets/Icon.PNG': 'icon',
    'site/Images/Logo.PNG': 'image', 'site/Traps/Icon.PNG': 'moved image', 'site/Other.PNG': 'unrelated' });
  const insensitive = fs.existsSync(path.join(f.cwd, 'site', 'ASSETS', 'style.css'));
  // The target inode still has its original stamp. A directory link cannot
  // authorize a new spelling even if the referenced bytes really are there.
  const trap = path.join(f.cwd, 'site', 'Traps'), moved = path.join(f.root, 'outside');
  fs.renameSync(trap, moved);
  fs.symlinkSync(moved, trap, 'junction');
  const second = await f.deliver('second', {
    'site/index.html': '<link rel="stylesheet" href="/ASSETS/style.css"><link rel="stylesheet" href="/aSsEtS/style.css"><img src="traps/ICON.png">', });
  const published = await versions.exportTurn({ ...f, archive: second, turnId: 'second' });
  const names = published.map(row => row.relative.split(path.sep).slice(3).join('/')).sort();
  assert.deepEqual(names, (insensitive ? ['site/Assets/Icon.PNG', 'site/Assets/Style.CSS', 'site/Images/Logo.PNG', 'site/index.html'] : ['site/index.html']).sort());
  fs.rmSync(f.cwd, { recursive: true });
  const backup = path.join(f.root, 'restored-alias-proof');
  fs.cpSync(f.profile, backup, { recursive: true });
  const [, { reader }] = await versions.readers(backup, f.id, JSON.parse(JSON.stringify(second)), f.guard);
  const receipts = reader.packageFiles();
  assert.deepEqual(receipts.map(row => row.relative).sort(), names);
  assert.deepEqual(receipts.find(row => row.relative === 'site/index.html').aliases, []);
  const old = JSON.parse(JSON.stringify(second));
  for (const row of old.versions) delete row.aliases;
  const legacy = await versions.readers(backup, f.id, old, f.guard);
  assert.equal(legacy[1].reader.packageFiles()[0].aliases, undefined);
  if (insensitive) {
    assert.deepEqual(receipts.find(row => row.relative === 'site/Assets/Style.CSS').aliases.sort(), ['site/ASSETS/style.css', 'site/aSsEtS/style.css']);
    assert.deepEqual(receipts.find(row => row.relative === 'site/Assets/Icon.PNG').aliases.sort(), ['site/ASSETS/icon.png', 'site/aSsEtS/icon.png']);
    assert.deepEqual(receipts.find(row => row.relative === 'site/Images/Logo.PNG').aliases, ['site/images/logo.png']);
  }
});
